#!/usr/bin/env node
/**
 * Fact alignment — worker. Weekly audit of the NOAN fact base for gaps,
 * cross-block contradictions, content overlap, and the standing `[Fact Candidate]`
 * capture queue (see CLAUDE.md's "Standing behavior: fact-candidate capture" and
 * .claude/skills/noan-fact-alignment/SKILL.md, which this ports).
 *
 * Never writes a business fact directly — every correction is a recommendation in the
 * report; a human reviews and posts it separately via the review task this creates.
 *
 * Flow:
 *   1. Load prior state (relevantStackSlugs, lastRun) — soft first-run default, not a
 *      hard-fail: this is trend/scoping bookkeeping, not an anti-duplicate-send ledger.
 *   2. Gather candidates: the `[Fact Candidate]` backlog queue (split into genuine
 *      candidates vs. "mark stack relevant" instructions) and a notes scan over the
 *      calendar-anchored window (the 7 days ending the day before the most recent Monday
 *      on or before today — stable regardless of exactly when this script executes),
 *      skipping this project's own automation report notes.
 *   3. Resolve in-scope stacks/blocks (in_use_only, unioned with relevantStackSlugs) and
 *      the full facts sweep; compute gaps (in-scope blocks with no fact) and the stray-fact
 *      anomaly (a fact sitting on an out-of-scope block) deterministically.
 *   4. Hand all of that to Claude (fact-alignment-agent.mjs, no tools) for gap-fill
 *      drafting, contradiction/overlap detection, and candidate-fact drafting.
 *   5. Build the run's recommendation manifest (buildManifest): a stable id per finding,
 *      its target block, the exact drafted content, and the id of the fact it was reasoned
 *      against. The report's ids are rendered FROM the manifest, so the two cannot drift.
 *   6. Render the report deterministically (renderReport), post a NOAN note, create a
 *      self-assigned review task tagged "fact review" (best-effort tagging), close out
 *      consumed [Fact Candidate] tasks, email the report recipients, and persist state
 *      (including the manifest, pruned to the retention window).
 *
 * Env:
 *   NOAN_PERSONAL_API_KEY, ANTHROPIC_API_KEY, RESEND_API_KEY, MAIL_FROM   required
 *   FACT_ALIGNMENT_CONFIG_BLOCK_SLUG, FACT_ALIGNMENT_PLAYBOOK_BLOCK_SLUG  required
 *   FACT_ALIGNMENT_MODEL     default "claude-opus-5"
 *   FACT_ALIGNMENT_REVIEW_DUE_DAYS   default 5
 *   FACT_ALIGNMENT_MANIFEST_RETENTION_DAYS   default 60
 *   FACT_ALIGNMENT_REVIEW_ASSIGNEES   comma-separated identity ids added to the review task
 *                                     alongside the running identity
 *   DRY_RUN=1                log the computed report, write/send nothing
 */

import { pathToFileURL } from "node:url";
import { noanGet, noanGetAll, noanPost, noanPatch, noanPut, findTagId, whoAmI, assertNoanKey, postNote, NOTE_CONTENT_CAP } from "./noan.mjs";
import { assertModelKey } from "./anthropic.mjs";
import { respondLine } from "./respond-by.mjs";
import { sendReportEmail } from "./resend.mjs";
import { peekState, saveLocalState } from "./state-local.mjs";
import { renderReportEmailHtml } from "./markdown-email.mjs";
import { runFactAlignmentAgent, renderReport, renderReportForNote, genuineCandidates, buildManifest, manifestWindowKey } from "./fact-alignment-agent.mjs";

