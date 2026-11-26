#!/usr/bin/env node
// The real worker, run as a child process against a fake NOAN and a fake model.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { agentFile } from "./pack-paths.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? `: ${d}` : ""}`); } };

const WORKER = agentFile("results-report-worker.mjs");
const AGENT = "agent-1", BOSS = { id: "human-1", name: "Boss", email: "boss@example.com" };
const HEADER = "Period: FY2030 Q2 (ended 2030-06-30) · Report type: quarterly results · Units: USD millions unless stated";
const headline = (revenue) => `${HEADER}\n- Total revenue: $${revenue}M, up 5.2% vs last year\n- Net income: $9.8M`;
// Cash Flow is unpinned in a stack RESULTS_REPORT_STACKS names, and the Config doesn't list FAQs.
const CONFIG = "Write the release in four short paragraphs.\n\n[[REPORTING SUBTYPES]]\nMetric/results-summary\n[[/REPORTING SUBTYPES]]\n\n[[RULE SUBTYPES]]\nPolicy/tone\n[[/RULE SUBTYPES]]";
const WORLD = {
  blocks: [
    { id: "b-head", title: "Headline Results", subtype: "Metric/results-summary", stack: { title: "Financial Results" } },
    { id: "b-cash", title: "Cash Flow", stack: { title: "Old Earnings" } },
    { id: "b-tone", title: "Tone", subtype: "Policy/tone", stack: { title: "Brand" } },
    { id: "b-faq", title: "FAQs", subtype: "Product/faqs", stack: { title: "Products and Services" } },
  ],
  facts: {
    "b-head": [{ id: "f-head-1", content: headline("80.4") }],
    "b-cash": [{ id: "f-cash-1", content: `${HEADER}\n- Free cash flow: $7.1M` }],
    "b-tone": [{ id: "f-tone", content: "Dry and exact. TONE-MARKER" }],
    "b-faq": [{ id: "f-faq", content: "Do you ship abroad? Yes. FAQ-MARKER" }],
    "cfg": [{ id: "f-cfg", content: CONFIG }],
    "play": [{ id: "f-play", content: "Plain and factual." }],
  },
  tasks: [], notes: [], assets: [], seq: 0, prompts: [],
};

// FAKE_STALE=first gets net income wrong on the first draft only, FAKE_STALE=always on every draft.
const FAKE_FETCH = `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const LOG = process.env.FAKE_FETCH_LOG, WORLD_FILE = process.env.FAKE_WORLD;
const load = () => JSON.parse(readFileSync(WORLD_FILE, "utf8"));
const save = (w) => writeFileSync(WORLD_FILE, JSON.stringify(w));
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const sse = (text) => new Response([
  { type: "message_start", message: { id: "m", usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
].map(e => "data: " + JSON.stringify(e)).join("\\n\\n") + "\\n", { status: 200 });
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method || "GET").toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  appendFileSync(LOG, JSON.stringify({ method, url: url.pathname, body }) + "\\n");
  if (url.host === "anthropic.test") {
    const user = [].concat(body.messages[0].content).map(c => typeof c === "string" ? c : c.text).join("");
    const revenue = user.match(/Total revenue: \\$([\\d.]+)M/)[1];
    const redraft = user.includes("Figures in that draft the facts do not support");
    const w = load(); w.prompts.push({ system: [].concat(body.system).map(c => typeof c === "string" ? c : c.text).join(""), user }); save(w);
    const stale = process.env.FAKE_STALE === "always" || (process.env.FAKE_STALE === "first" && !redraft);
    return sse("# Example Co Reports Second Quarter Results\\n\\nTotal revenue was $" + revenue + " million, up 5.2%. Net income was $" + (stale ? "9.1" : "9.8") + " million. Free cash flow was $7.1 million.");
  }
  if (url.host !== "noan.test") return json({}, 404);
  const w = load(), p = url.pathname.replace(/^\\/v1/, ""), q = url.searchParams;
  const id = (k) => k + "-" + (++w.seq);
  if (method === "GET") {
    if (p === "/me") return json({ identity: { id: "${AGENT}", role: "bot" }, project: { name: "Example Co" } });
    if (p === "/blocks") return json({ items: q.get("page") > 1 ? [] : w.blocks });
    if (p === "/facts") return json({ items: (w.facts[q.get("block_id") || (q.get("block_slug") === "rr-config" ? "cfg" : "play")] || []).slice(-1) });
    if (p === "/tasks") return json({ items: q.get("page") > 1 ? [] : w.tasks });
    if (p === "/tags") return json({ items: [{ id: "tag-nh", name: "needs-human" }] });
    return json({ items: [] });
  }
  let m;
  if (p === "/tasks" && method === "POST") { const t = { id: id("task"), ...body, completed: false, tags: [], assignees: [], comments: [] }; w.tasks.push(t); save(w); return json({ task: t }); }
  if ((m = p.match(/^\\/tasks\\/([^/]+)\\/comments$/))) {
    const c = { id: id("c"), content: body.content, createdAt: new Date().toISOString(), creator: { id: "${AGENT}", name: "Agent", email: "agent@example.com" } };
    w.tasks.find(t => t.id === m[1]).comments.push(c); save(w); return json({ comment: c });
  }
  if ((m = p.match(/^\\/tasks\\/([^/]+)$/)) && method === "PATCH") { Object.assign(w.tasks.find(t => t.id === m[1]), body); save(w); return json({ task: {} }); }
  if (p === "/notes") { const n = { id: id("note"), ...body }; w.notes.push(n); save(w); return json({ note: n }); }
  if (p === "/assets") { const a = { originalId: id("asset"), versions: [body] }; w.assets.push(a); save(w); return json({ asset: { id: a.originalId, originalId: a.originalId } }); }
  if ((m = p.match(/^\\/assets\\/([^/]+)\\/versions$/))) { w.assets.find(a => a.originalId === m[1]).versions.push(body); save(w); return json({ asset: {} }); }
  return new Response("", { status: 200 });
};
`;

