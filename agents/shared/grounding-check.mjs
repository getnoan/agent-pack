#!/usr/bin/env node
/**
 * Grounding check: does the workspace hold the facts each agent reads?
 *
 * The agents' operating instructions live in the Agent Config facts, but the
 * agents also ground their work in BUSINESS facts — the product FAQ the support
 * agent answers from, the positioning and ideal-customer blocks the deck and the
 * market research are written against. Those are managed blocks every workspace
 * has, so nothing needs creating; but they start empty, and an agent grounded in
 * an empty block fails quietly: support escalates everything, research writes
 * from nothing, decks come out thin. Nobody is told why.
 *
 * This turns that into work on the board. For every block an agent reads that
 * holds no fact, it files ONE task — "Fill Product FAQs so the customer support
 * agent can answer product questions from your facts" — deduplicated on an
 * externalId so re-running never doubles up. Run by the seed scripts after
 * seeding, by the wizard's agents step, or by hand:
 *
 *   node --env-file=.env grounding-check.mjs [--agent "customer support"] [--dry-run] [--json]
 *
 * The table below is the single statement of what each agent reads. The test
 * (test-grounding-check.mjs) pins it to the workers' own lists, so it cannot
 * drift from the code that does the reading.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { noanGet, noanPost, noanPut, findTaskByExternalId } from "./noan.mjs";
import { DESIGN_DIR } from "./pack-paths.mjs";

/** The deck's slugs come from its config (design/config.json, else the example). */
export function deckSlugs(designDir = DESIGN_DIR) {
  for (const f of ["config.json", "config.defaults.json", "config.example.json"]) {
    const p = path.join(designDir, f);
    if (!existsSync(p)) continue;
    try {
      const s = JSON.parse(readFileSync(p, "utf8")).deck_fact_slugs || {};
      const out = [s.visual, ...(s.value || []), s.design_system].filter(Boolean);
      if (out.length) return out;
    } catch {}
  }
  return [];
}

/** What each agent reads, and why a stranger should fill it. Managed slugs unless noted. */
export const GROUNDING = {
  "customer support": {
    why: "answer product questions from your facts instead of escalating them",
    slugs: ["product-faq", "product-features", "product-list"],
  },
  "market research": {
    why: "research the market against what the company already knows about itself and its customers",
    slugs: [
      // company context — the same list market-research-refresh-worker.mjs grounds Company Context in
      "product-list", "product-strategy", "product-roadmap", "product-faq", "monetization-model",
      "business-vision", "mission-vision", "value-proposition", "brand-positioning",
      // ICP — what Customer Insights is anchored to
      "ideal-customer", "sales-customer-profile", "sales-buyer-persona", "sales-buyer-segments",
      "sales-ICP-triggers", "audience-segments",
    ],
  },
  "sales deck": {
    why: "build a deck that sounds like the company and speaks to its ideal customer",
    slugs: deckSlugs(),
  },
};

export const agentsFor = (name) => Object.keys(GROUNDING).filter(a => !name || a.includes(String(name).toLowerCase()) || String(name).toLowerCase().includes(a));

/** Read the block's current fact and title; a block with no fact, or an empty one, is a gap. */
async function inspect(slug, deps) {
  const facts = await deps.get(`/facts?block_slug=${encodeURIComponent(slug)}&per_page=1`);
  const content = String(facts?.items?.[0]?.content || "").trim();
  let title = slug;
  try { const b = await deps.get(`/blocks?slug=${encodeURIComponent(slug)}&per_page=1`); title = b?.items?.[0]?.title || slug; } catch {}
  return { slug, title, filled: content.length > 0, chars: content.length };
}

