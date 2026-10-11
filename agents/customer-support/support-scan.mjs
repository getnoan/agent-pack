/**
 * Support-task scan rules (reply-worker.mjs scanSupportTasks) — the pure part,
 * split out so it can be tested; reply-worker runs its poll on import.
 *
 * A backlog task tagged `support` and assigned to the agent is its cue to open a
 * support conversation with the task's contact. Two things used to make a
 * task disappear from that scan for good (until 2026-09-10):
 *
 *   - no contact resolved → escalate() and a ledger entry {status:"no-contact"};
 *   - the outreach draft failed its guards → escalate() and {status:"escalated"};
 *
 * and the scan skipped ANY ledgered task. Linking the contact afterwards and
 * re-assigning the agent did nothing: the entry was permanent. Every escalation
 * filed by an external intake is filed without a contact until
 * the platform can link one at filing time, so that was the normal case, not the edge.
 *
 * Since 2026-09-10 those two outcomes PARK the task instead (parkForHuman:
 * needs-human, the agent off, the CS owner on) and write nothing to the ledger. Parked
 * means unassigned, and unassigned does not trigger — so re-assigning the agent
 * is the retry, the fleet's own convention, with no expiry logic and no
 * re-scan cost. The ledger keeps only `sent`, which is the one outcome a
 * second scan must never repeat. Older `no-contact` / `escalated` entries are
 * therefore retryable, not blocking.
 */

import { taskTriggers, taskHasTag, taskContactId } from "../shared/noan.mjs";
import { addressesAgentRx } from "../shared/task-comments.mjs";

export const DEFAULT_SUPPORT_TAG = "support";
export const PARK_TAG_NAME = "needs-human";

/** Legacy producers still emit "[support] …" titles; accept them until every
 *  producer is on tags. */
const LEGACY_TITLE_RX = /^\s*\[support\]/i;

/** True when this task should be worked on this scan. Only a SENT ledger
 *  entry blocks: everything else is either parked (unassigned, so it does not
 *  trigger anyway) or a pre-2026-09-10 entry that must not block a retry. */
export function supportTaskDue(task, ledgerEntry, { triggerTag = DEFAULT_SUPPORT_TAG } = {}) {
  if (!task || task.completed) return false;
  if (ledgerEntry?.status === "sent") return false;
  return taskTriggers(task, triggerTag) || (LEGACY_TITLE_RX.test(task.title || "") && !task.completed);
}

/** The tasks to work this scan, oldest first, capped. */
export function supportScanCandidates(tasks, ledger = {}, { triggerTag = DEFAULT_SUPPORT_TAG, limit = 3 } = {}) {
  return (tasks || [])
    .filter(t => supportTaskDue(t, ledger[t.id], { triggerTag }))
    .sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")))
    .slice(0, limit);
}

/** Contact for the outreach: a `Contact ID:` line in the details wins, else
 *  exactly one linked contact. Same rule as noan.taskContactId; re-exported
 *  under the lane's name so the worker and the test read the same thing. */
export function supportTaskContactId(task) {
  return taskContactId(task);
}

/** Tag ids to PUT when a re-assigned task is picked up again: everything it
 *  carries minus needs-human. `null` when it was not parked (no PUT needed). */
export function unparkedTagIds(task) {
  if (!taskHasTag(task, PARK_TAG_NAME)) return null;
  return (task.tags || []).filter(t => String(t.name || "").toLowerCase() !== PARK_TAG_NAME).map(t => t.id);
}

/* ---------------- comments as the hand-back (2026-09-10) ----------------
 *
 * Until now the support lane had exactly one door back in: re-assign the agent in
 * the NOAN UI. A teammate commenting on a parked support task got silence —
 * the reply worker never read comments, only the general, deck, demo and
 * sdr-reply lanes did (task-comments.mjs). Now a teammate comment that
 * addresses it re-arms the task: needs-human cleared, the agent assigned, and
 * the comment text rides into the outreach draft as guidance.
 *
 * Deliberately narrow, decided in code:
 *   - only a TEAMMATE comment (commander or the teammate domain, API-verified author;
 *     external comments are logged and dropped, the agent's own never count);
 *   - only one that addresses it: mentions the agent's name (with or without @) or
 *     starts with "retry" / "go ahead" / "go". A teammate writing "waiting on
 *     the customer" on their own task must not summon the agent;
 *   - only on a backlog support task the agent is NOT on — one it is on is
 *     already its own, and a done task is never re-armed;
 *   - only comments newer than the task's cursor and than the lane's
 *     baseline (the first run with this code), so deploying it does not
 *     re-arm every old escalation somebody once commented on.
 */

