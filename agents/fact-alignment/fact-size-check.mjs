/**
 * Fact size check: which facts are near or past the size a fact may have.
 *
 * The fact API's published cap is 20,000 characters. A fact past it cannot be rewritten once the
 * cap is enforced (every write tool posts the whole document), so it has to be split while it
 * still can be. This is the check that keeps every fact under it: the weekly fact-alignment
 * report lists, in code, every fact at or past WARN, every fact past MAX, and every block of
 * the capabilities registry past that registry's own working limit (capability-targets.mjs),
 * where a new group block is the fix rather than a split.
 *
 * Pure: it takes the facts the run already loaded, and renders lines. No API calls.
 */
import { REGISTRY_BLOCK_LIMIT } from "../shared/capability-targets.mjs";

export const SIZE_LIMITS = Object.freeze({ warn: 18000, max: 20000, registryBlock: REGISTRY_BLOCK_LIMIT });

/**
 * Findings, largest first. `facts` are objects with `blockSlug` and `content`; `registry` is the
 * capabilities registry's block slugs. Each finding is { slug, chars, level, limit }:
 *   over      past MAX: split it now
 *   near      at or past WARN: plan the split before it grows
 *   registry  a registry block past its working limit: add a group block
 */
export function factSizeFindings(facts, { registry = [] } = {}) {
  const reg = new Set(registry.map(s => String(s).toLowerCase()));
  const out = [];
  for (const f of facts || []) {
    const chars = String(f?.content || "").length;
    const slug = f?.blockSlug || "(unknown block)";
    if (chars > SIZE_LIMITS.max) out.push({ slug, chars, level: "over", limit: SIZE_LIMITS.max });
    else if (reg.has(slug.toLowerCase()) && chars > SIZE_LIMITS.registryBlock) out.push({ slug, chars, level: "registry", limit: SIZE_LIMITS.registryBlock });
    else if (chars >= SIZE_LIMITS.warn) out.push({ slug, chars, level: "near", limit: SIZE_LIMITS.max });
  }
  return out.sort((a, b) => b.chars - a.chars);
}

const n = (x) => x.toLocaleString("en-US");
const WHAT = {
  over: (f) => `${n(f.chars)} chars, past the ${n(f.limit)} cap: split it now, while it can still be rewritten`,
  registry: (f) => `${n(f.chars)} chars, past the registry's ${n(f.limit)} working limit: move entries to a new group block`,
  near: (f) => `${n(f.chars)} chars, within ${n(f.limit - f.chars)} of the ${n(f.limit)} cap: plan the split before it grows`,
};

/** The report section, or [] when every fact is comfortably under. Rendered only when it has
 *  something to say, like Malformed Captures: a standing empty section trains a skim. */
export function renderFactSizes(findings) {
  if (!findings?.length) return [];
  return [
    "", "## Fact Sizes",
    `Facts at or past ${n(SIZE_LIMITS.warn)} characters, of NOAN's ${n(SIZE_LIMITS.max)} cap. A fact past the cap cannot be rewritten once the cap is enforced, so split it while it can be; a capabilities registry block has its own ${n(SIZE_LIMITS.registryBlock)} limit. Checked in code every run.`,
    "",
    findings.map(f => `- \`${f.slug}\`: ${WHAT[f.level](f)}`).join("\n"),
  ];
}

/** One Summary line, or null. */
export function factSizesSummary(findings) {
  if (!findings?.length) return null;
  const over = findings.filter(f => f.level !== "near").length;
  return over
    ? `${over} fact(s) past a size limit and ${findings.length - over} near it — see Fact Sizes.`
    : `${findings.length} fact(s) within ${n(SIZE_LIMITS.max - SIZE_LIMITS.warn)} characters of the ${n(SIZE_LIMITS.max)} cap — see Fact Sizes.`;
}
