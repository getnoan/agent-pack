/**
 * Minimal Claude client. Raw fetch, no SDK — keeps the zero-dependency deploy
 * shape (the workflow runs the worker directly with no install step).
 *
 * Two call shapes:
 *   callClaude()      → free-form text
 *   callClaudeJSON()  → structured output constrained to a JSON Schema
 *
 * Structured output (`output_config.format`) is used instead of the tool-forcing
 * trick the agents use because every call here is an extraction/judgement that
 * returns data, not a conversation. The model cannot return prose by accident.
 */

import { recordUsage } from "./usage-log.mjs";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

/* The endpoint is configurable, so a pack user is not locked to one vendor's billing.
 *
 * ANTHROPIC_BASE_URL is the Anthropic SDK's own variable name, not one invented here, and it is
 * the whole mechanism: every gateway that speaks the Messages wire format — LiteLLM, OpenRouter,
 * a Bedrock or Vertex proxy — is reachable by setting it, with no adapter in this repo and no
 * change in any caller. That is deliberate. A second provider adapter living here would mean
 * owning system-prompt placement, JSON-schema and tool-use translation forever, in two public
 * packs, and its failure mode is silent: caching and thinking simply stop happening while every
 * call still succeeds. Translation belongs in a gateway the user chooses and can see.
 *
 * So the agents are model-agnostic, and in the common case need no extra infrastructure:
 *   - OpenRouter serves the Messages format directly at https://openrouter.ai/api (model-
 *     agnostic, no proxy to run). Set the *_MODEL variables to ids it knows.
 *   - LiteLLM, self-hosted, translates a Messages request to openai, gemini, vertex_ai,
 *     bedrock and azure models — the option to take when you want your own routing or
 *     cost tracking.
 *
 * The one thing that does NOT work is pointing this at a provider's own OpenAI-shaped URL
 * (api.openai.com and the like): those speak Chat Completions, and the request and response
 * bodies differ. That is a fact about one URL, not a limit on which models can be used.
 *
 * ANTHROPIC_API_KEY stays canonical: 32 fleet modules name it in their required-env arrays and
 * 31 workflows pass it as a secret, so renaming it would churn all of those and every Actions
 * secret for no functional gain. LLM_API_KEY is an alias for a user whose endpoint is not
 * Anthropic, for whom the Anthropic-shaped name is simply a lie. */
export const DEFAULT_BASE_URL = "https://api.anthropic.com";

/** The base URL, trailing slashes stripped. A malformed value is a NAMED error here rather than
 *  an unhelpful fetch failure later — same rule the mail env guard applies to RESEND_API_KEY. */
export function resolveBaseUrl(env = process.env) {
  const raw = (env.ANTHROPIC_BASE_URL || DEFAULT_BASE_URL).trim().replace(/\/+$/, "");
  let url;
  try { url = new URL(raw); } catch { throw new Error(`ANTHROPIC_BASE_URL is not a valid URL: ${raw}`); }
  if (!/^https?:$/.test(url.protocol)) throw new Error(`ANTHROPIC_BASE_URL must be http(s): ${raw}`);
  return raw;
}
export const messagesUrl = (env = process.env) => `${resolveBaseUrl(env)}/v1/messages`;
/** Canonical name first, neutral alias second. */
export const resolveKey = (env = process.env) => env.ANTHROPIC_API_KEY || env.LLM_API_KEY;
/** Whether the configured endpoint is Anthropic's own — i.e. whether the Anthropic-only
 *  features below (prompt caching, extended thinking) can be relied on. */
export const isAnthropicEndpoint = (env = process.env) => {
  try { return new URL(resolveBaseUrl(env)).hostname === "api.anthropic.com"; } catch { return false; }
};

/* Say what degraded and whose problem it is, once per process. A gateway that ignores
 * cache_control still answers 200, so the only symptom of losing caching is the bill — which is
 * exactly how sixteen uncached agents went unnoticed until someone read the spend report. */
let announced = false;
export function announceEndpoint(env = process.env, log = console.warn) {
  if (announced || isAnthropicEndpoint(env)) return;
  announced = true;
  log(`anthropic.mjs: routing to ${new URL(resolveBaseUrl(env)).host} via ANTHROPIC_BASE_URL. `
    + `Prompt caching and extended thinking are Anthropic Messages features: this endpoint may ignore `
    + `them, so cache savings and thinking budgets are NOT verified here. Set the *_MODEL variables `
    + `to model ids your endpoint knows — the "claude-*" defaults will not resolve elsewhere.`);
}

