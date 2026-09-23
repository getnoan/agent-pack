/**
 * The reply drafting agent. Same shape as the other drafters: the shared Messages helper (postMessages),
 * READ-ONLY NOAN tools, final answer forced through one structured tool.
 *
 * The model must choose: action "reply" (with the drafted answer) or
 * "escalate" (with a reason). The worker treats anything that isn't a clean,
 * confident "reply" as an escalation — the safe default direction.
 */

import { noanGet, noanGetAll, companyName } from "./noan.mjs";
import { agentName as defaultAgentName, linkRule } from "./required-env.mjs";

import { postMessages } from "./anthropic.mjs";

const MODEL = process.env.REPLY_DRAFT_MODEL || "claude-opus-5";
// Claude Opus 5 (2026-09-09): thinking is on by default. Keep it explicit
// (adaptive, low effort: the cheap setting that still avoids
// tool-calls-as-text). The refusal fallbacks that used to be set here by hand
// now come from postMessages, which opts every Opus 5 request in — and which
// carries the prompt-cache breakpoints this agent never had (caching brief
// 2026-09-09, P2): system + tools cache across a run, so per-task data must
// stay in messages, never in the system prompt.
// Adaptive thinking + effort are Opus/Sonnet-tier params (Haiku 400s on
// them), so an env override to a smaller model sends neither.
const THINKING = /^claude-(opus|sonnet)/.test(MODEL)
  ? { thinking: { type: "adaptive" }, output_config: { effort: "low" } }
  : {};

const TOOLS = [
  {
    name: "list_blocks",
    description: "List available NOAN fact blocks (slugs + titles).",
    input_schema: {
      type: "object",
      properties: { title: { type: "string", description: "Optional partial title filter." } },
    },
  },
  {
    name: "get_facts",
    description:
      "Read the verified facts for one or more NOAN block slugs. These are ground truth. An empty block is information — do not invent.",
    input_schema: {
      type: "object",
      properties: { block_slugs: { type: "array", items: { type: "string" } } },
      required: ["block_slugs"],
    },
  },
  {
    name: "submit_reply",
    description:
      "Submit your decision. Call exactly once. action 'reply' sends your draft in-thread; action 'escalate' forwards the message to a human instead (always the right call when unsure).",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["reply", "escalate"] },
        reason: { type: "string", description: "escalate only: why a human should take this." },
        html:   { type: "string", description: "reply only: body as simple HTML (<p>, <br>, <ol>, <li>, <a>). No wrapper." },
        text:   { type: "string", description: "reply only: plain-text version." },
        grounded_on: {
          type: "array", items: { type: "string" },
          description: "reply only: block slugs whose facts you used.",
        },
        confidence: {
          type: "string", enum: ["high", "medium", "low"],
          description: "reply only: confidence the answer is accurate. 'low' is treated as escalate.",
        },
      },
      required: ["action"],
    },
  },
];

