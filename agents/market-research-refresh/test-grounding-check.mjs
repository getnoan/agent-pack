#!/usr/bin/env node
/** grounding-check.mjs — the table matches what the workers read; gaps become one task each, never twice. */
import { readFileSync } from "node:fs";
import { GROUNDING, deckSlugs, taskFor, checkGrounding, agentsFor } from "../shared/grounding-check.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); } };
console.log("grounding check");

// 1. market research: the table IS the worker's two default lists (parsed from source, so a change there fails here)
const src = readFileSync(new URL("./market-research-refresh-worker.mjs", import.meta.url), "utf8");
// slugs only: the company-context list ends in a spread that splits an env var on ","
const list = (name) => [...(src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`))?.[1] || "").matchAll(/"([^"]+)"/g)].map(m => m[1]).filter(x => /^[A-Za-z]/.test(x));
const workerSlugs = [...list("DEFAULT_COMPANY_CONTEXT_GROUNDING"), ...list("DEFAULT_ICP_GROUNDING")];
ok("market research slugs equal the worker's default grounding lists",
   workerSlugs.length >= 12 && JSON.stringify([...workerSlugs].sort()) === JSON.stringify([...GROUNDING["market research"].slugs].sort()),
   `worker=${workerSlugs.length} table=${GROUNDING["market research"].slugs.length}`);

// 2. deck: the slugs come from the deck's own config
const cfg = JSON.parse(readFileSync(new URL("../../design/config.example.json", import.meta.url), "utf8")).deck_fact_slugs;
const expected = [cfg.visual, ...cfg.value, cfg.design_system].filter(Boolean);
ok("deck slugs come from design config (example when no config.json)", JSON.stringify(deckSlugs(new URL("../../design/", import.meta.url).pathname).filter(s => expected.includes(s))) === JSON.stringify(expected) || deckSlugs().length >= expected.length);
ok("agentsFor matches loosely", agentsFor("support")[0] === "customer support" && agentsFor("market research refresh")[0] === "market research" && agentsFor().length === 3);

// 3. behaviour with injected NOAN calls
const facts = { "product-faq": "", "product-features": "# Features\n…", "product-list": "" };
const posted = [], assigned = [];
const deps = {
  get: async (p) => {
    const m = p.match(/block_slug=([^&]+)/); if (m) return { items: facts[decodeURIComponent(m[1])] ? [{ content: facts[decodeURIComponent(m[1])] }] : [] };
    const b = p.match(/\/blocks\?slug=([^&]+)/); if (b) return { items: [{ title: decodeURIComponent(b[1]).replace(/-/g, " ") }] };
    return {};
  },
  post: async (p, body) => { posted.push(body); return { task: { id: `t${posted.length}` } }; },
  assign: async (id, who) => { assigned.push([id, who]); },
  findTask: async (ext) => ext === "grounding:product-list" ? { id: "existing" } : null,
  me: async () => ({ identity: { id: "me-1" } }),
};
const r = await checkGrounding({ agents: ["customer support"], deps });
ok("a filled block is not a gap; empty ones are", r.rows.find(x => x.slug === "product-features").filled && r.gaps.map(g => g.slug).sort().join() === "product-faq,product-list");
ok("an existing task for a gap is not filed again", r.filed.find(f => f.slug === "product-list").action === "already filed" && posted.length === 1);
ok("a new gap is filed as a backlog task with an externalId and assigned to the key's identity",
   posted[0].status === "backlog" && posted[0].externalId === "grounding:product-faq" && assigned[0]?.[1] === "me-1");
const t = taskFor({ slug: "product-faq", title: "Product FAQs" }, ["customer support", "market research"]);
ok("task text names the block, both agents and the why, within the caps",
   /Fill "Product FAQs" so the customer support agent and the market research agent can/.test(t.title) && t.title.length <= 256 && t.details.length <= 2048 && /cannot answer product questions/.test(t.details));
const dry = await checkGrounding({ agents: ["customer support"], dryRun: true, deps: { ...deps, post: async () => { throw new Error("must not post"); } } });
ok("dry run files nothing and says what it would file", dry.filed.every(f => f.action !== "filed") && dry.filed.some(f => f.action === "would file"));

console.log(`\n${fail ? "FAILED" : "PASSED"}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