const CONFIG_SLUG = process.env.FACT_ALIGNMENT_CONFIG_BLOCK_SLUG;
const PLAYBOOK_SLUG = process.env.FACT_ALIGNMENT_PLAYBOOK_BLOCK_SLUG;
const DRY_RUN = process.env.DRY_RUN === "1";
const STATE_NAME = "fact-alignment";
const REVIEW_DUE_DAYS = parseInt(process.env.FACT_ALIGNMENT_REVIEW_DUE_DAYS || "5", 10);
const FACT_CHAR_CAP = 40000; // matches the agent's get_facts truncation cap
const DUE_WEEKDAY = 1; // Monday (JS Date#getUTCDay(): 0=Sun..6=Sat) — this automation's cron.
// How long a run's recommendation manifest is retained. The review task is due in 5 days, so
// this is generous by design — it's the window in which someone can still look a recommendation
// up by the id the report gave it. Each manifest is roughly the size of the drafted content in
// its report (~10KB), so a couple of months of them is well under a megabyte.
const MANIFEST_RETENTION_DAYS = parseInt(process.env.FACT_ALIGNMENT_MANIFEST_RETENTION_DAYS || "60", 10);

// Extra identities on the weekly review task, alongside the running identity. The worker
// self-assigns via GET /me, which resolves to whoever owns NOAN_PERSONAL_API_KEY — in Actions
// that is the owner of the CI secret, so the task names only them unless someone is added
// here. No API resolves an identity from an email address, so these are raw ids (from GET /me
// with that person's key).
const EXTRA_REVIEW_ASSIGNEES = (process.env.FACT_ALIGNMENT_REVIEW_ASSIGNEES || "")
  .split(",").map(v => v.trim()).filter(Boolean);

/**
 * Calendar-anchored window: the 7 days ending the day before the most recent
 * occurrence of DUE_WEEKDAY on or before `today`. Independent of when this script
 * actually executes — a cron firing exactly on schedule, a delayed/jittered run, or
 * an ad hoc/test run on any other day all resolve to the same Mon-Sun week a fully
 * on-schedule run would have used, instead of drifting to reflect wall-clock
 * execution time (the previous lastRun-to-now approach).
 */
function calendarWeekWindow(dueWeekday, today) {
  const diff = (today.getUTCDay() - dueWeekday + 7) % 7;
  const due = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - diff));
  const windowEnd = new Date(due.getTime() - 1); // 23:59:59.999 the day before due date
  const windowStart = new Date(due.getTime() - 7 * 86_400_000); // 00:00:00.000, 7 days before due date
  return { windowStart, windowEnd };
}

function log(...a) { console.log(new Date().toISOString(), ...a); }

/**
 * The most recent site scan, if there is one, plus whether it is NEW to this report.
 *
 * The scan runs monthly and this report weekly, so the same findings would otherwise be
 * rendered in full four weeks running — which is how a section teaches its readers to skip it.
 * `isNew` is true when the scan ran after the previous fact-alignment report; an unchanged scan
 * collapses to a single line rather than disappearing, so an unresolved finding is still
 * visible without being re-argued every week.
 *
 * A missing or unreadable site-scan ledger is not an error here: the scan is a separate,
 * optional automation and this report predates it.
 */
export function latestSiteScan(siteState, priorRunIso) {
  const runs = siteState?.runs;
  if (!runs || typeof runs !== "object") return null;
  const entries = Object.values(runs).filter(r => Number.isFinite(Date.parse(r?.at || "")));
  if (!entries.length) return null;
  const latest = entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  const priorAt = Date.parse(priorRunIso || "");
  return { ...latest, isNew: !Number.isFinite(priorAt) || Date.parse(latest.at) > priorAt };
}

/**
 * Who the review task goes to. PUT /tasks/{id}/assignees is a full replacement, so the running
 * identity has to be included explicitly or self-assignment is silently dropped. Deduped
 * because the extra list may well contain the running identity — running this with Daniel's
 * key while he is also configured as an extra reviewer must not name him twice.
 */
export function reviewAssignees(identityId, extra = []) {
  return [...new Set([identityId, ...extra].filter(Boolean))];
}

/** Drop manifests past the retention window so the ledger stays bounded, per the agent
 *  standard's "prune what expires" rule. An entry with no readable createdAt can't be aged
 *  and would otherwise live forever, so it goes — but noisily, since it means something
 *  wrote a manifest in a shape this function doesn't recognise. */
function pruneManifests(manifests, now) {
  const cutoff = now.getTime() - MANIFEST_RETENTION_DAYS * 86_400_000;
  const kept = {};
  for (const [key, m] of Object.entries(manifests || {})) {
    const at = Date.parse(m?.createdAt || "");
    if (!Number.isFinite(at)) { log(`  warn: dropping manifest '${key}' — unreadable createdAt`); continue; }
    if (at >= cutoff) kept[key] = m;
  }
  return kept;
}

