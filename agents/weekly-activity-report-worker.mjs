#!/usr/bin/env node
/**
 * Weekly activity report — worker. A retrospective digest of a week of NOAN activity:
 * tasks completed/opened, fact updates, assets created, and standalone notes captured,
 * organized into themes with an overarching narrative of how the company evolved. Ports
 * .claude/skills/noan-weekly-activity-report/SKILL.md.
 *
 * Unlike fact-alignment (finds problems) or market-research-refresh (writes new facts),
 * this automation only observes and narrates. It writes no business facts and creates no
 * review task — a NOAN note + Growth Team email is the entire delivery.
 *
 * Flow:
 *   1. Compute the report window from the calendar, not from lastRun-to-now: the 7 days
 *      ending the day before the most recent Wednesday (this automation's due day) on or
 *      before today (calendarWeekWindow) — stable regardless of exactly when this script
 *      executes. Load prior state (lastRun, contactNoteCounts) — soft first-run default:
 *      no prior state means note deltas are suppressed this run (every contact would
 *      otherwise look "new," a false signal the Agent Config calls out explicitly).
 *   2. Gather, deterministically: tasks completed/opened this window (full sweep, no
 *      server-side date filter exists on GET /tasks), standalone notes in-window
 *      (early-stop pagination), per-contact note-array deltas vs. stored counts, fact
 *      updates in-window (full sweep, resolved to stack/block titles via the in-use
 *      catalog with a targeted per-slug fallback), and assets created in-window
 *      (early-stop pagination, already sorted newest-first).
 *   3. Hand all of that to Claude (weekly-activity-report-agent.mjs, no tools) for the
 *      one part that needs actual reading comprehension across sections: 2-4 themes and
 *      the overall summary narrative.
 *   4. Render the report deterministically (renderReport) — the Playbook's two firm
 *      rules (every itemized list is a bullet list, Fact Updates is a real markdown
 *      table) are enforced in code, not left to the model's phrasing.
 *   5. Post a NOAN note, email the report recipients, persist state.
 *
 * Env:
 *   NOAN_PERSONAL_API_KEY, ANTHROPIC_API_KEY, RESEND_API_KEY, MAIL_FROM   required
 *   ACTIVITY_REPORT_CONFIG_BLOCK_SLUG, ACTIVITY_REPORT_PLAYBOOK_BLOCK_SLUG   required
 *   ACTIVITY_REPORT_MODEL    default "claude-opus-5"
 *   DRY_RUN=1                log the computed report, write/send nothing
 */

import { noanGet, noanGetAll, assertNoanKey, postNote } from "./noan.mjs";
import { assertModelKey } from "./anthropic.mjs";
import { agentName } from "./required-env.mjs";
import { fetchMemosByContact, mergeCounts, shouldSeedBaseline, computeMemoDeltas } from "./contact-memos.mjs";
import { sendReportEmail } from "./resend.mjs";
import { peekState, saveLocalState } from "./state-local.mjs";
import { renderReportEmailHtml } from "./markdown-email.mjs";
import { runWeeklyActivityReportAgent, renderReport } from "./weekly-activity-report-agent.mjs";

const CONFIG_SLUG = process.env.ACTIVITY_REPORT_CONFIG_BLOCK_SLUG;
const PLAYBOOK_SLUG = process.env.ACTIVITY_REPORT_PLAYBOOK_BLOCK_SLUG;
const DRY_RUN = process.env.DRY_RUN === "1";
const STATE_NAME = "weekly-activity-report";
const DUE_WEEKDAY = 3; // Wednesday (JS Date#getUTCDay(): 0=Sun..6=Sat) — this automation's cron.

/**
 * Calendar-anchored window: the 7 days ending the day before the most recent
 * occurrence of DUE_WEEKDAY on or before `today`. Independent of when this script
 * actually executes — a cron firing exactly on schedule, a delayed/jittered run, or
 * an ad hoc/test run on any other day all resolve to the same Wed-Tue week a fully
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

function required(name) {
  if (!process.env[name]) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
// Either NOAN key satisfies this. noan.mjs prefers the per-category key and refuses to run
// with neither, so naming the shared key here would reject a correctly configured
// per-category run — and it is why the shared key had to stay in every workflow env block.
assertNoanKey();
// Either model-key name satisfies this; see assertModelKey.
assertModelKey();
["RESEND_API_KEY", "MAIL_FROM",
 "ACTIVITY_REPORT_CONFIG_BLOCK_SLUG", "ACTIVITY_REPORT_PLAYBOOK_BLOCK_SLUG"].forEach(required);

/* ---------------- brain (editable in the NOAN UI) ---------------- */

