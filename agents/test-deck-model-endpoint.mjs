#!/usr/bin/env node
/**
 * The deck resolves the SAME model endpoint as the JS agents.
 *
 * Why this exists: the deck is Python with its own client, so it sits outside the one-module
 * chokepoint the JS side enforces. When the endpoint became configurable, five agents followed
 * ANTHROPIC_BASE_URL and the deck did not — it read only its own config.json, so a user who
 * pointed the pack at their own endpoint got five agents there and the deck still calling the
 * default vendor. Two clients that must agree, with nothing asserting that they do.
 *
 * So this compares the two directly rather than checking each in isolation: for the same
 * environment, the URL Python builds must equal the URL messagesUrl() builds. The shapes differ
 * underneath — the JS variable is the bare base and appends "/v1/messages", the Python config key
 * carries the version segment and appends "/messages" — which is exactly the kind of difference
 * that drifts silently, because both halves look right on their own.
 *
 * Python, not a source-pattern match: load_cfg() is run for real with the environment set, so
 * this tests resolution rather than the presence of a line of code.
 *
 * Run:  node agents/test-deck-model-endpoint.mjs
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { messagesUrl, resolveKey } from "./anthropic.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DESIGN = path.join(REPO, "design");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); } };

console.log("the deck follows the same model variables");

/* design/ arrives with the export; a tree that has only the starter facts legitimately lacks it,
 * and ci.yml tolerates that for the Python syntax step too. Skip rather than fail. */
if (!existsSync(path.join(DESIGN, "deck.py"))) {
  console.log("  no design/deck.py in this tree — skipping");
  console.log("\nPASSED  0 passed, 0 failed");
  process.exit(0);
}

/** load_cfg() under a given environment, as JSON. */
function deckCfg(env) {
  const code = [
    "import importlib.util, sys, json, os",
    "sys.path.insert(0, 'design')",
    "spec = importlib.util.spec_from_file_location('deck', 'design/deck.py')",
    "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
    "c = m.load_cfg()",
    "print(json.dumps({'base': c.get('anthropic_base'), 'key': c.get('anthropic_api_key'), 'model': c.get('design_model')}))",
  ].join("\n");
  // A clean environment: inherited keys would mask exactly the bug this is checking for.
  const clean = { PATH: process.env.PATH, HOME: process.env.HOME, ...env };
  const out = execFileSync("python3", ["-c", code], { cwd: REPO, env: clean, encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}
const deckUrl = (env) => `${deckCfg(env).base}/messages`;

let python = true;
try { execFileSync("python3", ["--version"], { stdio: "ignore" }); } catch { python = false; }
if (!python) {
  console.log("  no python3 on this machine — skipping");
  console.log("\nPASSED  0 passed, 0 failed");
  process.exit(0);
}

// --- the invariant: one variable, one endpoint, both languages --------------
for (const [label, env] of [
  ["unset (the default vendor)", {}],
  ["a hosted gateway", { ANTHROPIC_BASE_URL: "https://gateway.example.com/api" }],
  ["a local gateway", { ANTHROPIC_BASE_URL: "http://localhost:4000" }],
  ["trailing slashes", { ANTHROPIC_BASE_URL: "https://gateway.example.com///" }],
  ["a path-prefixed gateway", { ANTHROPIC_BASE_URL: "https://gateway.example.com/llm" }],
]) {
  const py = deckUrl(env), js = messagesUrl(env);
  ok(`${label}: the deck and the JS agents call the same URL`, py === js, `python=${py} js=${js}`);
}

// --- the key: same two names, same precedence ------------------------------
ok("the canonical key reaches the deck",
   deckCfg({ ANTHROPIC_API_KEY: "k-canonical" }).key === "k-canonical");
ok("the neutral alias reaches the deck",
   deckCfg({ LLM_API_KEY: "k-alias" }).key === "k-alias");
{
  const env = { ANTHROPIC_API_KEY: "k-canonical", LLM_API_KEY: "k-alias" };
  const py = deckCfg(env).key;
  ok("with both set, the deck picks what resolveKey() picks", py === resolveKey(env), `python=${py} js=${resolveKey(env)}`);
}

// --- the model id ----------------------------------------------------------
/* An unset variable must not INVENT a model, and must not clobber a configured one. Stated
 * against the config file rather than "is non-empty": the exported pack legitimately has no
 * config.json and no config.defaults.json (the latter is on the export's forbidden list), so
 * "there is always a value here" is true upstream and false downstream — which is how an
 * assertion passes for everyone who writes it and fails for everyone who ships it. The call
 * sites carry their own default for exactly this case. */
{
  const cfgFile = ["config.json", "config.defaults.json"]
    .map(f => path.join(DESIGN, f)).find(existsSync);
  const configured = cfgFile ? JSON.parse(readFileSync(cfgFile, "utf8")).design_model ?? null : null;
  ok("an unset model variable neither invents a value nor clobbers the configured one",
     (deckCfg({}).model ?? null) === (configured ?? null),
     `resolved=${deckCfg({}).model} config=${configured} (${cfgFile || "no config file"})`);
}
ok("the model id is settable by variable, like every other agent",
   deckCfg({ DESIGN_MODEL: "vendor/some-model" }).model === "vendor/some-model");

console.log(`\n${fail ? "FAILED" : "PASSED"}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