// Checked inside main(), not at module load. latestSiteScan and pruneManifests are pure and
// imported by tests, and a module that exits the process on import cannot be tested without
// inventing dummy secrets. Same reason the other workers upstream do it this way.
const REQUIRED_ENV = ["RESEND_API_KEY", "MAIL_FROM",
  "FACT_ALIGNMENT_CONFIG_BLOCK_SLUG", "FACT_ALIGNMENT_PLAYBOOK_BLOCK_SLUG"];
function requireEnv() {
  // Either NOAN key satisfies this — noan.mjs prefers the per-category key and refuses to run with
  // neither. It belongs HERE and not at module scope: the comment above REQUIRED_ENV is explicit
  // that the pure halves are imported by tests, and a module that throws on import cannot be tested
  // without inventing dummy secrets.
  assertNoanKey();
  // Either model-key name satisfies this; see assertModelKey.
  assertModelKey();
  const missing = REQUIRED_ENV.filter(n => !process.env[n]);
  if (missing.length) { console.error(`Missing required env var(s): ${missing.join(", ")}`); process.exit(1); }
}

/* ---------------- brain (editable in the NOAN UI) ---------------- */

async function loadAgentBrain() {
  const cfg  = await noanGet(`/facts?block_slug=${encodeURIComponent(CONFIG_SLUG)}`);
  const play = await noanGet(`/facts?block_slug=${encodeURIComponent(PLAYBOOK_SLUG)}`);
  const config   = (cfg.items  || []).map(f => f.content).join("\n\n").trim();
  const playbook = (play.items || []).map(f => f.content).join("\n\n").trim();
  if (!config) throw new Error(`No facts in fact-alignment config block '${CONFIG_SLUG}'. Refusing to run un-instructed.`);
  return { config, playbook };
}

function capFact(content) {
  if (!content) return content;
  return content.length > FACT_CHAR_CAP ? content.slice(0, FACT_CHAR_CAP) + "\n[...fact truncated]" : content;
}

/* ---------------- capture queue ---------------- */

const FACT_CANDIDATE_RX = /^\[Fact Candidate\]/i;
const MARK_STACK_RX = /^\[Fact Candidate\]\s*mark stack\s*"([^"]+)"\s*as relevant/i;

// The prefix above is anchored and bracketed, so "Fact candidate: ..." — or the same title
// with a leading space — matches nothing and the capture is dropped with no error, no warning
// and no trace in the report. That silence is the failure mode worth designing against: the
// person who wrote it has no way to find out. Anything that plainly MEANT to be a capture is
// caught here and named in the report instead of vanishing. Deliberately loose, and matched
// anywhere in the title rather than at the start: a false positive costs one report line, a
// false negative costs a fact. These are reported only — never fed to the model as candidates
// (a task called "Fix the fact candidate prefix" is a chore, not a business fact) and never
// closed out, so correcting the title is enough to have the next run pick it up properly.
const NEAR_MISS_RX = /fact[\s._-]*candidate/i;

export function isMalformedCapture(title) {
  const t = title || "";
  return NEAR_MISS_RX.test(t) && !FACT_CANDIDATE_RX.test(t);
}

async function loadCaptureQueue() {
  const backlog = await noanGetAll(`/tasks?status=backlog&per_page=100`);
  const flagged = backlog.filter(t => FACT_CANDIDATE_RX.test(t.title || ""));
  const markStackTasks = [];
  const genericCandidateTasks = [];
  for (const t of flagged) {
    const m = (t.title || "").match(MARK_STACK_RX);
    if (m) markStackTasks.push({ task: t, stackSlug: m[1] });
    else genericCandidateTasks.push(t);
  }
  const malformedCaptures = backlog.filter(t => isMalformedCapture(t.title));
  return { markStackTasks, genericCandidateTasks, malformedCaptures };
}

/* ---------------- notes scan (early-stop pagination: newest-first, no date filter) ---------------- */

