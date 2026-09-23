/**
 * Capabilities loading — the two-fact split of the agent's capabilities
 * fact.
 *
 * The single capabilities fact splits into:
 *   FLEET — the agent's capabilities fact (existing block, existing slug): the task
 *           types, scheduled agents, Slack, integrations — the routing menu.
 *   APP   — the app capabilities fact (new sibling block): what the desktop
 *           app can do on a person's Mac.
 *
 * The rule for who reads what: routing menus get FLEET only; anything that
 *  answers "can the agent do X?" gets BOTH (a partial view recreates the
 * 2026-08-18 public capability-denial incident).
 *
 * APP_CAPABILITIES_BLOCK_SLUG is unset until the migration runs — every
 * reader must treat an empty app text as "not split yet" and behave exactly
 * as before, which is why this ships ahead of the migration.
 */
import { noanGet } from "./noan.mjs";

export const FLEET_CAPS_SLUG = () => process.env.CAPABILITIES_BLOCK_SLUG || "";
export const APP_CAPS_SLUG = () => process.env.APP_CAPABILITIES_BLOCK_SLUG || "";

async function factText(slug) {
  if (!slug) return "";
  const res = await noanGet(`/facts?block_slug=${encodeURIComponent(slug)}`);
  return (res.items || []).map(f => f.content).join("\n\n").trim();
}

/**
 * Load both capability texts. `app` is "" when the split has not happened
 * (or on an install that predates it) — never an error.
 * `combined` is the both-readers' convenience: fleet + app, joined.
 */
export async function loadCapabilityTexts() {
  const [fleet, app] = await Promise.all([
    factText(FLEET_CAPS_SLUG()),
    factText(APP_CAPS_SLUG()).catch(() => ""),
  ]);
  return { fleet, app, combined: [fleet, app].filter(Boolean).join("\n\n") };
}