/** The model key, or a named error — the exact shape of assertNoanKey() in noan.mjs, and here
 *  for the same reason: two names satisfy one requirement, so a plain presence check on one of
 *  them is wrong. Four shipped workers listed "ANTHROPIC_API_KEY" in their REQUIRED_ENV array,
 *  which would have refused to start for a user whose endpoint is not Anthropic — the endpoint
 *  being configurable is inert if the front door still demands one vendor's variable name. */
export function assertModelKey(env = process.env) {
  if (resolveKey(env)) return;
  throw new Error(
    "No model API key. Set ANTHROPIC_API_KEY, or LLM_API_KEY if your endpoint is not Anthropic " +
    "(see ANTHROPIC_BASE_URL). A GitHub secret that is missing or misspelled renders as an empty " +
    "string, so check the secret name first.");
}

const ANTHROPIC_URL = messagesUrl();
const KEY = resolveKey();

/** Model used for per-surface fact extraction (high volume, mechanical). */
export const EXTRACT_MODEL = process.env.AUDIT_EXTRACT_MODEL || "claude-opus-5";
/** Model used for diffing, adversarial verification, and composing. */
export const ANALYSIS_MODEL = process.env.AUDIT_ANALYSIS_MODEL || "claude-opus-5";

/**
 * All requests STREAM. A non-streaming call that runs server-side web searches
 * can take >5 minutes before the first byte, which trips Node's undici headers
 * timeout (UND_ERR_HEADERS_TIMEOUT, hard-capped at 300s). With streaming the
 * headers arrive immediately and pings keep the body alive; we reconstruct the
 * final message from the SSE events and callers never know the difference.
 */
function reconstruct(sseText) {
  const blocks = [];
  let stop_reason = null, stop_details = null, usage = null;

  for (const line of sseText.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    let ev;
    try { ev = JSON.parse(line.slice(6)); } catch { continue; }

    switch (ev.type) {
      case "content_block_start": {
        const b = structuredClone(ev.content_block);
        // tool_use inputs stream as partial JSON; accumulate then parse at stop.
        if (b.type === "tool_use" || b.type === "server_tool_use") b._json = "";
        blocks[ev.index] = b;
        break;
      }
      case "content_block_delta": {
        const b = blocks[ev.index]; if (!b) break;
        const d = ev.delta;
        if (d.type === "text_delta") b.text = (b.text || "") + d.text;
        // NO onThinking here: reconstruct() is the batch path with no
        // callbacks in scope — a stray call added with the thinking trace
        // (PR #30) crashed every batch worker whenever the model emitted
        // thinking (intermittent by nature of adaptive thinking; caught via
        // a failed investor digest, 2026-08-06).
        else if (d.type === "thinking_delta") b.thinking = (b.thinking || "") + d.thinking;
        else if (d.type === "signature_delta") b.signature = (b.signature || "") + d.signature;
        else if (d.type === "input_json_delta") b._json = (b._json || "") + d.partial_json;
        else if (d.type === "citations_delta") (b.citations ||= []).push(d.citation);
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index];
        if (b && b._json !== undefined) {
          try { b.input = b._json ? JSON.parse(b._json) : (b.input || {}); } catch { /* keep b.input */ }
          delete b._json;
        }
        break;
      }
      case "message_delta":
        stop_reason = ev.delta?.stop_reason ?? stop_reason;
        stop_details = ev.delta?.stop_details ?? stop_details;
        usage = ev.usage ?? usage;
        break;
      case "error":
        // Capacity and transient server faults can arrive *here* rather than as an HTTP
        // status: the request 200s, the stream opens, and the failure shows up as an
        // in-band error event. Tag the type so post() can retry those the same way it
        // already retries an HTTP 429/5xx — see RETRYABLE_STREAM_ERRORS.
        throw Object.assign(
          new Error(`stream error: ${JSON.stringify(ev.error).slice(0, 300)}`),
          { streamErrorType: ev.error?.type || null },
        );
    }
  }
  return { content: blocks.filter(Boolean), stop_reason, stop_details, usage };
}

/**
 * In-stream error types worth another attempt. These are the same transient conditions
 * the HTTP 429/5xx branch below already retries — the API just delivers them mid-stream
 * sometimes instead of as a status code. Anything else (invalid_request_error,
 * authentication_error, permission_error, ...) is a standing fault: retrying repeats it.
 */
