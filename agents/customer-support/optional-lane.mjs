/**
 * Optional lanes: modules a worker uses when they are there and does without
 * when they are not.
 *
 * The open-source agent pack ships the six agents and nothing that exists
 * only for our own business. Some of those business lanes ride on the reply
 * worker — re-engagement decks, pre-call briefs, the course, prospector
 * digests — and a static `import` of a file the export cut out would crash
 * the worker at load. So the worker asks for each lane through here instead.
 *
 * Two rules, both deliberate:
 *   - ABSENT is not BROKEN. A lane whose file is missing returns the caller's
 *     fallback (each predicate answering "not this thread"), with
 *     `present: false`. A lane whose file exists but fails to load THROWS —
 *     a syntax error in the fleet must never read as "lane switched off".
 *   - The specifier is built, not literal, so the export's closure walk
 *     (scripts/export-lib.mjs walkClosure, which follows every quoted
 *     "./name.mjs" after a from or a dynamic import, comments included)
 *     cannot see it. That is the point: a lane reaches the pack only
 *     if something imports it statically, and the exporter fails the export
 *     if one does.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The business lanes: modules that exist only for our own company and must
 * never reach the pack. ONE list, read by the exporter (which fails the export
 * if any is statically reachable from a pack worker) and by the shipped sweep
 * in test-generic-config.mjs (which asserts the same in the customer's copy).
 * Every name reply-worker passes to loadLane() must be here, and the sweep
 * checks that too, so a lane cannot be added to one side and not the other.
 */
export const BUSINESS_LANES = Object.freeze([
  "brief-agent.mjs", "brief-core.mjs", "brief-reply.mjs", "changelog.mjs", "ci-alert.mjs",
  "course-agent.mjs", "course-reply.mjs", "course-shared.mjs", "implement-intake.mjs",
  "prospector-replies.mjs", "reengage-reply.mjs",
]);

export async function loadLane(name, fallback = {}, base = import.meta.url) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`loadLane: not a lane name: ${name}`);
  const url = new URL(`./${name}.mjs`, base);
  if (!existsSync(fileURLToPath(url))) return { ...fallback, present: false };
  const mod = await import(url.href);
  return { ...mod, present: true };
}
