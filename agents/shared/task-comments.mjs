/**
 * Task comments as a steering channel. Read side only. Pure: no network, no
 * state. The worker owns the cursor (its journal's `commentCursor`, an ISO
 * createdAt) and passes the task it fetched.
 *
 * A comment from GET /tasks is exactly { id, content: "<string>", createdAt,
 * creator: { id, name, email } }. Build nothing that expects other fields
 * (content.plainText, createdByAssistant, removedAt and the rest): they are
 * gone for good.
 *
 * Each comment is one of three kinds, decided in code, never by the model:
 *   teammate: creator is a commander or on the teammate domain. It steers: it
 *             wakes a waiting task and counts as the requester's own words for
 *             the code-verified approval gates.
 *   self:     creator.id is one of the agent's identities, or the text carries
 *             the agent marker (agent-comment.mjs). Never steering, so the
 *             agent's own status comments cannot wake it.
 *   external: anyone else with board access. Logged and dropped, never shown
 *             to the model: a comment is an injection surface.
 * A comment relayed from Slack belongs to its verified speaker, never to the
 * key owner; unverified, it belongs to nobody (slack-relayed.mjs).
 *
 * A comment is attributed to the OWNER of the key that posted it, with no agent
 * flag in the payload. An agent comment without the marker, posted with a
 * person's key, reads back as that person's instruction and reaches the
 * approval gates. The marker and assertAgentIdentity (noan.mjs) guard this.
 * A comment with no creator.email is dropped as external and logged as
 * UNCLASSIFIED. That is the fail-closed direction: work stalls, nothing fires.
 * Soft-deleted comments never arrive, so there is no client-side filter.
 * Edits do not re-wake; only a new comment does, since the cursor is createdAt.
 */

import { verityIds } from "./noan.mjs";
import { hasAgentMarker, verifyAgentComment, stripSignature } from "./agent-comment.mjs";
import { parseRelayed, verifyRelayed } from "./slack-relayed.mjs";
import { isTeammateEmail, agentName } from "./required-env.mjs";

/** Same rule as general-tools' teammateAllowed — kept local so this module
 *  stays importable without the belt's third-party clients. Every worker parses
 *  COMMANDERS the same way, and every one of them defaults to empty. */
export function defaultCommanders() {
  // Unset means NOBODY steers. A built-in roster would travel into the public
  // agent pack and let our teammates steer a stranger's agents.
  return new Set(
    (process.env.COMMANDERS || "")
      .split(",").map(s => s.trim().toLowerCase()).filter(Boolean));
}

function isTeammate(email, commanders) {
  return isTeammateEmail(email, commanders);
}

/** A comment's text, whichever shape it arrives in.
 *
 *  Raw from GET /tasks, `content` is a plain string. Already normalised, the
 *  text is on `text`. Anything else (an object, a
 *  number, absent) is "", which drops the comment rather than stringifying
 *  "[object Object]" into a steering channel.
 *
 *  Deliberately no `content.plainText` fallback: that shape is never coming
 *  back, so a fallback would only hide the next reshape. */
export function commentText(c) {
  const v = c?.text ?? c?.content;
  return typeof v === "string" ? v.trim() : "";
}

/** Normalise a task's comments: empties dropped, oldest first, each classified
 *  as teammate / self / external. */