async function loadAgentBrain() {
  const cfg  = await noanGet(`/facts?block_slug=${encodeURIComponent(CONFIG_SLUG)}`);
  const play = await noanGet(`/facts?block_slug=${encodeURIComponent(PLAYBOOK_SLUG)}`);
  const config   = (cfg.items  || []).map(f => f.content).join("\n\n").trim();
  const playbook = (play.items || []).map(f => f.content).join("\n\n").trim();
  if (!config) throw new Error(`No facts in weekly-activity-report config block '${CONFIG_SLUG}'. Refusing to run un-instructed.`);
  return { config, playbook };
}

/* ---------------- notes / assets: early-stop pagination (newest-first, no date filter) ---------------- */

async function fetchNotesInWindow(windowStartIso, windowEndIso) {
  const kept = [];
  let page = 1;
  for (;;) {
    const res = await noanGet(`/notes?page=${page}&per_page=100`);
    const items = res.items || [];
    if (!items.length) break;
    for (const n of items) {
      if (n.createdAt < windowStartIso) return kept; // older than window — done, newest-first order
      if (n.createdAt <= windowEndIso) kept.push(n); // newer than windowEnd — skip, keep paginating
    }
    if (!res?.links?.next) break;
    page++;
  }
  return kept;
}

async function fetchAssetsInWindow(windowStartIso, windowEndIso) {
  const kept = [];
  let page = 1;
  for (;;) {
    const res = await noanGet(`/assets?sort=createdAt&order=desc&page=${page}&per_page=100`);
    const items = res.items || [];
    if (!items.length) break;
    for (const a of items) {
      if (a.createdAt < windowStartIso) return kept;
      if (a.createdAt <= windowEndIso) kept.push(a);
    }
    if (!res?.links?.next) break;
    page++;
  }
  return kept;
}

function inferNoteSource(title) {
  const t = title || "";
  if (/Weekly Fact Alignment Report/i.test(t)) return "Weekly Fact Alignment Report";
  if (/Growth Metrics Refresh/i.test(t)) return "Growth Metrics Refresh";
  if (/Product Usage Refresh/i.test(t)) return "Product Usage Refresh";
  if (/Market Research/i.test(t)) return "Market Research Refresh";
  if (/Weekly Activity Report/i.test(t)) return "Weekly Activity Report";
  if (new RegExp("^\\[" + agentName().replace(/[.*+?^${}()|[\]\\]/g, m => "\\" + m) + "\\] followed up", "i").test(t)) return `${agentName()} follow-up`;
  return "unattributed";
}

/* ---------------- fact updates: block/stack title resolution ---------------- */

async function loadInUseBlockStackMaps() {
  const blocks = await noanGetAll(`/blocks?in_use_only=true&per_page=100`);
  const stacks = await noanGetAll(`/stacks?in_use_only=true&per_page=100`);
  const blockBySlug = new Map(blocks.map(b => [b.slug, b]));
  const stackTitleBySlug = new Map(stacks.map(s => [s.slug, s.title]));
  return { blockBySlug, stackTitleBySlug };
}