// one grammar for the whole fleet — see task-comments.mjs
// The agent's name is read at call time (AGENT_NAME), so this is a test()-shaped
// wrapper rather than a RegExp built once at import.
export const SUPPORT_REARM_RX = { test: text => addressesAgentRx().test(text) };

/** The fresh teammate comments on `task` since `cursor`/`since`, and which of
 *  them re-arm. `steering` is task-comments' steeringComments(task, opts),
 *  passed in so this module stays free of the commanders config. Returns
 *  { fresh, rearm } — `rearm` is the newest addressing comment or null. */
export function supportCommentRearm(task, steering, { cursor = null, since = null } = {}) {
  if (!task || task.completed || task.status === "done") return { fresh: [], rearm: null };
  if (taskTriggers(task, DEFAULT_SUPPORT_TAG)) return { fresh: [], rearm: null };   // already the agent's
  const floor = [cursor, since].filter(Boolean).sort().pop() || null;
  const fresh = (steering || []).filter(c => c.kind === "teammate" && (!floor || c.at > floor));
  const addressing = fresh.filter(c => SUPPORT_REARM_RX.test(c.text));
  return { fresh, rearm: addressing.length ? addressing[addressing.length - 1] : null };
}

/* ---------------- expired cases close their task (2026-10-07) ----------------
 *
 * A support task opens a case, the task goes in-progress, and only
 * closeCaseTask() takes it out again — which ran solely when the CUSTOMER
 * replied and the case resolved or escalated. pruneCases() marks an unanswered
 * case `expired` after CASE_EXPIRY_DAYS and did nothing else, so every outreach
 * that got no reply left its task in-progress for good. Found on a one-way
 * correction that by design expected no reply; every task-opened case on the
 * ledger that day had one turn and had been closed, if at all, by hand.
 *
 * Now an expired case with a task PARKS that task: the outreach went out and
 * nobody answered, which is a person's call (close it, or follow up), not the
 * agent's. Re-assigning the agent does not re-send — the `sent` ledger entry
 * still blocks — so the comment says what the options actually are.
 *
 * `taskSettled` on the case makes this run once per case. A task the board
 * read did not return (pagination drops rows; or it was deleted) is retried on
 * later polls and given up after EXPIRED_TASK_MAX_MISSES, so one vanished task
 * cannot cost a full board walk every poll forever. */

export const EXPIRED_TASK_MAX_MISSES = 3;

/** Cases whose task still needs settling, as [email, case] pairs. */
export function expiredCasesToSettle(cases = {}) {
  return Object.entries(cases || {}).filter(([, c]) => c?.status === "expired" && c.taskId && !c.taskSettled);
}

/** What to do with an expired case's task, given the live task (or undefined).
 *  "park"     — still open: hand it to a person.
 *  "settled"  — already closed (a person got there first): nothing to do.
 *  "retry"    — not on the board read: try again next poll.
 *  "give-up"  — missing EXPIRED_TASK_MAX_MISSES times: stop looking. */
export function expiredCaseAction(kase, task) {
  if (!task) return (kase?.settleMisses || 0) + 1 >= EXPIRED_TASK_MAX_MISSES ? "give-up" : "retry";
  if (task.completed || task.status === "done") return "settled";
  return "park";
}

/** The comment left on a parked task. Says what happened and what re-assigning
 *  will NOT do, since the obvious retry is a no-op here. */
export function expiredCaseComment(kase, { agentName = "the agent", expiryDays = 14 } = {}) {
  const sent = String(kase?.openedAt || "").slice(0, 10) || "earlier";
  return `No reply in ${expiryDays} days to the outreach sent ${sent}${kase?.subject ? ` ("${kase.subject}")` : ""}, so the support case has expired. ` +
    `Close this task if nothing more is needed, or follow up with the contact yourself. ` +
    `Re-assigning ${agentName} will not send it again.`;
}