async function execTool(name, input) {
  switch (name) {
    case "list_blocks": {
      const q = input.title ? `?title=${encodeURIComponent(input.title)}&per_page=100` : `?per_page=100`;
      const items = await noanGetAll(`/blocks${q}`);
      return items.map(b => ({ slug: b.slug, title: b.title, stack: b.stack?.slug }));
    }
    case "get_facts": {
      // Cap each fact individually — a flat slice on the combined result used to
      // silently drop whole blocks (the pricing block vanished behind a 14k
      // product-features fact, causing a wrong "no usable facts" escalation).
      const out = {};
      for (const s of input.block_slugs || []) {
        const res = await noanGet(`/facts?block_slug=${encodeURIComponent(s)}&per_page=100`);
        out[s] = (res.items || []).map(f =>
          f.content.length > 9000 ? f.content.slice(0, 9000) + "\n[...fact truncated]" : f.content);
      }
      return out;
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

// get_facts results are the agent's ground truth — give them room; keep other
// tool results tight.
export function resultLimit(toolName) {
  return toolName === "get_facts" ? 60000 : 12000;
}

function buildSystemPrompt(brain, agentName, company) {
  return [
    `You are ${agentName}, replying to inbound email on behalf of ${company}.`,
    `Sign any reply as ${agentName} and no one else.`,
    `\n\n`,
    brain.config,
    brain.playbook ? `\n\n## Reply playbook\n${brain.playbook}` : "",
    `\n\n## Hard rules (system-enforced)`,
    `- When in ANY doubt, submit action "escalate" — a human takes the thread. This is success, not failure.`,
    `- Ground every claim in NOAN facts via get_facts. Ungroundable → escalate.`,
    linkRule(),
    `- Never promise, commit, discount, refund, or apologise on behalf of the company.`,
    `- You do NOT send email. Call submit_reply and the system acts on it.`,
  ].join("");
}

function buildUserPrompt(inbound, body, contact, memoContext, agentName) {
  return [
    `A contact has replied to an email ${agentName} sent them. Decide: reply or escalate.`,
    ``,
    `## Inbound message`,
    `From: ${inbound.from}`,
    `Subject: ${inbound.subject || "(none)"}`,
    ``,
    body || "(empty body)",
    ``,
    `## Contact (from NOAN)`,
    `Name: ${contact.name || "(unknown)"}`,
    `Email: ${contact.email}`,
    contact.website ? `Website: ${contact.website}` : ``,
    contact.companyRoles?.length ? `Roles: ${contact.companyRoles.map(r => `${r.role || "?"} @ ${r.companyName}`).join("; ")}` : ``,
    contact.tags?.length ? `Tags: ${contact.tags.map(t => t.name).join(", ")}` : ``,
    memoContext ? `\n## Contact history (INTERNAL history in NOAN (meeting summaries, past agent emails, support exchanges). Use it for continuity: know what has already been said or sent, reference genuinely shared history naturally. NEVER quote a memo verbatim, never mention internal notes exist, never reveal anything the contact would not already know.)\n${memoContext}` : ``,
    ``,
    `Ground yourself in the relevant fact blocks first (get_facts), then call submit_reply.`,
  ].filter(Boolean).join("\n");
}

/** Returns { action:"reply", html, text, confidence, grounded_on } or { action:"escalate", reason }. */
export async function runReplyAgent({ inbound, body, contact, brain, memoContext = null, agentName = defaultAgentName() }) {
  const system = buildSystemPrompt(brain, agentName, await companyName());
  const messages = [{ role: "user", content: buildUserPrompt(inbound, body, contact, memoContext, agentName) }];

  for (let turn = 0; turn < 10; turn++) {
    const data = await postMessages({ model: MODEL, max_tokens: 5000, ...THINKING, system, tools: TOOLS, messages }, { usage: { action: "reply-draft" } });
    if (data.stop_reason === "refusal") throw new Error(`model refused: ${data.stop_details?.explanation || "no explanation"}`);
    const toolUses = (data.content || []).filter(b => b.type === "tool_use");

    const submit = toolUses.find(b => b.name === "submit_reply");
    if (submit) {
      const d = submit.input || {};
      if (d.action === "escalate") return { action: "escalate", reason: d.reason || "model chose escalate" };
      if (d.action === "reply") {
        if (!d.html || !d.text) return { action: "escalate", reason: "model submitted an incomplete reply draft" };
        if (d.confidence === "low") return { action: "escalate", reason: `model low confidence: ${(d.reason || "").slice(0, 200)}` };
        return { action: "reply", html: d.html, text: d.text, confidence: d.confidence, grounded_on: d.grounded_on || [] };
      }
      return { action: "escalate", reason: `model submitted unknown action "${d.action}"` };
    }

    if (toolUses.length === 0) {
      messages.push({ role: "assistant", content: data.content });
      messages.push({ role: "user", content: "Please call submit_reply (action reply or escalate), or a read tool if you still need facts." });
      continue;
    }

    messages.push({ role: "assistant", content: data.content });
    const results = [];
    for (const tu of toolUses) {
      if (tu.name === "submit_reply") continue;
      let out;
      try { out = await execTool(tu.name, tu.input || {}); }
      catch (e) { out = { error: e.message }; }
      results.push({ type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out).slice(0, resultLimit(tu.name)) });
    }
    messages.push({ role: "user", content: results });
  }
  return { action: "escalate", reason: "drafting loop exhausted without a decision" };
}