const OWN_REPORT_TITLE_MARKERS = [
  "Growth Metrics Refresh", "Product Usage Refresh", "Market Research Refresh",
  "Weekly Activity Report", "Weekly Fact Alignment Report",
];
function looksLikeAutomationReport(title) {
  const t = title || "";
  return OWN_REPORT_TITLE_MARKERS.some(marker => t.includes(marker));
}

// A [Fact Candidate] note is the rationale behind a [Fact Candidate] task, not an independent
// find. Capture writes both in the same window, so scanning the note would hand the model the
// same candidate twice — once as source:"task", once as source:"notes-scan" — and the prompt
// asks for one entry per item. The task is the queue entry (its details carry the summary the
// model reads and it is what gets closed out); the note is the long-form rationale for whoever
// reviews the report. Deliberately reuses FACT_CANDIDATE_RX so the note exclusion can never
// drift away from the task prefix it mirrors.
//
// The content is checked as well as the title, because a capture written through the NOAN MCP
// server cannot set a title at all: create_note takes only `content`, and the server derives
// the title itself — rewriting it rather than copying the first line, and dropping a bracketed
// prefix while doing so. Measured live 2026-09-19: content beginning
// "[Fact Candidate] MCP prefix-survival probe 2026-09-19" came back titled
// "MCP Prefix-Survival Probe 2026-09-19". A title-only check therefore misses every MCP-written
// capture note, and does so invisibly — the note has a perfectly good title, just not that one.
//
// Only the first non-empty line counts. Matching anywhere in the body would swallow any note
// that merely discusses the convention, which is the opposite failure: a real find, silently
// dropped, with nothing in the report to say so.
function firstLine(content) {
  for (const line of String(content || "").split("\n")) {
    const t = line.trim();
    if (t) return t;
  }
  return "";
}

export function skipNoteFromScan(title, content = "") {
  return looksLikeAutomationReport(title)
    || FACT_CANDIDATE_RX.test(title || "")
    || FACT_CANDIDATE_RX.test(firstLine(content));
}

async function fetchNotesInWindow(windowStartIso, windowEndIso) {
  const kept = [];
  let page = 1;
  for (;;) {
    const res = await noanGet(`/notes?page=${page}&per_page=100`);
    const items = res.items || [];
    if (!items.length) break;
    for (const n of items) {
      if (n.createdAt < windowStartIso) return kept; // older than window — done, sorted newest-first
      if (n.createdAt <= windowEndIso) kept.push(n); // newer than windowEnd — skip, keep paginating
    }
    if (!res?.links?.next) break;
    page++;
  }
  return kept;
}

/* ---------------- in-scope stacks/blocks/facts ---------------- */

async function loadScope(relevantStackSlugs) {
  const allStacks = await noanGetAll(`/stacks?per_page=100`); // full catalog, unfiltered — for stack titles
  const inUseStacks = await noanGetAll(`/stacks?in_use_only=true&per_page=100`);
  const stackTitleBySlug = new Map(allStacks.map(s => [s.slug, s.title]));
  const inUseSlugs = new Set(inUseStacks.map(s => s.slug));
  const inScopeSlugs = new Set([...inUseSlugs, ...relevantStackSlugs]);

  const blocks = await noanGetAll(`/blocks?in_use_only=true&per_page=100`);
  const coveredStackSlugs = new Set(blocks.map(b => b.stack?.slug));

  // Supplement for relevantStackSlugs the in_use_only fetch didn't already cover
  // (a "mark stack relevant" correction targeting a stack not formally in-use).
  for (const slug of relevantStackSlugs) {
    if (coveredStackSlugs.has(slug)) continue;
    const stack = allStacks.find(s => s.slug === slug);
    const blockSlugs = (stack?.blocks || []).map(b => b.slug);
    if (!blockSlugs.length) continue;
    const qs = blockSlugs.map(s => `slug=${encodeURIComponent(s)}`).join("&");
    const supplement = await noanGetAll(`/blocks?${qs}&per_page=100`).catch(() => []);
    blocks.push(...supplement);
  }

  const inScopeBlocks = blocks.filter(b => inScopeSlugs.has(b.stack?.slug));
  return { stackTitleBySlug, inScopeSlugs, inScopeBlocks };
}