const dir = mkdtempSync(path.join(tmpdir(), "results-report-"));
const worldFile = path.join(dir, "world.json");
writeFileSync(worldFile, JSON.stringify(WORLD));
writeFileSync(path.join(dir, "results-report.json"), JSON.stringify({ initialized: true, reports: {} }));
writeFileSync(path.join(dir, "fake-fetch.mjs"), FAKE_FETCH);
const world = () => JSON.parse(readFileSync(worldFile, "utf8"));
const state = () => JSON.parse(readFileSync(path.join(dir, "results-report.json"), "utf8"));
const edit = (fn) => { const w = world(); fn(w); writeFileSync(worldFile, JSON.stringify(w)); };
const comment = (taskId, content) => edit(w => w.tasks.find(t => t.id === taskId).comments.push(
  { id: `c-${Date.now()}`, content, createdAt: new Date(Date.now() + 1000).toISOString(), creator: BOSS }));

function run({ type = "", stale = "", dryRun = false } = {}) {
  const log = path.join(dir, `requests-${Date.now()}.jsonl`);
  const res = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(dir, "fake-fetch.mjs")).href, WORKER], {
    cwd: path.dirname(WORKER), encoding: "utf8", timeout: 60_000,
    env: {
      PATH: process.env.PATH, HOME: dir, STATE_BACKEND: "local", STATE_DIR: dir, FAKE_FETCH_LOG: log, FAKE_WORLD: worldFile,
      NOAN_API_URL: "http://noan.test", NOAN_PERSONAL_API_KEY: "npak_fake", AGENT_IDENTITY_ID: AGENT, AGENT_COMMENT_SECRET: "s",
      ANTHROPIC_BASE_URL: "http://anthropic.test", ANTHROPIC_API_KEY: "sk-fake", USAGE_LOG: "0",
      COMMANDERS: BOSS.email, PARK_ASSIGNEES_ENG: BOSS.id,
      RESULTS_REPORT_CONFIG_BLOCK_SLUG: "rr-config", RESULTS_REPORT_PLAYBOOK_BLOCK_SLUG: "rr-playbook", RESULTS_REPORT_STACKS: "Old Earnings",
      ...(type ? { RESULTS_REPORT_TYPE: type } : {}), ...(stale ? { FAKE_STALE: stale } : {}), ...(dryRun ? { DRY_RUN: "1" } : {}),
    },
  });
  const requests = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : [];
  return {
    out: `${res.stdout}\n${res.stderr}`, status: res.status,
    model: requests.filter(r => r.url === "/v1/messages").length,
    writes: requests.filter(r => r.method !== "GET" && r.url !== "/v1/messages"),
  };
}
const posted = (r, method, rx) => r.writes.filter(w => w.method === method && rx.test(w.url));

console.log("a dry run drafts and checks, and writes nothing");
const dry = run({ type: "earnings release", stale: "first", dryRun: true });
ok("the run finishes", dry.status === 0, dry.out.slice(-800));
ok("…redrafts once after the stale figure", dry.model === 2 && /draft 2: \d+ traced, \d+ by value only, 0 not traced/.test(dry.out), dry.out.slice(-800));
ok("…and makes no write", dry.writes.length === 0, dry.writes.map(w => `${w.method} ${w.url}`).join(", "));

