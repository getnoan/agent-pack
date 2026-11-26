#!/usr/bin/env node
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  noanGet, noanGetAll, noanPost, noanPatch, assertNoanKey, postNote, postTaskComment,
  createTaskOnce, parkForHuman, allTasksOnce, sanitizeCopy,
} from "../shared/noan.mjs";
import { assertModelKey } from "../shared/anthropic.mjs";
import { loadLocalState, saveLocalState } from "../shared/state-local.mjs";
import { defaultCommanders, normalizeComments } from "../shared/task-comments.mjs";
import { verdictFromComments } from "../shared/newsletter-approval.mjs";
import { respondLine } from "../shared/respond-by.mjs";
import { unescapeUi } from "../shared/ui-escaping.mjs";
import { setUsageContext } from "../shared/usage-log.mjs";
import { traceFigures, sourceFactIds, renderTrace, periodOf } from "./figure-check.mjs";
import { draftReport, titleOf, MODEL } from "./results-report-agent.mjs";

export const STATE = "results-report";
const AGENT = "results-report";
const DRY_RUN = process.env.DRY_RUN === "1";

function log(...a) { console.log(new Date().toISOString(), ...a); }
const commit = (state) => { if (!DRY_RUN) saveLocalState(STATE, state); };

// Each delimiter sits alone on its line, so a fence named in prose doesn't open one.
export function fenceLines(text, name) {
  const m = unescapeUi(text).match(
    new RegExp(`^\\[\\[${name}\\]\\][ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*\\[\\[\\/${name}\\]\\][ \\t]*$`, "m"));
  return m ? m[1].split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#")) : [];
}

async function loadBrain() {
  const read = async (slug) => ((await noanGet(`/facts?block_slug=${encodeURIComponent(slug)}`)).items || [])
    .map(f => f.content).join("\n\n").trim();
  const config = await read(process.env.RESULTS_REPORT_CONFIG_BLOCK_SLUG);
  const playbook = await read(process.env.RESULTS_REPORT_PLAYBOOK_BLOCK_SLUG);
  if (!config) throw new Error("The Results Report Agent Config fact is empty. Refusing to run un-instructed.");
  const reporting = fenceLines(config, "REPORTING SUBTYPES");
  if (!reporting.length) throw new Error("The Results Report Agent Config fact lists no [[REPORTING SUBTYPES]].");
  return { config, playbook, reporting, rules: fenceLines(config, "RULE SUBTYPES"), metricWords: fenceLines(config, "METRIC WORDS") };
}

export function blockRole(block, { reporting, rules, stacks = process.env.RESULTS_REPORT_STACKS }) {
  if (reporting.includes(block.subtype)) return "report";
  if (rules.includes(block.subtype)) return "rule";
  const unpinned = String(stacks || "").split(",").map(s => s.trim()).filter(Boolean);
  return !block.subtype && unpinned.includes(block.stack?.title) ? "report" : null;
}

async function readFacts(brain) {
  const facts = [], rules = [];
  for (const b of await noanGetAll("/blocks")) {
    const role = blockRole(b, brain);
    if (!role) continue;
    const f = ((await noanGet(`/facts?block_id=${b.id}`)).items || [])[0];
    if (!f) { log(`  ${b.stack?.title} / ${b.title}: no fact, left out`); continue; }
    (role === "rule" ? rules : facts).push({
      id: f.id, blockId: b.id, subtype: b.subtype || null, stack: b.stack?.title || "", block: b.title, content: unescapeUi(f.content),
    });
  }
  if (!facts.length) throw new Error("No reporting facts: no block is pinned to a reporting subtype, and RESULTS_REPORT_STACKS names no stack that has facts.");
  return { facts, rules };
}

const blockFactsOf = (facts) => Object.fromEntries(facts.map(f => [f.blockId, f.id]));
export function factsHash(blockFacts) {
  const rows = Object.entries(blockFacts).sort(([a], [b]) => a.localeCompare(b)).map(([b, f]) => `${b}=${f}`);
  return createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 12);
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
export const reportKey = (type, period) => `${slug(type)}:${slug(period)}`;

async function draftChecked(brain, { facts, rules }, { type, period }) {
  let draft = sanitizeCopy(await draftReport({ ...brain, facts, rules, reportType: type, period }));
  let check = traceFigures(draft, facts, { extraMetricWords: brain.metricWords });
  log(`  draft 1: ${check.traced.length} traced, ${check.valueOnly.length} by value only, ${check.untraced.length} not traced`);
  if (check.untraced.length) {
    draft = sanitizeCopy(await draftReport({ ...brain, facts, rules, reportType: type, period, feedback: { draft, check } }));
    check = traceFigures(draft, facts, { extraMetricWords: brain.metricWords });
    log(`  draft 2: ${check.traced.length} traced, ${check.valueOnly.length} by value only, ${check.untraced.length} not traced`);
  }
  return { draft, check };
}