const RETRYABLE_STREAM_ERRORS = new Set(["overloaded_error", "api_error", "timeout_error"]);

/* ---------------- prompt caching (VOICE-COST-PLAN phase 1) ----------------
 * Every request gets up to three ephemeral cache breakpoints: the tools
 * array (most stable — its own breakpoint so a system-prompt swap from a
 * brain refresh doesn't evict it), the system prompt, and the newest
 * message (so the whole conversation prefix reuses across turns AND across
 * iterations inside a tool loop). Cache reads bill at 10% of input; the
 * voice app's ~50-70k-token resent prefix was the bulk of its $60/day.
 *
 * NON-MUTATING by construction: callers like the voice session hold their
 * `messages` array across turns — writing cache_control into their objects
 * would accumulate breakpoints past the API's limit of 4. Copies only.
 * Thinking blocks can't carry cache_control, so the newest-message marker
 * walks back past them. ANTHROPIC_NO_CACHE=1 is the escape hatch. */
export function withCacheBreakpoints(body) {
  if (process.env.ANTHROPIC_NO_CACHE === "1") return body;
  const bp = { type: "ephemeral" };
  const out = { ...body };
  if (Array.isArray(out.tools) && out.tools.length) {
    out.tools = out.tools.slice();
    const li = out.tools.length - 1;
    out.tools[li] = { ...out.tools[li], cache_control: bp };
  }
  if (typeof out.system === "string" && out.system) {
    out.system = [{ type: "text", text: out.system, cache_control: bp }];
  } else if (Array.isArray(out.system) && out.system.length) {
    out.system = out.system.slice();
    const li = out.system.length - 1;
    out.system[li] = { ...out.system[li], cache_control: bp };
  }
  if (Array.isArray(out.messages) && out.messages.length) {
    out.messages = out.messages.slice();
    const li = out.messages.length - 1;
    const m = out.messages[li];
    if (typeof m.content === "string" && m.content) {
      out.messages[li] = { ...m, content: [{ type: "text", text: m.content, cache_control: bp }] };
    } else if (Array.isArray(m.content) && m.content.length) {
      const content = m.content.slice();
      for (let b = content.length - 1; b >= 0; b--) {
        const t = content[b]?.type;
        if (t === "thinking" || t === "redacted_thinking") continue;
        content[b] = { ...content[b], cache_control: bp };
        break;
      }
      out.messages[li] = { ...m, content };
    }
  }
  return out;
}

/* ---------------- request dump (PROMPT CACHING BRIEF 2026-09-09, P2) ----------------
 * ANTHROPIC_DUMP_DIR=<dir> writes every request body AS SENT (cache_control
 * markers, stream flag, beta header) to <dir>/<iso-time>-<n>.json. It exists
 * to diagnose cache churn: log four or five consecutive payloads from one
 * session and diff adjacent pairs — only the appended turn should differ.
 * Anything else that differs inside the overlap is the invalidator. The API
 * key is never written — but the BODY is the full prompt, which for the
 * drafting agents means a prospect's crawled site and contact details in
 * plaintext. Point it at a directory outside any repo tree and off shared
 * hosts, and delete the dump when the diagnosis is done. Unset in
 * production; a failed write is logged once and never fails the call. */
