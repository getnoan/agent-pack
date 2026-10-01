/**
 * The platform's managed "Legacy" stack: where retired blocks are moved, "kept here so you
 * don't lose the facts you added to them". Every project has one, it is always in use, and the
 * public API has no way to mark a stack not-in-use (only POST /stacks/{id}/use). So a reader
 * that takes "in use" or "every fact" as its corpus pulls retired truth in: one workspace
 * measured 2026-09-29 held 43 such facts, one still quoting plans that no longer exist.
 *
 * One predicate, shared by every fact reader (the agent's search by email and in Slack, fact
 * alignment, doc intake, the Slack stale-fact review and stack lists). Identified by slug AND
 * the managed flag, never by title: a customer can create their own custom stack called
 * "Legacy" and it is theirs to search. A block carries its stack as { id, slug, title, managed }
 * (checked live 2026-09-29), and a stack from /stacks carries slug and managed itself.
 */

export const RETIRED_STACK_SLUG = "legacy";

/** A stack object (from /stacks, or a block's `stack`) that is the platform's managed Legacy stack. */
export const isRetiredStack = (stack) => Boolean(stack) && stack.slug === RETIRED_STACK_SLUG && stack.managed === true;

/** A block (from /blocks) that sits in the managed Legacy stack. */
export const isRetiredBlock = (block) => isRetiredStack(block?.stack);

/** Slugs of the retired blocks in a /blocks list. */
export const retiredBlockSlugs = (blocks) => new Set((blocks || []).filter(isRetiredBlock).map(b => b.slug));

/** Facts minus those on retired blocks. `blocks` is the /blocks list the facts are matched
 *  against; a fact whose block is not in it is left for the caller's own rule (deleted blocks). */
export function withoutRetiredFacts(facts, blocks) {
  const retired = retiredBlockSlugs(blocks);
  return retired.size ? (facts || []).filter(f => !retired.has(f.blockSlug)) : (facts || []);
}