export function createPromptFor({ type, period, facts, check, reason }) {
  const used = new Set(sourceFactIds(check, facts));
  return [
    `${type} for ${period}, written only from the current facts in ${[...new Set(facts.map(f => `"${f.stack}"`))].join(" and ")}.${reason ? ` ${reason}` : ""}`,
    "",
    `Verification: all ${check.traced.length + check.valueOnly.length} figures traced to these facts by value, comparison basis and metric (${check.valueOnly.length} by value only, with no metric words around them).`,
    "",
    "Source facts, fetched with GET /facts?block_id=<id> and confirmed still current when this asset was saved:",
    ...facts.filter(f => used.has(f.id)).map(f => `- ${f.stack} / ${f.block}: fact ${f.id} (block ${f.blockId})`),
  ].join("\n");
}

const APPROVE_HOW = `To save it as an asset, comment \`approve\` on this task (commanders only; the word must start the comment). To drop it, comment \`no\`. Only comments posted after the draft count, and the first yes or no wins. If the facts change before then, the draft is written again.`;

async function fileTask({ externalId, title, details, reason }) {
  const { id, created } = await createTaskOnce({ title, details, status: "backlog", externalId }, { log });
  if (created) await parkForHuman({ id, tags: [], assignees: [] }, { lane: "eng", agent: AGENT, reason, status: null, log });
  return { id, created };
}

async function generate(state, brain, { type, reason = "" }) {
  const { facts, rules } = await readFacts(brain);
  const period = periodOf(facts);
  if (!period) throw new Error("No reporting fact opens with a \"Period:\" header, so there is no period to report on.");
  const key = reportKey(type, period.label);
  const blockFacts = blockFactsOf(facts);
  const hash = factsHash(blockFacts);
  const prior = state.reports[key] || { type, period: period.label };
  log(`${type} for ${period.label}: ${facts.length} facts, ${hash}${reason ? ` (${reason})` : ""}`);

  const { draft, check } = await draftChecked(brain, { facts, rules }, { type, period: period.label });
  const title = titleOf(draft);
  const trace = renderTrace(check, { title: `Figure check: ${title || type}` });

  if (DRY_RUN) {
    console.log(`\n${draft}\n\n${trace}`);
    log(`dry run: ${check.untraced.length ? "would file the untraced figures as a task" : "would post the draft for approval"}; nothing written`);
    return;
  }
  const next = { ...prior, type, period: period.label, draftedHash: hash };
  if (check.untraced.length) {
    const what = `The ${type} for ${period.label} has ${check.untraced.length} figure(s) the facts do not support, after one redraft. It was not saved.`;
    const posted = await postNote({ title: `Figure check: ${type} ${period.label}`, content: trace, externalId: `${AGENT}:${key}:${hash}:trace` });
    const noteId = posted?.note?.id || posted?.id;
    const task = await fileTask({
      externalId: `${AGENT}:${key}:${hash}:untraced`,
      title: `Results report: ${type} for ${period.label} has untraced figures`,
      details: `${what}\n\nCorrect the facts, or the figures' comparison basis and metric words, then dispatch the report again. The full check is in the note "Figure check: ${type} ${period.label}"${noteId ? ` (${noteId})` : ""}.\n\n${respondLine("human")}`,
      reason: what,
    });
    state.reports[key] = next;
    commit(state);
    if (task.created) await postTaskComment(task.id, renderTrace({ ...check, traced: [], valueOnly: [] }, { title: "Not traced" }));
    return;
  }
  const isNew = !prior.assetId;
  const what = `${isNew ? "Draft" : "New version"} of the ${type} for ${period.label}, ready for approval.${reason ? ` ${reason}` : ""}`;
  const task = await fileTask({
    externalId: `${AGENT}:${key}:${hash}`,
    title: `Approve: ${title || `${type} for ${period.label}`}`,
    details: `${what} Every figure traced to the current facts (${check.traced.length} by label, ${check.valueOnly.length} by value only). The draft is in the comments.\n\n${APPROVE_HOW}\n\n${respondLine("comment")}`,
    reason: what,
  });
  if (!task.created) { log(`  already waiting on task ${task.id}`); state.reports[key] = next; commit(state); return; }
  const posted = await postTaskComment(task.id, draft);
  state.reports[key] = {
    ...next,
    pending: {
      taskId: task.id, postedAt: posted?.createdAt || new Date().toISOString(), blockFacts,
      title: title || `${type} for ${period.label}`,
      description: `${type} for ${period.label}, written from the reporting facts; every figure checked against them.`,
      text: draft,
      createPrompt: createPromptFor({ type, period: period.label, facts, check, reason }),
    },
  };
  commit(state);
}

