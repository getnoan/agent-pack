#!/usr/bin/env node
/**
 * Shared seeding helper for the agent pack's starter Config and Playbook facts.
 *
 * Every agent in this pack reads its operating instructions from NOAN facts at run
 * time, not from code. This module puts the starter versions of those facts into
 * your project once, so the agents have something to read on day one. After that
 * they are yours: edit them in the NOAN app and the next run behaves differently,
 * with no deploy and no code change.
 *
 * DOCTRINE — idempotent and additive-only, and the distinction matters:
 *   - A block is created only when it is missing.
 *   - A fact is written ONLY when this code created the block in the same run.
 * POST /facts REPLACES a block's entire fact, so writing to a block we did not
 * create could destroy tuning a user did by hand. Re-running this is therefore
 * always safe: on a provisioned workspace it is a no-op that reports what it
 * found and changes nothing.
 *
 * Used by every seed-*.mjs in this pack and by the pack's bootstrap registry.
 */

import { noanGet, noanGetAll, noanPost } from "./noan.mjs";

export const STACK_TITLE = process.env.AGENT_CONFIG_STACK_TITLE || "Agent Config";

const STACK_DESCRIPTION =
  "Operating instructions for your NOAN agents. Each agent reads these facts at run time, " +
  "so editing one here changes how that agent behaves on its next run — no deploy needed.";

/**
 * Find the custom Agent Config stack, creating it if absent.
 * POST /stacks requires at least one block, so a placeholder block is supplied
 * on creation; callers then ensure their own blocks against the returned id.
 */
export async function ensureAgentConfigStack({ log = console.log } = {}) {
  const stacks = await noanGetAll("/stacks?custom_only=true");
  const hit = (stacks || []).find(
    s => (s.title || "").trim().toLowerCase() === STACK_TITLE.trim().toLowerCase()
  );
  if (hit) return { id: hit.id, created: false };

  const res = await noanPost("/stacks", {
    title: STACK_TITLE,
    description: STACK_DESCRIPTION,
    blocks: [{ title: "Agent Index", description: "What each agent in this project is for." }],
  });
  const id = res?.stack?.id || res?.id;
  if (!id) throw new Error("could not create the Agent Config stack (no id in the create response)");
  log(`  created the "${STACK_TITLE}" stack`);
  return { id, created: true };
}

/** Find a block by title within the project, creating it in `stackId` if absent. */
export async function ensureBlock(stackId, title, description) {
  const blocks = await noanGetAll("/blocks?in_use_only=true");
  const hit = (blocks || []).find(
    b => (b.title || "").trim().toLowerCase() === title.trim().toLowerCase()
  );
  if (hit) return { slug: hit.slug, created: false };

  const res = await noanPost(`/stacks/${stackId}/blocks`, { title, description });
  const slug = res?.block?.slug || res?.slug;
  if (!slug) throw new Error(`could not create block "${title}" (no slug in the create response)`);
  return { slug, created: true };
}

/**
 * Seed one agent's facts.
 *
 * @param {object}   spec
 * @param {string}   spec.agent   human name, for logging
 * @param {Array<{title,description,content,envVar}>} spec.blocks
 * @returns {Promise<Record<string,string>>} envVar -> block slug, for .env
 */
export async function seedAgentFacts({ agent, blocks }, { log = console.log } = {}) {
  const me = await noanGet("/me");
  log(`project: ${me?.project?.name ?? "?"} · identity: ${me?.identity?.email ?? "?"}`);
  log(`seeding starter facts for: ${agent}`);

  const { id: stackId } = await ensureAgentConfigStack({ log });
  const env = {};
  let wrote = 0;

  for (const b of blocks) {
    const { slug, created } = await ensureBlock(stackId, b.title, b.description);
    env[b.envVar] = slug;
    if (created) {
      await noanPost("/facts", { blockSlug: slug, content: b.content });
      log(`  seeded "${b.title}"`);
      wrote++;
    } else {
      log(`  "${b.title}" already exists — left untouched`);
    }
  }

  log(wrote ? `\n${wrote} fact(s) written.` : "\nNothing to do — everything was already in place.");
  log("\nAdd to .env:");
  for (const [k, v] of Object.entries(env)) log(`${k}=${v}`);
  log(
    "\nThese are starter instructions. Open them in NOAN and edit them to fit your business — " +
    "the agents read them fresh on every run."
  );
  await groundingCheck(agent, log);
  return env;
}

/** The agent also reads business facts that start empty. The check (shipped by the
 *  export as grounding-check.mjs) files one task per empty block; absent module = skip. */
async function groundingCheck(agent, log) {
  let mod;
  try { mod = await import("./grounding-check.mjs"); }
  catch (e) { if (e?.code === "ERR_MODULE_NOT_FOUND") return; throw e; }
  const agents = mod.agentsFor(agent);
  if (!agents.length) return;
  log(`\nBlocks the ${agents.join(", ")} agent reads:`);
  const r = await mod.checkGrounding({ agents, log });
  if (!r.gaps.length) { log("  every one holds a fact."); return; }
  log(`  ${r.gaps.length} hold no fact — ${r.filed.filter(f => f.action === "filed").length} task(s) filed on your board, ${r.filed.filter(f => f.action === "already filed").length} already there.`);
}

/** Small wrapper so each seed script is `runSeed(spec)` and nothing else. */
export function runSeed(spec) {
  seedAgentFacts(spec).catch(e => {
    console.error(e?.message || e);
    process.exit(1);
  });
}