let dumpSeq = 0;
let dumpWarned = false;
function dumpRequest(body, headers) {
  const dir = process.env.ANTHROPIC_DUMP_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${String(++dumpSeq).padStart(4, "0")}.json`;
    writeFileSync(path.join(dir, name), JSON.stringify({
      at: new Date().toISOString(),
      betas: headers["anthropic-beta"] || null,
      body,
    }, null, 2));
  } catch (e) {
    if (!dumpWarned) { dumpWarned = true; console.error(`anthropic: request dump failed (${e.message.slice(0, 120)})`); }
  }
}

/* Claude Opus 5 (2026-09-09): its safety classifiers can decline a request
 * (HTTP 200, stop_reason "refusal"). Every Opus 5 request opts into
 * server-side refusal fallbacks by default so a declined call re-runs on
 * Anthropic's recommended substitute instead of failing the agent run.
 * Callers that already pass `fallbacks` (the FDA expert) are left alone. */
const thinkingDefaultsOn = (m) => /^claude-(opus-5|sonnet-5)/.test(String(m || ""));
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
function wantsFallbacks(body) {
  return String(body?.model || "").startsWith("claude-opus-5") && body?.fallbacks === undefined;
}
function withFallbacks(body) {
  return wantsFallbacks(body) ? { ...body, fallbacks: "default" } : body;
}
function betaHeader(betas, body) {
  const list = [...(betas || [])];
  // `fallbacks` in the body without its beta header is a 400. Add the header
  // whether the helper chose fallbacks (Opus 5 default) or the caller passed
  // them explicitly — the drafting agents that moved here from their own
  // fetch (SDR first, 2026-09-09) used to set both by hand.
  const needsBeta = wantsFallbacks(body) || body?.fallbacks !== undefined;
  if (needsBeta && !list.includes(FALLBACK_BETA)) list.push(FALLBACK_BETA);
  return list.length ? { "anthropic-beta": list.join(",") } : {};
}

/* SHARED-HELPER CONTRACT NOTE (added 2026-08-13, FDA): `betas` is an optional
 * array of anthropic-beta header values. Omitted → header not sent; existing
 * callers see byte-identical requests. First caller: the FDA expert, which
 * opts into server-side refusal fallbacks on claude-opus-5. */
/* SHARED-HELPER CONTRACT NOTE (added 2026-09-09, prompt caching brief P1):
 * post() is now exported as `postMessages` so the drafting agents that built
 * their own fetch to api.anthropic.com (sixteen of them, every one uncached)
 * can route through the breakpoints, retry ladder, usage ledger and Opus 5
 * fallbacks in one move. Two additive options:
 *   usage: { action }  — the spend-ledger action label ("draft", "tighten",
 *                        ...); the daily spend report keys on agent/action, so
 *                        a caller that used to pass one to recordUsage keeps it.
 *   (env) ANTHROPIC_DUMP_DIR — see dumpRequest above.
 * Omitted, existing callers see byte-identical requests and ledger rows. */
async function post(body, { retries = 4, timeoutMs = 15 * 60 * 1000, betas, usage: usageOpts } = {}) {
  announceEndpoint();
  for (let attempt = 0; ; attempt++) {
    const headers = {
      "Content-Type": "application/json",
      "x-api-key": KEY,
      "anthropic-version": "2023-06-01",
      ...betaHeader(betas, body),
    };
    const sent = { ...withFallbacks(withCacheBreakpoints(body)), stream: true };
    dumpRequest(sent, headers);
    const res = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(sent),
      // Overall wall-clock guard per attempt; pings keep the body alive. A
      // multi-search server-tool turn can legitimately run >15 min, so
      // callers doing that pass a larger budget.
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) throw new Error(`Anthropic ${res.status} after ${attempt} retries`);
      await new Promise(r => setTimeout(r, Math.min(2000 * 2 ** attempt, 20000)));
      continue;
    }
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`Anthropic ${res.status}: ${t.slice(0, 300)}`);
    }
    let data;
    try {
      data = reconstruct(await res.text());
    } catch (e) {
      // Same transient condition as the 429/5xx branch above, delivered by a different
      // route, so it gets the same budget and the same backoff. A stream that errored
      // produced no completion, so there is nothing to record in the spend ledger.
      if (RETRYABLE_STREAM_ERRORS.has(e.streamErrorType)) {
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, Math.min(2000 * 2 ** attempt, 20000)));
          continue;
        }
        e.message += ` (after ${attempt} retries)`;
      }
      throw e;
    }
    // spend ledger (usage-log.mjs) — one row per billed request; never throws
    await recordUsage({ provider: "anthropic", model: body.model, usage: data.usage, action: usageOpts?.action });
    return data;
  }
}

/** Raw Messages call: the reconstructed message ({content, stop_reason,
 *  stop_details, usage}) with no refusal/pause handling — the caller owns
 *  those, as the drafting loops already do. See the contract note on post(). */
export const postMessages = post;

function firstText(data) {
  const block = (data.content || []).find(b => b.type === "text");
  return block?.text ?? "";
}

/**
 * Incremental streaming call (built for the voice app). Same wire format as
 * post() but events are parsed AS THEY ARRIVE and every top-level text delta
 * is handed to `onText` — so a caller can start speaking/showing the reply
 * while the model is still generating. Returns the same reconstructed
 * message shape as post(); thinking blocks (signatures included) survive
 * intact for verbatim echo. Retries only before the first emitted text —
 * once the user has heard words, a mid-stream failure surfaces instead of
 * silently restarting the sentence.
 */
export async function callClaudeStream(body, { onText = () => {}, onThinking = () => {}, retries = 3, timeoutMs = 15 * 60 * 1000 } = {}) {
  let emitted = false;
  for (let attempt = 0; ; attempt++) {
    // Per-call latency probes (VOICE-LATENCY-PLAN P0): wall-clock only,
    // set once each, returned on the result — never affects the stream.
    const t0 = Date.now();
    let tFirstByte = null, tFirstThink = null, tFirstOut = null;
    try {
      const headers = {
        "Content-Type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
        ...betaHeader(undefined, body),
      };
      const sent = { ...withFallbacks(withCacheBreakpoints(body)), stream: true };
      dumpRequest(sent, headers);
      const res = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers,
        body: JSON.stringify(sent),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        throw Object.assign(new Error(`Anthropic ${res.status}`), { retryable: true });
      }
      if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);

      const blocks = [];
      let stop_reason = null, stop_details = null;
      let usage = null, sse = "";
      const dec = new TextDecoder();
      for await (const chunk of res.body) {
        if (tFirstByte === null) tFirstByte = Date.now();
        sse += dec.decode(chunk, { stream: true });
        let nl;
        while ((nl = sse.indexOf("\n")) !== -1) {
          const line = sse.slice(0, nl); sse = sse.slice(nl + 1);
          if (!line.startsWith("data: ")) continue;
          let ev;
          try { ev = JSON.parse(line.slice(6)); } catch { continue; }
          switch (ev.type) {
            case "content_block_start": {
              const b = structuredClone(ev.content_block);
              if (b.type === "tool_use" || b.type === "server_tool_use") b._json = "";
              if (b.type === "thinking" && tFirstThink === null) tFirstThink = Date.now();
              if ((b.type === "text" || b.type === "tool_use") && tFirstOut === null) tFirstOut = Date.now();
              blocks[ev.index] = b;
              break;
            }
            case "content_block_delta": {
              const b = blocks[ev.index]; if (!b) break;
              const d = ev.delta;
              if (d.type === "text_delta") {
                b.text = (b.text || "") + d.text;
                if (b.type === "text") { emitted = true; onText(d.text); }
              }
              else if (d.type === "thinking_delta") { b.thinking = (b.thinking || "") + d.thinking; onThinking(d.thinking); }
              else if (d.type === "signature_delta") b.signature = (b.signature || "") + d.signature;
              else if (d.type === "input_json_delta") b._json = (b._json || "") + d.partial_json;
              else if (d.type === "citations_delta") (b.citations ||= []).push(d.citation);
              break;
            }
            case "content_block_stop": {
              const b = blocks[ev.index];
              if (b && b._json !== undefined) {
                try { b.input = b._json ? JSON.parse(b._json) : (b.input || {}); } catch { /* keep b.input */ }
                delete b._json;
              }
              break;
            }
            case "message_delta":
              stop_reason = ev.delta?.stop_reason ?? stop_reason;
              stop_details = ev.delta?.stop_details ?? stop_details;
              usage = ev.usage ?? usage;
              break;
            case "error":
              // Tagged for the same reason as in reconstruct(): the retry decision below
              // needs the error's type, not just its message text.
              throw Object.assign(
                new Error(`stream error: ${JSON.stringify(ev.error).slice(0, 300)}`),
                { streamErrorType: ev.error?.type || null },
              );
          }
        }
      }
      if (stop_reason === "refusal") {
        throw new Error(`model refused: ${stop_details?.explanation || "no explanation"}`);
      }
      // spend ledger (usage-log.mjs) — never throws
      await recordUsage({ provider: "anthropic", model: body.model, usage });
      return {
        content: blocks.filter(Boolean), stop_reason, stop_details, usage,
        timing: {
          ttfb_ms: tFirstByte === null ? null : tFirstByte - t0,
          first_output_ms: tFirstOut === null ? null : tFirstOut - t0,   // first TEXT or TOOL_USE = end of deliberation
          thinking_lead_ms: tFirstThink === null || tFirstOut === null ? null : tFirstOut - tFirstThink,
          total_ms: Date.now() - t0,
        },
      };
    } catch (e) {
      const retryable = e.retryable
        || RETRYABLE_STREAM_ERRORS.has(e.streamErrorType)
        || /fetch failed|network|ECONNRESET|ETIMEDOUT|terminated|aborted/i.test(String(e.message));
      // `!emitted` still gates everything: once text has gone out to onText, a retry would
      // duplicate it for the caller, so a mid-stream failure after output stays terminal.
      if (!emitted && retryable && attempt < retries) {
        await new Promise(r => setTimeout(r, Math.min(2000 * 2 ** attempt, 20000)));
        continue;
      }
      throw e;
    }
  }
}

/**
 * Raw call for callers that need the full response (server tools, citations).
 * Handles the server-tool `pause_turn` continuation loop; refusal still throws.
 *
 * Content is ACCUMULATED across continuations — the first version returned
 * only the final turn, silently dropping cited text blocks produced before a
 * pause. The caller sees one merged content array, as if the turn never paused.
 */
export async function callClaudeRaw(body, { maxContinuations = 5, timeoutMs } = {}) {
  let messages = body.messages;
  const allContent = [];
  for (let i = 0; ; i++) {
    const data = await post({ ...body, messages }, { timeoutMs });
    if (data.stop_reason === "refusal") {
      throw new Error(`model refused: ${data.stop_details?.explanation || "no explanation"}`);
    }
    allContent.push(...(data.content || []));
    if (data.stop_reason !== "pause_turn") return { ...data, content: allContent };
    if (i >= maxContinuations) throw new Error("server-tool loop exhausted (pause_turn)");
    // Resume: append the paused assistant turn (this turn's content only,
    // exactly as received) and re-send unchanged.
    messages = [...messages, { role: "assistant", content: data.content }];
  }
}

/**
 * Free-form call. `thinking` defaults to adaptive — on Opus 4.8 thinking is OFF
 * unless explicitly requested, and every call in this pipeline is a judgement
 * call worth thinking about.
 */
/**
 * One-shot text call. SHARED-HELPER CONTRACT NOTE (changed 2026-08-13):
 * `effort` and `thinking` are now OPT-OUT — pass `effort: null` /
 * `thinking: false` to omit output_config and the thinking block entirely.
 * Before this, output_config was always sent, which 400s on models that
 * don't support it (Haiku 4.5). Defaults are unchanged ("high" + adaptive),
 * so existing callers behave exactly as before; only callers that opt out
 * see different request bodies.
 */
export async function callClaude({ system, user, model = ANALYSIS_MODEL, maxTokens = 8000, effort = "high", thinking = true }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
  };
  // effort/adaptive-thinking are Opus-tier params — smaller models (Haiku)
  // 400 on them. Pass effort: null / thinking: false to call those. On Opus 5
  // and Sonnet 5 an omitted `thinking` means ON, so thinking:false there is
  // sent as an explicit off (allowed at effort high or below).
  if (effort) body.output_config = { effort };
  if (thinking) body.thinking = { type: "adaptive" };
  else if (thinkingDefaultsOn(model)) body.thinking = { type: "disabled" };

  const data = await post(body);
  if (data.stop_reason === "refusal") {
    throw new Error(`model refused: ${data.stop_details?.explanation || "no explanation"}`);
  }
  return firstText(data);
}

/**
 * Agentic tool loop (built for the general agent; reusable by future agents).
 *
 * Unlike the drafting agents (read-only tools, one forced submit), this loop
 * lets the model plan its own steps through a caller-supplied tool belt. The
 * SAFETY BOUNDARY IS THE BELT, not this loop: every handler the caller passes
 * in `execTool` must enforce its own guards. This loop only enforces budgets.
 *
 *   execTool(name, input) → JSON-serialisable result, OR
 *                           { __terminal: {...} } to end the loop (finish/wait)
 *
 * Adaptive thinking is on and assistant content (thinking blocks included) is
 * echoed back verbatim each turn — required on Opus 4.8. A running budget line
 * is appended after each tool-result batch so the model can pace itself.
 *
 * Returns { terminal, toolCalls, elapsedMs }. terminal is what execTool
 * returned under __terminal, or {type:"budget_exceeded"|"stalled"}.
 */
/* SHARED-HELPER CONTRACT NOTE (added 2026-08-13, FDA): `betas` (anthropic-beta
 * header values) and `extraBody` (spread into the request body, e.g.
 * { fallbacks: "default" }) are optional and additive — omitted, the request
 * is unchanged for existing callers. */
export async function callClaudeToolLoop({
  system, messages, tools, execTool,
  model = ANALYSIS_MODEL, maxTokens = 8000, effort = "high",
  maxToolCalls = 40, maxWallMs = 30 * 60_000, log = () => {},
  betas, extraBody,
  // Chat surfaces (the Slack companion): a reply with no tool call IS the
  // final answer — return it, never nudge toward finish/wait. Worker
  // surfaces keep the nudge: unattended runs must end in a terminal tool.
  textEndsTurn = false,
}) {
  const started = Date.now();
  let toolCalls = 0;
  let nudges = 0;
  let lastText = "";

  for (;;) {
    const elapsedMs = Date.now() - started;
    if (toolCalls >= maxToolCalls || elapsedMs >= maxWallMs) {
      return { terminal: { type: "budget_exceeded", toolCalls, elapsedMs }, toolCalls, elapsedMs, lastText };
    }

    const data = await post({
      model,
      max_tokens: maxTokens,
      system,
      tools,
      messages,
      thinking: { type: "adaptive" },
      output_config: { effort },
      ...(extraBody || {}),
    }, { betas });
    if (data.stop_reason === "refusal") {
      throw new Error(`model refused: ${data.stop_details?.explanation || "no explanation"}`);
    }

    const toolUses = (data.content || []).filter(b => b.type === "tool_use");
    lastText = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n") || lastText;

    if (!toolUses.length) {
      if (textEndsTurn) {
        return { terminal: { type: "answered" }, toolCalls, elapsedMs: Date.now() - started, lastText };
      }
      if (++nudges > 2) {
        return { terminal: { type: "stalled", note: lastText.slice(0, 600) }, toolCalls, elapsedMs: Date.now() - started, lastText };
      }
      messages.push({ role: "assistant", content: data.content });
      messages.push({ role: "user", content: "You ended your turn without a tool call. Every turn must end in a tool call: continue the work, or call finish (task complete), wait (blocked on something that resolves later), or ask_requester (need input). Do not narrate plans without executing them." });
      continue;
    }

    // Echo the assistant turn verbatim BEFORE executing — thinking blocks must
    // ride along unchanged or the next request 400s.
    messages.push({ role: "assistant", content: data.content });

    const results = [];
    for (const tu of toolUses) {
      toolCalls++;
      let out;
      try { out = await execTool(tu.name, tu.input || {}); }
      catch (e) { out = { error: e.message }; }
      log(`    tool ${tu.name} (${toolCalls}/${maxToolCalls})${out?.error ? ` → error: ${out.error.slice(0, 120)}` : ""}`);
      if (out && out.__terminal) {
        return { terminal: out.__terminal, toolCalls, elapsedMs: Date.now() - started, lastText };
      }
      results.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(out ?? null).slice(0, out?.__generous ? 60000 : 25000),
      });
    }
    const mins = Math.round((Date.now() - started) / 60000);
    results.push({
      type: "text",
      text: `[budget] ${toolCalls}/${maxToolCalls} tool calls used, ~${mins} min elapsed of ${Math.round(maxWallMs / 60000)}. Pace yourself; wrap up cleanly before the budget runs out.`,
    });
    messages.push({ role: "user", content: results });
  }
}

/**
 * Structured call. Returns the parsed object, guaranteed to match `schema`.
 * Note: the schema must set `additionalProperties: false` on every object and
 * list every key in `required` — the API enforces this.
 * Hosted callers can bound timeoutMs/retries; omitted values preserve fleet defaults.
 */
export async function callClaudeJSON({ system, user, schema, model = ANALYSIS_MODEL, maxTokens = 8000, effort = "high", thinking = true, timeoutMs, retries }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: "user", content: user }],
    output_config: { effort, format: { type: "json_schema", schema } },
  };
  if (thinking) body.thinking = { type: "adaptive" };
  else if (thinkingDefaultsOn(model)) body.thinking = { type: "disabled" };

  const data = await post(body, { timeoutMs, retries });
  if (data.stop_reason === "refusal") {
    throw new Error(`model refused: ${data.stop_details?.explanation || "no explanation"}`);
  }
  if (data.stop_reason === "max_tokens") {
    throw new Error(`response truncated at max_tokens (${maxTokens}) — output may be incomplete`);
  }
  const text = firstText(data);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`structured output was not valid JSON: ${text.slice(0, 200)}`);
  }
}
