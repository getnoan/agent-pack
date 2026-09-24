/**
 * Customer-success agent — the model side of support cases.
 *
 * Handles every customer inbound (fresh or mid-case). Same safety model as the
 * other agents: READ-ONLY NOAN tools; every write (send, memo, task, brief,
 * case state) is deterministic code in reply-worker.mjs.
 *
 * One submit_support call per turn:
 *   action reply    — send the message, keep the case open (gathering details
 *                     or awaiting the customer's confirmation)
 *   action resolve  — send the message and close the case as handled
 *   action escalate — send a short holding message, close as needs-human
 */

import { noanGet, noanGetAll, searchContacts, companyName } from "../shared/noan.mjs";
import { agentName as defaultAgentName, linkRule } from "../shared/required-env.mjs";

import { postMessages } from "../shared/anthropic.mjs";

const MODEL = process.env.CS_MODEL || "claude-opus-5";
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
    description: "List available NOAN fact blocks. Use if you need knowledge beyond the recommended set.",
    input_schema: { type: "object", properties: { title: { type: "string" } } },
  },
  {
    name: "get_facts",
    description: "Read verified facts for NOAN block slugs. Ground truth — never invent beyond them.",
    input_schema: {
      type: "object",
      properties: { block_slugs: { type: "array", items: { type: "string" } } },
      required: ["block_slugs"],
    },
  },
  {
    name: "search_contacts",
    description: "Search NOAN contacts by name/company/email for more context on the customer.",
    input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  },
  {
    name: "submit_support",
    description: "Submit your single decision for this turn. The system sends the message and performs all record-keeping.",
    input_schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["reply", "resolve", "escalate"] },
        reply_html: { type: "string", description: "Message to the CUSTOMER as simple HTML. For escalate: a short holding line saying a teammate will pick this up." },
        reply_text: { type: "string", description: "Plain-text version." },
        subject: { type: "string", description: "OUTREACH ONLY (when " + defaultAgentName() + " is opening the conversation, not replying): a short, natural subject line. Omit when replying in-thread." },
        is_issue: {
          type: "boolean",
          description: "true if this is a genuine support issue/problem (something wrong, broken, blocking, or a complaint). false for a simple product question answered in one turn — those skip the team brief.",
        },
        issue_summary: { type: "string", description: "One–three sentence summary of the issue and its current state, for the memo and team brief." },
        solved: { type: "boolean", description: "resolve only: was the customer's issue actually addressed (vs. worked around / answered partially)?" },
        followup_tasks: {
          type: "array",
          description: "Follow-up work this case surfaced (bug to check, doc to fix, promise made to the customer). Empty if none.",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              details: { type: "string" },
              assign: { type: "string", enum: ["verity", "human"], description: "verity = something an agent handles; human = needs a person." },
            },
            required: ["title", "details", "assign"],
          },
        },
        reason: { type: "string", description: "escalate only: one sentence why a human is needed." },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
      },
      required: ["action", "reply_html", "reply_text", "is_issue", "issue_summary", "confidence"],
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

function buildSystemPrompt(brain, agentName, company) {
  // Product-manual guidance is a fact of OUR workspace (the block slugs are
  // ours), so it only enters the prompt when PRODUCT_MANUAL_SLUG_PREFIX names
  // those blocks; a downstream copy has no such prefix and gets no such line.
  const manualPrefix = (process.env.PRODUCT_MANUAL_SLUG_PREFIX || "").trim();
  return [
    `You are ${agentName}, ${company}'s customer success agent, handling a support conversation by email.`,
    `Sign every message as ${agentName} and no one else.`,
    `\n\n`,
    brain.csConfig,
    brain.playbook ? `\n\n## Tone playbook\n${brain.playbook}` : "",
    `\n\n## Hard rules (system-enforced)`,
    `- Ground every claim in NOAN facts via get_facts. If you can't ground it, say you'll check rather than guessing.`,
    manualPrefix ? `- For questions about how the product works, read the Product Manual stack blocks FIRST (slugs start with "${manualPrefix}": overview, assistant, stacks-blocks-facts, tasks-tags, network, assets, notes, activity-analytics, settings-account, api-integrations, verity-in-slack, agent-skills, partner-briefs; use manual-troubleshooting for errors and "X isn't working"). The manual's how-tos are dual-path: prefer giving the customer the "Via assistant" instruction, with UI steps as fallback. Anything in Settings (billing, team, integrations, API keys, deletions) the in-app assistant CANNOT do — give UI steps there.` : "",
    linkRule(),
    `- Never invent features, fixes, timelines, or commitments. Never promise refunds, credits, or account changes — that's escalate territory.`,
    `- Ask at most ONE focused question per message — never a questionnaire. The system caps a case at 10 exchanges and escalates it automatically, so use the room to actually help; but if two consecutive rounds make no progress, resolve or escalate rather than going in circles.`,
    `- Money, legal, security, data loss, anger, or anything you're unsure of → escalate. Low confidence is treated as escalate.`,
    `- You do NOT send email or write records. Call submit_support once; the system does the rest.`,
  ].join("");
}

