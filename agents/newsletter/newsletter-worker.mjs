#!/usr/bin/env node
/**
 * Newsletter worker: one NOAN asset, one contact tag, one
 * button. Sends a Newsletter-tagged asset to every contact carrying the chosen
 * tag, exactly once each, through the fleet's Resend sender.
 *
 * No model in the loop. This is a deterministic sender: the issue is written by
 * a person as a NOAN asset, the audience is whoever carries the tag, and
 * everything else here is guards, rendering, and a ledger.
 *
 * TWO TRIGGERS, one worker:
 *
 *   dispatch   `.github/workflows/newsletter.yml` (workflow_dispatch) maps its
 *              inputs onto NEWSLETTER_ASSET / NEWSLETTER_AUDIENCE_TAG /
 *              NEWSLETTER_MODE = dry-run | test | live.
 *
 *   tags       NEWSLETTER_MODE=poll, run two-hourly from poller.yml (asked for
 *              2026-09-07: "could we just add a tag to the email?"). An asset
 *              tagged Newsletter + <audience tag> + `Test` gets test-sent to
 *              NEWSLETTER_TEST_RECIPIENT; tagged + `Send` goes live, gated
 *              exactly as the button is. The audience is the asset's own tag:
 *              of its tags that are not control tags, exactly one must be
 *              carried by at least one contact. Remove the tag before the
 *              poll to abort.
 *
 *              There are no receipt tags: the public API has no route that
 *              writes tags onto an asset (PUT/PATCH/POST on /assets/{id}/tags
 *              and /assets/{id} all 404, probed 2026-09-07), so the LEDGER is
 *              the receipt. tested[] and live[] are keyed by the asset's
 *              STABLE id and carry the version they ran against: the same
 *              tags on the same version do nothing twice, and an EDIT makes a
 *              new version, which needs a new Test before Send will run.
 *              Refusals are emailed once per asset version and reason.
 *
 * ASSET IDS MOVE. The list id is `<originalId>-<updatedAt ms>`, so it changes
 * on every edit. Every ledger key and idempotency key here uses stableId():
 * `originalId` when present, else the uuid prefix. Keying on the raw id would
 * make an edited issue look never-sent, which is the one failure this file
 * must never have.
 *
 * THE AUDIENCE IS THE TAG (decided 2026-09-07). Whoever carries the audience
 * tag is in, Churned included; the worker never second-guesses the segment.
 * The only subtractions are the hard stops in NEWSLETTER_EXCLUDE_TAGS
 * (Unsubscribed, plus the tags whose own usage instructions forbid bulk mail),
 * address hygiene, and dedupe on email. Every subtraction is counted by reason
 * in the summary so nothing is invisible.
 *
 * CONTACT READS ARE A UNION SWEEP, never one pass. GET /contacts paginates
 * over a non-deterministic sort and a single pass has been measured to miss
 * ~5%. The residual gap against meta.totalItems is reported, not hidden.
 *
 * TWO BELTS AGAINST A DOUBLE SEND: the ledger (sent[assetId][contactId]) and
 * Resend's idempotency key. Sends go through /emails/batch in chunks of up to
 * 100 (2026-09-21), so the key is per CHUNK, chunkKey(): the slot plus a hash
 * of the chunk's contact ids. The ledger is the durable one; Resend keeps keys
 * for 24 hours. NEWSLETTER_NONCE changes the key AND the ledger slot for a
 * deliberate re-send of an issue.
 *
 * SUBJECT = asset title, PREVIEW TEXT = asset description (decided 2026-09-07).
 * stripFrontMatter() removes Subject / Preview text lines an author left at
 * the top of the body, and the summary says what it removed.
 *
 * UNSUBSCRIBE: every send carries a link to NEWSLETTER_UNSUB_BASE/unsubscribe
 * with the contact id and hmac_sha256(NEWSLETTER_UNSUB_SECRET, contactId) first
 * 32 hex, plus RFC 8058 one-click headers. The company site must verify the
 * same formula and tag the contact Unsubscribed. The formula is pinned by
 * its test upstream here, and should be pinned by the site's own test too;
 * change one, change both.
 *
 * Env:
 *   NOAN_PERSONAL_API_KEY / NOAN_AGENT_API_KEY   required
 *   RESEND_API_KEY, MAIL_FROM                    required for test/live/poll
 *   NEWSLETTER_UNSUB_SECRET                      required for test/live/poll (>= 16 chars)
 *   NEWSLETTER_MODE             dry-run | test | live | poll                 default dry-run
 *   NEWSLETTER_ASSET            asset id (either form), or exact title       dispatch modes
 *   NEWSLETTER_AUDIENCE_TAG     contact tag name                             dispatch modes
 *   NEWSLETTER_TEST_RECIPIENT   where test sends go                          required for test/poll, no default
 *   NEWSLETTER_NONCE            re-send escape hatch (see above)
 *   NEWSLETTER_EXCLUDE_TAGS     comma list, config.defaults.env
 *   NEWSLETTER_MAX_RECIPIENTS   live refuses above this                      default 1000
 *   NEWSLETTER_TEST_WINDOW_DAYS live requires a test send this recent        default 7
 *   NEWSLETTER_SEND_SPACING_MS  gap between batch requests (Resend: 2 req/s) default 600
 *   NEWSLETTER_BATCH_SIZE       recipients per /emails/batch request         default 100 (the max)
 *   NEWSLETTER_UNSUB_BASE       REQUIRED for test/live/poll, no default — the origin
 *                               unsubscribe links point at
 *   NEWSLETTER_REPORT_TO        reports and refusals go here                 no default; unset means no report
 *   NEWSLETTER_SUMMARY_OUT      path: markdown summary (job summary)
 *   NEWSLETTER_HTML_OUT         path: rendered HTML (job artifact)
 *   DRY_RUN=1                   poll mode: decide and log, send and write nothing
 */

import { createHash, createHmac } from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { noanGet, noanGetAll, noanPost, noanPatch, allTasksOnce, findTagId, findContactByEmail, postNote, assertNoanKey, parkForHuman } from "../shared/noan.mjs";
import { buildDetails, appendRun, runLine, runUrl } from "./task-run-lines.mjs";
import { verdictFromComments, approvalBindingsOk } from "./newsletter-approval.mjs";
import { defaultCommanders, normalizeComments } from "../shared/task-comments.mjs";
import { sendEmail, sendBatch, BATCH_MAX } from "../shared/resend.mjs";
import { loadLocalState, saveLocalState } from "../shared/state-local.mjs";
import { renderNewsletterHtml, parseIssue, blocksToText, stripCaptureLines, SLACK_TOKEN } from "../shared/newsletter-email.mjs";
import { setUsageContext } from "../shared/usage-log.mjs";
import { dimsFromUrl } from "../shared/newsletter-images.mjs";
import { agentName } from "../shared/required-env.mjs";

export const STATE_NAME = "newsletter";
export const ISSUE_TAG = "Newsletter";
export const UNSUBSCRIBED_TAG = "Unsubscribed";
/** Asset control tags for the poll trigger. Neither is ever an audience. */
export const CONTROL_TAGS = { test: "Test", send: "Send" };
const PAGE_SIZES = [100, 75, 50, 25];
// Same pattern network-integrity uses to spot test/placeholder contacts.
export const TEST_PATTERN = /\+(test|new|trial|ball)|(^|[^a-z])(test|placeholder)([^a-z]|$)/i;
const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MODES = new Set(["dry-run", "test", "live", "poll"]);
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const log = (...a) => console.log(...a);
const lower = s => String(s || "").trim().toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------- pure helpers (exported for its test upstream) ---------------- */

/** External copy rule: no em dashes. Same replacement the investor digest uses. */
export function sanitizeCopy(s) {
  return String(s ?? "").replace(/\s*[—–―]\s*/g, ", ");
}

/** Asset text arrives with a few HTML entities baked in (the changelog path does the same).
 *  `&amp;` is decoded LAST: first, it turned the text "&amp;lt;" (a literal "&lt;") into "<",
 *  decoding twice — the double-unescape CodeQL flags as js/double-escaping. */
export function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** The id that survives edits: originalId, else the uuid at the front of the list id. */
export function stableId(asset) {
  if (asset?.originalId) return asset.originalId;
  const m = UUID_RX.exec(asset?.id || "");
  return m ? m[0].toLowerCase() : String(asset?.id || "");
}

/** What a Test or Send ran against. A new version needs a new Test. */
export function versionOf(asset) {
  return asset?.activeVersion?.id || asset?.updatedAt || asset?.id || "";
}

/** hmac_sha256(secret, contactId), first 32 hex chars. Pinned across two repos. */
export function mintUnsubscribeToken(secret, contactId) {
  if (!secret || String(secret).length < 16) throw new Error("NEWSLETTER_UNSUB_SECRET missing or under 16 chars");
  return createHmac("sha256", String(secret)).update(String(contactId)).digest("hex").slice(0, 32);
}