async function loadAllFacts() {
  const all = await noanGetAll(`/facts?per_page=100`);
  const byBlockSlug = new Map(all.map(f => [f.blockSlug, f]));
  return byBlockSlug;
}

async function computeAnomalies(factsByBlock, inScopeBlocks) {
  const inScopeSlugSet = new Set(inScopeBlocks.map(b => b.slug));
  const strayBlockSlugs = [...factsByBlock.keys()].filter(s => !inScopeSlugSet.has(s));
  if (!strayBlockSlugs.length) return [];
  const qs = strayBlockSlugs.map(s => `slug=${encodeURIComponent(s)}`).join("&");
  const resolved = await noanGetAll(`/blocks?${qs}&per_page=100`).catch(() => []);
  const bySlug = new Map(resolved.map(b => [b.slug, b]));
  return strayBlockSlugs.map(slug => {
    const b = bySlug.get(slug);
    return b
      ? { blockSlug: slug, blockTitle: b.title, stackSlug: b.stack?.slug }
      : { blockSlug: slug, blockTitle: null, stackSlug: null, note: "block no longer exists" };
  });
}

/* ---------------- report recipients (live from NOAN, by REPORT_RECIPIENT_TAG) ---------------- */

async function fetchGrowthTeamEmails() {
  // The recipients are whoever carries REPORT_RECIPIENT_TAG. No tag configured
  // means nobody, and the run says so, rather than a built-in team name that
  // belongs to one company.
  const tag = (process.env.REPORT_RECIPIENT_TAG || "").trim().toLowerCase();
  if (!tag) { log("  warn: REPORT_RECIPIENT_TAG is not set — the report has no email recipients"); return []; }
  const contacts = await noanGetAll(`/contacts?per_page=100`);
  return contacts
    .filter(c => (c.tags || []).some(t => (t.name || "").toLowerCase() === tag))
    .map(c => c.email)
    .filter(Boolean);
}

/* ---------------- main ---------------- */