function buildUserPrompt({ inbound, body, contact, caseData, openerNote, outreach, memoContext }) {
  if (outreach) {
    return [
      `## Proactive outreach (a teammate queued a support task — YOU open the conversation)`,
      `Task: ${outreach.title}`,
      `Brief: ${outreach.details || "(none)"}`,
      ``,
      `## Customer (from NOAN)`,
      `Name: ${contact.name || "(unknown)"} · Email: ${contact.email}`,
      contact.companyRoles?.length ? `Roles: ${contact.companyRoles.map(r => `${r.role || "?"} @ ${r.companyName}`).join("; ")}` : ``,
      contact.tags?.length ? `Tags: ${contact.tags.map(t => t.name || t).join(", ")}` : ``,
      memoContext ? `\n## Contact history (INTERNAL history in NOAN (meeting summaries, past agent emails, support exchanges). Use it for continuity: know what has already been said or sent, reference genuinely shared history naturally. NEVER quote a memo verbatim, never mention internal notes exist, never reveal anything the contact would not already know.)\n${memoContext}` : ``,
      ``,
      `Compose the FIRST message to this customer about the issue in the brief: say why you're reaching out (a teammate flagged it / checking in), offer concrete grounded help or ask ONE focused question to get started, and include a subject line. Action must be "reply" (the case opens and awaits their answer) — or "escalate" if the brief is too unclear to act on.`,
      `Ground yourself in the relevant facts first, then call submit_support.`,
    ].filter(Boolean).join("\n");
  }
  const history = (caseData?.turns || []).map(t => `- [${t.who}] ${t.summary}`).join("\n");
  return [
    caseData ? `## Ongoing support case (opened ${caseData.openedAt.slice(0, 10)}${caseData.openedBy !== "direct" ? `, handed to you by ${caseData.openedBy}` : ""})` : `## New inbound from a customer`,
    history ? `Conversation so far:\n${history}` : ``,
    openerNote ? `Teammate's handoff note: ${openerNote}` : ``,
    ``,
    `## Their latest message`,
    `From: ${inbound.from}`,
    `Subject: ${inbound.subject || "(none)"}`,
    ``,
    body || "(empty)",
    ``,
    `## Customer (from NOAN)`,
    `Name: ${contact.name || "(unknown)"} · Email: ${contact.email}`,
    contact.companyRoles?.length ? `Roles: ${contact.companyRoles.map(r => `${r.role || "?"} @ ${r.companyName}`).join("; ")}` : ``,
    contact.tags?.length ? `Tags: ${contact.tags.map(t => t.name || t).join(", ")}` : ``,
    memoContext ? `\n## Contact history (INTERNAL history in NOAN (meeting summaries, past agent emails, support exchanges). Use it for continuity: know what has already been said or sent, reference genuinely shared history naturally. NEVER quote a memo verbatim, never mention internal notes exist, never reveal anything the contact would not already know.)\n${memoContext}` : ``,
    ``,
    `Ground yourself in the relevant facts, then call submit_support.`,
  ].filter(Boolean).join("\n");
}

export async function runSupportAgent({ inbound, body, contact, brain, caseData = null, openerNote = null, outreach = null, memoContext = null, agentName = defaultAgentName() }) {
  const system = buildSystemPrompt(brain, agentName, await companyName());
  const messages = [{ role: "user", content: buildUserPrompt({ inbound, body, contact, caseData, openerNote, outreach, memoContext }) }];

  for (let turn = 0; turn < 10; turn++) {
    const data = await postMessages({ model: MODEL, max_tokens: 6000, ...THINKING, system, tools: TOOLS, messages }, { usage: { action: "cs" } });
    if (data.stop_reason === "refusal") throw new Error(`model refused: ${data.stop_details?.explanation || "no explanation"}`);
    const toolUses = (data.content || []).filter(b => b.type === "tool_use");

    const submit = toolUses.find(b => b.name === "submit_support");
    if (submit) {
      const d = submit.input || {};
      if (d.confidence === "low" && d.action !== "escalate") {
        return { ...d, action: "escalate", reason: d.reason || "model low confidence" };
      }
      return d;
    }

    if (!toolUses.length) {
      messages.push({ role: "assistant", content: data.content });
      messages.push({ role: "user", content: "Please call submit_support, or a read tool if you still need facts." });
      continue;
    }

    messages.push({ role: "assistant", content: data.content });
    const results = [];
    for (const tu of toolUses) {
      if (tu.name === "submit_support") continue;
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
  return { action: "escalate", reply_html: "", reply_text: "", is_issue: true, issue_summary: "support loop exhausted without a decision", reason: "loop exhausted", confidence: "low" };
}
