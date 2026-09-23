/**
 * Scheduling agent — the MODEL steps of the meeting loop. Everything else
 * (slot computation, availability re-check, event creation, email sends) is
 * deterministic code in reply-worker.mjs / google-cal.mjs.
 *
 *   interpretInit        — a commander's email CCing the agent + externals: is it
 *                          a scheduling request, who with, how long, about what?
 *   interpretReply       — the other side's answer: which offered slot (or
 *                          counter-proposal / decline / unclear)?
 *   interpretCustomerAsk — the customer-initiated direction (2026-07-25): is a
 *                          customer mid-thread clearly asking to book time with
 *                          a named teammate? Gated by MEETING_RX in the worker
 *                          so ordinary email never reaches the classifier.
 *
 * This header said "the two MODEL steps" until 2026-09-06; interpretCustomerAsk
 * had been here since July. All three are single forced-tool calls, and the
 * model has no read or write tools at all — stricter than read-only, because
 * there is nothing for it to reach even in principle.
 */

import { postMessages } from "./anthropic.mjs";
import { companyName } from "./noan.mjs";
import { agentName } from "./required-env.mjs";

const MODEL = process.env.SCHEDULE_MODEL || "claude-opus-5";
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

async function forcedTool({ system, user, tool }) {
  const data = await postMessages({
    model: MODEL, max_tokens: 4000, ...THINKING, system,
    tools: [tool], tool_choice: { type: "tool", name: tool.name },
    messages: [{ role: "user", content: user }],
  }, { usage: { action: "schedule" } });
  if (data.stop_reason === "refusal") throw new Error(`model refused: ${data.stop_details?.explanation || "no explanation"}`);
  const tu = (data.content || []).find(b => b.type === "tool_use" && b.name === tool.name);
  if (!tu) throw new Error("model returned no tool call");
  return tu.input || {};
}

export async function interpretInit({ inbound, body, externals, defaultDuration }) {
  const out = await forcedTool({
    system:
      `You classify an email a teammate sent, CCing ${agentName()} (an assistant) with external people on the thread. Three possible intents:\n` +
      `- "schedule": the teammate asks ${agentName()} to find a meeting time with the external participant(s).\n` +
      `- "support": the teammate hands ${agentName()} a CUSTOMER ISSUE to handle — the external person has a problem/question and the teammate asks ${agentName()} to help them (e.g. "${agentName()}, can you help Jane with this?").\n` +
      `- "neither": anything else.\n` +
      `Be conservative — pick schedule/support only when the ask is clear.`,
    user: [
      `From (teammate): ${inbound.from}`,
      `External participants on thread: ${externals.join(", ")}`,
      `Subject: ${inbound.subject || "(none)"}`,
      ``,
      body || "(empty)",
    ].join("\n"),
    tool: {
      name: "classify",
      description: "Classify the thread intent.",
      input_schema: {
        type: "object",
        properties: {
          intent: { type: "string", enum: ["schedule", "support", "neither"] },
          prospect_email: { type: "string", description: "schedule: which external the meeting is with. support: the customer's email. From the list." },
          topic: { type: "string", description: "schedule: short meeting topic. Empty if unknown." },
          duration_min: { type: "number", description: `schedule: meeting length in minutes if stated, else ${defaultDuration}.` },
          prospect_first_name: { type: "string", description: "The external person's first name if inferable, else empty." },
          issue_note: { type: "string", description: "support: one-sentence summary of the issue as the teammate describes it." },
        },
        required: ["intent"],
      },
    },
  });
  out.is_scheduling = out.intent === "schedule";   // back-compat
  return out;
}