export function normalizeComments(task, { commanders = defaultCommanders(), selfIds = verityIds() } = {}) {
  const self = new Set(selfIds);
  const out = [];
  for (const c of task?.comments || []) {
    if (!c) continue;
    const raw = commentText(c);
    if (!raw) continue;
    let text = stripSignature(raw);
    let email = String(c.creator?.email || c.email || "").toLowerCase().trim();
    let via = null;
    const creatorId = c.creator?.id || c.creatorId || null;
    let kind = "external";
    // Two ways a comment is the agent's own, and the second carries the weight:
    // creator.id only works where the key is genuinely the agent's identity,
    // which a deployment running under a person's key cannot arrange. The
    // marker travels in the comment itself. See agent-comment-marker.json.
    //
    // ORDER MATTERS: this is checked before the Slack relay below. A relayed
    // comment carries a person's words; if it were ever posted with the
    // AGENT's own key, creator.id would make it "self" and the person's words
    // would be ignored. Relays are posted with the workspace owner's key by
    // design. Keep it that way when the other keys move under the agent.
    if (creatorId && self.has(creatorId)) kind = "self";
    else if (hasAgentMarker(raw)) {
      kind = "self";
      // Recognised by shape, so a bad signature does NOT reclassify it as a
      // teammate's — that would be the dangerous direction. Say so instead:
      // it means a rotated/missing secret, or someone imitating the marker.
      const v = verifyAgentComment(raw, task?.id);
      if (!v.valid) {
        console.warn(`task-comments: comment ${c.id} carries the agent marker but does not verify (${v.reason}) — treated as the agent's own and ignored`);
      }
    }
    // Words carried from a Slack thread arrive under the key of whoever owns
    // the hosted connection, usually a commander. Attribution by creator would
    // turn any member's "send it" into that commander's. So a relayed comment
    // is never the key owner's: verified, it is the SPEAKER's, judged by the
    // speaker's address; unverified, it is nobody's. See slack-relayed.mjs.
    else if (parseRelayed(raw).relayed) {
      const v = verifyRelayed(raw, task?.id);
      if (v.valid) { email = v.email; text = v.text; via = "slack"; if (isTeammate(email, commanders)) kind = "teammate"; }
      else { email = ""; console.warn(`task-comments: comment ${c.id} was relayed from Slack but cannot be verified (${v.reason}) — dropped, it steers and approves nothing`); }
    }
    else if (isTeammate(email, commanders)) kind = "teammate";
    // A comment that is not ours and carries no address cannot be told from a
    // stranger's, so it is dropped as external — correct, but indistinguishable
    // from "nobody commented" unless it is said out loud.
    if (kind === "external" && !email && !parseRelayed(raw).relayed) {
      console.warn(`task-comments: UNCLASSIFIED comment ${c.id} — no creator.email on the payload, dropped as external`);
    }
    out.push({
      id: c.id, at: String(c.createdAt || ""), email, name: via ? `${email} (via Slack)` : (c.creator?.name || email || "unknown"),
      text, kind, via,
    });
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Comments newer than the cursor (ISO createdAt). No cursor → every comment. */
export function commentsSince(comments, cursor) {
  if (!cursor) return comments.slice();
  return comments.filter(c => c.at > cursor);
}

/** The cursor after seeing these comments: the newest createdAt, never older
 *  than the previous cursor. */
export function latestCursor(comments, prev = null) {
  let cur = prev || null;
  for (const c of comments) if (c.at && (!cur || c.at > cur)) cur = c.at;
  return cur;
}

/** Does this comment ADDRESS the agent — the fleet's one rule for "wake up /
 *  hand it back".
 *  Mentions the agent's name (with or without @), or starts with "retry" /
 *  "go ahead" / "go". A teammate writing "waiting on the customer" on their
 *  own task must not summon the agent.
 *
 *  Deliberately SEPARATE from the verb grammar in comment-grammar.mjs,
 *  which answers what a comment asks for on a task an
 *  agent already owns. This one answers whether a PARKED task comes back at
 *  all. Folding them together would make a bare "send" re-arm a parked
 *  general task, which is a behaviour change, not a de-duplication. */
const escapeRx = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, m => "\\" + m);
/** The agent's name comes from AGENT_NAME at call time, never a literal: a
 *  downstream copy named something else must wake on its own name. */
export function addressesAgentRx() {
  return new RegExp("(^|[\\s(])@?" + escapeRx(agentName()) + "\\b|^\\s*(retry|go ahead|go)\\b", "i");
}
export function addressesAgent(text) {
  return addressesAgentRx().test(String(text || ""));
}

/** Teammate comments only — the ones that steer. */
export function steeringComments(task, opts) {
  return normalizeComments(task, opts).filter(c => c.kind === "teammate");
}

function stamp(iso) {
  return String(iso || "").slice(0, 16).replace("T", " ");
}

/** One comment as a code-stamped line, the same shape as the `[Note] Reply
 *  from …` entries the reply worker writes, so everything downstream that
 *  reads teammate text (the approval regexes, the grants classifier) reads a
 *  comment the same way. */
export function renderComment(c) {
  return `[Comment] ${c.name} <${c.email}> (${stamp(c.at)}):\n${c.text}`;
}

export function renderComments(comments) {
  return comments.map(renderComment).join("\n\n");
}

/** The lower-cased teammate comment text on a task — what the code-verified
 *  gates (approve_pending, requesterWroteAddress, requesterNamedTag) search
 *  alongside the teammate-authored part of the description. Self and external
 *  comments contribute nothing. */
export function teammateCommentText(task, opts) {
  return steeringComments(task, opts).map(c => c.text).join("\n").toLowerCase();
}