async function main() {
  requireEnv();
  const now = new Date();
  const nowIso = now.toISOString();
  log(`Fact alignment starting${DRY_RUN ? " (DRY-RUN)" : ""}`);

  const me = await whoAmI();
  const identityId = me?.identity?.id;
  if (!identityId) throw new Error("GET /me returned no identity id — can't self-assign the review task.");

  // 1. Prior state — soft first-run default (trend/scoping bookkeeping, not an
  // anti-duplicate-send ledger, so a missing row is a legitimate first run, not an abort).
  const prior = peekState(STATE_NAME) || {};
  const relevantStackSlugs = Array.isArray(prior.relevantStackSlugs) ? prior.relevantStackSlugs : [];
  const isFirstRun = !prior.lastRun;
  const { windowStart, windowEnd } = calendarWeekWindow(DUE_WEEKDAY, now);
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = windowEnd.toISOString();
  const windowLabel = `${windowStartIso.slice(0, 10)} to ${windowEndIso.slice(0, 10)}`;

  const brain = await loadAgentBrain();

  // 2. Candidates
  const { markStackTasks, genericCandidateTasks, malformedCaptures } = await loadCaptureQueue();
  const allNotesInWindow = await fetchNotesInWindow(windowStartIso, windowEndIso);
  const notesCandidates = allNotesInWindow.filter(n => !skipNoteFromScan(n.title, n.content));
  log(`  ${genericCandidateTasks.length} capture-queue candidate(s), ${markStackTasks.length} relevance correction(s), ${notesCandidates.length} notes-scan candidate(s)`);
  if (malformedCaptures.length) log(`  ${malformedCaptures.length} malformed capture(s) — reported, not consumed: ${malformedCaptures.map(t => JSON.stringify(t.title || "")).join(", ")}`);

  // 3. Relevance corrections applied before scoping
  const updatedRelevantStackSlugs = [...new Set([...relevantStackSlugs, ...markStackTasks.map(m => m.stackSlug)])];

  const { stackTitleBySlug, inScopeBlocks } = await loadScope(updatedRelevantStackSlugs);
  const factsByBlock = await loadAllFacts();
  const gapBlocks = inScopeBlocks.filter(b => !factsByBlock.has(b.slug));
  // BlockListItem.stack only carries {id,slug} — resolve display titles via the stack map.
  const stackTitleOf = b => stackTitleBySlug.get(b.stack?.slug) || b.stack?.slug || "unknown stack";
  const filledInScopeBlocks = inScopeBlocks
    .filter(b => factsByBlock.has(b.slug))
    .map(b => ({ slug: b.slug, title: b.title, stackTitle: stackTitleOf(b), content: capFact(factsByBlock.get(b.slug).content) }));
  const gapBlocksWithTitles = gapBlocks.map(b => ({ slug: b.slug, title: b.title, stackTitle: stackTitleOf(b) }));

  const anomalies = await computeAnomalies(factsByBlock, inScopeBlocks);
  log(`  ${inScopeBlocks.length} in-scope block(s), ${gapBlocks.length} gap(s), ${anomalies.length} anomal(y/ies)`);

  // 4. Model synthesis
  const result = await runFactAlignmentAgent({
    windowLabel, isFirstRun,
    inScopeBlocks: filledInScopeBlocks,
    gapBlocks: gapBlocksWithTitles,
    taskCandidates: genericCandidateTasks,
    notesCandidates,
    anomalies,
    brain,
  }, { log });
  const candidates = genuineCandidates(result);
  log(`  ${result.gaps.length} gap(s) drafted, ${result.contradictions.length} contradiction(s), ${result.overlaps.length} overlap(s), ${candidates.length} genuine candidate(s) (${result.candidates.length} reviewed)`);

  // 5. Deliver
  const factReviewTagId = await findTagId("fact review").catch(() => null);
  const missingFactReviewTag = !factReviewTagId;

  // Built before the report so the report's ids come from the manifest itself — one source
  // of truth for the ids rather than two generators that could drift apart.
  // Read-only: this report renders the site scan's findings, it never runs or writes the scan.
  const site = latestSiteScan(peekState("site-scan"), prior.lastRun);
  if (site) log(`  site scan of ${site.at.slice(0, 10)}: ${site.findings?.length || 0} finding(s), ${site.isNew ? "new since the last report" : "unchanged since the last report"}`);
  else log("  no site scan on record — Website Divergences section will say so");

  const manifest = buildManifest({
    windowKey: manifestWindowKey(windowStartIso),
    windowLabel,
    result,
    baseFactIdOf: slug => factsByBlock.get(slug)?.id ?? null,
    createdAt: nowIso,
    websiteFindings: site?.isNew ? site.findings : [],
  });
  const applicableCount = manifest.entries.filter(e => e.applicable).length;
  log(`  manifest ${manifest.windowKey}: ${manifest.entries.length} recommendation(s), ${applicableCount} with a concrete block + drafted content`);

  const reportOpts = { windowLabel, result, manifest, site, missingFactReviewTag, malformedCaptures, emptyRecipients: false };
  // The email carries the report in full. The note is the same report with its quoted bodies
  // clipped to whatever fits the note character cap — see renderReportForNote. Both are
  // rendered here so the dry-run shows exactly what each channel would receive.
  const report = renderReport(reportOpts);
  const note = renderReportForNote(reportOpts);
  if (note.condensed) {
    log(`  report is ${report.length} chars, over NOAN's ${NOTE_CONTENT_CAP}-char note limit — note copy clips quoted bodies to ${note.budget} chars (${note.text.length} chars). The emailed copy is complete.`);
  }
  if (!note.fits) {
    log(`  WARN: at the smallest body budget the note copy is still ${note.text.length} chars, over ${NOTE_CONTENT_CAP} — postNote will cut the tail and the archived note will be incomplete. Clipping bodies can no longer recover this; shorten a section.`);
  }

  if (DRY_RUN) {
    log("  dry-run: would post this report —\n" + report);
    log(`  dry-run: note copy would be ${note.text.length} chars${note.condensed ? ` (bodies clipped to ${note.budget})` : " (unclipped — the full report fits)"}, email copy ${report.length} chars`);
    log(`  dry-run: would persist manifest ${manifest.windowKey} — ${manifest.entries.map(e => `${e.id}${e.applicable ? "" : ` (not applicable: ${e.blockedReason})`}`).join(", ") || "(no recommendations)"}`);
    const emails = await fetchGrowthTeamEmails().catch(e => { log(`  warn: recipient lookup failed: ${e.message}`); return []; });
    log(`  dry-run: would email the report recipients (${emails.length} recipient(s)): ${emails.join(", ") || "(none found)"}`);
    log(`  dry-run: would create a review task, self-assigned, tagged "fact review" (found: ${!missingFactReviewTag})`);
    log(`  dry-run: would close out ${genericCandidateTasks.length + markStackTasks.length} consumed [Fact Candidate] task(s)`);
    return;
  }

  await postNote({
    title: `Weekly Fact Alignment Report — ${windowLabel}`,
    content: note.text,
    externalId: `fact-alignment:${windowStartIso.slice(0, 10)}`,
  });
  log("  posted NOAN note");

  const dueDate = new Date(now.getTime() + REVIEW_DUE_DAYS * 86_400_000).toISOString().slice(0, 10);
  const created = await noanPost("/tasks", {
    title: `[Fact Alignment] ${windowLabel} — ${result.gaps.length} gap(s), ${result.contradictions.length} contradiction(s), ${result.overlaps.length} overlap(s), ${candidates.length} candidate(s)`,
    details: `See the Weekly Fact Alignment Report NOAN note for ${windowLabel} for the full recommendations.\n\n${respondLine("reportEmail")}`,
    status: "backlog",
    dueDate,
  });
  const reviewTaskId = created?.task?.id || created?.id;
  if (reviewTaskId) {
    const assigneeIds = reviewAssignees(identityId, EXTRA_REVIEW_ASSIGNEES);
    await noanPut(`/tasks/${reviewTaskId}/assignees`, { assigneeIds });
    if (factReviewTagId) await noanPut(`/tasks/${reviewTaskId}/tags`, { tagIds: [factReviewTagId] });
    log(`  created review task ${reviewTaskId}, assigned to ${assigneeIds.length} identity/identities${factReviewTagId ? ", tagged fact review" : " (fact review tag missing — left untagged)"}`);
  } else {
    log("  warn: review task creation returned no id — could not self-assign or tag it");
  }

  // Close out consumed [Fact Candidate] tasks (capture-queue candidates + relevance corrections).
  for (const t of [...genericCandidateTasks, ...markStackTasks.map(m => m.task)]) {
    try {
      await noanPatch(`/tasks/${t.id}`, { completed: true, status: "done" });
    } catch (e) {
      log(`  warn: failed to close out task ${t.id}: ${e.message}`);
    }
  }
  if (genericCandidateTasks.length + markStackTasks.length) {
    log(`  closed out ${genericCandidateTasks.length + markStackTasks.length} consumed [Fact Candidate] task(s)`);
  }

  const emails = await fetchGrowthTeamEmails().catch(e => { log(`  warn: recipient lookup failed, skipping email: ${e.message}`); return []; });
  if (emails.length) {
    const { deduped, reason } = await sendReportEmail({
      agent: "fact-alignment",
      period: windowStartIso.slice(0, 10),   // same window identifier as the note's externalId above
      to: emails,
      subject: `Weekly Fact Alignment Report — ${windowLabel}`,
      html: renderReportEmailHtml(report),
      text: report,
    });
    log(deduped
      ? `  email skipped for ${windowStartIso.slice(0, 10)}: ${reason}`
      : `  emailed the report recipients (${emails.length} recipient(s))`);
  } else {
    log("  warn: no contacts carry REPORT_RECIPIENT_TAG — email skipped");
  }

  // Persist state
  const manifests = pruneManifests(prior.manifests, now);
  manifests[manifest.windowKey] = manifest;
  saveLocalState(STATE_NAME, {
    initialized: true,
    lastRun: nowIso,
    relevantStackSlugs: updatedRelevantStackSlugs,
    manifests,
  });
  log(`  saved state (${Object.keys(manifests).length} manifest(s) retained)`);

  log("run complete.");
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry && import.meta.url === entry) {
  main().catch(e => { console.error("fatal:", e); process.exit(1); });
}