export async function interpretReply({ body, offeredSlots, timeZone, senderEmail = "", receivedAtISO = "", now = new Date() }) {
  return forcedTool({
    system:
      `You interpret a reply to a scheduling email. Today is ${now.toISOString().slice(0, 10)}. ` +
      (senderEmail ? `The reply is from ${senderEmail}` : "") +
      (receivedAtISO ? `, received ${receivedAtISO}. ` : ". ") +
      `${agentName()} offered these slots (all times ${timeZone}):\n` +
      offeredSlots.map((s, i) => `${i + 1}. ${s.human} (starts ${s.startISO})`).join("\n") +
      `\nDecide what the person chose.\n` +
      `accept = they clearly picked ONE offered slot.\n` +
      `counter = they proposed ONE different specific time (return it as ISO 8601 UTC, interpreting their words in ${timeZone}).\n` +
      `new_times = the offered slots don't suit and they want different options — a different week, a time-of-day ` +
      `preference, particular days, or a list of their own availability windows — without accepting one specific time ` +
      `(e.g. "can we do next week?", "mornings are better", "not Fridays", "I'm free Mon 2-4pm and Wed 9-12"). ` +
      `Fill in ONLY the constraint fields their words actually support; leave the rest out.\n` +
      `decline = they don't want to meet at all.\n` +
      `unclear = anything else you cannot confidently place, including picking two offered slots at once.\n` +
      `Be conservative about accept and counter, but when they are clearly asking for other times prefer new_times over unclear.\n` +
      `TIMEZONE: the person may be in a different timezone from the offer. Clues, in rough order of strength: explicit ` +
      `markers (ET, PST, CET, "my time"); a city in the signature; quoted email headers in the body — a mail client ` +
      `renders quoted "Sent:" timestamps in THE SENDER'S local time, so comparing one against the actual UTC time of ` +
      `that message (the thread ran shortly before ${receivedAtISO || now.toISOString()}) reveals their UTC offset; ` +
      `and the company behind their email domain, if you know where it is based. When their timezone is stated or ` +
      `inferable this way, interpret every time they mention in THEIR timezone and report it in prospect_timezone; ` +
      `otherwise interpret times in ${timeZone}. All ISO fields you return are UTC — do the conversion yourself.`,
    user: body || "(empty)",
    tool: {
      name: "interpret",
      description: "Interpret the scheduling reply.",
      input_schema: {
        type: "object",
        properties: {
          decision: { type: "string", enum: ["accept", "counter", "new_times", "decline", "unclear"] },
          slot_index: { type: "number", description: "1-based index of the accepted slot (accept only)." },
          counter_start_iso: { type: "string", description: "ISO 8601 UTC start time they proposed (counter only)." },
          window_start_iso: { type: "string", description: "new_times: earliest acceptable moment as ISO 8601 UTC, if they bounded it (\"next week\" = the coming Monday 00:00 in their timezone). Omit if unbounded." },
          window_end_iso: { type: "string", description: "new_times: latest acceptable moment as ISO 8601 UTC, if they bounded it (\"next week\" = that Sunday 23:59). Omit if unbounded." },
          day_start: { type: "string", description: `new_times: earliest acceptable time of day, 24h HH:MM in ${timeZone} (convert from their timezone if known), if they stated one (afternoons = 13:00). Omit otherwise.` },
          day_end: { type: "string", description: `new_times: latest acceptable time of day, 24h HH:MM in ${timeZone} (convert from their timezone if known), if they stated one (mornings = 12:00). Omit otherwise.` },
          weekdays: { type: "array", items: { type: "string", enum: ["Mon", "Tue", "Wed", "Thu", "Fri"] }, description: "new_times: only these weekdays suit, if they said so. Omit otherwise." },
          windows: {
            type: "array",
            description: "new_times: when they list SPECIFIC availability windows (\"Mon 2-4pm, Wed 9-12\"), return every window as UTC ISO start/end, converted from their timezone (prospect_timezone if set). Omit when they only gave loose preferences.",
            items: {
              type: "object",
              properties: {
                start_iso: { type: "string", description: "Window start, ISO 8601 UTC." },
                end_iso:   { type: "string", description: "Window end, ISO 8601 UTC." },
              },
              required: ["start_iso", "end_iso"],
            },
          },
          prospect_timezone: { type: "string", description: "IANA timezone (e.g. America/New_York) when their timezone is stated or clearly inferable from the message. Omit if unknown." },
          reason: { type: "string", description: "One sentence for new_times/decline/unclear — what they asked for." },
        },
        required: ["decision"],
      },
    },
  });
}

/**
 * interpretCustomerAsk — a CUSTOMER in an email thread with the agent asks to
 * set up time with a teammate ("can we get 30 min with Sam?"). Added
 * 2026-07-25 after a customer's ask got escalated instead of scheduled: customers
 * can now initiate the scheduling flow, with the teammate as calendar owner.
 * Conservative: only wants_meeting=true when they are clearly asking to
 * arrange a live conversation, not merely mentioning a call.
 */
export async function interpretCustomerAsk({ inbound, body, teammates, defaultDuration = 30 }) {
  return forcedTool({
    system:
      `You classify an email from a CUSTOMER to ${agentName()} (an AI assistant at ${await companyName()}). ` +
      `Decide whether they are clearly asking to SET UP A MEETING/CALL with a human on the NOAN team.\n` +
      `Team members they might name: ${teammates.join(", ")} (match by first name too, e.g. "Sam" → sam@...).\n` +
      `wants_meeting=true ONLY for a clear ask to arrange time (e.g. "could we set up a call", "can I get 30 minutes with Sam", "happy to jump on a call if you can set it up"). ` +
      `Mentioning a past call, or "maybe some day", is NOT an ask.`,
    user: [
      `From (customer): ${inbound.from}`,
      `Subject: ${inbound.subject || "(none)"}`,
      ``,
      body || "(empty)",
    ].join("\n"),
    tool: {
      name: "classify",
      description: "Classify whether the customer is asking to schedule time with the team.",
      input_schema: {
        type: "object",
        properties: {
          wants_meeting: { type: "boolean" },
          with_teammate_email: { type: "string", description: "The teammate they want to meet, from the list. Empty if unspecified (a default owner will be used)." },
          topic: { type: "string", description: "Short meeting topic. Empty if unknown." },
          duration_min: { type: "number", description: `Meeting length if stated, else ${defaultDuration}.` },
          first_name: { type: "string", description: "The customer's first name if inferable, else empty." },
        },
        required: ["wants_meeting"],
      },
    },
  });
}
