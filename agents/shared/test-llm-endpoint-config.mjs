#!/usr/bin/env node
/**
 * The model endpoint is configuration, not a hardcoded vendor.
 *
 * Why this ships: the pack is run by other companies, and requiring one vendor's account to use
 * it is a lock-in the agents do not actually need. Every call already funnels through one module
 * (test-anthropic-endpoint-guard.mjs keeps it that way, upstream), so the endpoint is a variable
 * in one place rather than an adapter layer.
 *
 * ANTHROPIC_BASE_URL is the Anthropic SDK's own variable name. Any gateway speaking the Messages
 * wire format is reachable by setting it. An OpenAI-shaped endpoint is NOT: the bodies differ, so
 * a gateway has to sit in front, and the client says so out loud rather than failing obscurely.
 *
 * The host is never spelled out here — it is imported. Spelling it would both duplicate the one
 * source and trip the upstream guard that keeps the endpoint in a single module.
 *
 * Run:  node agents/test-llm-endpoint-config.mjs
 */
import {
  DEFAULT_BASE_URL, resolveBaseUrl, messagesUrl, resolveKey, isAnthropicEndpoint, announceEndpoint,
} from "./anthropic.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); } };
const threw = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

const GATEWAY = "https://gateway.example.com";

console.log("model endpoint is configuration");

// --- base URL -------------------------------------------------------------
ok("unset → the default vendor endpoint, unchanged", resolveBaseUrl({}) === DEFAULT_BASE_URL);
ok("unset → the Messages path is appended once", messagesUrl({}) === `${DEFAULT_BASE_URL}/v1/messages`);
ok("set → the gateway is used", messagesUrl({ ANTHROPIC_BASE_URL: GATEWAY }) === `${GATEWAY}/v1/messages`);
ok("trailing slashes are stripped, so the path is never doubled",
   messagesUrl({ ANTHROPIC_BASE_URL: `${GATEWAY}///` }) === `${GATEWAY}/v1/messages`);
ok("surrounding whitespace is tolerated (a copied .env line)",
   messagesUrl({ ANTHROPIC_BASE_URL: `  ${GATEWAY}  ` }) === `${GATEWAY}/v1/messages`);
ok("a path-prefixed gateway keeps its prefix",
   messagesUrl({ ANTHROPIC_BASE_URL: `${GATEWAY}/llm` }) === `${GATEWAY}/llm/v1/messages`);

// A bad value must be a NAMED error, not an obscure fetch failure fifteen minutes into a run.
const bad = threw(() => resolveBaseUrl({ ANTHROPIC_BASE_URL: "not a url" }));
ok("a malformed base URL is a named error", /ANTHROPIC_BASE_URL is not a valid URL/.test(bad || ""), bad);
const scheme = threw(() => resolveBaseUrl({ ANTHROPIC_BASE_URL: "ftp://files.example.com" }));
ok("a non-http scheme is a named error", /ANTHROPIC_BASE_URL must be http/.test(scheme || ""), scheme);

// --- key ------------------------------------------------------------------
ok("the canonical key is read", resolveKey({ ANTHROPIC_API_KEY: "k1" }) === "k1");
ok("the neutral alias is read when the canonical one is unset", resolveKey({ LLM_API_KEY: "k2" }) === "k2");
ok("the canonical key wins when both are set",
   resolveKey({ ANTHROPIC_API_KEY: "k1", LLM_API_KEY: "k2" }) === "k1");
ok("neither set → undefined, so the caller's own env check reports it", resolveKey({}) === undefined);

// --- capability honesty ---------------------------------------------------
ok("the default endpoint is the vendor's own", isAnthropicEndpoint({}) === true);
ok("a gateway is not", isAnthropicEndpoint({ ANTHROPIC_BASE_URL: GATEWAY }) === false);
// Built from the constant, never spelled: a suffix attack on the real host must not read as it.
ok("a lookalike host is not", isAnthropicEndpoint({ ANTHROPIC_BASE_URL: `${DEFAULT_BASE_URL}.evil.example` }) === false);
ok("a malformed value is not (and does not throw here)",
   isAnthropicEndpoint({ ANTHROPIC_BASE_URL: "not a url" }) === false);

/* The announcement exists because a gateway that ignores cache_control still answers 200: the
 * only symptom of losing caching is the bill. Silent on the default so a normal run stays quiet.
 * Order matters below — the notice latches once per process, so the silent case runs first. */
let lines = [];
announceEndpoint({}, (m) => lines.push(m));
ok("nothing is announced on the default endpoint", lines.length === 0, lines.join(" | "));

lines = [];
announceEndpoint({ ANTHROPIC_BASE_URL: GATEWAY }, (m) => lines.push(m));
ok("a gateway is announced once", lines.length === 1, `${lines.length} lines`);
ok("…naming the host", /gateway\.example\.com/.test(lines[0] || ""), lines[0]);
ok("…and saying which features are unverified there",
   /caching/i.test(lines[0] || "") && /thinking/i.test(lines[0] || ""), lines[0]);
ok("…and pointing at the model variables, whose defaults do not resolve elsewhere",
   /_MODEL/.test(lines[0] || ""), lines[0]);

lines = [];
announceEndpoint({ ANTHROPIC_BASE_URL: GATEWAY }, (m) => lines.push(m));
ok("…and not again on every call", lines.length === 0, lines.join(" | "));

console.log(`\n${fail ? "FAILED" : "PASSED"}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
