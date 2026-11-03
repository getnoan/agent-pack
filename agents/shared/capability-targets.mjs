/**
 * Capability-fact targets — which document a capability edit lands on
 * (capabilities-split plan workstream 2). "fleet" is the capabilities registry
 * and stays the default, so every pre-split caller keeps its meaning; "app" is
 * the App capabilities block.
 *
 * The fleet registry is a core block (CAPABILITIES_BLOCK_SLUG) plus zero or more
 * group blocks (CAPABILITIES_GROUP_BLOCK_SLUGS, comma-separated).
 * An edit to an existing entry lands on the one block whose headings carry it. With
 * no groups configured nothing is read to decide, and every edit lands on the core
 * block exactly as before.
 *
 * The core sections are wipe canaries: if they are gone the document has been
 * wiped or truncated — build on it and the write makes the damage permanent. The core
 * block's two never move to a group; a group block opens with its own "# " title line,
 * and that line is its canary.
 */
import { noanGet } from "./noan.mjs";

export const CAPABILITIES_CORE_SECTIONS = ["## general", "## How you answer her"];
/** One registry block's working limit, in characters: past it, add a group block. */
export const REGISTRY_BLOCK_LIMIT = 15000;

export const CAPABILITY_TARGETS = {
  fleet: { env: "CAPABILITIES_BLOCK_SLUG",     coreSections: CAPABILITIES_CORE_SECTIONS },
  app:   { env: "APP_CAPABILITIES_BLOCK_SLUG", coreSections: ["## Kill switch", "## Reminders"] },
};

export function capabilityTarget(target = "fleet") {
  const t = CAPABILITY_TARGETS[target];
  if (!t) throw new Error(`unknown capability target "${target}" — use "fleet" or "app"`);
  const slug = process.env[t.env];
  if (!slug) throw new Error(`${t.env} missing`);
  return { slug, coreSections: t.coreSections };
}

/** The group blocks of the fleet registry, in config order. */
export function groupSlugs() {
  return (process.env.CAPABILITIES_GROUP_BLOCK_SLUGS || "").split(",").map(s => s.trim()).filter(Boolean);
}

/** Every block of the fleet registry: the core block first, then the groups. */
export function registrySlugs(coreSlug = process.env.CAPABILITIES_BLOCK_SLUG) {
  return [...new Set([coreSlug, ...groupSlugs()].filter(Boolean))];
}

/** A heading names the entry `name` when it is the name, or the name followed by its
 *  qualifier ("sdr (scheduled)", "pr-review (GitHub-triggered)"). */
export function headingMatches(heading, name) {
  const h = heading.trim().toLowerCase(), n = name.trim().toLowerCase();
  return h === n || h.startsWith(`${n} `) || h.startsWith(`${n}(`);
}

const HEADING_RX = /^##\s+(.+)$/gm;

/** The block an existing entry lives in: { slug, coreSections }. Refuses an entry found in
 *  two blocks. An entry found nowhere resolves to the core block, so the caller's own
 *  "no such section" handling runs exactly as it did before groups existed. */
export async function capabilityBlockFor(name, target = "fleet", { read = blockText } = {}) {
  const base = capabilityTarget(target);
  if (target !== "fleet" || !groupSlugs().length) return base;
  const hits = [];
  for (const slug of registrySlugs(base.slug)) {
    const doc = await read(slug);
    if ([...doc.matchAll(HEADING_RX)].some(m => headingMatches(m[1], name))) hits.push({ slug, doc });
  }
  if (hits.length > 1) throw new Error(`"## ${name}" is in ${hits.length} registry blocks (${hits.map(h => h.slug).join(", ")}) — refusing to guess which one to edit`);
  if (!hits.length || hits[0].slug === base.slug) return base;
  return { slug: hits[0].slug, coreSections: groupCanary(hits[0].slug, hits[0].doc) };
}

/** The target for a NEW entry: the core block, or the group block named by `block`. */
export async function capabilityBlockForNew(block = null, target = "fleet", { read = blockText } = {}) {
  const base = capabilityTarget(target);
  if (!block || block === base.slug) return base;
  if (target !== "fleet" || !groupSlugs().includes(block)) {
    throw new Error(`"${block}" is not a block of the fleet registry (CAPABILITIES_GROUP_BLOCK_SLUGS) — refusing to write`);
  }
  return { slug: block, coreSections: groupCanary(block, await read(block)) };
}

/** A group block's wipe canary: its opening "# " title line. A group without one is
 *  refused, because nothing would prove its document is whole. */
export function groupCanary(slug, doc) {
  const first = String(doc || "").split("\n")[0];
  if (!/^# \S/.test(first)) throw new Error(`registry block ${slug} does not open with a "# " title line — refusing to write without a wipe canary`);
  return [first];
}

async function blockText(slug) {
  const res = await noanGet(`/facts?block_slug=${encodeURIComponent(slug)}&per_page=100`);
  return (res.items || []).map(f => f.content).join("\n\n");
}