export function taskFor(gap, agents) {
  const names = agents.map(a => `${a} agent`).join(" and the ");
  const why = GROUNDING[agents[0]].why;
  const title = `Fill "${gap.title}" so the ${names} can ${why}`.slice(0, 250);
  const details = [
    `The block "${gap.title}" (slug ${gap.slug}) holds no fact, and the ${names} read${agents.length > 1 ? "" : "s"} it every run.`,
    `Until it is filled: ${agents.map(a => `the ${a} agent cannot ${GROUNDING[a].why}`).join("; ")}.`,
    ``,
    `Write it as a reference entry, not an answer: a lead sentence that stands alone, then short labelled sections, and an "As of <date>" line on anything that can go stale. One truth per block; if the same claim already lives elsewhere, point at it rather than repeating it.`,
    ``,
    `Filed by the agent pack's grounding check (externalId grounding:${gap.slug}); it will not file this twice. Delete the task if the block is empty on purpose.`,
  ].join("\n").slice(0, 2000);
  return { title, details, externalId: `grounding:${gap.slug}` };
}

/**
 * Check the blocks each agent reads; file a task per empty block unless dryRun.
 * `deps` lets tests inject the NOAN calls; production uses noan.mjs.
 */
export async function checkGrounding({ agents = Object.keys(GROUNDING), dryRun = false, log = () => {}, deps = null } = {}) {
  deps = deps || {
    get: noanGet,
    post: noanPost,
    assign: async (taskId, id) => noanPut(`/tasks/${taskId}/assignees`, { assigneeIds: [id] }),
    findTask: findTaskByExternalId,
    me: async () => noanGet("/me"),
  };
  const bySlug = new Map();
  for (const a of agents) for (const s of GROUNDING[a]?.slugs || []) { if (!bySlug.has(s)) bySlug.set(s, []); bySlug.get(s).push(a); }
  const rows = [];
  for (const slug of bySlug.keys()) rows.push({ ...(await inspect(slug, deps)), agents: bySlug.get(slug) });
  const gaps = rows.filter(r => !r.filled);
  for (const r of rows) log(`  ${r.filled ? "✓" : "·"} ${r.title} (${r.slug}) ${r.filled ? `${r.chars} chars` : "EMPTY"} — ${r.agents.join(", ")}`);
  const filed = [];
  if (gaps.length) {
    let me = null;
    for (const gap of gaps) {
      const t = taskFor(gap, gap.agents);
      const existing = await deps.findTask(t.externalId);
      if (existing) { filed.push({ slug: gap.slug, action: "already filed", taskId: existing.id }); continue; }
      if (dryRun) { filed.push({ slug: gap.slug, action: "would file", title: t.title }); continue; }
      const created = await deps.post("/tasks", { title: t.title, details: t.details, status: "backlog", externalId: t.externalId });
      const id = created?.task?.id || created?.id;
      if (!id) { filed.push({ slug: gap.slug, action: "failed" }); continue; }
      try { me = me || (await deps.me())?.identity?.id; if (me) await deps.assign(id, me); } catch {}
      filed.push({ slug: gap.slug, action: "filed", taskId: id, title: t.title });
    }
  }
  return { rows, gaps, filed };
}

/* CLI */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const json = argv.includes("--json"), dryRun = argv.includes("--dry-run");
  const agents = arg("--agent") ? agentsFor(arg("--agent")) : Object.keys(GROUNDING);
  const log = json ? () => {} : (s) => console.log(s);
  log(`grounding check — ${agents.join(", ")}${dryRun ? " (dry run)" : ""}`);
  const r = await checkGrounding({ agents, dryRun, log });
  if (json) console.log(JSON.stringify({ agents, gaps: r.gaps.map(g => ({ slug: g.slug, title: g.title, agents: g.agents })), filed: r.filed }));
  else {
    log(r.gaps.length ? `\n${r.gaps.length} block(s) the agents read hold no fact:` : "\nEvery block the agents read holds a fact.");
    for (const f of r.filed) log(`  ${f.action}: ${f.title || f.slug}${f.taskId ? ` (task ${f.taskId})` : ""}`);
    if (r.gaps.length) log("\nEach is now a task on your NOAN board (or would be, without --dry-run). Fill the blocks in the app; the agents read them fresh on every run.");
  }
}
