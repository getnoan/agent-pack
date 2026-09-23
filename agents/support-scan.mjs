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

import { taskTriggers, taskHasTag, taskContactId } from "./noan.mjs";
import { addressesAgentRx } from "./task-comments.mjs";

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
