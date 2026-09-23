/**
 * Report handles — the one vocabulary every scheduled report uses so a reply can name an
 * item and a reader (human or the general agent) knows what acting on it means.
 *
 * Why (audit of 2026-09-08): a commander can now
 * reply to a report email with "do 2 and 4" or "go ahead" and it becomes an assigned general
 * task carrying the quoted report. That only has a defined reading if every recommendation
 * is numbered and says whether it is ready to act on or needs a human choice first. The
 * reports are assembled in code from the model's structured answer, so the numbering and
 * the labels are assigned HERE, deterministically — never left to the model's phrasing.
 *
 *   [Specific]         a bounded, concrete item someone can act on as written — for the
 *                      fact-alignment report, a target block AND drafted text both exist.
 *   [Needs a decision] a judgement, a choice between sides, or an outside-system change
 *                      comes first; nothing is written on the strength of "go ahead" alone.
 */
import { agentName, pronouns } from "./required-env.mjs";

export const LABEL_SPECIFIC = "[Specific]";
export const LABEL_DECISION = "[Needs a decision]";

/** The model's per-item classification (growth / product-usage recommendedActions) mapped to
 *  a label. Anything that is not an explicit "specific" is a decision: the bias is toward
 *  the human, so an omitted or malformed kind never turns into an autonomous act. */
export function labelForKind(kind) {
  return kind === "specific" ? LABEL_SPECIFIC : LABEL_DECISION;
}

/** The fixed closing line every report carries, so the reading of a reply is stated on the
 *  report itself rather than only in a playbook the reader may never open. */
export function handleFooterText(example = "do A1") {
  return `Reply to this email naming items ("${example}", or "go ahead" for every ${LABEL_SPECIFIC} item) and ${agentName()} picks it up as a task. ${LABEL_SPECIFIC} items are ready to act on as written; ${LABEL_DECISION} items need a human call first — ${pronouns().subj} will ask, not guess.`;
}

export function handleFooter(example = "do A1") {
  return ["", "## Acting on this report", handleFooterText(example)];
}
