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

export const STACK_DESCRIPTION =
  "Operating instructions for the AI agents in this project, not facts about the business. " +
  "Each block belongs to the agent named in its title: an agent follows only its own blocks. " +
  "Agents read these on every run, so editing one changes that agent's next run with no deploy. " +
  "Start with the Agent Index block.";

export const AGENT_INDEX_TITLE = "Agent Index";

export const AGENT_INDEX_DESCRIPTION =
  "Start here: how this stack is organised and how people and agents should use it.";

export const AGENT_INDEX_FACT = `This stack holds operating instructions for the AI agents that work in this project. It holds no facts about the business itself.

How it is organised:
- A block titled **<Name> Agent Config** says what one agent does: what to fetch, how to decide, and when to hand over to a person.
- A block titled **<Name> Playbook** says how that agent's output reads: tone, structure and format. Not every agent has one.
- The name at the start of the title says which agent the block belongs to.

If you are an agent:
- Follow only the blocks that belong to you. Treat any other agent's blocks as a description of how that agent works, never as instructions to you.
- Do not cite this stack as the truth about the business. For what the business offers, charges or believes, and who it serves, read the facts in the other stacks.
- Where a block tells you to do something and a verified business fact says something different about the business, follow the instruction on what to do and the business fact on what is true.
- Do not change these blocks unless a person asks you to.
- Leave this stack out of any audit of the fact base. These blocks are instructions, so they are not gaps, contradictions or overlaps in it.

If you are a person:
- These are starter instructions, written to suit most businesses. Edit them to fit yours.
- An edit changes the agent's next run. No deploy or code change is needed.
- A section headed "Editing this fact" is a note for you. Everything else is read by the agent as its instructions.`;

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
    blocks: [{ title: AGENT_INDEX_TITLE, description: AGENT_INDEX_DESCRIPTION }],
  });
  const id = res?.stack?.id || res?.id;
  if (!id) throw new Error("could not create the Agent Config stack (no id in the create response)");
  log(`  created the "${STACK_TITLE}" stack`);

  // Only on the run that created the stack, so an edited index is never overwritten.
  // A failure here must not lose the agent's own facts, which are written next.
  const index = (res?.stack?.blocks || []).find(b => b.title === AGENT_INDEX_TITLE);
  try {
    if (!index?.slug) throw new Error("no slug for it in the create response");
    await noanPost("/facts", { blockSlug: index.slug, content: AGENT_INDEX_FACT });
    log(`  seeded "${AGENT_INDEX_TITLE}"`);
  } catch (e) {
    log(`  could not seed "${AGENT_INDEX_TITLE}" (${e?.message || e}); add its fact in NOAN by hand`);
  }
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
  log(`project: ${me?.project?.name ?? "?"} · identity: ${me?.identity?.email || me?.identity?.name || "?"}`);
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