export function unsubscribeUrl(base, contactId, token, { oneClick = false } = {}) {
  if (!base) throw new Error("NEWSLETTER_UNSUB_BASE is required — an unsubscribe link has no default origin");
  const root = String(base).replace(/\/+$/, "");
  const path = oneClick ? "/api/public/unsubscribe" : "/unsubscribe";
  return `${root}${path}?c=${encodeURIComponent(contactId)}&t=${encodeURIComponent(token)}`;
}

/** Turn a list asset into an issue: title, description, body with front matter removed. */
/**
 * Unfilled placeholders an author left behind.
 *
 * Every other guard here asks whether the issue is well formed; none asked
 * whether it was FINISHED. The 2026-09 issue went to its audience with the
 * literal text `\[calendar link\]` where its booking CTA belonged, having
 * passed the tag check, the length check and the em-dash sanitizer on the way
 * (caught in review 2026-09-15).
 *
 * Deliberately narrow, because the cost of a false positive is refusing a
 * finished issue:
 *   - bracketed text that is NOT a markdown link (no `(` after the `]`) and
 *     reads like a slot rather than an aside: "[calendar link]", "[insert
 *     date]", "[TODO]", "[your name]", "[xxx]". A real aside ("[sic]",
 *     "[2]", "[see below]") does not match.
 *   - handlebars/mustache leftovers: {{name}}, {{ first_name }}.
 * Markdown escapes are stripped first, since authors write \[ \] and the
 * renderer keeps them.
 */
export const PLACEHOLDER_WORD = /(?:^|[^a-z])(link|url|insert|todo|tbd|placeholder|name here|your \w+|date here|xxx+|tk|cta|calendar)(?:[^a-z]|$)/i;
export function findPlaceholders(body) {
  const text = String(body || "").replace(/\\([[\]{}])/g, "$1");
  const out = [];
  for (const m of text.matchAll(/\[([^\]\n]{1,60})\](?!\()/g)) {
    if (PLACEHOLDER_WORD.test(m[1])) out.push(`[${m[1]}]`);
  }
  for (const m of text.matchAll(/\{\{[^}\n]{1,60}\}\}/g)) out.push(m[0]);
  // A Slack mention or channel token (<@U123>, <#C123|general>) outside the
  // capture line, which issueFromAsset has already removed: the issue was lifted
  // from Slack and not finished, and a reader would see the raw token.
  for (const m of text.matchAll(SLACK_TOKEN)) out.push(m[0]);
  return [...new Set(out)];
}

export function issueFromAsset(hit) {
  const title = decodeEntities(hit.activeVersion?.title || "").trim();
  const description = decodeEntities(hit.activeVersion?.description || "").trim();
  const raw = decodeEntities(hit.activeVersion?.text || "").trim();
  if (!title) return { error: `asset ${stableId(hit)} has no title` };
  const front = stripFrontMatter(raw, title);
  // The Slack capture's provenance line is for the workspace, not the reader
  // (decided 2026-09-21): removed, and listed with the front matter.
  const capture = stripCaptureLines(front.body);
  const body = capture.body;
  const stripped = [...front.stripped, ...capture.removed];
  if (body.length < 40) return { error: `asset ${stableId(hit)} body is ${body.length} chars; refusing to send an empty issue` };
  const holes = findPlaceholders(body);
  if (holes.length) return { error: `the body still has ${holes.length} unfilled placeholder(s): ${holes.join(", ")}; fill them in before sending` };
  // What the heuristics did, for the summary a person reads before it goes live.
  const { promoted, buttons, images, inlineImages } = parseIssue(body, { promote: true });
  const bad = imageProblems(images, inlineImages, process.env.NEWSLETTER_IMAGE_BASE || "");
  if (bad.length) return { error: `the body has ${bad.length} image problem(s): ${bad.join("; ")}` };
  return { asset: hit, id: stableId(hit), version: versionOf(hit), title, description, body, stripped, promoted, buttons, images, dateLabel: dateLabelOf(hit) };
}

/*
 * What makes a picture unsendable, checked before anything goes out
 *. Every one of these reached the board as a broken
 * box before it was a rule: the one image an issue ever carried was a
 * `share.google` page link, which is not an image at all.
 *
 *   - it sits inside a sentence (an email cannot lay that out)
 *   - its description is missing, or still the words the upload reply suggested
 *   - it is not in the newsletter bucket, so nothing checked its size, type or
 *     metadata, and its host may be down when the email is opened
 *   - its name carries no size, so Outlook would draw it at its full width
 */
export const ALT_PLACEHOLDER = /^(|image|picture|photo|screenshot|alt|alt text|describe (the|this) (image|picture)( here)?)$/i;
export function imageProblems(images = [], inlineImages = [], base = "") {
  const out = [];
  for (const i of inlineImages) out.push(`the image ${i.url} is inside a sentence; put it on a line of its own`);
  for (const i of images) {
    if (ALT_PLACEHOLDER.test(i.alt.trim())) out.push(`the image ${i.url.split("/").pop()} has no description; write what the picture shows inside the [brackets]`);
    if (!base) out.push("NEWSLETTER_IMAGE_BASE is not set, so no image can be checked");
    else if (!i.url.startsWith(base)) out.push(`the image ${i.url} is not hosted for the newsletter`);
    else if (!dimsFromUrl(i.url)) out.push(`the image ${i.url.split("/").pop()} has no size in its name`);
  }
  return [...new Set(out)];
}

