/**
 * Capabilities loading — the two-fact split of the agent's capabilities
 * fact.
 *
 * The single capabilities fact splits into:
 *   FLEET — the agent's capabilities registry: the task types, scheduled agents,
 *           Slack, integrations — the routing menu. A core block (existing block,
 *           existing slug) plus zero or more group blocks
 *           (CAPABILITIES_GROUP_BLOCK_SLUGS), read
 *           together as one document.
 *   APP   — the app capabilities fact (new sibling block): what the desktop
 *           app can do on a person's Mac.
 *
 * The rule for who reads what: routing menus get FLEET only; anything that
 *  answers "can the agent do X?" gets BOTH (a partial view makes the agent
 * publicly deny capabilities it has). A partial FLEET is the same failure, so
 * nothing reads the core block alone to answer either question.
 *
 * When APP_CAPABILITIES_BLOCK_SLUG is unset, every reader must treat the empty
 * app text as "not split" and use FLEET alone.
 */
import { noanGet } from "../shared/noan.mjs";
import { registrySlugs } from "../shared/capability-targets.mjs";

export const FLEET_CAPS_SLUG = () => process.env.CAPABILITIES_BLOCK_SLUG || "";
export const APP_CAPS_SLUG = () => process.env.APP_CAPABILITIES_BLOCK_SLUG || "";

async function factText(slug) {
  if (!slug) return "";
  const res = await noanGet(`/facts?block_slug=${encodeURIComponent(slug)}`);
  return (res.items || []).map(f => f.content).join("\n\n").trim();
}

/** Is this slug one of the fleet registry's blocks (core or group)? */
export function isRegistrySlug(slug, coreSlug = FLEET_CAPS_SLUG()) {
  const s = String(slug || "").trim().toLowerCase();
  return !!s && registrySlugs(coreSlug).some(r => r.toLowerCase() === s);
}

/**
 * The whole fleet registry as one document: the core block, then each group in
 * config order. "" when no core block is configured. A group that fails to read
 * throws rather than quietly shrinking the menu.
 */
export async function loadFleetCapabilities(coreSlug = FLEET_CAPS_SLUG()) {
  if (!coreSlug) return "";
  const texts = await Promise.all(registrySlugs(coreSlug).map(factText));
  return texts.filter(Boolean).join("\n\n");
}

/** The registry in GET /facts shape, for code that checks whether an entry exists. */
export async function registryFacts(coreSlug = FLEET_CAPS_SLUG()) {
  return { items: [{ content: await loadFleetCapabilities(coreSlug) }] };
}

/**
 * Load both capability texts. `app` is "" when the split has not happened
 * (or on an install that predates it) — never an error.
 * `combined` is the both-readers' convenience: fleet + app, joined.
 */
export async function loadCapabilityTexts() {
  const [fleet, app] = await Promise.all([
    loadFleetCapabilities(),
    factText(APP_CAPS_SLUG()).catch(() => ""),
  ]);
  return { fleet, app, combined: [fleet, app].filter(Boolean).join("\n\n") };
}

/**
 * GET /facts for a model's get_facts tool. A read of the core block returns the whole
 * registry once groups exist, so a model that asks for "the capabilities block" never
 * sees part of the menu (the 2026-08-18 public denial). Every other slug, and the core
 * block while there are no groups, is the plain read.
 */
export async function factsForModel(slug) {
  const core = FLEET_CAPS_SLUG();
  if (core && String(slug).trim().toLowerCase() === core.toLowerCase() && registrySlugs(core).length > 1) {
    return registryFacts(core);
  }
  return noanGet(`/facts?block_slug=${encodeURIComponent(slug)}&per_page=100`);
}

/** A get_facts tool's per-fact character cap for `slug`. Once the registry has groups, a
 *  registry block is never cut, since a cut registry is the partial menu factsForModel exists
 *  to prevent (the joined registry is sized to fit the tool result). With no groups the cap is
 *  unchanged, so a single oversized registry fact is cut exactly as before. */
export function modelCap(slug, cap) {
  return registrySlugs().length > 1 && isRegistrySlug(slug) ? Infinity : cap;
}