console.log("a dispatched draft waits for approval");
const first = run({ type: "earnings release", stale: "first" });
ok("the run finishes", first.status === 0, first.out.slice(-800));
const approval = world().tasks.find(t => t.title.startsWith("Approve:"));
ok("an approval task is filed, saying how to approve", approval && /comment `approve`/.test(approval.details) && /Respond by:/.test(approval.details));
ok("…with the checked redraft as its comment", approval?.comments.some(c => /Net income was \$9\.8 million/.test(c.content)));
ok("…and no asset yet", world().assets.length === 0);
const prompt = world().prompts[0];
ok("the pinned and the named-stack blocks are the reporting facts", /Total revenue: \$80\.4M/.test(prompt.user) && /Free cash flow: \$7\.1M/.test(prompt.user));
ok("…the tone rule reaches the instructions, not the facts", prompt.system.includes("TONE-MARKER") && !prompt.user.includes("TONE-MARKER"));
ok("…and a block pinned to a subtype the Config does not list is never read", world().prompts.every(x => !`${x.system}${x.user}`.includes("FAQ-MARKER")));
ok("the draft is held in state with the facts it came from",
   JSON.stringify(Object.values(state().reports)[0]?.pending?.blockFacts) === JSON.stringify({ "b-head": "f-head-1", "b-cash": "f-cash-1" }));

console.log("a run with no verdict changes nothing");
const idle = run();
ok("no write and no model call", idle.status === 0 && idle.writes.length === 0 && idle.model === 0, idle.writes.map(w => `${w.method} ${w.url}`).join(", "));

console.log("an approval saves the asset");
comment(approval.id, "approve");
const saved = run();
ok("the run finishes", saved.status === 0, saved.out.slice(-800));
const asset = world().assets[0];
ok("one asset is created", world().assets.length === 1 && posted(saved, "POST", /^\/v1\/assets$/).length === 1);
ok("…its createPrompt names every source fact", /fact f-head-1 \(block b-head\)/.test(asset?.versions[0].createPrompt) && /fact f-cash-1/.test(asset?.versions[0].createPrompt));
ok("…and the task is closed done", world().tasks.find(t => t.id === approval.id)?.status === "done");

console.log("a restated fact becomes a new version of the same asset");
edit(w => w.facts["b-head"].push({ id: "f-head-2", content: headline("80.1") }));
const restate = run();
const second = world().tasks.find(t => t.title.startsWith("Approve:") && t.id !== approval.id);
ok("a new draft waits on its own task", second && second.comments.some(c => /\$80\.1 million/.test(c.content)), restate.out.slice(-800));
const again = run();
ok("…and is not drafted twice", again.model === 0 && world().tasks.filter(t => t.title.startsWith("Approve:")).length === 2);
comment(second.id, "approve");
const versioned = run();
ok("on approval it posts a version, not a second asset",
   world().assets.length === 1 && world().assets[0].versions.length === 2 && posted(versioned, "POST", /^\/v1\/assets$/).length === 0, versioned.out.slice(-800));

edit(w => w.facts["b-tone"].push({ id: "f-tone-2", content: "Drier still. TONE-MARKER" }));
ok("a change to a rule fact is not a restatement", run().model === 0);

console.log("a draft whose facts change before the approval is not saved");
edit(w => w.facts["b-head"].push({ id: "f-head-3", content: headline("80.2") }));
run();
const third = world().tasks.find(t => t.title.startsWith("Approve:") && t.status !== "done");
edit(w => w.facts["b-head"].push({ id: "f-head-4", content: headline("80.3") }));
comment(third.id, "approve");
const movedRun = run();
const fourth = world().tasks.find(t => t.title.startsWith("Approve:") && t.status !== "done");
ok("the approved draft is not saved and its task is closed",
   world().assets[0].versions.length === 2 && world().tasks.find(t => t.id === third.id)?.status === "done", movedRun.out.slice(-800));
ok("…and a new draft from the current facts waits on its own task", fourth && fourth.id !== third.id && fourth.comments.some(c => /\$80\.3 million/.test(c.content)));
comment(fourth.id, "no");
run();
ok("a no drops the draft and saves nothing", world().tasks.find(t => t.id === fourth.id)?.status === "done" && world().assets[0].versions.length === 2);

console.log("a draft that never traces is filed and never saved");
const approvals = world().tasks.filter(t => t.title.startsWith("Approve:")).length;
edit(w => w.facts["b-cash"].push({ id: "f-cash-2", content: `${HEADER}\n- Free cash flow: $7.1M\n- Capital expenditure: $2.0M` }));
const bad = run({ stale: "always" });
const filed = world().tasks.find(t => /untraced figures/.test(t.title));
ok("a task names the untraced figures", filed && filed.comments.some(c => /\$9\.1 million/.test(c.content)), bad.out.slice(-800));
ok("…the full check is a note", world().notes.some(n => /Figure check/.test(n.title)));
ok("…no approval task and no new version", world().tasks.filter(t => t.title.startsWith("Approve:")).length === approvals && world().assets[0].versions.length === 2);
ok("…and the same facts are not drafted again", run({ stale: "always" }).model === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