async function closeTask(taskId, comment) {
  await postTaskComment(taskId, comment);
  await noanPatch(`/tasks/${taskId}`, { completed: true, status: "done" });
}

async function saveAsset(report) {
  const p = report.pending;
  const body = { title: p.title, description: p.description, text: p.text, createPrompt: p.createPrompt };
  if (report.assetId) {
    await noanPost(`/assets/${report.assetId}/versions`, body);
    return report.assetId;
  }
  const created = await noanPost("/assets", body);
  const asset = created?.asset || created;
  const id = asset?.originalId || asset?.id;
  if (!id) throw new Error("POST /assets returned no asset id");
  return id;
}

async function readVerdicts(state, current) {
  const redraft = [];
  const commanders = defaultCommanders();
  if (!commanders.size) log("  COMMANDERS is unset, so nobody can approve a draft");
  const tasks = await allTasksOnce();
  for (const [key, report] of Object.entries(state.reports)) {
    const p = report.pending;
    if (!p) continue;
    const task = tasks.find(t => t.id === p.taskId);
    // A board read can miss a row, so a task that is not listed keeps its draft waiting.
    if (!task) { log(`  ${key}: task ${p.taskId} not in this board read; checked again next run`); continue; }
    if (task.completed || task.status === "done") {
      log(`  ${key}: its task was closed without a verdict; the draft is dropped`);
      delete report.pending;
      commit(state);
      continue;
    }
    const verdict = verdictFromComments(normalizeComments(task, { commanders }), commanders, { since: p.postedAt });
    if (!verdict) continue;
    log(`  ${key}: ${verdict.verdict} from ${verdict.by}`);
    if (DRY_RUN) continue;
    if (verdict.verdict === "decline") {
      delete report.pending;
      commit(state);
      await closeTask(p.taskId, `Dropped on ${verdict.by}'s "no". Nothing was saved.`);
      continue;
    }
    const moved = Object.entries(p.blockFacts).filter(([b, f]) => current[b] !== f);
    if (moved.length) {
      delete report.pending;
      commit(state);
      await closeTask(p.taskId, `Not saved: ${moved.length} source fact(s) changed after this draft was written. A new draft follows on its own task.`);
      redraft.push({ key, type: report.type, reason: `Redrafted because ${moved.length} source fact(s) changed while the last draft waited for approval.` });
      continue;
    }
    report.assetId = await saveAsset(report);
    report.blockFacts = p.blockFacts;
    report.savedHash = factsHash(p.blockFacts);
    report.savedAt = new Date().toISOString();
    delete report.pending;
    commit(state);
    await closeTask(p.taskId, `Saved on ${verdict.by}'s approval as asset ${report.assetId}.`);
  }
  return redraft;
}

export function restatements(reports, current, periodLabel) {
  return Object.entries(reports).flatMap(([key, r]) => {
    if (!r.assetId || r.pending || r.period !== periodLabel || !r.blockFacts) return [];
    const now = Object.fromEntries(Object.keys(r.blockFacts).map(b => [b, current[b] ?? null]));
    const hash = factsHash(now);
    if (hash === r.savedHash || hash === r.draftedHash) return [];
    const changed = Object.keys(r.blockFacts).filter(b => now[b] !== r.blockFacts[b]).length;
    return [{ key, type: r.type, reason: `Redrafted because ${changed} source fact(s) changed since the saved version.` }];
  });
}

async function main() {
  setUsageContext({ agent: AGENT });
  assertNoanKey();
  assertModelKey();
  for (const v of ["RESULTS_REPORT_CONFIG_BLOCK_SLUG", "RESULTS_REPORT_PLAYBOOK_BLOCK_SLUG"]) {
    if (!process.env[v]) throw new Error(`${v} is not set. Run seed-results-report.mjs and set the slugs it prints.`);
  }
  log(`results report${DRY_RUN ? " (dry run)" : ""}, model ${MODEL}`);
  const state = loadLocalState(STATE, "reports");
  const brain = await loadBrain();
  const type = (process.env.RESULTS_REPORT_TYPE || "").trim();
  if (type) await generate(state, brain, { type });

  const { facts } = await readFacts(brain);
  const current = blockFactsOf(facts);
  const redraft = await readVerdicts(state, current);
  const period = periodOf(facts);
  const todo = [...redraft, ...(period ? restatements(state.reports, current, period.label) : [])];
  for (const r of todo.filter((r, i) => todo.findIndex(x => x.key === r.key) === i)) {
    await generate(state, brain, { type: r.type, reason: r.reason });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e?.stack || e); process.exit(1); });
}
