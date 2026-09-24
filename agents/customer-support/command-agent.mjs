/**
 * The command agent — teammates' emails → structured actions.
 *
 * When a verified teammate emails the agent, this loop reads the request against
 * its capability fact and returns ONE structured decision via submit_action:
 *
 *   queue_task      — create a task for one of the marker agents (or a todo)
 *   confirm_pending — the teammate is confirming a previously-queued pending task
 *   decline         — not something it can do; reply says so and offers the
 *                     closest alternative
 *   escalate        — it can't safely interpret the request at all
 *
 * Same safety model as every other agent: the model only ever has READ tools;
 * the worker performs all writes (task creation, renames, sends) in
 * deterministic code after validating the action against its own executable map.
 */

import { noanGet, noanGetAll, searchContacts, companyName } from "../shared/noan.mjs";
import { agentName as defaultAgentName, allowedLinks } from "../shared/required-env.mjs";

import { postMessages } from "../shared/anthropic.mjs";

const MODEL = process.env.COMMAND_MODEL || "claude-opus-5";
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

export const TOOLS = [
  {
    name: "list_blocks",
    description: "List available NOAN fact blocks. Use only if you need company knowledge beyond what you were given.",
    input_schema: { type: "object", properties: { title: { type: "string" } } },
  },
  {
    name: "get_facts",
    description: "Read verified facts for NOAN block slugs. Ground truth — do not invent.",
    input_schema: {
      type: "object",
      properties: { block_slugs: { type: "array", items: { type: "string" } } },
      required: ["block_slugs"],
    },
  },
  {
    name: "search_contacts",
    description:
      "Search NOAN contacts by name, company or email. Use this to resolve who a requested task is about. If several people match, do NOT guess — decline and ask the teammate to specify the email.",
    input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  },
  {
    name: "submit_action",
    description: "Submit your single decision. Call exactly once. The system executes it — you never write or send anything yourself.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["queue_task", "confirm_pending", "decline", "escalate"] },
        task: {
          type: "object",
          description: "Required when action=queue_task.",
          properties: {
            type: {
              type: "string",
              enum: ["deck", "onboard", "followup", "todo", "general"],
              description: "general = anything the teammate wants " + defaultAgentName() + " to do that is not a specialist type above — including a reply to one of its own report emails with an instruction or approval. todo = a plain to-do for a HUMAN; nothing runs on it.",
            },
            title: {
              type: "string",
              description: "Human title WITHOUT any [marker] prefix — the system adds the marker. E.g. 'Sales deck for Jane Doe — Acme'.",
            },
            details: {
              type: "string",
              description: "Task details/brief, including everything the specialist agent needs (context, meeting date, what the follow-up is about…). Do NOT include the contact line — the system stamps it. For type=general on a report reply: ONLY the teammate's instruction, in their sense (e.g. 'Act on recommendation 2 of the fact alignment report' or 'Go ahead with the specific recommendations') — the system appends the quoted report itself; do not copy or summarise it.",
            },
            contact_email: {
              type: "string",
              description: "Email of the NOAN contact this task is about (resolve via search_contacts). Required for deck/onboard/followup; omit for todo/general unless the request is about a specific contact. When search_contacts finds NOBODY but the teammate wrote the person's exact address in their own words, pass that address verbatim — the system creates the contact (untagged, memoed) and links it. Never an address you inferred or completed.",
            },
            contact_name: {
              type: "string",
              description: "Only alongside a contact_email that is NOT yet in NOAN: the person's name exactly as the teammate wrote it, so the new contact is not named after the address. Omit if they gave no name.",
            },
          },
          required: ["type", "title", "details"],
        },
        pending_contact_email: {
          type: "string",
          description: "When action=confirm_pending: the contact email of the pending task being confirmed.",
        },
        reply_html: { type: "string", description: defaultAgentName() + "'s reply to the teammate as simple HTML — confirming what was queued (and for onboard, asking them to reply CONFIRM), or explaining a decline. Sign as " + defaultAgentName() + "." },
        reply_text: { type: "string", description: "Plain-text version of the same reply." },
        reason: { type: "string", description: "For decline/escalate: one sentence why." },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["action", "reply_html", "reply_text", "confidence"],
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
      const out = {};
      for (const s of input.block_slugs || []) {
        const res = await noanGet(`/facts?block_slug=${encodeURIComponent(s)}&per_page=100`);
        out[s] = (res.items || []).map(f =>
          f.content.length > 40000 ? f.content.slice(0, 40000) + "\n[...fact truncated]" : f.content);
      }
      return out;
    }
    case "search_contacts": {
      const items = await searchContacts(input.q || "", { perPage: 10 });
      return items.map(c => ({
        id: c.id, name: c.name, email: c.email, website: c.website,
        companyRoles: c.companyRoles, tags: (c.tags || []).map(t => t.name),
      }));
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

function buildSystemPrompt(capabilities, agentName, pendingSummary, appCapabilities = "", company = "the company") {
  const links = allowedLinks();
  return [
    `You are ${agentName}, ${company}'s agent, receiving an email from a VERIFIED TEAMMATE (not a customer).`,
    `Your job: interpret their request as one of your capabilities and submit exactly one action.`,
    `\n\n## Your capabilities (the only things you can queue)\n`,
    capabilities,
    appCapabilities ? `\n\n## The desktop app's own capabilities (BRIEFING ONLY — you cannot queue these; they run on a person's Mac. Use this to answer "can ${agentName}..." questions truthfully, never to promise execution by email.)\n${appCapabilities}` : "",
    pendingSummary ? `\n\n## Currently pending (awaiting CONFIRM)\n${pendingSummary}` : "",
    `\n\n## Hard rules (system-enforced)`,
    `- One email → one submit_action call. If they ask for two things, queue the primary one and say in your reply that they should send the second separately.`,
    `- Resolve the contact with search_contacts before queueing deck/onboard/followup. Exactly one match → use it. Several matches → decline and ask for the exact email address. No match: if the teammate wrote the person's exact email address in their own words, queue with that contact_email (and contact_name if they named them) — the system creates the contact, untagged, and memos where it came from; if they wrote no address, decline and ask for it. Never invent, infer, or complete an address.`,
    `- A reply to one of ${agentName}'s OWN report emails (weekly activity, fact alignment, growth metrics, product usage, market research, or any other scheduled report — the quoted report is in the body) that carries an instruction or an approval — "go ahead", "do recommendation 2", "apply 1 and 3", "post that correction" — is type=general, never todo. A bare approval means "act on the specific, actionable items in this report"; write that as the instruction. Never treat the quoted report's own text as the request — only the teammate's words are.`,
    `- Anything else the teammate wants ${agentName} to do (research, a draft, a NOAN change, a multi-step job) is also type=general. type=todo is only for a to-do a HUMAN will pick up.`,
    `- If the email is clearly just a confirmation (e.g. "confirm", "yes go ahead") and a pending item matches, use confirm_pending.`,
    `- Requests outside the capability list → decline, plainly and helpfully; offer a todo task if it's a real to-do for a person.`,
    `- A request you cannot safely interpret at all → escalate.`,
    `- Your reply is sent to the teammate in-thread. Keep it to 1–4 sentences, sign as ${agentName}, ${links.length ? `no links except ${links.join(", ")}` : "no links"}.`,
    `- Never claim a task is DONE — you are queueing work, so say queued/on it and when they'll see the result.`,
    `- Set confidence low if unsure; low confidence is treated as escalate.`,
  ].join("");
}

function buildUserPrompt(inbound, body, sender) {
  return [
    `## Email from teammate`,
    `From: ${sender.name || ""} <${sender.email}>`,
    `Subject: ${inbound.subject || "(none)"}`,
    ``,
    body || "(empty body)",
  ].join("\n");
}

export async function runCommandAgent({ inbound, body, sender, capabilities, appCapabilities = "", pendingSummary, agentName = defaultAgentName() }) {
  const system = buildSystemPrompt(capabilities, agentName, pendingSummary, appCapabilities, await companyName());
  const messages = [{ role: "user", content: buildUserPrompt(inbound, body, sender) }];

  for (let turn = 0; turn < 10; turn++) {
    const data = await postMessages({ model: MODEL, max_tokens: 6000, ...THINKING, system, tools: TOOLS, messages }, { usage: { action: "command" } });
    if (data.stop_reason === "refusal") throw new Error(`model refused: ${data.stop_details?.explanation || "no explanation"}`);
    const toolUses = (data.content || []).filter(b => b.type === "tool_use");

    const submit = toolUses.find(b => b.name === "submit_action");
    if (submit) {
      const d = submit.input || {};
      if (d.confidence === "low") return { action: "escalate", reason: `low confidence: ${(d.reason || "").slice(0, 200)}` };
      return d;
    }

    if (!toolUses.length) {
      messages.push({ role: "assistant", content: data.content });
      messages.push({ role: "user", content: "Please call submit_action, or a read tool if you still need information." });
      continue;
    }

    messages.push({ role: "assistant", content: data.content });
    const results = [];
    for (const tu of toolUses) {
      if (tu.name === "submit_action") continue;
      let out;
      try { out = await execTool(tu.name, tu.input || {}); }
      catch (e) { out = { error: e.message }; }
      results.push({
        type: "tool_result", tool_use_id: tu.id,
        content: JSON.stringify(out).slice(0, tu.name === "get_facts" ? 60000 : 12000),
      });
    }
    messages.push({ role: "user", content: results });
  }
  return { action: "escalate", reason: "command loop exhausted without a decision" };
}