async function resolveUnknownBlocks(slugs) {
  if (!slugs.length) return new Map();
  const qs = slugs.map(s => `slug=${encodeURIComponent(s)}`).join("&");
  const found = await noanGetAll(`/blocks?${qs}&per_page=100`).catch(() => []);
  return new Map(found.map(b => [b.slug, b]));
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
  const now = new Date();
  const nowIso = now.toISOString();
  log(`Weekly activity report starting${DRY_RUN ? " (DRY-RUN)" : ""}`);

  const prior = peekState(STATE_NAME); // null on a genuine first run — soft read, not a hard-fail
  const isFirstRun = !prior;
  const priorContactNoteCounts = prior?.contactNoteCounts || {};
  const { windowStart, windowEnd } = calendarWeekWindow(DUE_WEEKDAY, now);
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = windowEnd.toISOString();
  const windowStartDate = windowStartIso.slice(0, 10);
  const windowEndDate = windowEndIso.slice(0, 10);
  const windowLabel = `${windowStartDate} to ${windowEndDate}`;

  const brain = await loadAgentBrain();

  // 1. Tasks — full sweep, no server-side date filter on this endpoint.
  const allTasks = await noanGetAll(`/tasks?per_page=100`);
  const completedRaw = allTasks.filter(t => t.completed && t.updatedAt && t.updatedAt >= windowStartIso && t.updatedAt <= windowEndIso);
  const openedRaw = allTasks.filter(t => t.createdAt && t.createdAt >= windowStartIso && t.createdAt <= windowEndIso);
  const openedIds = new Set(openedRaw.map(t => t.id));
  const completedIds = new Set(completedRaw.map(t => t.id));
  const tasksCompleted = completedRaw.map(t => ({ id: t.id, title: t.title, bothOpenedAndCompleted: openedIds.has(t.id) }));
  const tasksOpened = openedRaw.map(t => ({ id: t.id, title: t.title, bothOpenedAndCompleted: completedIds.has(t.id) }));
  log(`  ${tasksCompleted.length} task(s) completed, ${tasksOpened.length} opened`);

  // 2. Standalone notes in-window
  const notesInWindow = await fetchNotesInWindow(windowStartIso, windowEndIso);
  const standaloneNotes = notesInWindow.map(n => ({
    id: n.id,
    title: n.title || "",
    content: n.content || "",
    // The 150-char gist is the MODEL's view and stays that length on purpose: the
    // report now prints a one-line headline (noteHeadline), but trimming the prompt
    // to match would starve theme synthesis of the note bodies it clusters on.
    titleOrGist: n.title || ((n.content || "").length > 150 ? `${n.content.slice(0, 150)}…` : (n.content || "")),
    inferredSource: inferNoteSource(n.title),
  }));

  // 3. Contact memo deltas. See contact-memos.mjs for why this needs a
  // per-contact read and why a failed one must not be counted as zero.
  const contacts = await noanGetAll(`/contacts?per_page=100`);
  const { memosById, failures: memoReadFailures, failureKinds } = await fetchMemosByContact(contacts);
  const failureSummary = [...(failureKinds || new Map())].map(([k, n]) => `${n}× ${k}`).join(", ");
  if (memoReadFailures) log(`  warn: ${memoReadFailures} contact read(s) failed (${failureSummary}) — skipped, not counted as zero`);

  const updatedContactNoteCounts = mergeCounts(priorContactNoteCounts, memosById);
  const { seed: suppressDeltas, why: seedWhy } = shouldSeedBaseline({
    isFirstRun, priorCounts: priorContactNoteCounts, liveCounts: updatedContactNoteCounts,
  });
  const staleBaseline = seedWhy === "stale-baseline";
  if (staleBaseline) log(`  stored baseline empty but ${Object.keys(updatedContactNoteCounts).length} contact(s) have memos — seeding, deltas suppressed this run`);

  const contactNoteDeltas = suppressDeltas
    ? []
    : computeMemoDeltas({ contacts, memosById, priorCounts: priorContactNoteCounts });
  log(`  ${contactNoteDeltas.length} contact memo delta(s), ${standaloneNotes.length} standalone note(s) in window`);

  // 4. Fact updates in-window — full sweep, resolve titles via the in-use catalog.
  const allFacts = await noanGetAll(`/facts?per_page=100`);
  const factsInWindow = allFacts.filter(f => f.createdAt >= windowStartIso && f.createdAt <= windowEndIso);
  const { blockBySlug, stackTitleBySlug } = await loadInUseBlockStackMaps();
  const unresolvedSlugs = [...new Set(factsInWindow.map(f => f.blockSlug).filter(s => !blockBySlug.has(s)))];
  const resolvedUnknown = await resolveUnknownBlocks(unresolvedSlugs);
  const factUpdates = factsInWindow
    .map(f => {
      const b = blockBySlug.get(f.blockSlug) || resolvedUnknown.get(f.blockSlug);
      const blockTitle = b ? b.title : `${f.blockSlug} (block no longer exists)`;
      const stackTitle = b ? (stackTitleBySlug.get(b.stack?.slug) || b.stack?.slug || "unknown stack") : "unknown";
      return { stackTitle, blockTitle, blockSlug: f.blockSlug, updatedDate: f.createdAt.slice(0, 10) };
    })
    .sort((a, b) => a.stackTitle.localeCompare(b.stackTitle) || a.blockTitle.localeCompare(b.blockTitle));
  log(`  ${factUpdates.length} fact update(s) in window`);

  // 5. Assets created in-window — already sorted newest-first, early-stop.
  const assetsRaw = await fetchAssetsInWindow(windowStartIso, windowEndIso);
  const assetsCreated = assetsRaw.map(a => ({ title: a.activeVersion?.title || "(untitled)", tags: (a.tags || []).map(t => t.name) }));
  log(`  ${assetsCreated.length} asset(s) created in window`);

  // 6. Model synthesis: themes + summary
  const result = await runWeeklyActivityReportAgent({
    windowLabel, isFirstRun, baselineSeeded: staleBaseline, tasksCompleted, tasksOpened, factUpdates, assetsCreated, contactNoteDeltas, standaloneNotes, brain,
  });
  log(`  ${result.themes.length} theme(s) identified`);

  // 7. Deliver
  const emails = await fetchGrowthTeamEmails().catch(e => { log(`  warn: recipient lookup failed: ${e.message}`); return []; });

  const dataNotes = [];
  if (isFirstRun) dataNotes.push("First/bootstrap run — no prior state, so contact-note deltas are suppressed this run (baseline-seeding).");
  if (staleBaseline) dataNotes.push("Contact-memo deltas are suppressed this run: the stored baseline was empty because this section had been reading a field the list endpoint does not return, so it reported zero every week. Counts are being seeded now and deltas resume next run — this is a one-off, not a quiet week.");
  if (memoReadFailures) dataNotes.push(`${memoReadFailures} contact record(s) could not be read this run (${failureSummary}); they are excluded from the memo deltas rather than counted as zero.`);
  const gained = contactNoteDeltas.filter(c => !c.replaced);
  if (gained.length) dataNotes.push(`${gained.length} contact(s) gained ${gained.reduce((n, c) => n + c.newNotes.length, 0)} new memo(s) this week. Memos are not listed in this report — they inform the themes above and are read on the contact record itself.`);
  const replaced = contactNoteDeltas.filter(c => c.replaced);
  if (replaced.length) dataNotes.push(`${replaced.length} contact(s) had their note history replaced rather than appended since last run — delta not reliably computable: ${replaced.map(c => c.contactName).join(", ")}.`);
  if (!emails.length) dataNotes.push(`No contacts carry REPORT_RECIPIENT_TAG — this report was not emailed.`);

  const report = renderReport({
    windowLabel, windowStartDate, windowEndDate, isFirstRun, baselineSeeded: staleBaseline, result,
    factUpdates, assetsCreated, standaloneNotes, dataNotes,
  });

  if (DRY_RUN) {
    log("  dry-run: would post this report —\n" + report);
    log(`  dry-run: would email the report recipients (${emails.length} recipient(s)): ${emails.join(", ") || "(none found)"}`);
    return;
  }

  await postNote({
    title: `Weekly Activity Report — ${windowEndDate}`,
    content: report,
    externalId: `weekly-activity-report:${windowStartDate}`,
  });
  log("  posted NOAN note");

  if (emails.length) {
    const { deduped, reason } = await sendReportEmail({
      agent: "weekly-activity-report",
      period: windowStartDate,   // same window identifier as the note's externalId above
      to: emails,
      subject: `Weekly Activity Report — ${windowEndDate}`,
      html: renderReportEmailHtml(report),
      text: report,
    });
    log(deduped
      ? `  email skipped for ${windowStartDate}: ${reason}`
      : `  emailed the report recipients (${emails.length} recipient(s))`);
  } else {
    log("  warn: no contacts carry REPORT_RECIPIENT_TAG — email skipped");
  }

  saveLocalState(STATE_NAME, {
    initialized: true,
    lastRun: nowIso,
    contactNoteCounts: updatedContactNoteCounts,
  });
  log("  saved state");

  log("run complete.");
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
