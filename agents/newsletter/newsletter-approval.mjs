/**
 * Approving an issue without a hand-applied tag.
 *
 * Pure on purpose: everything here is a decision about whether hundreds of
 * people get an email, so it is all testable without a live fact, a live board
 * or a live inbox. The worker does the reads; this file does the judging.
 *
 * No model reads an approval. A commander types a word, code matches it
 * literally, and the bindings are arithmetic. An approval path that
 * needed a model to decide what someone meant would be a worse gate than the
 * tag it replaces.
 */
import { agentName } from "../shared/required-env.mjs";
import { commentText } from "../shared/task-comments.mjs";

/** Anchored at the START of the body, never merely contained in it.
 *  "I would approve this if the CTA were shorter" must not send to 290 people,
 *  which is the whole reason the approvals path upstream anchors the same way. */
const escapeRx = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, m => "\\" + m);
const APPROVE_RX = () => new RegExp("^\\s*(?:@?" + escapeRx(agentName()) + "[,:\\s]+)?(approve[ds]?|send(?:\\s+it)?|go\\s+ahead)\\b", "i");
const DECLINE_RX = () => new RegExp("^\\s*(?:@?" + escapeRx(agentName()) + "[,:\\s]+)?(no|hold|stop|wait|not\\s+yet|don'?t|do\\s+not)\\b", "i");

/**
 * "approve" | "decline" | null.
 *
 * Decline is matched FIRST: "no, don't send" opens with a decline word and
 * also contains "send", and reading that as approval is the one misreading
 * that cannot be taken back.
 */
export function parseApproval(text) {
  const t = String(text || "");
  if (!t.trim()) return null;
  if (DECLINE_RX().test(t)) return "decline";
  if (APPROVE_RX().test(t)) return "approve";
  return null;
}

/**
 * Only an address on COMMANDERS, on either surface, and never the agent
 * itself. `commanders` is the caller's already-resolved set, so an unset
 * COMMANDERS means an empty set means nobody approves - the standing rule,
 * failing closed.
 */
export function isApprover(email, commanders) {
  const e = String(email || "").trim().toLowerCase();
  return Boolean(e && commanders && commanders.has(e));
}

/**
 * What an approval was given FOR, checked again at send time.
 *
 * The version and the tag are equality. The count is a tolerance, because the
 * audience is computed from a live sweep at send time rather than named by a
 * person: this is the only send in the fleet whose recipient list can grow
 * between the yes and the send, so it is the only approval that needs this.
 *
 * Growth only. A list that SHRANK is not a reason to re-ask: nobody receives
 * mail they were not approved for.
 */
export function approvalBindingsOk(approval, { version, tag, recipients, driftPct = 10 } = {}) {
  if (!approval) return { ok: false, reason: "no approval on record" };
  if (approval.declined) return { ok: false, reason: `declined by ${approval.by || "a commander"}; a new test clears it` };
  if (approval.version !== version) {
    return { ok: false, reason: `approved version ${String(approval.version || "?").slice(0, 8)}, ${String(version || "?").slice(0, 8)} is live; test it again` };
  }
  // A test taken before approval binding shipped recorded no tag or count, so
  // there is nothing to check the approval against. Refuse in the same words
  // liveGate uses for its own version-tracking gap rather than comparing
  // against a missing value and telling a commander they approved "null".
  if (approval.tag == null) return { ok: false, reason: "the test this approval refers to predates approval binding; test it again" };
  if (String(approval.tag).toLowerCase() !== String(tag || "").toLowerCase()) {
    return { ok: false, reason: `approved for "${approval.tag}", this send is to "${tag}"` };
  }
  const was = Number(approval.count);
  if (Number.isFinite(was) && was > 0 && Number.isFinite(recipients)) {
    const growth = ((recipients - was) / was) * 100;
    if (growth > driftPct) {
      return { ok: false, reason: `the audience grew from ${was} to ${recipients} (${growth.toFixed(0)}%, over the ${driftPct}% allowed) since it was approved; test and approve it again` };
    }
  }
  return { ok: true };
}

/**
 * The first usable verdict in a task's comments, oldest first.
 *
 * FIRST, not last: the rule is that the first approval wins and later ones are
 * logged. A decline after an approval does not un-send an email that already
 * went, so pretending the last word rules would be a lie about what happened.
 * Comments that are neither are ignored entirely, which is what makes it safe
 * to discuss an issue on its own task.
 */
export function verdictFromComments(comments, commanders) {
  for (const c of comments || []) {
    // NOT a human. normalizeComments marks an agent-authored comment
    // `kind: "self"` (its creator.id is one of the agent's identity ids);
    // there is no `fromAgent` field and checking for one made this guard
    // INERT, so an assistant-written "approve" whose creator address happened
    // to be a commander armed a live send. Both spellings are accepted now
    // because a raw API comment has neither.
    //
    // Which is why the ONLY caller passes normalizeComments(...) and a raw
    // comment must never be passed here: since 2026-09-18 the payload carries
    // no createdByAssistant, so a raw comment has nothing to mark it as the
    // agent's own — `kind` is the entire guard.
    if (c?.kind === "self" || c?.fromAgent) continue;
    const email = c?.creator?.email || c?.email;
    if (!isApprover(email, commanders)) continue;
    const verdict = parseApproval(commentText(c));
    // `at` on a normalized comment, `createdAt` on a raw one.
    if (verdict) return { verdict, by: String(email).toLowerCase(), at: c?.at || c?.createdAt || null, commentId: c?.id || null };
  }
  return null;
}