/** At send time: every image answers 200 with an image type. The host being up now is the least a reader needs. */
export async function unreachableImages(images = [], fetchImpl = fetch) {
  const out = [];
  for (const i of images) {
    try {
      const res = await fetchImpl(i.url, { method: "GET", signal: AbortSignal.timeout(15_000) });
      const type = res.headers.get("content-type") || "";
      if (!res.ok || !/^image\//.test(type)) out.push(`the image ${i.url.split("/").pop()} did not load (${res.status}${type ? `, ${type}` : ""})`);
      await res.arrayBuffer().catch(() => {});
    } catch (e) {
      out.push(`the image ${i.url.split("/").pop()} did not load (${e.message})`);
    }
  }
  return out;
}

/**
 * The eyebrow's month, from the VERSION being sent, not the clock: the same
 * recipient and version must render byte-identical on every run, which a
 * batch send's idempotency relies on. An issue
 * edited in late September and sent in October says September. en-US.
 */
export function dateLabelOf(asset) {
  const d = new Date(asset?.updatedAt || asset?.createdAt || Date.now());
  return (Number.isNaN(d.getTime()) ? new Date() : d).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Find the issue among Newsletter-tagged assets by id (either form) or exact title. */
export function resolveIssue(assets, needle) {
  const n = lower(needle);
  if (!n) return { error: "NEWSLETTER_ASSET is empty" };
  const byId = assets.find(a => lower(a.id) === n || lower(stableId(a)) === n || lower(a.originalId) === n);
  const byTitle = assets.filter(a => lower(decodeEntities(a.activeVersion?.title)) === n);
  const hit = byId || (byTitle.length === 1 ? byTitle[0] : null);
  if (!hit) {
    if (byTitle.length > 1) return { error: `${byTitle.length} Newsletter assets share the title "${needle}"; pass the asset id` };
    // Say what WAS readable: under a category key with no asset scope this list
    // is empty, and that is a different problem from a mistyped title.
    const seen = assets.slice(0, 5).map(a => `"${decodeEntities(a.activeVersion?.title || "(untitled)")}"`).join(", ");
    return { error: `no asset tagged ${ISSUE_TAG} matches "${needle}" (id or exact title); ${assets.length} ${ISSUE_TAG} asset(s) readable with this key${assets.length ? `, newest: ${seen}` : ""}` };
  }
  return issueFromAsset(hit);
}

/**
 * The subject is the asset TITLE and the preview text is the asset DESCRIPTION
 * (decided 2026-09-07). Issues drafted before that rule carry their own
 * "Subject:" / "Preview text:" lines and a "---" rule at the top of the body,
 * and some open with a "# Title" that repeats the asset title. None of that
 * belongs in the email, so it is removed here rather than by hand, and the
 * summary says what was taken out.
 */
export function stripFrontMatter(text, title = "") {
  const lines = String(text ?? "").split(/\r?\n/);
  const stripped = [];
  let i = 0;
  // Authors write these bolded far more often than bare, and the bare-only
  // pattern silently passed `**Subject:** "..."` straight into the body as the
  // reader's first line (the live 2026-09 issue, caught in review). Leading
  // emphasis, heading and quote markers are skipped, and the colon may sit
  // inside or outside the emphasis: `**Subject:**`, `**Subject**:`, `## Subject:`.
  const FM = /^\s*[#>*_\s]*(subject|preview text|pre-?header)\s*[*_]*\s*:/i;
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) { i += 1; continue; }
    if (FM.test(l)) { stripped.push(l.trim()); i += 1; continue; }
    if (/^\s*-{3,}\s*$/.test(l) && stripped.length) { i += 1; continue; }
    if (/^\s*#\s+/.test(l) && lower(l.replace(/^\s*#\s+/, "")) === lower(title)) { stripped.push(l.trim()); i += 1; continue; }
    break;
  }
  return { body: lines.slice(i).join("\n").trim(), stripped };
}

/**
 * The audience: everyone carrying the tag, minus the hard stops.
 * Returns the recipients and a count of every exclusion by reason, so the
 * summary can show exactly who was subtracted and why.
 */
export function selectAudience(contacts, { tagName, excludeTags = [] }) {
  const want = lower(tagName);
  const stops = new Set(excludeTags.map(lower).filter(Boolean));
  const excluded = { byTag: {}, noEmail: 0, badEmail: 0, testAddress: 0, duplicateEmail: 0 };
  const seen = new Set();
  const recipients = [];
  let tagged = 0;
  for (const c of contacts) {
    const tags = (c.tags || []).map(t => lower(t.name));
    if (!tags.includes(want)) continue;
    tagged += 1;
    const stop = tags.find(t => stops.has(t));
    if (stop) { excluded.byTag[stop] = (excluded.byTag[stop] || 0) + 1; continue; }
    const email = lower(c.email);
    if (!email) { excluded.noEmail += 1; continue; }
    if (!EMAIL_RX.test(email)) { excluded.badEmail += 1; continue; }
    if (TEST_PATTERN.test(email) || TEST_PATTERN.test(c.name || "")) { excluded.testAddress += 1; continue; }
    if (seen.has(email)) { excluded.duplicateEmail += 1; continue; }
    seen.add(email);
    recipients.push({ id: c.id, name: c.name || "", email });
  }
  recipients.sort((a, b) => a.email.localeCompare(b.email));
  return { tagged, recipients, excluded };
}

/** How many contacts carry each tag, keyed by lower-cased tag name. */
export function contactTagCounts(contacts) {
  const counts = new Map();
  for (const c of contacts) for (const t of c.tags || []) {
    const k = lower(t.name);
    if (k) counts.set(k, (counts.get(k) || 0) + 1);
  }
  return counts;
}

/**
 * Poll trigger: which of the asset's own tags is the audience. Of the tags
 * that are not control tags, exactly one must be carried by at least one
 * contact. None or several is a refusal with a reason a person can act on.
 */
export function audienceFromAsset(asset, counts, { controlTags = [ISSUE_TAG, CONTROL_TAGS.test, CONTROL_TAGS.send] } = {}) {
  const control = new Set(controlTags.map(lower));
  const names = (asset.tags || []).map(t => t?.name).filter(n => n && !control.has(lower(n)));
  const candidates = names.filter(n => (counts.get(lower(n)) || 0) > 0);
  if (candidates.length === 1) return { tag: candidates[0], count: counts.get(lower(candidates[0])) };
  if (!candidates.length) {
    return { error: `no audience: ${names.length ? `none of the asset's other tags (${names.join(", ")}) is carried by any contact` : "the asset carries no tag besides Newsletter and the control tags"}. Add the audience tag (Subscriber, say) to the asset.` };
  }
  return { error: `ambiguous audience: ${candidates.join(", ")} are all carried by contacts. Keep exactly one audience tag on the asset.` };
}

/** Poll trigger: what an asset's control tags ask for, minus what the ledger says already ran on this version. */
export function pollPlan(asset, state) {
  const tags = new Set((asset.tags || []).map(t => lower(t?.name)));
  const id = stableId(asset);
  const version = versionOf(asset);
  const actions = [];
  if (tags.has(lower(CONTROL_TAGS.test)) && state?.tested?.[id]?.version !== version) actions.push("test");
  // Two ways in, one outcome: the Send TAG a person
  // applies in NOAN, or a commander's approval on the issue's task. The tag
  // stays because it works; the approval exists because no agent can ever
  // write that tag (POST /assets takes tagIds on CREATE only).
  // A DECLINE is recorded on the same key and carries the same version, so
  // "there is an approval record for this version" is not the test - it would
  // arm a send the moment a commander said no. The record must be an approval.
  const approval = state?.approved?.[id];
  const approved = Boolean(approval && !approval.declined && approval.version === version);
  const armed = tags.has(lower(CONTROL_TAGS.send)) || approved;
  if (armed && state?.live?.[id]?.version !== version) actions.push("send");
  return { id, version, actions };
}

/**
 * Can this plan's outcome be known WITHOUT the contact sweep, and has it
 * already been reported?
 *
 * The sweep is ~50 s of pagination over ~790 contacts. poll() runs it as soon
 * as any asset has work, but a send-only plan whose test gate already fails is
 * decided by the ledger alone: liveGate checks `tested` before it ever looks at
 * the audience. An asset left tagged `Send` therefore cost a full sweep every
 * hour, forever, to re-derive a refusal that was already parked and already
 * emailed (measured 2026-09-14: the step went from 2-3 s idle to 50-68 s the
 * moment an asset was tagged, and stayed there five days).
 *
 * `recipients: 1` is a probe, not a count: it holds liveGate's two
 * audience-dependent checks (empty audience, over the cap) clear, so a `false`
 * here can only have come from the test checks above them. A plan blocked ONLY
 * by its audience still sweeps, because deciding that needs the contacts.
 */
export function decidedBeforeSweep(plan, state, { testWindowDays = 7, now = Date.now() } = {}) {
  if (plan?.actions?.length !== 1 || plan.actions[0] !== "send") return false;
  const gate = liveGate(state, plan.id, { version: plan.version, testWindowDays, recipients: 1, now });
  if (gate.ok) return false;
  const prev = state?.parked?.[plan.id];
  return Boolean(prev && prev.version === plan.version && prev.reason === `Live send refused: ${gate.reason}`);
}

/** May a live send proceed? The test gate is the one that stops the mistake that matters. */
export function liveGate(state, assetId, { version = null, testWindowDays = 7, maxRecipients = 1000, recipients = 0, now = Date.now() } = {}) {
  const tested = state?.tested?.[assetId];
  if (!tested?.at) return { ok: false, reason: `no test send of this issue on record; run a test first and read it in an inbox` };
  if (version && tested.version && tested.version !== version) return { ok: false, reason: `the issue was edited after its last test send (version ${String(tested.version).slice(0, 8)} was tested, ${String(version).slice(0, 8)} is live); test it again` };
  if (version && !tested.version) return { ok: false, reason: `the last test send predates version tracking; test it again` };
  const age = (now - Date.parse(tested.at)) / 86400_000;
  if (!(age <= testWindowDays)) return { ok: false, reason: `last test send was ${age.toFixed(1)} days ago, over the ${testWindowDays}-day window; test it again` };
  if (recipients > maxRecipients) return { ok: false, reason: `${recipients} recipients is over NEWSLETTER_MAX_RECIPIENTS=${maxRecipients}; raise the cap deliberately or narrow the tag` };
  if (recipients === 0) return { ok: false, reason: "audience is empty after exclusions" };
  return { ok: true };
}

/**
 * The board task for an asset that could not be sent. ONE per asset, not one
 * per refusal: a second refusal while it is open appends a dated run line
 * (the CI alert's appendRun upstream), so an asset left tagged reads as "Failed N times
 * since ..." rather than N tasks.
 *
 * Keyed on the STABLE asset id, so editing the issue (which mints a new
 * version and a new list id) lands on the same task the author is already
 * looking at.
 */
/**
 * What the person should actually DO, per refusal reason.
 *
 * The point of putting a refusal on the board is that the card names the next
 * action; "live send refused" on its own is the state the author was already
 * in. Every branch here says which TAG to move, because tags are the only
 * control surface an author has (the API cannot write tags onto an asset, so
 * the worker can never do it for them).
 */
export function fixFor(reason) {
  const r = String(reason || "");
  const test = `Add the \`${CONTROL_TAGS.test}\` tag to the asset. The next poll sends a proof copy to the test inbox; once that has been read, the \`${CONTROL_TAGS.send}\` tag goes live on the poll after it. Nothing sends until the proof has been made.`;
  if (/no test send of this issue on record/.test(r)) return test;
  if (/edited after its last test send/.test(r)) return `The issue changed since its last proof, so the proof no longer matches what would go out. ${test}`;
  if (/predates version tracking|over the .* window/.test(r)) return `The last proof is too old to stand. ${test}`;
  if (/over NEWSLETTER_MAX_RECIPIENTS/.test(r)) return `Narrow the audience tag, or raise NEWSLETTER_MAX_RECIPIENTS in config.defaults.env deliberately. The cap refuses rather than trimming, so nobody gets a partial send.`;
  if (/audience is empty after exclusions/.test(r)) return `Everyone carrying the tag was excluded (Unsubscribed, a no-bulk-mail tag, no or bad email, or a duplicate inbox). Check the audience tag is the one you meant.`;
  if (/^no audience:/.test(r)) return `Add the audience tag to the asset — the tag whose contacts should receive it (Subscriber, say). Exactly one of the asset's non-control tags must be carried by at least one contact.`;
  if (/^ambiguous audience:/.test(r)) return `Remove audience tags until exactly one remains. The worker refuses rather than guessing which segment you meant.`;
  if (/unfilled placeholder/.test(r)) return `Replace the bracketed placeholders the reason names with real values (a Slack token such as <@U...> means the text was lifted from Slack: write the person's name instead), then the next poll picks the asset up. If a placeholder is a booking link, read it from the NOAN fact that records it (a Call Booking Details block, say) rather than pasting from an old email.`;
  if (/image problem/.test(r)) return `Drop the picture in Slack to ${agentName()} with the words "host this for the newsletter", paste the line she replies with on a line of its own where the picture goes, and write what the picture shows inside the [brackets]. A picture from anywhere else (a Google Drive or share link, the website) is refused, because nothing has checked it will load when the email is opened.`;
  if (/refusing to send an empty issue|has no title/.test(r)) return `Fix the asset itself: it needs a title and a body of at least 40 characters. The subject comes from the title and the preview text from the description.`;
  return `Fix what the reason above names, then the next poll picks the asset up. The control tags stay on it either way — the API cannot remove them.`;
}

export function refusalTaskExternalId(assetId) {
  return `newsletter:${assetId}`;
}

/**
 * The test inbox list. Comma separated, deduped, lower-cased, order kept.
 *
 * One address until 2026-09-15, when two more reviewers joined it: a proof
 * copy is the only gate before a live send, and one pair of eyes is a thin
 * gate for the one send in the fleet that reaches the whole list at once.
 */
export function parseRecipients(raw) {
  const seen = new Set();
  const out = [];
  for (const part of String(raw || "").split(",")) {
    const e = lower(part);
    if (!e || seen.has(e)) continue;
    seen.add(e);
    out.push(e);
  }
  return out;
}

export function ledgerSlot(assetId, nonce) {
  return nonce ? `${assetId}:${nonce}` : assetId;
}

/**
 * THE BATCH'S IDEMPOTENCY KEY. Resend's key covers
 * one REQUEST, and a request is now up to 100 recipients, so the per-contact key
 * `newsletter:<asset>:<contact>` became a key per chunk, derived from exactly who
 * is in it: the ledger slot (asset, plus nonce) and a hash of the sorted contact
 * ids.
 *
 * The case it exists for: Resend accepted a chunk and the run died before the
 * ledger write. The re-run skips everyone the ledger holds, so the pending list
 * and therefore the chunk are the same, the payload is byte-identical (the date
 * label comes from the version, not the clock), and Resend replays the original
 * response instead of sending again. Any other re-run is covered by the ledger,
 * which stays the durable belt; Resend keeps keys for 24 hours.
 */
export function chunkKey(slot, contactIds) {
  const digest = createHash("sha256").update([...contactIds].sort().join(",")).digest("hex").slice(0, 16);
  return `newsletter:${slot}:b:${digest}`;
}

/** Recipients the ledger has not seen, in chunks of at most `size` (and the endpoint's 100). */
export function planChunks(recipients, sentForSlot = {}, size = BATCH_MAX) {
  const n = Math.max(1, Math.min(BATCH_MAX, Math.floor(size) || BATCH_MAX));
  const pending = recipients.filter(r => !sentForSlot[r.id]);
  const chunks = [];
  for (let i = 0; i < pending.length; i += n) chunks.push(pending.slice(i, i + n));
  return { chunks, skipped: recipients.length - pending.length };
}

/** Resend tags on every newsletter email: what a delivery event is about (plan §2.1). */
export function mailTags(assetId, contactId) {
  const t = [{ name: "stream", value: "newsletter" }, { name: "issue", value: String(assetId) }];
  if (contactId) t.push({ name: "contact", value: String(contactId) });
  return t.map(x => ({ name: x.name, value: x.value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) }));
}

export function renderSummary({ mode, issue, tag, audience, reportedTotal, sweptTotal, gate, results }) {
  const L = [];
  L.push(`## Newsletter ${mode}`);
  L.push("");
  L.push(`**Subject:** ${issue.title} (asset ${issue.id}, ${issue.body.length} chars)`);
  L.push(`**Preview text:** ${issue.description || "(asset has no description; the inbox will preview the first body line)"}`);
  if (issue.stripped?.length) L.push(`**Removed from the body:** ${issue.stripped.map(s => `\`${s.slice(0, 60)}\``).join(", ")} (subject and preview come from the asset's title and description; a Slack capture line is for the workspace, not the reader)`);
  if (issue.promoted?.length) L.push(`**Made into subheadings:** ${issue.promoted.map(s => `\`${s.slice(0, 70)}\``).join(", ")} (write \`## Heading\` to set one explicitly)`);
  if (issue.buttons?.length) L.push(`**Buttons:** ${issue.buttons.map(s => `\`${s}\``).join(", ")}`);
  if (issue.images?.length) L.push(`**Images:** ${issue.images.map(i => `\`${i.alt.slice(0, 60)}\` (${(dimsFromUrl(i.url) || {}).width || "?"}px)`).join(", ")}`);
  L.push(`**Audience tag:** ${tag}`);
  L.push("");
  L.push(`| | count |`);
  L.push(`|---|---|`);
  L.push(`| contacts swept | ${sweptTotal}${reportedTotal ? ` of ${reportedTotal} NOAN reports` : ""} |`);
  L.push(`| carrying the tag | ${audience.tagged} |`);
  for (const [t, n] of Object.entries(audience.excluded.byTag)) L.push(`| excluded: tagged ${t} | ${n} |`);
  if (audience.excluded.noEmail) L.push(`| excluded: no email | ${audience.excluded.noEmail} |`);
  if (audience.excluded.badEmail) L.push(`| excluded: malformed email | ${audience.excluded.badEmail} |`);
  if (audience.excluded.testAddress) L.push(`| excluded: test/placeholder address | ${audience.excluded.testAddress} |`);
  if (audience.excluded.duplicateEmail) L.push(`| excluded: duplicate email | ${audience.excluded.duplicateEmail} |`);
  L.push(`| **recipients** | **${audience.recipients.length}** |`);
  if (reportedTotal && sweptTotal < reportedTotal) {
    L.push("");
    L.push(`Sweep gap: ${reportedTotal - sweptTotal} contact(s) NOAN reports but the union sweep did not return. GET /contacts pagination is lossy; anyone in that slice was not mailed.`);
  }
  if (gate && !gate.ok) { L.push(""); L.push(`**Live send refused:** ${gate.reason}`); }
  if (results) {
    L.push("");
    L.push(`| result | count |`);
    L.push(`|---|---|`);
    L.push(`| sent | ${results.sent} |`);
    L.push(`| already sent (ledger) | ${results.skipped} |`);
    if (results.batches != null) L.push(`| batch requests | ${results.batches} |`);
    L.push(`| failed | ${results.failed} |`);
    if (results.failures?.length) {
      L.push("");
      for (const f of results.failures.slice(0, 20)) L.push(`- ${f.email}: ${f.error}`);
    }
  }
  if (audience.recipients.length) {
    L.push("");
    L.push(`First ${Math.min(10, audience.recipients.length)}: ${audience.recipients.slice(0, 10).map(r => `${r.name || "(no name)"} <${r.email}>`).join(", ")}`);
  }
  return L.join("\n");
}

/* ---------------- config + reads ---------------- */

function readConfig() {
  const mode = process.env.NEWSLETTER_MODE || "dry-run";
  if (!MODES.has(mode)) throw new Error(`NEWSLETTER_MODE must be dry-run | test | live | poll, got "${mode}"`);
  const excludeTags = (process.env.NEWSLETTER_EXCLUDE_TAGS || UNSUBSCRIBED_TAG).split(",").map(s => s.trim()).filter(Boolean);
  if (!excludeTags.map(lower).includes(lower(UNSUBSCRIBED_TAG))) excludeTags.push(UNSUBSCRIBED_TAG);
  return {
    mode,
    excludeTags,
    maxRecipients: parseInt(process.env.NEWSLETTER_MAX_RECIPIENTS || "1000", 10),
    testWindowDays: parseFloat(process.env.NEWSLETTER_TEST_WINDOW_DAYS || "7"),
    approvalDriftPct: parseFloat(process.env.NEWSLETTER_APPROVAL_DRIFT_PCT || "10"),
    spacing: parseInt(process.env.NEWSLETTER_SEND_SPACING_MS || "600", 10),
    batchSize: parseInt(process.env.NEWSLETTER_BATCH_SIZE || String(BATCH_MAX), 10),
    base: process.env.NEWSLETTER_UNSUB_BASE || "",
    secret: process.env.NEWSLETTER_UNSUB_SECRET || "",
    testRecipients: parseRecipients(process.env.NEWSLETTER_TEST_RECIPIENT),
    reportTo: process.env.NEWSLETTER_REPORT_TO || "",
    dryRun: process.env.DRY_RUN === "1",
  };
}

export function requireSendEnv(cfg, mode) {
  for (const n of ["RESEND_API_KEY", "MAIL_FROM"]) if (!process.env[n]) throw new Error(`${n} is required for mode=${mode}`);
  // NEWSLETTER_UNSUB_BASE lost its default when fleet addresses came out of the
  // code. It is a URL rather than an address, so it is not in that class — but an
  // unset one yields a malformed unsubscribe link, and a bulk send with a broken
  // unsubscribe is a compliance problem, not a cosmetic one. Loud before the first
  // send beats silent across the whole list.
  if (!cfg.base) throw new Error(`NEWSLETTER_UNSUB_BASE is required for mode=${mode} — every send carries an unsubscribe link and it has no default`);
  // The same no-default rule seen from the other end: NEWSLETTER_TEST_RECIPIENT has no
  // default either, and an unset one reaches Resend as an empty `to` — an opaque
  // API error rather than a message naming the missing key. Required in the two
  // modes that can test-send. poll is included because the live gate makes a test
  // the only route to a live send, so a polling fleet always needs one, and the
  // tag trigger has no way to name a recipient per issue. mode=live is exempt:
  // its test send already happened.
  if ((mode === "test" || mode === "poll") && !cfg.testRecipients.length) {
    throw new Error(`NEWSLETTER_TEST_RECIPIENT is required for mode=${mode} — a test send has nowhere to go and it has no default`);
  }
  mintUnsubscribeToken(cfg.secret, "probe");   // throws with the right message if the secret is unusable
}

async function unionSweepContacts() {
  const byId = new Map();
  let reportedTotal = 0;
  for (const perPage of PAGE_SIZES) {
    for (let page = 1; page <= 60; page++) {
      const res = await noanGet(`/contacts?page=${page}&per_page=${perPage}`);
      reportedTotal = res?.meta?.totalItems ?? reportedTotal;
      for (const c of res?.items || []) byId.set(c.id, c);
      if (!res?.meta?.hasNext) break;
    }
    if (reportedTotal && byId.size >= reportedTotal) break;
  }
  return { contacts: [...byId.values()], reportedTotal };
}

async function fetchNewsletterAssets() {
  const tagId = await findTagId(ISSUE_TAG);
  if (!tagId) throw new Error(`tag "${ISSUE_TAG}" not found in NOAN`);
  return noanGetAll(`/assets?tag_id=${encodeURIComponent(tagId)}&sort=createdAt&order=desc&per_page=100`);
}

function writeOutputs(summary, html) {
  if (process.env.NEWSLETTER_SUMMARY_OUT) fs.writeFileSync(process.env.NEWSLETTER_SUMMARY_OUT, summary);
  if (process.env.NEWSLETTER_HTML_OUT) fs.writeFileSync(process.env.NEWSLETTER_HTML_OUT, html);
}

/* ---------------- sends ---------------- */

function buildMail({ issue, contactId, secret, base }) {
  const token = contactId ? mintUnsubscribeToken(secret, contactId) : null;
  const link = contactId ? unsubscribeUrl(base, contactId, token) : `${String(base).replace(/\/+$/, "")}/unsubscribe`;
  const oneClick = contactId ? unsubscribeUrl(base, contactId, token, { oneClick: true }) : null;
  const subject = sanitizeCopy(issue.title);
  const bodyMd = sanitizeCopy(issue.body);
  const preheader = sanitizeCopy(issue.description || "");
  const dateLabel = issue.dateLabel || "";
  // Subject from the asset TITLE, display headline from its DESCRIPTION
  // (decided 2026-09-15). An asset with no description keeps the title as its
  // headline rather than opening on a blank line.
  const html = renderNewsletterHtml({ title: subject, headline: preheader || subject, markdown: bodyMd, unsubscribeUrl: link, preheader, dateLabel, promote: true });
  // The text part from the same parse as the HTML, so it reads as text: no
  // `**`, no `##`, links as "label (url)".
  const text = `${preheader || subject}\n\n${blocksToText(parseIssue(bodyMd, { promote: true }).blocks)}\n\n--\nUnsubscribe: ${link}`;
  const headers = oneClick
    ? { "List-Unsubscribe": `<${oneClick}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
    : undefined;
  return { subject, html, text, headers };
}

async function sendWithRetry(args) {
  try { return await sendEmail(args); }
  catch (e) {
    if (e?.status === 429) { await sleep(2500); return sendEmail(args); }
    throw e;
  }
}

/** One batch, retried once on a 429. The retry reuses the key and the payload. */
async function sendBatchWithRetry(emails, opts) {
  try { return await sendBatch(emails, opts); }
  catch (e) {
    if (e?.status === 429) { await sleep(2500); return sendBatch(emails, opts); }
    throw e;
  }
}

/** A short internal mail to NEWSLETTER_REPORT_TO. Never to a contact. */
/**
 * A refusal goes on the board, not only into an inbox.
 *
 * The fleet settled this in its CI alert path in 2026-09: an
 * email is an event and a task is a state, and "a human needs to do something"
 * lives on the board, where the weekly board sweep can find it if nobody acts.
 * The newsletter missed that change because a refusal is not a FAILURE — the
 * worker returns cleanly and the step is green, so the workflow's
 * `Alert on failure` step never fires. Its `parked` ledger was a private,
 * unread copy of `needs-human` (2026-09-09 → 09-14: an asset refused on ~120
 * consecutive polls, reported once, and nothing anywhere knew it was stuck).
 *
 * Never throws: a board that is down must not stop the poll reporting by mail.
 */
async function fileRefusalTask(cfg, { assetId, title, reason, fix }) {
  const ext = refusalTaskExternalId(assetId);
  const taskTitle = `[Newsletter] not sent: ${title}`.slice(0, 200);
  const line = runLine("refused", runUrl());
  const assignees = String(process.env.NEWSLETTER_ASSIGNEES || "").split(",").map(x => x.trim()).filter(Boolean);
  try {
    const open = (await allTasksOnce()).find(t => t.externalId === ext && !t.completed && t.status !== "done");
    if (open) {
      await noanPatch(`/tasks/${open.id}`, { details: appendRun(open.details, line) });
      // unassign:false — the owner stays on it and the agent is not on it to drop.
      await parkForHuman(open, { lane: "eng", agent: "newsletter", assignees, reason, unassign: false, status: null, log });
      log(`  board: appended this run to open task ${open.id}`);
      return open.id;
    }
    const created = await noanPost("/tasks", {
      title: taskTitle,
      details: buildDetails({ what: reason, fix, line }),
      status: "backlog",          // a park is waiting on a human; never column-less
      externalId: ext,
    });
    const id = created?.task?.id || created?.id;   // creates nest under the resource name
    if (!id) throw new Error("task creation returned no id");
    const parked = await parkForHuman({ id, tags: [], assignees: [] }, { lane: "eng", agent: "newsletter", assignees, reason, status: null, log });
    log(`  board: filed task ${id}${parked.assigned.length ? ` → ${parked.assigned.length} assignee(s) (${parked.source})` : " (UNASSIGNED)"}`);
    return id;
  } catch (e) {
    log(`  warn: could not file the refusal task: ${e.message}`);
    return null;
  }
}

/**
 * The issue has been proofed; now a commander can say yes without opening
 * NOAN. Same task as a refusal would file - ONE per asset,
 * externalId newsletter:<stableId> - so an issue that was refused and then
 * fixed carries its whole history on one card rather than two.
 *
 * The card has to quote the audience, the count and the version, because those
 * are exactly what the approval is checked against later. A card that said
 * only "ready" would be asking for a yes to something unstated.
 *
 * Never throws: an issue that was proofed but whose card failed to file is
 * still armable with the Send tag, and the summary says so.
 */
async function fileReadyTask(cfg, { assetId, title, tag, count, version }) {
  const ext = refusalTaskExternalId(assetId);
  const taskTitle = `[Newsletter] ready to send: ${title}`.slice(0, 200);
  const line = runLine("proofed", runUrl());
  const what = `"${title}" was test-sent to ${cfg.testRecipients.join(", ")} and is ready to go live to "${tag}" (${count} recipients, version ${String(version).slice(0, 8)}).`;
  const fix = `Read the proof in your inbox. To send it, comment \`approve\` on this task (or \`send it\` / \`go ahead\`) - commanders only, and the word must START the comment. To stop it, comment \`no\` or \`hold\`. Applying the \`${CONTROL_TAGS.send}\` tag in NOAN still works too. An edit to the issue voids this: it needs a fresh test.`;
  const assignees = String(process.env.NEWSLETTER_ASSIGNEES || "").split(",").map(x => x.trim()).filter(Boolean);
  try {
    const open = (await allTasksOnce()).find(t => t.externalId === ext && !t.completed && t.status !== "done");
    if (open) {
      await noanPatch(`/tasks/${open.id}`, { title: taskTitle, details: appendRun(open.details, line) });
      await parkForHuman(open, { lane: "eng", agent: "newsletter", assignees, reason: what, unassign: false, status: null, log });
      log(`  board: task ${open.id} is now ready-to-send`);
      return open.id;
    }
    const created = await noanPost("/tasks", { title: taskTitle, details: buildDetails({ what, fix, line }), status: "backlog", externalId: ext });
    const id = created?.task?.id || created?.id;
    if (!id) throw new Error("task creation returned no id");
    const parked = await parkForHuman({ id, tags: [], assignees: [] }, { lane: "eng", agent: "newsletter", assignees, reason: what, status: null, log });
    log(`  board: filed ready-to-send task ${id}${parked.assigned.length ? ` → ${parked.assigned.length} assignee(s)` : " (UNASSIGNED)"}`);
    return id;
  } catch (e) {
    log(`  warn: could not file the ready-to-send task: ${e.message}`);
    return null;
  }
}

/**
 * The loop closing. The issue this task was filed about has now gone out, so
 * the task is done — written as BOTH fields, because status and completed are
 * stored independently and neither implies the other (283 of 892 tasks drifted
 * that way before the 2026-08-28 repair).
 *
 * Never throws: the send already happened and the ledger already records it;
 * a board write failing here must not make a delivered issue look failed.
 */
async function closeRefusalTask(assetId) {
  const ext = refusalTaskExternalId(assetId);
  try {
    const open = (await allTasksOnce()).find(t => t.externalId === ext && !t.completed && t.status !== "done");
    if (!open) return null;
    await noanPatch(`/tasks/${open.id}`, { completed: true, status: "done" });
    log(`  board: closed refusal task ${open.id} — the issue went out`);
    return open.id;
  } catch (e) {
    log(`  warn: could not close the refusal task: ${e.message}`);
    return null;
  }
}

async function report(cfg, subject, markdown) {
  return sendWithRetry({
    to: cfg.reportTo,
    subject,
    html: renderNewsletterHtml({ title: subject, markdown, unsubscribeUrl: null }),
    text: markdown,
    cc: false,
    idempotencyKey: `newsletter-report:${Date.now()}`,
  }).catch(e => log(`  warn: report email failed: ${e.message}`));
}

/** Resolve the audience for one issue against the swept contacts. */
function audienceFor(cfg, sweep, tag) {
  const audience = selectAudience(sweep.contacts, { tagName: tag, excludeTags: cfg.excludeTags });
  log(`  ${audience.tagged} tagged "${tag}"; ${audience.recipients.length} recipients`);
  for (const [t, n] of Object.entries(audience.excluded.byTag)) log(`  excluded ${n} tagged "${t}"`);
  return audience;
}

/** Test send: the rendered issue to the test recipient. Records tested[id] with the version. */
async function runTest(cfg, state, issue, tag, sweep, { via }) {
  const audience = audienceFor(cfg, sweep, tag);
  const out = { mode: "test", issue, tag, audience, reportedTotal: sweep.reportedTotal, sweptTotal: sweep.contacts.length };

  // ONE SEND PER RECIPIENT, not one send addressed to several. The unsubscribe
  // link is hmac(secret, contactId), so a single mail to three people would
  // carry ONE person's token and whoever clicked it would unsubscribe someone
  // else. Per-recipient also makes the test a real rehearsal of the live loop
  // rather than a different code path.
  const mails = [];
  for (const email of cfg.testRecipients) {
    const contact = await findContactByEmail(email).catch(() => null);
    mails.push({ email, contact, mail: buildMail({ issue, contactId: contact?.id || null, secret: cfg.secret, base: cfg.base }) });
  }
  const preview = mails[0].mail;

  if (cfg.dryRun) {
    log(`  DRY_RUN: would test-send "${issue.title}" to ${cfg.testRecipients.join(", ")}`);
    return { summary: renderSummary(out), html: preview.html };
  }

  // One batch, one email per address, each with its own token (see above). A
  // test is proofed per run, so its key is per run too.
  const sent = [], failed = [];
  try {
    const res = await sendBatchWithRetry(mails.map(({ email, contact, mail }) => ({
      to: email, subject: `[TEST] ${mail.subject}`, html: mail.html, text: mail.text, headers: mail.headers,
      tags: mailTags(issue.id, contact?.id || null),
    })), { idempotencyKey: `newsletter-test:${issue.id}:${issue.version}:${Date.now()}` });
    res.forEach((r, i) => {
      const { email, contact } = mails[i];
      if (r.ok) { sent.push({ email, resendId: r.id, live: Boolean(contact) }); log(`  test sent to ${email} (Resend ${r.id || "?"})`); }
      else { failed.push({ email, error: r.error }); log(`  warn: test send to ${email} failed: ${r.error}`); }
    });
  } catch (e) {
    for (const { email } of mails) failed.push({ email, error: e.message });
    log(`  warn: test batch failed: ${e.message}`);
  }

  // Nothing proofed means no gate was satisfied: refuse rather than record a
  // test that never reached anyone.
  if (!sent.length) throw new Error(`test send failed for every recipient (${failed.map(f => `${f.email}: ${f.error}`).join("; ")})`);

  state.tested = state.tested || {};
  state.tested[issue.id] = {
    at: new Date().toISOString(),
    to: sent.map(x => x.email),
    version: issue.version,
    resendIds: sent.map(x => x.resendId),
    via,
    // What an approval on this test is an approval FOR. Recorded here rather
    // than parsed back out of the task's text.
    tag,
    count: audience.recipients.length,
  };
  saveLocalState(STATE_NAME, state);

  const taskId = await fileReadyTask(cfg, { assetId: issue.id, title: issue.title, tag, count: audience.recipients.length, version: issue.version });
  const lines = sent.map(x => `${x.email} (Resend ${x.resendId || "?"}${x.live ? "" : ", unsubscribe link has no token: not a NOAN contact"})`);
  const summary = renderSummary(out)
    + `\n\nTest send delivered to ${sent.length} inbox(es): ${lines.join("; ")}.`
    + (failed.length ? ` FAILED for ${failed.map(f => `${f.email} (${f.error})`).join("; ")}.` : "")
    + ` Each copy carries that recipient's own unsubscribe link. Live sends of this version are open for ${cfg.testWindowDays} days.`
    + (taskId
      ? ` To send it, comment \`approve\` on the NOAN task (commanders only, the word must start the comment), or apply the ${CONTROL_TAGS.send} tag.`
      : ` The board task could not be filed this run, so apply the ${CONTROL_TAGS.send} tag in NOAN to send it.`);
  return { summary, html: preview.html };
}

/**
 * The live send loop, in chunks through /emails/batch (plan §2.2): one request
 * per chunk of up to NEWSLETTER_BATCH_SIZE, NEWSLETTER_SEND_SPACING_MS apart
 * (Resend's 2 req/s counts a batch as one request), and `save()` after every
 * chunk so the ledger never trails Resend by more than one request.
 *
 * `sentForSlot` is the ledger's map for this slot and is written in place.
 * `send` and `wait` are injectable so its test can play
 * Resend, including a crash between Resend accepting and the ledger landing.
 */
export async function sendLiveChunks({ issue, slot, recipients, sentForSlot, cfg, save, send = sendBatchWithRetry, wait = sleep }) {
  const { chunks, skipped } = planChunks(recipients, sentForSlot, cfg.batchSize);
  const results = { sent: 0, skipped, failed: 0, failures: [], batches: 0 };
  let consecutiveFailures = 0;
  for (const chunk of chunks) {
    const key = chunkKey(slot, chunk.map(r => r.id));
    const emails = chunk.map(r => {
      const mail = buildMail({ issue, contactId: r.id, secret: cfg.secret, base: cfg.base });
      return { to: r.email, subject: mail.subject, html: mail.html, text: mail.text, headers: mail.headers, tags: mailTags(issue.id, r.id) };
    });
    const at = new Date().toISOString();
    let res;
    try {
      res = await send(emails, { idempotencyKey: key });
    } catch (e) {
      // 409 invalid_idempotent_request: this exact chunk's key was used with a
      // different payload inside Resend's 24 h window, so these recipients WERE
      // sent to by an earlier run whose ledger write never landed (and something
      // in the render changed since: config, not content, since the version is
      // pinned). Record them rather than risk a second copy.
      if (e?.status === 409 && e?.code === "invalid_idempotent_request") {
        for (const c of chunk) sentForSlot[c.id] = { at, email: c.email, resendId: null, via: "idempotent-replay" };
        save();
        results.sent += chunk.length;
        log(`  batch key ${key} already used: ${chunk.length} recorded as sent by an earlier run`);
        continue;
      }
      results.failed += chunk.length;
      for (const c of chunk) results.failures.push({ email: c.email, error: e.message });
      log(`  FAIL batch of ${chunk.length}: ${e.message}`);
      consecutiveFailures += 1;
      // A whole request failing twice running is configuration (key, sender,
      // domain) or an outage, not a bad address: permissive validation already
      // isolates a bad address inside a chunk.
      if (consecutiveFailures >= 2) {
        log("  two consecutive batch failures; this is configuration or an outage, not a bad address. Stopping.");
        break;
      }
      if (cfg.spacing) await wait(cfg.spacing);
      continue;
    }
    results.batches += 1;
    res.forEach((r, i) => {
      const c = chunk[i];
      if (r.ok) {
        sentForSlot[c.id] = { at, email: c.email, resendId: r.id || null };
        results.sent += 1;
      } else {
        // One address Resend would not take. The rest of the chunk went.
        results.failed += 1;
        results.failures.push({ email: c.email, error: r.error });
        log(`  FAIL ${c.email}: ${r.error}`);
      }
    });
    // OUTSIDE the try on purpose. Resend has accepted this chunk; if the ledger
    // cannot record it, the run must stop here and throw, never count the chunk
    // as failed and carry on. The next run rebuilds this same chunk with the
    // same key and bytes, and Resend replays it (pinned by its test).
    save();
    consecutiveFailures = 0;
    log(`  batch ${results.batches}/${chunks.length}: ${res.filter(r => r.ok).length} of ${chunk.length} accepted`);
    if (cfg.spacing) await wait(cfg.spacing);
  }
  return results;
}

/** Live send to the audience, gated, ledgered per contact, reported. Throws only on a refused gate when `strict`. */
async function runLive(cfg, state, issue, tag, sweep, { nonce = "", via, strict = true }) {
  const audience = audienceFor(cfg, sweep, tag);
  const out = { mode: "live", issue, tag, audience, reportedTotal: sweep.reportedTotal, sweptTotal: sweep.contacts.length };
  const preview = buildMail({ issue, contactId: null, secret: cfg.secret, base: cfg.base });
  const gate = liveGate(state, issue.id, { version: issue.version, testWindowDays: cfg.testWindowDays, maxRecipients: cfg.maxRecipients, recipients: audience.recipients.length });
  // The bindings an approval was given under, re-checked against what is
  // actually about to happen. Only when an approval
  // armed this send: a Send TAG applied by hand is its own authority and has
  // never been bound to a count.
  const approval = state?.approved?.[issue.id];
  if (gate.ok && approval && !approval.declined && approval.version === issue.version) {
    const bound = approvalBindingsOk(approval, {
      version: issue.version, tag, recipients: audience.recipients.length, driftPct: cfg.approvalDriftPct,
    });
    if (!bound.ok) {
      const summary = renderSummary({ ...out, gate: bound });
      log("\n" + summary);
      if (strict) throw new Error(`live send refused: ${bound.reason}`);
      return { refused: bound.reason, summary, html: preview.html };
    }
  }
  if (!gate.ok) {
    const summary = renderSummary({ ...out, gate });
    log("\n" + summary);
    if (strict) throw new Error(`live send refused: ${gate.reason}`);
    return { refused: gate.reason, summary, html: preview.html };
  }
  if (cfg.dryRun) { log(`  DRY_RUN: would send "${issue.title}" live to ${audience.recipients.length} contacts tagged ${tag}`); return { summary: renderSummary(out), html: preview.html }; }

  const slot = ledgerSlot(issue.id, nonce);
  state.sent = state.sent || {};
  state.sent[slot] = state.sent[slot] || {};
  const results = await sendLiveChunks({
    issue, slot, recipients: audience.recipients, sentForSlot: state.sent[slot], cfg,
    save: () => saveLocalState(STATE_NAME, state),
  });

  state.live = state.live || {};
  state.live[issue.id] = { at: new Date().toISOString(), version: issue.version, tag, slot, via, ...results, failures: undefined };
  state.issues = state.issues || [];
  state.issues.push({ assetId: issue.id, version: issue.version, slot, title: issue.title, tag, at: new Date().toISOString(), via, ...results, failures: undefined });
  saveLocalState(STATE_NAME, state);

  const summary = renderSummary({ ...out, results });
  log("\n" + summary);

  await postNote({
    title: `Newsletter sent: ${issue.title}`,
    content: summary,
    externalId: `newsletter:${slot}:${lower(tag)}`,
  }).catch(e => log(`  warn: NOAN note failed: ${e.message}`));

  // The loop closes here. Any refusal task filed for this asset was waiting on
  // exactly this, so it is done — whatever the reason it was parked for, and
  // whether the send came from a tag or the button.
  await closeRefusalTask(issue.id);

  await sendWithRetry({
    to: cfg.reportTo,
    subject: `[newsletter] "${issue.title}" to ${tag}: ${results.sent} sent, ${results.failed} failed`,
    html: renderNewsletterHtml({ title: "Newsletter send report", markdown: summary, unsubscribeUrl: null }),
    text: summary,
    cc: false,
    idempotencyKey: `newsletter-report:${slot}:${process.env.GITHUB_RUN_ID || Date.now()}`,
  }).catch(e => log(`  warn: report email failed: ${e.message}`));

  if (results.failed && !results.sent) throw new Error(`every send failed (${results.failed}); see failures above`);
  return { summary, html: preview.html, results };
}

/* ---------------- dispatch (the button) ---------------- */

async function dispatch(cfg) {
  const needle = process.env.NEWSLETTER_ASSET || "";
  const tag = (process.env.NEWSLETTER_AUDIENCE_TAG || "").trim();
  if (!needle || !tag) throw new Error("NEWSLETTER_ASSET and NEWSLETTER_AUDIENCE_TAG are required");
  const nonce = (process.env.NEWSLETTER_NONCE || "").trim();
  log(`Newsletter worker: mode=${cfg.mode} asset="${needle}" tag="${tag}"${nonce ? ` nonce=${nonce}` : ""}`);
  if (cfg.mode !== "dry-run") requireSendEnv(cfg, cfg.mode);

  // Tag must exist as a contact tag before the whole contact list is swept for it.
  if (!(await findTagId(tag))) throw new Error(`contact tag "${tag}" does not exist in NOAN`);

  const issue = resolveIssue(await fetchNewsletterAssets(), needle);
  if (issue.error) throw new Error(issue.error);
  const dead = await unreachableImages(issue.images);
  if (dead.length) throw new Error(`the body has ${dead.length} image problem(s): ${dead.join("; ")}`);
  log(`  issue: "${issue.title}" (${issue.id} v${String(issue.version).slice(0, 8)}, ${issue.body.length} chars)`);

  const sweep = await unionSweepContacts();
  log(`  swept ${sweep.contacts.length}${sweep.reportedTotal ? `/${sweep.reportedTotal}` : ""} contacts`);
  const state = loadLocalState(STATE_NAME, "sent");

  if (cfg.mode === "dry-run") {
    const audience = audienceFor(cfg, sweep, tag);
    const summary = renderSummary({ mode: "dry-run", issue, tag, audience, reportedTotal: sweep.reportedTotal, sweptTotal: sweep.contacts.length });
    const preview = buildMail({ issue, contactId: null, secret: "dry-run-preview-secret", base: cfg.base });
    writeOutputs(summary, preview.html);
    log("\n" + summary);
    log("\n  dry-run: nothing sent, nothing written.");
    return;
  }
  if (cfg.mode === "test") {
    const r = await runTest(cfg, state, issue, tag, sweep, { via: "dispatch" });
    writeOutputs(r.summary, r.html);
    log("\n" + r.summary);
    return;
  }
  const r = await runLive(cfg, state, issue, tag, sweep, { nonce, via: "dispatch", strict: true });
  writeOutputs(r.summary, r.html);
}

/* ---------------- poll (the tags) ---------------- */

/**
 * Which assets could plausibly be waiting on a yes right now.
 *
 * Pure, and the reason the board is not read on every poll. Reading approvals
 * means a full GET /tasks sweep, and this file's standing question is what a
 * step costs when it finds NOTHING. An asset only qualifies when it has been
 * proofed on its CURRENT version, has not gone live on it, is not already
 * approved, and does not carry the Send tag (which needs no approval). Most
 * polls that is nobody and the board is never touched.
 */
export function awaitingApproval(assets, state) {
  return assets.filter(a => {
    const id = stableId(a);
    const version = versionOf(a);
    const tags = new Set((a.tags || []).map(t => lower(t?.name)));
    if (tags.has(lower(CONTROL_TAGS.send))) return false;
    if (state?.tested?.[id]?.version !== version) return false;
    if (state?.live?.[id]?.version === version) return false;
    if (state?.approved?.[id]?.version === version) return false;
    return true;
  });
}

/**
 * Read commanders' verdicts off the issues' own tasks and record them.
 *
 * Writes state; returns what it found so the run can say so. Never throws: a
 * board that is unreachable means no approval was SEEN, which is the safe
 * direction - the issue simply does not send this poll.
 */
async function collectApprovals(cfg, assets, state) {
  const waiting = awaitingApproval(assets, state);
  if (!waiting.length) return [];
  const commanders = defaultCommanders();
  if (!commanders.size) {
    log("  approvals: COMMANDERS is empty, so nobody can approve — set it in config.defaults.env");
    return [];
  }
  let tasks;
  try { tasks = await allTasksOnce(); }
  catch (e) { log(`  warn: could not read the board for approvals: ${e.message}`); return []; }

  const found = [];
  for (const a of waiting) {
    const id = stableId(a);
    const version = versionOf(a);
    const task = tasks.find(t => t.externalId === refusalTaskExternalId(id));
    if (!task) continue;
    // normalizeComments resolves the creator and marks the agent's own, so its
    // summaries on its own task can never read as a human saying yes.
    const verdict = verdictFromComments(normalizeComments(task, { commanders }), commanders);
    if (!verdict) continue;
    const tested = state.tested?.[id] || {};
    state.approved = state.approved || {};
    state.approved[id] = {
      at: new Date().toISOString(),
      version,
      tag: tested.tag || null,
      count: tested.count ?? null,
      by: verdict.by,
      via: "comment",
      taskId: task.id,
      ...(verdict.verdict === "decline" ? { declined: true } : {}),
    };
    found.push({ id, verdict: verdict.verdict, by: verdict.by, title: decodeEntities(a.activeVersion?.title || id) });
    log(`  approvals: ${verdict.verdict} by ${verdict.by} on "${found.at(-1).title}"`);
  }
  if (found.length && !cfg.dryRun) saveLocalState(STATE_NAME, state);
  if (found.length && cfg.dryRun) log("  DRY_RUN: approvals read but not recorded");
  return found;
}

async function poll(cfg) {
  log(`Newsletter worker: mode=poll${cfg.dryRun ? " (DRY_RUN)" : ""}`);
  requireSendEnv(cfg, "poll");
  const assets = await fetchNewsletterAssets();
  const state = loadLocalState(STATE_NAME, "sent");
  await collectApprovals(cfg, assets, state);
  const all = assets.map(a => ({ asset: a, ...pollPlan(a, state) })).filter(p => p.actions.length);
  const settled = new Set(all.filter(p => decidedBeforeSweep(p, state, { testWindowDays: cfg.testWindowDays })));
  for (const p of settled) log(`  parked (already reported, no sweep needed): ${decodeEntities(p.asset.activeVersion?.title || p.id)}: ${state.parked[p.id].reason}`);
  const plans = all.filter(p => !settled.has(p));
  // "nothing tagged" only when nothing IS tagged: an asset parked above is
  // tagged and waiting on a person, which is the opposite of nothing to do.
  if (!plans.length) {
    if (!settled.size) log(`  ${assets.length} Newsletter asset(s); nothing tagged ${CONTROL_TAGS.test} or ${CONTROL_TAGS.send} that has not already run on its current version`);
    return;
  }
  log(`  ${plans.length} asset(s) with work: ${plans.map(p => `${decodeEntities(p.asset.activeVersion?.title || p.id)} [${p.actions.join("+")}]`).join("; ")}`);

  const sweep = await unionSweepContacts();
  log(`  swept ${sweep.contacts.length}${sweep.reportedTotal ? `/${sweep.reportedTotal}` : ""} contacts`);
  const counts = contactTagCounts(sweep.contacts);

  for (const p of plans) {
    const issue = issueFromAsset(p.asset);
    const title = decodeEntities(p.asset.activeVersion?.title || p.id);
    const refuse = async (reason) => {
      // Once per asset version and reason: the tag stays on (no API to remove
      // it), so the poll would otherwise re-email every hour.
      state.parked = state.parked || {};
      const prev = state.parked[p.id];
      if (prev && prev.version === p.version && prev.reason === reason) { log(`  parked (already reported): ${title}: ${reason}`); return; }
      log(`  parked: ${title}: ${reason}`);
      if (cfg.dryRun) return;
      state.parked[p.id] = { at: new Date().toISOString(), version: p.version, reason };
      saveLocalState(STATE_NAME, state);
      // The board first: the email points AT the task, so the task has to exist
      // before the mail claims it does. A failure here is logged, not thrown —
      // the mail still goes, and its wording drops the claim.
      const fix = fixFor(reason);
      const taskId = await fileRefusalTask(cfg, { assetId: p.id, title, reason, fix });
      const where = taskId
        ? `A task is on the NOAN board (\`needs-human\`) and stays open until this issue goes out.`
        : `(The board task could not be filed this run — see the workflow log.)`;
      await report(cfg, `[newsletter] not sent: ${title}`, `**${title}** carries a newsletter control tag but did not run.\n\n${reason}\n\n**What to do:** ${fix}\n\n${where}`);
    };

    if (issue.error) { await refuse(issue.error); continue; }
    const dead = await unreachableImages(issue.images);
    if (dead.length) { await refuse(`the body has ${dead.length} image problem(s): ${dead.join("; ")}`); continue; }
    const aud = audienceFromAsset(p.asset, counts);
    if (aud.error) { await refuse(aud.error); continue; }
    log(`  ${title}: audience tag "${aud.tag}" (${aud.count} contacts), actions ${p.actions.join("+")}`);

    if (p.actions.includes("test")) {
      const r = await runTest(cfg, state, issue, aud.tag, sweep, { via: "tag" });
      const both = p.actions.includes("send");
      // DRY_RUN sends nothing, and that includes the report about the send it
      // did not make (a dry-run poll on 2026-09-07 emailed a "test sent" report).
      if (!cfg.dryRun) await report(cfg, `[newsletter] test sent: ${title}`, r.summary + (both
        ? `\n\nThis asset also carries the ${CONTROL_TAGS.send} tag. The live send to "${aud.tag}" runs on the NEXT poll, after this test has been read. Remove the ${CONTROL_TAGS.send} tag before then to stop it.`
        : `\n\nTo send it live to "${aud.tag}", add the ${CONTROL_TAGS.send} tag to the asset.`));
      continue;   // never test and go live in the same poll
    }
    if (p.actions.includes("send")) {
      const r = await runLive(cfg, state, issue, aud.tag, sweep, { via: "tag", strict: false });
      if (r.refused) await refuse(`Live send refused: ${r.refused}`);
    }
  }
}

/* ---------------- main ---------------- */

/**
 * `node newsletter-worker.mjs --preview "<asset id or title>" [out.html]`
 * Renders one issue exactly as a recipient would get it, with no send, no
 * ledger read and no contact sweep. Writes the HTML and the text part beside
 * it, and prints what the renderer removed, promoted and turned into buttons.
 */
async function preview(needle, outPath) {
  const issue = resolveIssue(await fetchNewsletterAssets(), needle);
  if (issue.error) throw new Error(issue.error);
  const mail = buildMail({ issue, contactId: null, secret: "preview-secret-not-sent", base: process.env.NEWSLETTER_UNSUB_BASE || "" });
  const out = outPath || process.env.NEWSLETTER_HTML_OUT || "newsletter-preview.html";
  fs.writeFileSync(out, mail.html);
  fs.writeFileSync(out.replace(/\.html?$/, "") + ".txt", mail.text);
  log(`Preview: "${issue.title}" (${issue.id}) -> ${out}`);
  if (issue.stripped.length) log(`  removed: ${issue.stripped.join(" | ")}`);
  log(`  subheadings made: ${issue.promoted.length ? issue.promoted.join(" | ") : "none"}`);
  log(`  buttons: ${issue.buttons.length ? issue.buttons.join(" | ") : "none"}`);
}

export async function main() {
  assertNoanKey();
  setUsageContext({ agent: "newsletter" });
  const at = process.argv.indexOf("--preview");
  if (at > -1) return preview(process.argv[at + 1] || process.env.NEWSLETTER_ASSET || "", process.argv[at + 2]);
  const cfg = readConfig();
  if (cfg.mode === "poll") return poll(cfg);
  return dispatch(cfg);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message || e); process.exit(1); });
}
