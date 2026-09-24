#!/usr/bin/env node
/**
 * NOAN reply agent — worker. Runs every 15 min.
 *
 * The agent's outbound mail carries Reply-To: <agent>@<id>.resend.app, so customer
 * replies land in Resend Inbound. This worker:
 *
 *   1. Polls GET https://api.resend.com/emails/receiving (no webhook server
 *      needed — fits the launchd/cron architecture of the other agents).
 *   2. Skips anything already in the ledger (a NOAN fact block), anything from
 *      an auto-responder/bounce address, and our own sends.
 *   3. Matches the sender to a NOAN contact by email — or, since 2026-09-09,
 *      creates one from the email (live exact-address dedupe first, untagged,
 *      provenance memo) so a first-time sender is answered, not parked.
 *   4. Runs the drafting model (READ-ONLY NOAN tools) which must choose:
 *        reply    → grounded answer, sent in the same thread (In-Reply-To)
 *        escalate → NO auto-answer; the inbound is forwarded to a human
 *                   (ESCALATE_TO) and a needs-human NOAN task is created.
 *      Low confidence or any guard failure also escalates (an unknown sender
 *      no longer does on its own — only a failed contact create).
 *   5. Records a memo on the contact, marks the email processed.
 *
 * Loop safety: auto-responder/bounce senders are skipped outright; at most
 * MAX_REPLIES_PER_SENDER_PER_DAY (default 3) auto-replies per sender per day —
 * beyond that, escalate. Idempotency: ledger keyed by Resend inbound email id;
 * Resend Idempotency-Key on every send.
 *
 * TEST mode: while TEST_RECIPIENT is set, replies AND escalation forwards all
 * go to TEST_RECIPIENT instead of the real sender / ESCALATE_TO.
 *
 * Extra env beyond the onboarding agent's:
 *   REPLY_CONFIG_BLOCK_SLUG / REPLY_PLAYBOOK_BLOCK_SLUG
 *   (state ledger: local file ~/.verity-agents/state/reply.json — see state-local.mjs)
 *   ESCALATE_TO                    REQUIRED, no default — where anything this
 *                                  agent cannot answer is forwarded
 *   REPLY_HUMAN_ASSIGNEES          identity ids for needs-human follow-ups;
 *                                  unset = the key's own identity
 *   MAX_REPLIES_PER_RUN            default 5
 *   MAX_REPLIES_PER_SENDER_PER_DAY default 3
 *   REPLY_ONLY_EMAIL_ID=<id>       process exactly this inbound email — testing
 *   PROSPECT_FOLLOWUP_ASSIGNEES    identity ids for the follow-up task a "sent N"
 *                                  digest reply files (prospector-replies.mjs)
 *   PROSPECT_FOLLOWUP_DAYS         its due offset, default 5
 */

import {
  addContactMemo,
  noanGet,
  noanGetAll,
  noanPost,
  noanPatch,
  noanPut,
  addTaskTags,
  assignVerity,
  fetchContactMemos,
  assertNoanKey,
  postNote,
  findOrCreateContactByEmail,
  senderDisplayName,
  parkForHuman,
  taskHasTag,
  unparkTask, assignResolvedOwner } from "../shared/noan.mjs";
import { assertModelKey } from "../shared/anthropic.mjs";
import { planQueuedTask, contactCreatePlan, warnUnregisteredTriggers } from "./command-queue.mjs";
import { runReplyAgent } from "./reply-agent.mjs";
import { runCommandAgent } from "./command-agent.mjs";
import { runSupportAgent } from "./cs-agent.mjs";
import { interpretInit, interpretReply, interpretCustomerAsk } from "./schedule-agent.mjs";
import { freeBusy, computeSlots, slotStillFree, createEvent } from "./google-cal.mjs";
import { parseScheduleFact } from "./slots.mjs";
import { sendEmail } from "../shared/resend.mjs";
import { supportScanCandidates, supportTaskContactId, supportCommentRearm } from "./support-scan.mjs";
import { steeringComments, normalizeComments, latestCursor, renderComments } from "../shared/task-comments.mjs";
import { loadLocalState, saveLocalState, peekState } from "../shared/state-local.mjs";
import { commanderAuthVerdict } from "./commander-auth.mjs";
import { loadLane } from "./optional-lane.mjs";

/* Business lanes that ride on this worker but are not part of the six-agent
 * pack: re-engagement decks, pre-call briefs, the course, prospector digests.
 * Loaded only if present (optional-lane.mjs): the export cuts them out, and
 * each lane then answers "not this thread" so routing falls through to the
 * generic paths. A lane that exists but fails to load still throws. */
const { hasOfferedThread, handleReengageReply } = await loadLane("reengage-reply", { hasOfferedThread: () => false });
const { hasBriefThread, handleBriefReply } = await loadLane("brief-reply", { hasBriefThread: () => false });
const { hasCourseThread, handleCourseReply, maybeCourseStartAsk } = await loadLane("course-reply",
  { hasCourseThread: () => false, maybeCourseStartAsk: async () => ({ handled: false }) });
const { matchDigestSubject, handleProspectorDigestReply } = await loadLane("prospector-replies", { matchDigestSubject: () => null });
const { hasImplementationThread, handleImplementationReply, maybeImplementationStartAsk, intakeOn } = await loadLane("implement-intake",
  { intakeOn: () => false, hasImplementationThread: async () => false, maybeImplementationStartAsk: async () => ({ handled: false }) });
import { respondLine } from "../shared/respond-by.mjs";
import { requireEnv, envList, envAddress, agentName as defaultAgentName, agentIdentityId, allowedLinks, pronouns } from "../shared/required-env.mjs";
import { USER_TAGS, isUserContact } from "./trigger-tags.mjs";

const AGENT_NAME     = defaultAgentName();
const TEST_RECIPIENT = process.env.TEST_RECIPIENT || null;
const ESCALATE_TO    = envAddress("ESCALATE_TO");   // no default: see required-env.mjs
const MAX_RUN        = parseInt(process.env.MAX_REPLIES_PER_RUN || "5", 10);
const MAX_PER_SENDER = parseInt(process.env.MAX_REPLIES_PER_SENDER_PER_DAY || "3", 10);
const MAX_COMMANDS_PER_SENDER = parseInt(process.env.MAX_COMMANDS_PER_SENDER_PER_DAY || "10", 10);
const DRY_RUN        = process.env.DRY_RUN === "1";

// Teammates whose emails are COMMANDS (queue work) rather than customer replies.
// Verified two ways before any command runs: the sender must be on this list AND
// the inbound must carry a DKIM pass for the teammate domain (From: alone is forgeable).
// Unset means NOBODY can issue commands — fails closed. A built-in roster here
// would travel downstream and put our teammates on a stranger's command list.
const COMMANDERS = new Set(envList("COMMANDERS"));
const CAPABILITIES_SLUG = process.env.CAPABILITIES_BLOCK_SLUG || null;
const AGENT_IDENTITY_ID = agentIdentityId();
// Who picks up a follow-up the agent decided needs a human. Comma-separated
// identity ids, same shape as BOARD_SWEEP_ESCALATION_ASSIGNEES. Unset falls
// back to the key's own identity — which is whoever minted the key, so pin it
// rather than letting an API-key rotation silently move someone's workload.
const HUMAN_ASSIGNEES = (process.env.REPLY_HUMAN_ASSIGNEES || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const SCHEDULE_CFG_SLUG = process.env.SCHEDULE_CONFIG_BLOCK_SLUG || null;
const CS_CFG_SLUG       = process.env.CS_CONFIG_BLOCK_SLUG || null;
const MAX_CS_TURNS_PER_SENDER = parseInt(process.env.MAX_CS_TURNS_PER_SENDER_PER_DAY || "10", 10);
const MAX_CS_EXCHANGES_PER_CASE = parseInt(process.env.MAX_CS_EXCHANGES_PER_CASE || "10", 10);
const SUBSCRIBER_TAG    = (process.env.SUBSCRIBER_TAG || "subscriber").toLowerCase();
const CASE_EXPIRY_DAYS  = 14;
const TASK_TAG_CS       = "customer success";

const CONFIG_SLUG   = process.env.REPLY_CONFIG_BLOCK_SLUG;
const PLAYBOOK_SLUG = process.env.REPLY_PLAYBOOK_BLOCK_SLUG;
const COURSE_ON     = process.env.COURSE_ENABLED === "1";   // education course routing

const RESEND_KEY = process.env.RESEND_API_KEY;

function log(...a) { console.log(new Date().toISOString(), ...a); }
function required(name) {
  if (!process.env[name]) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}
// Either NOAN key satisfies this. noan.mjs prefers the per-category key and refuses to run
// with neither, so naming the shared key here would reject a correctly configured
// per-category run — and it is why the shared key had to stay in every workflow env block.
assertNoanKey();
// Either model-key name satisfies this; see assertModelKey.
assertModelKey();
["RESEND_API_KEY", "MAIL_FROM",
 "REPLY_CONFIG_BLOCK_SLUG", "REPLY_PLAYBOOK_BLOCK_SLUG"].forEach(required);

/* ---------------- Resend inbound ---------------- */

async function resendGet(path) {
  const res = await fetch(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${RESEND_KEY}` },
  });
  if (!res.ok) throw new Error(`Resend GET ${path} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function listInbound() {
  // newest-first; one page of 100 is far more than a 15-min window needs,
  // and the ledger makes reprocessing impossible anyway.
  const page = await resendGet(`/emails/receiving?limit=100`);
  return page.data || [];
}

const getInbound = (id) => resendGet(`/emails/receiving/${id}`);

/* ---------------- brain + ledger ---------------- */

async function loadBrain() {
  const cfg  = await noanGet(`/facts?block_slug=${encodeURIComponent(CONFIG_SLUG)}`);
  const play = await noanGet(`/facts?block_slug=${encodeURIComponent(PLAYBOOK_SLUG)}`);
  const config   = (cfg.items  || []).map(f => f.content).join("\n\n").trim();
  const playbook = (play.items || []).map(f => f.content).join("\n\n").trim();
  if (!config) throw new Error(`No facts in reply config block '${CONFIG_SLUG}'. Run seed-reply.mjs. Refusing to run un-instructed.`);
  return { config, playbook };
}

const PROCESSED_KEEP_DAYS = 30;  // inbound feed is one page of 100; a month is ample
const SENT_KEEP_DAYS      = 7;   // sent counters are per-day; only today's are read

function pruneState(s) {
  const cutoff = new Date(Date.now() - PROCESSED_KEEP_DAYS * 86400_000).toISOString();
  for (const [id, p] of Object.entries(s.processed)) {
    if (p?.at && p.at < cutoff) delete s.processed[id];
  }
  const dayCutoff = new Date(Date.now() - SENT_KEEP_DAYS * 86400_000).toISOString().slice(0, 10);
  for (const key of Object.keys(s.sent)) {
    const day = key.slice(key.lastIndexOf("|") + 1);
    if (day < dayCutoff) delete s.sent[key];
  }
  return s;
}

async function loadState() {
  // Missing/corrupt file aborts — an empty ledger would re-reply to every
  // inbound email in the feed.
  const s = loadLocalState("reply", "processed");
  s.sent = s.sent || {};
  return pruneState(s);
}

async function saveState(state) {
  if (DRY_RUN) return;
  saveLocalState("reply", state);
}

/* ---------------- helpers ---------------- */

const EMAIL_RX = /<?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})>?\s*$/i;
function bareEmail(addr) {
  const m = String(addr || "").trim().match(EMAIL_RX);
  return m ? m[1].toLowerCase() : null;
}

// Our own address belongs in MAIL_FROM / SELF_ADDRESSES, not in the source: a
// downstream copy hardcoding ours would fail to recognise its OWN outbound mail,
// which is what the auto-sender loop guard depends on.
const SELF_ADDRESSES = new Set(
  [bareEmail(process.env.MAIL_FROM), ...envList("SELF_ADDRESSES")].filter(Boolean));

/** Addresses at the agent's own reply domain (REPLY_TO's domain) or a Resend
 *  receiving domain are the agent's, never a correspondent's. */
function isOwnMailDomain(e) {
  const replyDomain = (bareEmail(process.env.REPLY_TO) || "").split("@")[1];
  return (!!replyDomain && e.endsWith(`@${replyDomain}`)) || /@[a-z0-9-]+\.resend\.app$/i.test(e);
}

function isAutoSender(email) {
  return /(^|[.+-])(no-?reply|noreply|mailer-daemon|postmaster|bounce|donotreply|notifications?)@/i.test(email) ||
         /@(bounces?|notifications?)\./i.test(email);
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function badLinks(html, text) {
  const urls = `${html || ""}\n${text || ""}`.match(/https?:\/\/[^\s"'<>)]+/gi) || [];
  // Only the hosts named in AGENT_ALLOWED_LINKS may appear; unset means no link
  // at all. The URL matcher captures trailing sentence punctuation ("… at
  // https://example.com."), which made a permitted host fail — trim it first.
  const hosts = new Set(allowedLinks().map(u => { try { return new URL(u).hostname.toLowerCase(); } catch { return null; } }).filter(Boolean));
  return urls.filter(u => {
    try { return !hosts.has(new URL(u.replace(/[.,;:!?]+$/, "")).hostname.toLowerCase()); } catch { return true; }
  });
}

/* ---------------- teammate commands ---------------- */

function headerValue(full, name) {
  const h = full?.headers;
  if (!h) return "";
  const v = typeof h === "object" && !Array.isArray(h)
    ? h[name] ?? h[name.toLowerCase()]
    : (Array.isArray(h) ? h.find(x => (x.name || "").toLowerCase() === name)?.value : null);
  if (Array.isArray(v)) return v.map(x => (typeof x === "string" ? x : x?.value || JSON.stringify(x))).join(" ");
  return typeof v === "string" ? v : v ? JSON.stringify(v) : "";
}

/* From: is forgeable; both commander gates below require proof the mail was
 * DKIM-signed by the teammate domain and DMARC-aligned, as stamped by the receiving
 * MTA (Resend/SES) — commanderAuthVerdict() in commander-auth.mjs, which also
 * owns the Resend header encoding. Until 2026-09-10 this was two loose regexes
 * over the joined header that an attacker's own DKIM pass satisfied. */

/* EXECUTABLE (what can actually run), buildTaskTitle and the task-shaping
 * logic live in command-queue.mjs — the pure, testable half. The registry
 * consistency warning (every trigger tag named there must be one a deployed
 * worker polls) still fires at startup. */
warnUnregisteredTriggers(console.warn);

async function executeQueueTask({ verdict, senderEmail, byEmail, state, inboundId, inbound = null, body = "" }) {
  const t = verdict.task || {};
  let contact = t.contact_email ? (byEmail.get(t.contact_email.toLowerCase()) || null) : null;

  // A specialist command naming an address with no NOAN contact: create it —
  // but only when the teammate wrote that exact address themselves, above any
  // quoted or forwarded text (contactCreatePlan is the code-verified boundary,
  // ownWords the cut; findOrCreateContactByEmail
  // the live exact-address dedupe, so a record another agent created after this
  // run's snapshot loaded is reused, not duplicated). Untagged, with a
  // provenance memo, same as the unknown-sender path further down.
  let contactCreated = false;
  const cp = contactCreatePlan({ verdict, contact, body, subject: inbound?.subject || "" });
  if (cp.action === "refuse") return { ok: false, why: cp.why };
  if (cp.action === "create") {
    let r;
    try { r = await findOrCreateContactByEmail(cp.email, { name: cp.name }); }
    catch (e) { return { ok: false, why: `contact "${cp.email}" is not in NOAN and creating it failed: ${e.message}` }; }
    contact = r.contact;
    byEmail.set(cp.email, contact);
    contactCreated = r.created;
    if (r.created) {
      log(`  command names ${cp.email}, not in NOAN → created contact ${contact.id} (${contact.name})`);
      try {
        await addContactMemo(contact.id,
          `[${AGENT_NAME}] Contact created from a teammate email command — ${new Date().toISOString().slice(0, 10)}\n` +
          `Requested by: ${senderEmail}\nSubject: ${inbound?.subject || "(no subject)"}\nFor: ${t.type} task\n` +
          `Not previously in the network; created untagged (automation-arming tags stay a human call). Enrich or retag by hand if they matter.`);
      } catch (e) { log(`  warn: creation memo failed: ${e.message}`); }
    } else {
      log(`  command names ${cp.email}: missing from this run's snapshot but found live → ${contact.id} (no duplicate created)`);
    }
  }

  const planArgs = { verdict, contact, senderEmail, body, agentName: AGENT_NAME, inbound: { id: inboundId, subject: inbound?.subject || "" } };
  let plan = planQueuedTask(planArgs);
  if (!plan.ok) return plan;

  // A general task carries the quoted email; when it does not fit the 2048
  // cap the full text goes to a note FIRST, so the task's marker never names
  // a note that failed to post. The belt reads it back with noan_read_note.
  // If the note post fails, re-plan: same task, but the marker says the tail
  // was NOT preserved, rather than promising a note that does not exist.
  if (plan.overflowNote) {
    try { await postNote({ title: plan.overflowNote.title, content: plan.overflowNote.content, externalId: `cmd-quote:${inboundId}` }); }
    catch (e) {
      log(`  warn: overflow note failed (${e.message}) — re-planning without the note reference`);
      plan = planQueuedTask({ ...planArgs, overflowNoteFailed: true });
      if (!plan.ok) return plan;
    }
  }

  const created = await noanPost(`/tasks`, {
    title: plan.title,
    details: plan.details,
    status: "backlog",
    externalId: plan.externalId,
  });
  const taskId = created?.task?.id || created?.id;
  if (!taskId) return { ok: false, why: "task creation returned no id" };

  if (plan.tags.length) {
    try { await addTaskTags({ id: taskId, tags: [] }, ...plan.tags); }
    catch (e) { log(`  warn: tag failed: ${e.message}`); }
  }
  // pending capabilities stay UNassigned until the requester CONFIRMs —
  // assignment is the trigger now, so assigning here would fire the agent early.
  // todo is a human's to-do and stays unassigned too. general MUST be assigned:
  // "assigned + untagged" is the general worker's whole trigger.
  if (AGENT_IDENTITY_ID && plan.assign) {
    try { await noanPut(`/tasks/${taskId}/assignees`, { assigneeIds: [AGENT_IDENTITY_ID] }); }
    catch (e) { log(`  warn: assign failed: ${e.message}`); }
  }
  if (plan.contactId) {
    try { await noanPut(`/tasks/${taskId}/contacts`, { contactIds: [plan.contactId] }); } catch {}
  }

  if (plan.pending) {
    state.pending = state.pending || {};
    state.pending[(contact?.email || "").toLowerCase()] = {
      taskId, type: t.type, requestedBy: senderEmail, at: new Date().toISOString(),
    };
  }
  return { ok: true, taskId, pending: plan.pending, contactName: contact?.name, type: plan.type, quoted: !!plan.overflowNote, contactCreated: contactCreated ? contact.id : undefined };
}

async function executeConfirmPending({ verdict, senderEmail, state }) {
  const key = (verdict.pending_contact_email || "").toLowerCase();
  const entry = state.pending?.[key];
  if (!entry) return { ok: false, why: `no pending task for "${key || "(none)"}"` };
  if (entry.requestedBy !== senderEmail)
    return { ok: false, why: `pending task was requested by ${entry.requestedBy}; only they can confirm` };

  // assigning the agent IS the approval — the tagged task now triggers the
  // relevant agent on its next poll
  const page = await noanGetAll(`/tasks?status=backlog&per_page=100`);
  const task = page.find(x => x.id === entry.taskId);
  if (!task) return { ok: false, why: `pending task ${entry.taskId} is no longer in the backlog` };
  await assignVerity(task);
  delete state.pending[key];
  return { ok: true, taskId: entry.taskId };
}

/* ---------------- escalation ---------------- */

/** `sourceTask`: the escalation is ABOUT an existing board task (a support
 *  outreach task that could not be worked). The email still goes out, but no
 *  second "[reply-needs-human]" task is filed — the caller has parked the
 *  source task itself, and that is the one a human works. Two tasks for one
 *  problem was what the pre-2026-09-10 no-contact path produced. */
async function escalate({ inbound, body, contact, reason, sourceTask = null }) {
  const senderEmail = bareEmail(inbound.from) || "(unknown)";
  const to = TEST_RECIPIENT || ESCALATE_TO;
  const subjectBase = `[${AGENT_NAME}] needs a human: ${inbound.subject || "(no subject)"}`;
  const subject = TEST_RECIPIENT ? `[TEST → ${ESCALATE_TO}] ${subjectBase}` : subjectBase;

  await sendEmail({
    to,
    subject,
    html:
      `<p>${AGENT_NAME} received a reply ${pronouns().subj} shouldn't answer on ${pronouns().poss} own.</p>` +
      `<p><strong>From:</strong> ${inbound.from}<br>` +
      `<strong>Contact:</strong> ${contact ? `${contact.name} (in NOAN)` : "no NOAN contact match"}<br>` +
      `<strong>Reason:</strong> ${reason}</p>` +
      `<hr><p><strong>Their message:</strong></p><p>${(body || "(empty)").replace(/\n/g, "<br>")}</p>` +
      (sourceTask
        ? `<p>The task is parked on the NOAN board: <strong>${String(sourceTask.title || sourceTask.id).slice(0, 120)}</strong> (${sourceTask.id}). Fix what the reason says, then re-assign ${AGENT_NAME} to it and ${pronouns().subj} picks it up on ${pronouns().poss} next poll.</p>`
        : `<p>Reply directly to them at: ${senderEmail}</p>`),
    idempotencyKey: `${AGENT_NAME}:escalate:${inbound.id}`,
  });

  if (!sourceTask) try {
    const created = await noanPost(`/tasks`, {
      title: `[reply-needs-human] ${contact?.name || senderEmail} — ${String(inbound.subject || "").slice(0, 60)}`,
      details:
        `Inbound email ${AGENT_NAME} escalated instead of answering.\n` +
        `From: ${inbound.from}\n` +
        (contact ? `NOAN contact ID: ${contact.id}\n` : ``) +
        `Reason: ${reason}\n` +
        `Forwarded to: ${ESCALATE_TO}\n` +
        `${respondLine("reassign")}\n\n` +
        `--- message ---\n${(body || "").slice(0, 2000)}`,
      status: "backlog",
      externalId: `reply-escalate:${inbound.id}`,
    });
    const taskId = created?.task?.id || created?.id;
    // parked to the CS owner (REPLY_HUMAN_ASSIGNEES), the same person the email above
    // went to — until 2026-09-10 this task was tagged and left unassigned
    if (taskId) await parkForHuman({ id: taskId, tags: [], assignees: [] }, { lane: "cs", agent: "reply", assignees: HUMAN_ASSIGNEES, reason, status: null, log });
    if (taskId && contact) {
      try { await noanPut(`/tasks/${taskId}/contacts`, { contactIds: [contact.id] }); } catch {}
    }
  } catch (e) {
    log(`  warn: could not create escalation task: ${e.message}`);
  }

  if (contact) {
    try {
      await addContactMemo(contact.id, `[${AGENT_NAME}] Reply escalated to ${ESCALATE_TO} — ${new Date().toISOString().slice(0, 10)}\nSubject: ${inbound.subject}\nReason: ${reason}`);
    } catch {}
  }
}

/* ---------------- scheduling ---------------- */

let _schedCfg = null;
async function loadScheduleCfg() {
  if (_schedCfg) return _schedCfg;
  if (!SCHEDULE_CFG_SLUG) return (_schedCfg = parseScheduleFact(""));
  const res = await noanGet(`/facts?block_slug=${encodeURIComponent(SCHEDULE_CFG_SLUG)}`);
  // one parser for both lanes, so the booking pages and these emails agree on when the host is free
  return (_schedCfg = parseScheduleFact((res.items || []).map(f => f.content).join("\n")));
}

/** Addresses on the inbound that aren't the agent's own receiving/sending addresses.
 *  IMPORTANT: real-client mail must be read from the RAW To/Cc headers on the
 *  full message — Resend's list metadata only records the delivery address
 *  (to:[<agent>@reply…], cc:[]), which hid the prospect entirely. */
function externalParticipants(meta, full, senderEmail) {
  const raw = `${headerValue(full, "to")} ${headerValue(full, "cc")}`;
  let all = (raw.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(e => e.toLowerCase());
  if (!all.length) all = [...(meta.to || []), ...(meta.cc || [])].map(bareEmail).filter(Boolean);
  const ours = new Set([...SELF_ADDRESSES,
    bareEmail(process.env.REPLY_TO), senderEmail].filter(Boolean));
  return [...new Set(all.filter(e =>
    !ours.has(e) && !COMMANDERS.has(e) && !isOwnMailDomain(e)))];
}

async function notifyRequester({ requestedBy, subject, html, text, key }) {
  const to = TEST_RECIPIENT || requestedBy;
  await sendEmail({
    to,
    subject: TEST_RECIPIENT ? `[TEST → ${requestedBy}] ${subject}` : subject,
    html, text, idempotencyKey: key,
    cc: false,  // scheduling flow: requester already gets the handoff directly, no CC
  });
}

async function handleScheduleInit({ meta, body, senderEmail, externals, init, state, mark }) {
  const cfg = await loadScheduleCfg();
  const prospect = (init.prospect_email || "").toLowerCase();
  if (!externals.includes(prospect)) {
    mark("schedule-skipped", { reason: "prospect not on thread" });
    return false;
  }

  const now = new Date();
  const horizon = new Date(now.getTime() + (cfg.lookaheadDays + 7) * 86400e3);
  // the requester's calendar — with the service account, whoever CCs the agent
  // gets THEIR availability offered and the event lands on THEIR calendar
  const busy = await freeBusy(now.toISOString(), horizon.toISOString(), senderEmail);
  const slots = computeSlots(cfg, busy, now);
  if (!slots.length) {
    await notifyRequester({
      requestedBy: senderEmail,
      subject: `[${AGENT_NAME}] no free slots to offer ${prospect}`,
      html: `<p>Your calendar has no free ${cfg.durationMin}-min slots in the next ${cfg.lookaheadDays} working days within ${cfg.workStart}–${cfg.workEnd} ${cfg.timeZone}. Free some time or adjust the Scheduling Agent Config fact, then re-send.</p>`,
      text: `No free slots found in the next ${cfg.lookaheadDays} working days.`,
      key: `${AGENT_NAME}:sched-noslots:${meta.id}`,
    });
    mark("schedule-noslots");
    return true;
  }

  const duration = init.duration_min && init.duration_min !== cfg.durationMin ? init.duration_min : cfg.durationMin;
  const firstName = init.prospect_first_name || prospect.split("@")[0];
  const requesterName = senderEmail.split("@")[0].replace(/^\w/, c => c.toUpperCase());

  const listHtml = slots.map(s => `<li>${s.human}</li>`).join("");
  const listText = slots.map((s, i) => `${i + 1}. ${s.human}`).join("\n");
  const html =
    `<p>Hi ${firstName},</p>` +
    `<p>I'm ${AGENT_NAME}, ${requesterName}'s assistant at NOAN — happy to find us a time${init.topic ? ` for ${init.topic}` : ""}. ` +
    `Here are a few options (times in ${cfg.timeZone.replace("_", " ")}):</p>` +
    `<ul>${listHtml}</ul>` +
    `<p>Reply with whichever suits and I'll send a calendar invite. If none work, suggest a time and I'll check.</p>` +
    `<p>${AGENT_NAME}</p>`;
  const text = `Hi ${firstName},\n\nI'm ${AGENT_NAME}, ${requesterName}'s assistant at NOAN. Options (times in ${cfg.timeZone}):\n\n${listText}\n\nReply with whichever suits and I'll send a calendar invite. If none work, suggest a time and I'll check.\n\n${AGENT_NAME}`;

  // strip any pile of "Re:" and rebuild; a bare/empty subject gets a real one
  const coreSubj = (meta.subject || "").replace(/^\s*(re:\s*)+/i, "").trim();
  const subjectBase = coreSubj ? `Re: ${coreSubj}` : `Finding a time${init.topic ? ` — ${init.topic}` : ""}`;
  const sendResult = await sendEmail({
    to: TEST_RECIPIENT || prospect,
    subject: TEST_RECIPIENT ? `[TEST → ${prospect}] ${subjectBase}` : subjectBase,
    html, text,
    headers: { "In-Reply-To": meta.message_id },
    idempotencyKey: `${AGENT_NAME}:sched-offer:${meta.id}`,
    cc: false,  // scheduling emails don't CC the oversight inbox
  });

  state.threads = state.threads || {};
  state.threads[prospect] = {
    status: "offered", requestedBy: senderEmail, topic: init.topic || "",
    durationMin: duration, slots, subject: meta.subject || "",
    offeredStarts: slots.map(s => s.startISO), rounds: 0,
    at: new Date().toISOString(),
  };
  // confirm to the requester — a silent success is indistinguishable from a
  // no-fire from their inbox (2026-08-04, the Cassidy/Volition thread)
  await notifyRequester({
    requestedBy: senderEmail,
    subject: `[${AGENT_NAME}] offered ${firstName} ${slots.length} slot(s)${init.topic ? ` — ${init.topic}` : ""}`,
    html: `<p>Picked up your CC and offered ${prospect} these times from your calendar:</p><ul>${listHtml}</ul><p>I'll book and send the invite when they pick; nothing needed from you. Reply to them directly if you'd rather take it over.</p>`,
    text: `Offered ${prospect}:\n\n${listText}\n\nI'll book and send the invite when they pick.`,
    key: `${AGENT_NAME}:sched-offer-fyi:${meta.id}`,
  });

  mark("schedule-offered", { prospect, resend: sendResult?.id });
  log(`  ✓ offered ${slots.length} slot(s) to ${TEST_RECIPIENT || prospect}`);
  return true;
}

/**
 * Customer-initiated scheduling (2026-07-25): a customer mid-thread with
 * the agent asks for time with a teammate → offer slots from THAT teammate's
 * calendar and enter the standard offered-thread machinery (their reply then
 * books via handleScheduleReply exactly like teammate-initiated threads).
 * Keyword pre-filter keeps the classifier call off ordinary emails.
 */
const MEETING_RX = /\b(meet|meeting|call|calendar|schedule|scheduling|book|demo|catch\s?up|hop on|jump on|get together|set\s?up (some )?time|time to (chat|talk|connect)|\d+\s?min)/i;
const SCHEDULE_DEFAULT_OWNER = (envAddress("SCHEDULE_DEFAULT_OWNER") || "").toLowerCase();

async function startCustomerSchedule({ meta, contact, owner, topic, durationMin, firstName, state, mark }) {
  const cfg = await loadScheduleCfg();
  const prospect = (contact.email || "").toLowerCase();
  const now = new Date();
  const horizon = new Date(now.getTime() + (cfg.lookaheadDays + 7) * 86400e3);
  const busy = await freeBusy(now.toISOString(), horizon.toISOString(), owner);
  const slots = computeSlots(cfg, busy, now);
  if (!slots.length) {
    await notifyRequester({
      requestedBy: owner,
      subject: `[${AGENT_NAME}] ${contact.name || prospect} wants to meet but your calendar has no free slots`,
      html: `<p>${contact.name || prospect} asked to set up time with you, but I found no free ${cfg.durationMin}-min slots in the next ${cfg.lookaheadDays} working days. Free some time and I'll pick it up if they nudge, or reply to them directly.</p>`,
      text: `${contact.name || prospect} asked to meet; no free slots found in the next ${cfg.lookaheadDays} working days.`,
      key: `${AGENT_NAME}:sched-cust-noslots:${meta.id}`,
    });
    mark("schedule-customer-noslots", { prospect, owner });
    return true;
  }

  const ownerName = owner.split("@")[0].replace(/^\w/, c => c.toUpperCase());
  const name = firstName || (contact.name || prospect).split(" ")[0];
  const listHtml = slots.map(s => `<li>${s.human}</li>`).join("");
  const listText = slots.map((s, i) => `${i + 1}. ${s.human}`).join("\n");
  const html =
    `<p>Hi ${name},</p>` +
    `<p>Happy to set that up${topic ? ` to talk about ${topic}` : ""}. Here are some times that work for ${ownerName} (times in ${cfg.timeZone.replace("_", " ")}):</p>` +
    `<ul>${listHtml}</ul>` +
    `<p>Reply with whichever suits and I'll send a calendar invite. If none work, suggest a time and I'll check.</p>` +
    `<p>${AGENT_NAME}</p>`;
  const text = `Hi ${name},\n\nHappy to set that up${topic ? ` to talk about ${topic}` : ""}. Times that work for ${ownerName} (in ${cfg.timeZone}):\n\n${listText}\n\nReply with whichever suits and I'll send a calendar invite. If none work, suggest a time and I'll check.\n\n${AGENT_NAME}`;

  const coreSubj = (meta.subject || "").replace(/^\s*(re:\s*)+/i, "").trim();
  const subjectBase = coreSubj ? `Re: ${coreSubj}` : `Finding a time with ${ownerName}`;
  const sendResult = await sendEmail({
    to: TEST_RECIPIENT || prospect,
    subject: TEST_RECIPIENT ? `[TEST → ${prospect}] ${subjectBase}` : subjectBase,
    html, text,
    headers: { "In-Reply-To": meta.message_id },
    idempotencyKey: `${AGENT_NAME}:sched-cust-offer:${meta.id}`,
    cc: false,
  });

  state.threads = state.threads || {};
  state.threads[prospect] = {
    status: "offered", requestedBy: owner, topic: topic || "",
    durationMin: durationMin || cfg.durationMin, slots, subject: meta.subject || "",
    offeredStarts: slots.map(s => s.startISO), rounds: 0,
    customerInitiated: true,
    at: new Date().toISOString(),
  };

  // FYI to the calendar owner — a meeting is being arranged on their behalf
  await notifyRequester({
    requestedBy: owner,
    subject: `[${AGENT_NAME}] finding a time for ${contact.name || prospect}`,
    html: `<p>${contact.name || prospect} asked to set up time with you${topic ? ` about ${topic}` : ""}, so I've offered them ${slots.length} slot(s) from your calendar. I'll book it and send the invite when they pick; nothing needed from you. Reply to them directly if you'd rather handle it yourself.</p>`,
    text: `${contact.name || prospect} asked for time with you; ${slots.length} slot(s) offered from your calendar. I'll book when they pick.`,
    key: `${AGENT_NAME}:sched-cust-fyi:${meta.id}`,
  });

  try {
    await addContactMemo(contact.id, `[${AGENT_NAME}] Customer asked to meet ${ownerName} — offered ${slots.length} slot(s) from their calendar (${new Date().toISOString().slice(0, 10)}). Resend id: ${sendResult?.id || "n/a"}`);
  } catch {}

  mark("schedule-customer-offered", { prospect, owner, resend: sendResult?.id });
  log(`  ✓ customer-initiated: offered ${slots.length} slot(s) from ${owner}'s calendar to ${TEST_RECIPIENT || prospect}`);
  return true;
}

/** Prospect preferences (interpretReply new_times fields) → computeSlots constraints. */
function scheduleConstraints(verdict) {
  const c = {};
  const asDate = (iso) => { const d = iso ? new Date(iso) : null; return d && !isNaN(d) ? d : null; };
  const nb = asDate(verdict.window_start_iso); if (nb) c.notBefore = nb;
  const na = asDate(verdict.window_end_iso);   if (na && na > new Date()) c.notAfter = na;
  if (/^\d{2}:\d{2}$/.test(verdict.day_start || "")) c.dayStart = verdict.day_start;
  if (/^\d{2}:\d{2}$/.test(verdict.day_end || ""))   c.dayEnd = verdict.day_end;
  const days = (verdict.weekdays || []).filter(w => /^(Mon|Tue|Wed|Thu|Fri)$/.test(w));
  if (days.length) c.weekdays = days;
  // explicit availability windows ("Mon 2-4pm, Wed 9-12") — slots must land
  // inside one. Their bounds also steer the scan so a far-out window is reached.
  const windows = (verdict.windows || [])
    .map(w => ({ start: asDate(w.start_iso), end: asDate(w.end_iso) }))
    .filter(w => w.start && w.end && w.end > w.start && w.end > new Date());
  if (windows.length) {
    c.windows = windows.map(w => ({ startISO: w.start.toISOString(), endISO: w.end.toISOString() }));
    const earliest = new Date(Math.min(...windows.map(w => w.start)));
    const latest   = new Date(Math.max(...windows.map(w => w.end)));
    if (!c.notBefore || earliest < c.notBefore) c.notBefore = earliest;
    if (!c.notAfter  || latest   > c.notAfter)  c.notAfter  = latest;
  }
  return c;
}

async function handleScheduleReply({ meta, body, senderEmail, state, mark }) {
  const cfg = await loadScheduleCfg();
  const thread = state.threads[senderEmail];
  const verdict = await interpretReply({
    body, offeredSlots: thread.slots, timeZone: cfg.timeZone,
    senderEmail, receivedAtISO: meta.created_at || "",
  });

  const closeThread = (status) => { thread.status = status; thread.closedAt = new Date().toISOString(); };
  const tzHuman = cfg.timeZone.replace("_", " ");
  const requesterFirst = thread.requestedBy.split("@")[0].replace(/^\w/, c => c.toUpperCase());

  /** Offer a fresh batch of slots matching `constraints` (never repeating earlier
   *  offers). Returns false when the rounds cap is hit or nothing fits, so the
   *  caller falls back to the human handoff. */
  async function reoffer({ constraints, intro, prospectTz }) {
    thread.rounds = (thread.rounds || 0) + 1;
    if (thread.rounds > cfg.maxRounds) return false;
    const now = new Date();
    const futureDays = constraints.notBefore ? Math.max(0, Math.ceil((constraints.notBefore - now) / 86400e3)) : 0;
    const horizon = new Date(now.getTime() + Math.min(60, futureDays + cfg.lookaheadDays + 7) * 86400e3);
    const busy = await freeBusy(now.toISOString(), horizon.toISOString(), thread.requestedBy);
    const slots = computeSlots(cfg, busy, now, { ...constraints, excludeStarts: thread.offeredStarts || [] });
    if (!slots.length) return false;

    // when we know their timezone, show each slot in it too — a bare Lisbon
    // time reads as 5am to a Boston prospect with no way to tell
    let localTime = null;
    if (prospectTz && prospectTz !== cfg.timeZone) {
      try {
        const f = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: prospectTz });
        f.format(new Date());  // throws on a bad IANA name
        localTime = (s) => f.format(new Date(s.startISO));
      } catch { localTime = null; }
    }
    const line = (s) => localTime ? `${s.human} (${localTime(s)} your time)` : s.human;
    const listHtml = slots.map(s => `<li>${line(s)}</li>`).join("");
    const listText = slots.map((s, i) => `${i + 1}. ${line(s)}`).join("\n");
    const outro = `Reply with whichever suits and I'll send the invite. If none of these work either, I'll hand you over to ${requesterFirst} to sort a time directly.`;
    const subj = `Re: ${(thread.subject || "").replace(/^\s*(re:\s*)+/i, "").trim() || "Finding a time"}`;
    await sendEmail({
      to: TEST_RECIPIENT || senderEmail,
      subject: TEST_RECIPIENT ? `[TEST → ${senderEmail}] ${subj}` : subj,
      html: `<p>${intro}</p><ul>${listHtml}</ul><p>${outro}</p><p>${AGENT_NAME}</p>`,
      text: `${intro}\n\n${listText}\n\n${outro}\n\n${AGENT_NAME}`,
      headers: { "In-Reply-To": meta.message_id },
      idempotencyKey: `${AGENT_NAME}:sched-reoffer:${meta.id}`,
      cc: false,  // scheduling emails don't CC the oversight inbox
    });
    thread.slots = slots;
    thread.offeredStarts = [...(thread.offeredStarts || []), ...slots.map(s => s.startISO)];
    thread.at = new Date().toISOString();
    await notifyRequester({
      requestedBy: thread.requestedBy,
      subject: `[${AGENT_NAME}] re-offered ${senderEmail.split("@")[0]} ${slots.length} slot(s) (round ${thread.rounds})`,
      html: `<p>${senderEmail} asked for different times, so I offered these instead:</p><ul>${listHtml}</ul><p>Their message:</p><p>${(body || "").replace(/\n/g, "<br>")}</p>`,
      text: `Re-offered ${senderEmail}:\n\n${listText}\n\nTheir message:\n${body}`,
      key: `${AGENT_NAME}:sched-reoffer-fyi:${meta.id}`,
    });
    mark("schedule-reoffered", { round: thread.rounds, slots: slots.length });
    log(`  ✓ re-offered ${slots.length} slot(s) to ${TEST_RECIPIENT || senderEmail} (round ${thread.rounds})`);
    return true;
  }

  async function handOff(context) {
    await notifyRequester({
      requestedBy: thread.requestedBy,
      subject: `[${AGENT_NAME}] scheduling with ${senderEmail} needs you`,
      html: `<p>${context}</p><p>Their message:</p><p>${(body || "").replace(/\n/g, "<br>")}</p>`,
      text: `${context}\n\nTheir message:\n${body}`,
      key: `${AGENT_NAME}:sched-handoff:${meta.id}`,
    });
    closeThread("handed-off");
  }

  async function book(startISO) {
    const endISO = new Date(new Date(startISO).getTime() + thread.durationMin * 60000).toISOString();
    if (!(await slotStillFree(startISO, thread.durationMin, cfg.bufferMin, thread.requestedBy))) return null;
    const summary = (TEST_RECIPIENT ? "[TEST] " : "") +
      (thread.topic || `Meeting`) + ` — ${thread.requestedBy.split("@")[0]} / ${senderEmail.split("@")[0]}`;
    const attendees = TEST_RECIPIENT ? [thread.requestedBy] : [thread.requestedBy, senderEmail];
    return createEvent({
      summary,
      description: `Scheduled by ${AGENT_NAME} (NOAN) by email.`,
      startISO, endISO, attendees, meet: cfg.meet, timeZone: cfg.timeZone,
      asUser: thread.requestedBy,
    });
  }

  // "none of these suit, can you do X?" → compute new slots matching their ask
  if (verdict.decision === "new_times") {
    const ok = await reoffer({
      constraints: scheduleConstraints(verdict),
      prospectTz: verdict.prospect_timezone,
      intro: `Thanks for letting me know. Here are some alternatives that should fit (times in ${tzHuman}):`,
    });
    if (ok) return;
    const why = thread.rounds > cfg.maxRounds
      ? "we've already been through a few rounds of options"
      : "nothing free on your calendar fits their request";
    await handOff(`${senderEmail} asked for different times${verdict.reason ? ` (${verdict.reason})` : ""}, but ${why}, so ${AGENT_NAME} is handing the thread to you.`);
    mark("schedule-handoff", { reason: thread.rounds > cfg.maxRounds ? "max-rounds" : "no-fitting-slots" });
    log(`  scheduling new_times → no re-offer possible, handed to ${thread.requestedBy}`);
    return;
  }

  if (verdict.decision === "accept" || verdict.decision === "counter") {
    const startISO = verdict.decision === "accept"
      ? thread.slots[(verdict.slot_index || 1) - 1]?.startISO
      : verdict.counter_start_iso;
    const valid = startISO && !isNaN(new Date(startISO)) && new Date(startISO) > new Date();
    const event = valid ? await book(startISO) : null;
    if (event) {
      const human = new Intl.DateTimeFormat("en-GB", {
        weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
        hour12: false, timeZone: cfg.timeZone,
      }).format(new Date(startISO));
      const meetLine = event.hangoutLink ? `<p>Google Meet: ${event.hangoutLink}</p>` : "";
      const confirmSubj = `Re: ${(thread.subject || "").replace(/^\s*(re:\s*)+/i, "").trim() || "Finding a time"}`;
      await sendEmail({
        to: TEST_RECIPIENT || senderEmail,
        subject: TEST_RECIPIENT ? `[TEST → ${senderEmail}] ${confirmSubj}` : confirmSubj,
        html: `<p>Booked — ${human} (${cfg.timeZone.replace("_", " ")}). The calendar invite is on its way.</p>${meetLine}<p>${AGENT_NAME}</p>`,
        text: `Booked — ${human} (${cfg.timeZone}). The calendar invite is on its way.\n\n${AGENT_NAME}`,
        headers: { "In-Reply-To": meta.message_id },
        idempotencyKey: `${AGENT_NAME}:sched-confirm:${meta.id}`,
        cc: false,  // scheduling emails don't CC the oversight inbox
      });
      closeThread("booked");
      mark("schedule-booked", { start: startISO, event: event.id });
      log(`  ✓ booked ${startISO} with ${senderEmail} (event ${event.id})`);
      return;
    }
    // chosen slot taken, or their counter-proposal can't be booked → offer the
    // nearest workable alternatives before ever involving a human
    const constraints = verdict.decision === "counter" && valid
      ? { notBefore: new Date(`${startISO.slice(0, 10)}T00:00:00Z`) }  // search from their proposed day forward
      : {};
    const intro = verdict.decision === "accept"
      ? `Sorry, that time has just been taken on ${requesterFirst}'s calendar. The nearest alternatives (times in ${tzHuman}):`
      : `That time doesn't work on ${requesterFirst}'s calendar, sorry. The closest options I can offer (times in ${tzHuman}):`;
    if (await reoffer({ constraints, intro, prospectTz: verdict.prospect_timezone })) return;
    await handOff(`${senderEmail} ${verdict.decision === "accept" ? "picked a slot that is no longer free" : "proposed a time that couldn't be booked"} and ${AGENT_NAME} couldn't find workable alternatives, so the thread is yours.`);
    mark("schedule-handoff", { reason: "slot-unavailable" });
    return;
  }

  // decline / unclear → requester takes over
  await notifyRequester({
    requestedBy: thread.requestedBy,
    subject: `[${AGENT_NAME}] scheduling with ${senderEmail}: ${verdict.decision}`,
    html: `<p>${senderEmail} replied to the scheduling thread — ${AGENT_NAME} read it as "${verdict.decision}"${verdict.reason ? ` (${verdict.reason})` : ""} and is handing the thread to you.</p><p>Their message:</p><p>${(body || "").replace(/\n/g, "<br>")}</p>`,
    text: `Read as: ${verdict.decision}. Their message:\n${body}`,
    key: `${AGENT_NAME}:sched-handoff:${meta.id}`,
  });
  closeThread(verdict.decision);
  mark(`schedule-${verdict.decision}`);
  log(`  scheduling ${verdict.decision} → handed to ${thread.requestedBy}`);
}

/* ---------------- customer success cases ---------------- */

let _csBrain = null;
async function loadCsBrain() {
  if (_csBrain) return _csBrain;
  if (!CS_CFG_SLUG) return null;
  const cfg = await noanGet(`/facts?block_slug=${encodeURIComponent(CS_CFG_SLUG)}`);
  const play = await noanGet(`/facts?block_slug=${encodeURIComponent(PLAYBOOK_SLUG)}`);
  _csBrain = {
    csConfig: (cfg.items || []).map(f => f.content).join("\n\n").trim(),
    playbook: (play.items || []).map(f => f.content).join("\n\n").trim(),
  };
  return _csBrain.csConfig ? _csBrain : null;
}

function pruneCases(state) {
  const cutoff = Date.now() - CASE_EXPIRY_DAYS * 86400e3;
  for (const [k, c] of Object.entries(state.cases || {})) {
    if (c.status === "open" && new Date(c.openedAt).getTime() < cutoff) c.status = "expired";
  }
}

let _meId = null;
async function myIdentityId() {
  if (_meId !== null) return _meId;
  try { _meId = (await noanGet("/me"))?.identity?.id || ""; } catch { _meId = ""; }
  return _meId;
}

async function createFollowupTasks(tasks, contact, caseId) {
  const created = [];
  for (const [i, t] of (tasks || []).slice(0, 5).entries()) {
    try {
      const res = await noanPost(`/tasks`, {
        title: String(t.title || "Follow up on customer issue").replace(/^\s*(\[[^\]]+\]\s*)+/, "").slice(0, 140),
        details: `${t.details || ""}\n\nContact: ${contact.name}\nEmail: ${contact.email}\nNOAN contact ID: ${contact.id}\nFrom support case, ${new Date().toISOString().slice(0, 10)}`,
        status: "backlog",
        externalId: `cs-task:${caseId}:${i}`,
      });
      const taskId = res?.task?.id || res?.id;
      if (!taskId) continue;
      const stub = { id: taskId, tags: [], assignees: [] };
      if (t.assign === "human") {
        // a human's follow-up: needs-human + CS tag in one PUT, the CS owner on it
        // (REPLY_HUMAN_ASSIGNEES, else the CS lane default — never GET /me,
        // which is the key's account, not a person)
        await parkForHuman(stub, { lane: "cs", agent: "reply", assignees: HUMAN_ASSIGNEES, extraTags: [TASK_TAG_CS], status: null, log });
      } else {
        try { await addTaskTags(stub, TASK_TAG_CS); } catch {}
        if (AGENT_IDENTITY_ID) { try { await noanPut(`/tasks/${taskId}/assignees`, { assigneeIds: [AGENT_IDENTITY_ID] }); } catch {} }
      }
      try { await noanPut(`/tasks/${taskId}/contacts`, { contactIds: [contact.id] }); } catch {}
      created.push({ id: taskId, title: t.title, assign: t.assign });
    } catch (e) { log(`  warn: followup task failed: ${e.message}`); }
  }
  return created;
}

async function sendCaseBrief({ kase, contact, verdict, tasksCreated, inboundId }) {
  const solvedLine = verdict.action === "resolve"
    ? (verdict.solved ? "RESOLVED — no action needed" : "CLOSED — answered, but underlying issue may remain")
    : `NEEDS A HUMAN — ${verdict.reason || "escalated"}`;
  const taskLines = tasksCreated.length
    ? tasksCreated.map(t => `<li>${t.title} (assigned: ${t.assign})</li>`).join("")
    : "";
  const recipients = [...new Set([ESCALATE_TO, kase.openedBy !== "direct" ? kase.openedBy : null].filter(Boolean))];
  const to = TEST_RECIPIENT || recipients;
  const subjectBase = `[${AGENT_NAME}] customer issue: ${contact.name} — ${verdict.action === "resolve" ? (verdict.solved ? "solved" : "closed") : "needs human"}`;
  await sendEmail({
    to,
    subject: TEST_RECIPIENT ? `[TEST → ${recipients.join(",")}] ${subjectBase}` : subjectBase,
    html:
      `<p><strong>${solvedLine}</strong></p>` +
      `<p><strong>Customer:</strong> ${contact.name} &lt;${contact.email}&gt;</p>` +
      `<p><strong>Issue:</strong> ${verdict.issue_summary}</p>` +
      `<p><strong>Exchanges:</strong> ${(kase.turns || []).length}</p>` +
      (taskLines ? `<p><strong>Follow-up tasks created:</strong></p><ul>${taskLines}</ul>` : `<p>No follow-up tasks needed.</p>`) +
      `<p>Full record is on the contact's memos in NOAN.</p>`,
    text: `${solvedLine}\nCustomer: ${contact.name} <${contact.email}>\nIssue: ${verdict.issue_summary}`,
    idempotencyKey: `${AGENT_NAME}:cs-brief:${inboundId}`,
  });
}

/** One customer turn: run the model, send its message, keep all the records. */
async function handleSupportTurn({ meta, body, senderEmail, contact, state, mark, today, openerNote = null }) {
  const brain = await loadCsBrain();
  if (!brain) return false;   // CS not configured — caller falls back to plain reply agent

  state.cases = state.cases || {};
  pruneCases(state);
  let kase = state.cases[senderEmail]?.status === "open" ? state.cases[senderEmail] : null;

  // per-case ceiling: a real back-and-forth is fine, but a case that hasn't
  // resolved in MAX_CS_EXCHANGES_PER_CASE exchanges moves to a human
  if (kase && (kase.exchanges || 0) >= MAX_CS_EXCHANGES_PER_CASE) {
    await escalate({ inbound: meta, body, contact, reason: `Case reached ${MAX_CS_EXCHANGES_PER_CASE} exchanges without resolution — a human should take the thread.` });
    kase.status = "escalated";
    kase.closedAt = new Date().toISOString();
    mark("cs-escalated", { reason: "exchange-cap" });
    return true;
  }

  const capKey = `cs:${senderEmail}|${today}`;
  if ((state.sent[capKey] || 0) >= MAX_CS_TURNS_PER_SENDER) {
    await escalate({ inbound: meta, body, contact, reason: `Support-turn cap (${MAX_CS_TURNS_PER_SENDER}/day) reached for this customer — a human should take the thread.` });
    if (kase) kase.status = "escalated";
    mark("cs-escalated", { reason: "turn-cap" });
    return true;
  }

  let verdict;
  try {
    const memoContext = await fetchContactMemos(contact.id);
    verdict = await runSupportAgent({ inbound: meta, body, contact, brain, caseData: kase, openerNote, memoContext, agentName: AGENT_NAME });
  } catch (e) {
    await escalate({ inbound: meta, body, contact, reason: `Support agent failed: ${e.message}` });
    if (kase) kase.status = "escalated";
    mark("cs-error", { reason: e.message.slice(0, 200) });
    return true;
  }

  const rogue = badLinks(verdict.reply_html, verdict.reply_text);
  if (rogue.length) {
    await escalate({ inbound: meta, body, contact, reason: `Support draft contained non-NOAN links: ${rogue.join(", ")}` });
    if (kase) kase.status = "escalated";
    mark("cs-escalated", { reason: "rogue-links" });
    return true;
  }

  // a simple non-issue question answered in one turn: send + memo, but no case,
  // no brief, no tasks — the lightweight Q&A behavior customers had before
  const quickAnswer = !kase && !verdict.is_issue && verdict.action === "resolve";

  if (!kase && !quickAnswer) {
    kase = state.cases[senderEmail] = {
      id: meta.id, status: "open", openedAt: new Date().toISOString(),
      openedBy: openerNote ? bareEmail(meta.from) : "direct",
      subject: meta.subject || "", turns: [],
    };
  }
  if (kase) {
    kase.turns.push({ at: new Date().toISOString(), who: "customer", summary: (body || "").slice(0, 280) });
    kase.turns.push({ at: new Date().toISOString(), who: AGENT_NAME.toLowerCase(), summary: (verdict.reply_text || "").slice(0, 280) });
    kase.turns = kase.turns.slice(-16);
    kase.exchanges = (kase.exchanges || 0) + 1;
  }

  // send its message to the customer, in-thread
  if (verdict.reply_html) {
    const subj = kase?.subject || meta.subject || "";
    const subjectBase = /^re:/i.test(subj) ? subj : `Re: ${subj || "your message"}`;
    await sendEmail({
      to: TEST_RECIPIENT || contact.email,
      subject: TEST_RECIPIENT ? `[TEST → ${contact.email}] ${subjectBase}` : subjectBase,
      html: verdict.reply_html, text: verdict.reply_text,
      headers: { "In-Reply-To": meta.message_id },
      idempotencyKey: `${AGENT_NAME}:cs-reply:${meta.id}`,
    });
  }

  // memo every exchange
  try {
    await addContactMemo(contact.id, `[${AGENT_NAME}] Support ${verdict.action === "reply" ? "exchange" : verdict.action} — ${today}\n` +
        `Issue: ${verdict.issue_summary}\n` +
        `Them: ${(body || "").slice(0, 600)}\n` +
        `${AGENT_NAME}: ${(verdict.reply_text || "(escalation, no message)").slice(0, 600)}`);
  } catch (e) { log(`  warn: memo failed: ${e.message}`); }

  state.sent[capKey] = (state.sent[capKey] || 0) + 1;

  if (quickAnswer) {
    mark("cs-answer");
    log(`  ✓ quick answer to ${contact.email} (no case opened)`);
    return true;
  }

  if (verdict.action === "reply") {
    mark("cs-reply", { case: kase.id });
    log(`  ✓ support reply to ${contact.email} (case open, ${kase.turns.length / 2} exchange(s))`);
    return true;
  }

  // resolve / escalate → close out: tasks + brief (+ needs-human task on escalate)
  const tasksCreated = await createFollowupTasks(verdict.followup_tasks, contact, kase.id);
  if (verdict.action === "escalate") {
    await escalate({ inbound: meta, body, contact, reason: verdict.reason || verdict.issue_summary });
    kase.status = "escalated";
  } else {
    kase.status = "resolved";
  }
  kase.closedAt = new Date().toISOString();
  await closeCaseTask(kase, kase.status === "resolved" && verdict.solved !== false);
  if (verdict.is_issue) await sendCaseBrief({ kase, contact, verdict, tasksCreated, inboundId: meta.id });
  mark(`cs-${verdict.action}`, { case: kase.id, tasks: tasksCreated.length });
  log(`  ✓ case ${verdict.action} for ${contact.email} (${tasksCreated.length} task(s), brief ${verdict.is_issue ? "sent" : "skipped"})`);
  return true;
}

/* ---------------- sales follow-up replies ---------------- */

// Literal prefix written by worker.mjs on every follow-up send. Changing it in
// one place without the other silently returns follow-up replies to the
// support path, so the two must move together.
const FOLLOWUP_MEMO_PREFIX = `[${AGENT_NAME}] Follow-up email sent`;
const FOLLOWUP_REPLY_DAYS = parseInt(process.env.FOLLOWUP_REPLY_WINDOW_DAYS || "21", 10);

/** ISO date of a follow-up sent to this contact inside the window, else null.
 *
 *  HYDRATES the contact. The contact in hand comes from GET /contacts, and that
 *  endpoint does NOT return notes — verified 2026-08-11: `notes` is absent from
 *  list items and present only on GET /contacts/{id}. A version reading
 *  contact.notes directly would look correct, pass review, and never once fire.
 *
 *  Notes are plain STRINGS with no timestamp, so the date stamped into the memo
 *  body is not a fallback, it is the only way to date them.
 *
 *  Fails toward NOT intercepting: an unreadable contact keeps today's behaviour
 *  rather than diverting a reply on a guess. Bounded by MAX_REPLIES_PER_RUN, so
 *  this is at most a handful of extra reads per poll. */
async function recentFollowupMemo(contact) {
  if (!contact?.id) return null;
  let notes = [];
  try {
    const res = await noanGet(`/contacts/${contact.id}`);
    notes = (res?.contact || res)?.notes || [];
  } catch (e) {
    log(`  warn: could not hydrate ${contact.id} to check for a follow-up (${e.message})`);
    return null;
  }
  const cutoff = Date.now() - FOLLOWUP_REPLY_DAYS * 86400_000;
  const hits = [];
  for (const n of notes) {
    const text = typeof n === "string" ? n : (n?.content || n?.text || "");
    if (!text.startsWith(FOLLOWUP_MEMO_PREFIX)) continue;
    // TEST redirected means the contact never actually received anything, so
    // it is not prior contact and a reply from them is not a reply to it. Same
    // convention the re-engagement agent already honours; without this a single
    // test run would make every later inbound from that person look like a
    // hand-raise.
    if (/TEST redirected/i.test(text)) continue;
    const m = text.match(/Follow-up email sent — (\d{4}-\d{2}-\d{2})/);
    const at = m?.[1] || (n?.createdAt || n?.created_at ? String(n.createdAt || n.created_at).slice(0, 10) : null);
    if (at && new Date(at).getTime() >= cutoff) hits.push(at);
  }
  // newest, not merely the first the API happened to return
  return hits.length ? hits.sort().at(-1) : null;
}

/** Hand a follow-up reply to a human: Sales task + notification. No auto-reply. */
async function handleFollowupReply({ meta, body, senderEmail, contact, sentOn, mark }) {
  const quoted = (body || "").trim().slice(0, 1200);
  let taskId = null;
  try {
    const created = await noanPost(`/tasks`, {
      title: `Reply to our follow-up: ${contact.name || senderEmail}`.slice(0, 256),
      details: [
        `${contact.name || senderEmail} replied to the sales follow-up sent ${sentOn}.`,
        `This is a warm hand-raise. ${AGENT_NAME} did NOT answer it — a human should.`,
        ``,
        `Contact ID: ${contact.id}`,
        `Email: ${senderEmail}`,
        ``,
        `--- their reply ---`,
        quoted,
      ].join("\n").slice(0, 2000),
      status: "backlog",
      externalId: `followup-reply:${meta.id}`,
    });
    taskId = created?.task?.id || created?.id || null;
    if (taskId) {
      try { await addTaskTags({ id: taskId, tags: [] }, "Sales"); }
      catch (e) { log(`  warn: could not tag the Sales task: ${e.message}`); }
      // "a human should" needs to name one. A warm hand-raise is inbound
      // sales, so the sales lane's owner (decided 2026-09-11).
      // `keep` from the CREATE RESPONSE, not a re-read: PUT /assignees replaces
      // the whole set, and externalId carries no uniqueness guarantee, so if a
      // create ever answers with an existing row this stops us wiping whoever
      // was already on it. Free - the object is already in hand (PR review).
      await assignResolvedOwner(taskId, { lane: "sales", agent: "reply-followup", keep: (created?.task?.assignees || created?.assignees || []).map(a => a?.id).filter(Boolean), log });
      try { await noanPut(`/tasks/${taskId}/contacts`, { contactIds: [contact.id] }); }
      catch (e) { log(`  warn: could not link the contact: ${e.message}`); }
    }
  } catch (e) {
    log(`  warn: could not create the Sales task (${e.message}) — escalating anyway`);
  }
  // Left UNASSIGNED on purpose: this is for a person, and assigning the agent
  // would hand a buying signal straight back to an agent.
  await escalate({
    inbound: meta, body, contact,
    reason: `${contact.name || senderEmail} replied to the sales follow-up sent ${sentOn}. ${AGENT_NAME} did not answer it${taskId ? ` — Sales task ${taskId} created` : ""}. Worth a human reply.`,
  });
  mark("followup-reply", { contact: contact.id, sentOn, task: taskId });
  log(`  reply to a follow-up (sent ${sentOn}) → Sales task ${taskId || "(failed)"}, escalated, NOT auto-answered`);
}

/* ---------------- task-triggered support outreach ---------------- */

const SUPPORT_TRIGGER_TAG = process.env.SUPPORT_TRIGGER_TAG || "support";
const DETAILS_CAP = 2048;   // hard API cap on task details — rejected, not truncated, above it
const LEGACY_MARKER_RX = /^\s*(\[[a-z-]+\]\s*)+/i;

/** Backlog tasks tagged "support" AND assigned to the agent → it opens the
 *  conversation with the task's contact. (Tag + assignee trigger since
 *  2026-07-24 — the [support] title marker is retired.) */
async function scanSupportTasks(getContacts, state) {
  const brain = await loadCsBrain();
  if (!brain) return;
  state.taskOutreach = state.taskOutreach || {};
  pruneCases(state);

  const backlog = await noanGetAll(`/tasks?status=backlog&per_page=100`);

  // Comments as the hand-back (support-scan.mjs, 2026-09-10): a teammate
  // comment addressing the agent on a support task it is NOT on clears
  // needs-human, assigns it, and steers the draft. Cursor per task; a
  // baseline stamped on the first run so old comments never re-arm.
  state.supportComments = state.supportComments || {};
  state.supportCommentsSince = state.supportCommentsSince || new Date().toISOString();
  const guidance = {};   // taskId → rendered teammate comments for the draft
  for (const task of backlog) {
    if (!taskHasTag(task, SUPPORT_TRIGGER_TAG) || task.completed) continue;
    const steering = steeringComments(task, { commanders: COMMANDERS });
    const external = normalizeComments(task, { commanders: COMMANDERS }).filter(c => c.kind === "external" && c.at > (state.supportComments[task.id] || state.supportCommentsSince));
    for (const c of external) log(`  ignored comment on ${task.id} from ${c.email || "unknown"} (not a teammate)`);
    const { fresh, rearm } = supportCommentRearm(task, steering, { cursor: state.supportComments[task.id] || null, since: state.supportCommentsSince });
    if (!fresh.length && !external.length) continue;
    state.supportComments[task.id] = latestCursor([...fresh, ...external], state.supportComments[task.id] || null);
    if (!rearm) { for (const c of fresh) log(`  comment on ${task.id} from ${c.email} does not address ${AGENT_NAME}, leaving it — "${c.text.slice(0, 80)}"`); continue; }
    log(`support task ${task.id} — "${task.title}": re-armed by ${rearm.email}'s comment at ${rearm.at}`);
    if (DRY_RUN) { log(`  dry-run: would clear needs-human, assign ${AGENT_NAME}, draft with the comment as guidance`); continue; }
    try { await unparkTask(task); } catch (e) { log(`  warn: could not clear needs-human: ${e.message}`); }
    try { await assignVerity(task); task.assignees = [...(task.assignees || []), { id: AGENT_IDENTITY_ID }]; }
    catch (e) { log(`  warn: could not assign ${AGENT_NAME}: ${e.message}`); continue; }
    guidance[task.id] = renderComments(fresh);
  }
  await saveState(state);

  // trigger tag + the agent assigned (legacy "[support] …" titles accepted); only
  // a SENT ledger entry blocks — see support-scan.mjs for why nothing else does
  const tasks = supportScanCandidates(backlog, state.taskOutreach, { triggerTag: SUPPORT_TRIGGER_TAG, limit: 3 });
  if (!tasks.length) return;
  const contacts = await getContacts();

  // A task that could not be worked is PARKED (needs-human, the agent off, the CS
  // owner on via REPLY_HUMAN_ASSIGNEES) with the reason on the task, and the owner is
  // emailed. Nothing goes in the ledger: unassigned does not trigger, so
  // re-assigning the agent after the fix is the retry (since 2026-09-10).
  // The note goes into `details`: POST /tasks/{id}/notes does not exist (404,
  // verified 2026-09-10) and a catch around it hides that. PATCH replaces the
  // whole field, so append to the text in hand and trim the tail to the cap.
  const park = async (task, reason, contact) => {
    const entry = `\n\n[${AGENT_NAME}] Parked: ${reason} Then re-assign me to the task and I will open the conversation.`;
    let details = task.details || "";
    if (details.length + entry.length > DETAILS_CAP) details = details.slice(0, DETAILS_CAP - entry.length - 1).replace(/\s+\S*$/, "") + "…";
    try { await noanPatch(`/tasks/${task.id}`, { details: details + entry }); }
    catch (e) { log(`  warn: park note failed: ${e.message}`); }
    await parkForHuman(task, { lane: "cs", agent: "reply", assignees: HUMAN_ASSIGNEES, reason, status: null, log });
    await escalate({
      inbound: { id: `task:${task.id}:${new Date().toISOString().slice(0, 10)}`, from: "(support task)", subject: task.title },
      body: task.details || "", contact, reason, sourceTask: task,
    });
  };

  for (const task of tasks) {
    log(`support task ${task.id} — "${task.title}"`);

    // re-assigned after a park: drop needs-human, the task is being worked again
    try { if (await unparkTask(task)) log(`  unparked (needs-human cleared)`); }
    catch (e) { log(`  warn: could not clear needs-human: ${e.message}`); }

    const contactId = supportTaskContactId(task);
    const contact = contactId ? contacts.find(c => c.id === contactId) : null;
    if (!contact || !contact.email) {
      await park(task, contact
        ? `the task's contact has no email address — add one to the contact.`
        : `couldn't resolve the contact — link exactly one contact to the task, or put a 'Contact ID: <uuid>' line in the details.`, null);
      continue;
    }
    if (state.cases?.[contact.email.toLowerCase()]?.status === "open") {
      log(`  ${contact.email} already has an open case — leaving task for next runs`);
      continue;
    }

    let verdict;
    try {
      const memoContext = await fetchContactMemos(contact.id);
      verdict = await runSupportAgent({
        inbound: { id: `task:${task.id}`, from: "(support task)", subject: task.title },
        body: "", contact, brain, memoContext,
        // a teammate's comment that re-armed the task steers the draft
        outreach: { title: task.title.replace(LEGACY_MARKER_RX, "").trim(), details: guidance[task.id] ? `${task.details || ""}\n\nTeammate guidance (comments on the task):\n${guidance[task.id]}` : task.details },
        agentName: AGENT_NAME,
      });
    } catch (e) {
      log(`  outreach drafting failed: ${e.message} — will retry next run`);
      continue;
    }
    if (verdict.action !== "reply" || !verdict.reply_html || badLinks(verdict.reply_html, verdict.reply_text).length) {
      await park(task, `${verdict.reason || verdict.issue_summary || "the outreach draft failed its guards"} — fix the task details or the contact.`, contact);
      continue;
    }

    // claim the task, send the outreach, open the case
    try { await noanPatch(`/tasks/${task.id}`, { status: "in-progress" }); } catch {}

    const subject = (verdict.subject || task.title.replace(LEGACY_MARKER_RX, "").trim() || "Checking in from NOAN").slice(0, 120);
    await sendEmail({
      to: TEST_RECIPIENT || contact.email,
      subject: TEST_RECIPIENT ? `[TEST → ${contact.email}] ${subject}` : subject,
      html: verdict.reply_html, text: verdict.reply_text,
      idempotencyKey: `${AGENT_NAME}:cs-outreach:${task.id}`,
    });

    state.cases = state.cases || {};
    state.cases[contact.email.toLowerCase()] = {
      id: `task:${task.id}`, taskId: task.id, status: "open",
      openedAt: new Date().toISOString(), openedBy: "task",
      subject, turns: [{ at: new Date().toISOString(), who: AGENT_NAME.toLowerCase(), summary: (verdict.reply_text || "").slice(0, 280) }],
    };
    try {
      await addContactMemo(contact.id, `[${AGENT_NAME}] Support outreach (from task) — ${new Date().toISOString().slice(0, 10)}\nTask: ${task.title}\n${AGENT_NAME}: ${(verdict.reply_text || "").slice(0, 600)}`);
    } catch {}
    state.taskOutreach[task.id] = { at: new Date().toISOString(), status: "sent" };
    await saveState(state);
    log(`  ✓ outreach sent to ${TEST_RECIPIENT || contact.email}, case open, task in-progress`);
  }
}

/** When a task-initiated case closes, close its task too. */
async function closeCaseTask(kase, resolved) {
  if (!kase?.taskId) return;
  try {
    if (resolved) {
      await noanPatch(`/tasks/${kase.taskId}`, { status: "done", completed: true });
    } else {
      // fetch the live task so tag/assignee merges preserve what's there
      const all = await noanGetAll(`/tasks?per_page=100`);
      const task = all.find(t => t.id === kase.taskId) || { id: kase.taskId, tags: [], assignees: [] };
      // park: tagged-but-unassigned won't retrigger; re-assign the agent to retry.
      // The CS owner goes on it (REPLY_HUMAN_ASSIGNEES) so the case has an owner.
      await parkForHuman(task, { lane: "cs", agent: "reply", assignees: HUMAN_ASSIGNEES, reason: "support case closed unresolved", log });
    }
  } catch (e) { log(`  warn: could not update source task: ${e.message}`); }
}

/* ---------------- command handling ---------------- */

let _capabilities = null;
async function loadCapabilities() {
  if (_capabilities !== null) return _capabilities;
  if (!CAPABILITIES_SLUG) { _capabilities = { fleet: "", app: "" }; return _capabilities; }
  // Two-fact split (capabilities.mjs): fleet = the queueable menu (its absence
  // still hard-escalates below); app = the desktop app's own powers, briefing
  // only — missing is normal before the migration and on older installs.
  const { loadCapabilityTexts } = await import("./capabilities.mjs");
  const t = await loadCapabilityTexts();
  if (!t.app && process.env.APP_CAPABILITIES_BLOCK_SLUG) {
    console.warn("reply-worker: APP_CAPABILITIES_BLOCK_SLUG set but the fact is empty — app-capability questions will be answered from the fleet fact only");
  }
  _capabilities = { fleet: t.fleet, app: t.app };
  return _capabilities;
}

function pendingSummary(state) {
  const entries = Object.entries(state.pending || {});
  if (!entries.length) return "";
  return entries.map(([email, e]) =>
    `- ${e.type} for ${email} (requested by ${e.requestedBy}, ${e.at.slice(0, 10)})`).join("\n");
}

/* ---------------- general-agent ask replies ----------------
 * The general agent's ask_requester emails carry [VG-<taskId>] in the subject.
 * A teammate's reply is stamped onto the task description as a [Note] append
 * (the interim task-note convention — no notes API yet), which the general
 * worker diffs on its next poll and resumes the task with. Deterministic, no
 * model. The description PATCH is read-append-verify: a raw write would wipe
 * the requester's brief. */
const GENERAL_ASK_RX = /\[VG-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/i;

async function handleGeneralAskReply({ meta, body, senderEmail, taskId, mark }) {
  let task = null, status = null;
  for (const st of ["in-progress", "backlog", "done"]) {
    const r = await noanGet(`/tasks?status=${st}&per_page=100`);
    task = (r.items || []).find(t => t.id === taskId);
    if (task) { status = st; break; }
  }
  if (!task) {
    await sendEmail({
      to: TEST_RECIPIENT || senderEmail,
      subject: TEST_RECIPIENT ? `[TEST → ${senderEmail}] Re: ${meta.subject}` : `Re: ${meta.subject}`,
      html: `<p>I couldn't find that task any more (it may have been deleted), so your answer wasn't recorded.</p>`,
      text: `I couldn't find that task any more (it may have been deleted), so your answer wasn't recorded.`,
      headers: { "In-Reply-To": meta.message_id },
      idempotencyKey: `${AGENT_NAME}:general-ask-miss:${meta.id}`,
    });
    mark("general-ask-orphan", { taskId });
    log(`  general-ask reply for missing task ${taskId}`);
    return;
  }
  const answer = String(body || "").split(/\r?\n(?=>|On .+wrote:)/)[0].trim().slice(0, 800) || "(empty reply)";
  const prior = task.details || "";
  const entry = `[Note] Reply from ${senderEmail} (${new Date().toISOString().slice(0, 16).replace("T", " ")}):\n${answer}`;
  // 2048-cap compaction, shared with the agent; preserving because this IS a
  // human's words and an earlier human [Note] on its way out goes to a note
  // first rather than vanishing when the description overflows its cap.
  const { fitDetailsPreserving } = await import("../shared/noan.mjs");
  const { details, noteId } = await fitDetailsPreserving(prior, entry, { taskId: task.id, taskTitle: task.title });
  if (noteId) log(`  trimmed human notes preserved in note ${noteId}`);
  await noanPatch(`/tasks/${task.id}`, { details });
  const verify = await noanGet(`/tasks?status=${status}&per_page=100`);
  const after = (verify.items || []).find(t => t.id === task.id);
  if (prior && after && !(after.details || "").includes(prior.slice(0, 200))) {
    log(`  WARN: general-ask append verify failed on ${task.id}`);
  }
  await sendEmail({
    to: TEST_RECIPIENT || senderEmail,
    subject: TEST_RECIPIENT ? `[TEST → ${senderEmail}] Re: ${meta.subject}` : `Re: ${meta.subject}`,
    html: `<p>Got it, thanks. I've picked your answer up on the task and will carry on within a few minutes.</p>`,
    text: `Got it, thanks. I've picked your answer up on the task and will carry on within a few minutes.`,
    headers: { "In-Reply-To": meta.message_id },
    idempotencyKey: `${AGENT_NAME}:general-ask-ack:${meta.id}`,
  });
  mark("general-ask-answered", { taskId });
  log(`  ✓ general-ask answer stamped onto task ${taskId}`);
}

async function handleCommand({ meta, full, body, senderEmail, state, byEmail, mark, today }) {
  // spoof check: allowlisted From is not enough
  const auth = commanderAuthVerdict(full);
  if (!auth.verified) {
    await escalate({ inbound: meta, body, contact: null, reason: `Mail claims to be from teammate ${senderEmail} but DKIM verification for ${auth.domain || String(senderEmail).split("@")[1]} failed (${auth.reason}) — possible spoof. Not executed.` });
    mark("command-rejected", { reason: "dkim-fail" });
    log(`  commander address but DKIM failed (${auth.reason}) → escalated (possible spoof)`);
    return;
  }

  const cmdKey = `cmd:${senderEmail}|${today}`;
  if ((state.sent[cmdKey] || 0) >= MAX_COMMANDS_PER_SENDER) {
    await escalate({ inbound: meta, body, contact: null, reason: `Command cap reached (${MAX_COMMANDS_PER_SENDER}/day for ${senderEmail}).` });
    mark("command-rejected", { reason: "rate-cap" });
    return;
  }

  const caps = await loadCapabilities();
  const capabilities = caps.fleet;
  if (!capabilities) {
    await escalate({ inbound: meta, body, contact: null, reason: "No capabilities fact configured (CAPABILITIES_BLOCK_SLUG) — cannot execute teammate commands." });
    mark("command-rejected", { reason: "no-capabilities" });
    return;
  }

  const sender = byEmail.get(senderEmail) || { email: senderEmail };
  let verdict;
  try {
    verdict = await runCommandAgent({
      inbound: meta, body, sender, capabilities, appCapabilities: caps.app,
      pendingSummary: pendingSummary(state), agentName: AGENT_NAME,
    });
  } catch (e) {
    await escalate({ inbound: meta, body, contact: null, reason: `Command interpretation failed: ${e.message}` });
    mark("command-error", { reason: e.message.slice(0, 200) });
    return;
  }

  let outcome = null;
  if (verdict.action === "queue_task") {
    outcome = await executeQueueTask({ verdict, senderEmail, byEmail, state, inboundId: meta.id, inbound: meta, body });
  } else if (verdict.action === "confirm_pending") {
    outcome = await executeConfirmPending({ verdict, senderEmail, state });
  } else if (verdict.action === "escalate") {
    await escalate({ inbound: meta, body, contact: null, reason: verdict.reason || "Command agent escalated." });
    mark("command-escalated", { reason: verdict.reason });
    log(`  command escalated: ${verdict.reason || "(no reason)"}`);
    return;
  }
  // decline falls through with outcome=null — the reply explains itself

  if (outcome && !outcome.ok) {
    await escalate({ inbound: meta, body, contact: null, reason: `Command "${verdict.action}" could not be executed: ${outcome.why}` });
    mark("command-failed", { reason: outcome.why });
    log(`  command failed: ${outcome.why}`);
    return;
  }

  const rogue = badLinks(verdict.reply_html, verdict.reply_text);
  const replyHtml = rogue.length ? `<p>Done — see the NOAN board for details.</p>` : verdict.reply_html;
  const replyText = rogue.length ? `Done — see the NOAN board for details.` : verdict.reply_text;

  const subjectBase = /^re:/i.test(meta.subject || "") ? meta.subject : `Re: ${meta.subject || "your request"}`;
  const subject = TEST_RECIPIENT ? `[TEST → ${senderEmail}] ${subjectBase}` : subjectBase;
  const sendResult = await sendEmail({
    to: TEST_RECIPIENT || senderEmail,
    subject, html: replyHtml, text: replyText,
    headers: { "In-Reply-To": meta.message_id },
    idempotencyKey: `${AGENT_NAME}:cmdreply:${meta.id}`,
  });

  state.sent[cmdKey] = (state.sent[cmdKey] || 0) + 1;
  mark(`command-${verdict.action}`, { task: outcome?.taskId, resend: sendResult?.id, ...(outcome?.contactCreated ? { contactCreated: outcome.contactCreated } : {}) });
  log(`  ✓ command ${verdict.action}${outcome?.taskId ? ` → task ${outcome.taskId}` : ""}${outcome?.pending ? " (pending confirm)" : ""}, replied to ${TEST_RECIPIENT || senderEmail}`);
}

/* ---------------- main ---------------- */

async function main() {
  // Addresses have no defaults in code (required-env.mjs). Check the one that
  // would otherwise fail silently — an escalation with nowhere to go is lost mail.
  requireEnv("ESCALATE_TO", "Where this agent forwards anything it cannot answer itself.");
  log(`${AGENT_NAME} reply agent starting · mode: ${DRY_RUN ? "DRY-RUN" : TEST_RECIPIENT ? `TEST → ${TEST_RECIPIENT}` : "LIVE"} · escalations → ${ESCALATE_TO}`);
  const brain = await loadBrain();
  const state = await loadState();

  let inbound = await listInbound();
  const only = process.env.REPLY_ONLY_EMAIL_ID;
  if (only) inbound = inbound.filter(m => m.id === only);

  // contacts loaded lazily, once per run, only when actually needed
  let _contacts = null;
  const getContacts = async () => (_contacts ||= await noanGetAll(`/contacts?per_page=100`));

  const fresh = inbound.filter(m => !state.processed[m.id]);
  if (!fresh.length) {
    await scanSupportTasks(getContacts, state);   // support-tagged tasks fire even on quiet polls
    log("no new inbound email. done.");
    return;
  }
  log(`${fresh.length} new inbound email(s) (cap ${MAX_RUN})`);

  const contacts = await getContacts();
  const byEmail = new Map();
  for (const c of contacts) {
    if (c.email) byEmail.set(c.email.toLowerCase(), c);
  }

  const today = new Date().toISOString().slice(0, 10);

  // oldest first so threads are handled in order
  for (const meta of fresh.reverse().slice(0, MAX_RUN)) {
    const senderEmail = bareEmail(meta.from);
    log(`inbound ${meta.id} from ${meta.from} — "${meta.subject}"`);

    const markExtra = {};   // per-inbound facts every later mark() should carry (e.g. contactCreated)
    const mark = (status, extra = {}) => {
      state.processed[meta.id] = { at: new Date().toISOString(), from: senderEmail, status, ...markExtra, ...extra };
    };

    try {
      if (!senderEmail || isAutoSender(senderEmail)) {
        mark("skipped-auto");
        log("  auto-responder/bounce sender → skipped");
        await saveState(state); continue;
      }
      if (SELF_ADDRESSES.has(senderEmail)) {
        mark("skipped-self");
        log("  our own address → skipped");
        await saveState(state); continue;
      }
      if (DRY_RUN) { log("  dry-run: would process"); continue; }

      const full = await getInbound(meta.id);
      const body = (full.text && full.text.trim()) || stripHtml(full.html) || "";

      // active scheduling thread? the prospect's reply outranks every other route
      if (state.threads?.[senderEmail]?.status === "offered") {
        await handleScheduleReply({ meta, body, senderEmail, state, mark });
        await saveState(state); continue;
      }

      // teammates command; customers converse
      if (COMMANDERS.has(senderEmail)) {
        const auth = commanderAuthVerdict(full);
        if (!auth.verified) {
          await escalate({ inbound: meta, body, contact: null, reason: `Mail claims to be from teammate ${senderEmail} but DKIM verification for ${auth.domain || String(senderEmail).split("@")[1]} failed (${auth.reason}) — possible spoof. Not executed.` });
          mark("command-rejected", { reason: "dkim-fail" });
          log(`  commander address but DKIM failed (${auth.reason}) → escalated (possible spoof)`);
          await saveState(state); continue;
        }
        // general-agent question reply? deterministic subject match, no model
        const generalM = (meta.subject || "").match(GENERAL_ASK_RX);
        if (generalM) {
          await handleGeneralAskReply({ meta, body, senderEmail, taskId: generalM[1], mark });
          await saveState(state); continue;
        }
        // prospector digest reply ("sent 1,3 skip 2")? deterministic subject +
        // grammar match, no model. Must run BEFORE handleCommand: a
        // report reply with no subject match becomes a general task, and the
        // general agent has no lever on the prospect ledgers. A digest reply
        // that is NOT sent/skip falls through and is an ordinary command.
        const digestM = matchDigestSubject(meta.subject);
        if (digestM) {
          const r = await handleProspectorDigestReply({ meta, body, senderEmail, digest: digestM, mark, log });
          if (r.handled) { await saveState(state); continue; }
        }
        // CCing the agent on a thread with external people = maybe a scheduling ask
        const externals = externalParticipants(meta, full, senderEmail);
        if (externals.length) {
          const cfg = await loadScheduleCfg();
          let init = null;
          try { init = await interpretInit({ inbound: meta, body, externals, defaultDuration: cfg.durationMin }); }
          catch (e) { log(`  warn: schedule classify failed (${e.message}) — treating as command`); }
          if (init?.intent === "support") {
            const custEmail = (init.prospect_email || "").toLowerCase();
            const cust = byEmail.get(custEmail);
            if (!cust) {
              await escalate({ inbound: meta, body, contact: null, reason: `Teammate handed over a customer issue but "${custEmail || "(none)"}" doesn't match any NOAN contact.` });
              mark("cs-escalated", { reason: "unknown-customer" });
            } else {
              await handleSupportTurn({
                meta, body, senderEmail: custEmail, contact: cust, state, mark, today,
                openerNote: init.issue_note || (body || "").slice(0, 300),
              });
            }
            await saveState(state); continue;
          }
          if (init?.is_scheduling) {
            const handled = await handleScheduleInit({ meta, body, senderEmail, externals, init, state, mark });
            if (handled) { await saveState(state); continue; }
          }
        }
        await handleCommand({ meta, full, body, senderEmail, state, byEmail, mark, today });
        await saveState(state); continue;
      }

      // Sender not in the network? Until 2026-09-09 that escalated on its own:
      // Ryan O'Connor at SeedGrowth asked a product question the facts answer
      // and waited five hours for a human to approve the reply. Now the contact
      // is created from the email and routing continues — every guard below
      // (money, complaints, ungrounded answers, the per-sender cap) still
      // escalates exactly as it did for a known non-Subscriber.
      //
      // Duplicate guard, two layers. `byEmail` is this run's snapshot, so a
      // second mail from the same new sender in the same run reuses the record
      // set below. And findOrCreateContactByEmail re-checks the LIVE network by
      // exact address before it writes, so a contact another agent created
      // after the snapshot loaded is found, not duplicated. Created untagged —
      // Subscriber/Trial/etc. arm automations (trigger-tags.mjs) and stay a
      // human call — with a provenance memo so network integrity can see where
      // the record came from. A failed create is the one thing that still
      // escalates here: better a parked email than a reply to nobody on record.
      let contact = byEmail.get(senderEmail) || null;
      if (!contact) {
        let found;
        try {
          found = await findOrCreateContactByEmail(senderEmail, { name: senderDisplayName(meta.from) });
        } catch (e) {
          await escalate({ inbound: meta, body, contact: null, reason: `Sender is not a NOAN contact and creating one failed (${e.message}) — a human should reply and add them.` });
          mark("escalated", { reason: "contact-create-failed" });
          log(`  unknown sender → contact create failed (${e.message}) → escalated`);
          await saveState(state); continue;
        }
        contact = found.contact;
        byEmail.set(senderEmail, contact);
        if (found.created) {
          markExtra.contactCreated = contact.id;
          log(`  unknown sender → created contact ${contact.id} (${contact.name})`);
          try {
            await addContactMemo(contact.id,
              `[${AGENT_NAME}] Contact created from an inbound email — ${today}\n` +
              `From: ${meta.from}\nSubject: ${meta.subject || "(no subject)"}\n` +
              `Not previously in the network; created untagged so the message could be answered. Enrich or retag by hand if they matter.`);
          } catch (e) { log(`  warn: creation memo failed: ${e.message}`); }
        } else {
          log(`  sender missing from this run's contact snapshot but found live → ${contact.id} (no duplicate created)`);
        }
      }

      // Reply on a pre-call brief's thread? Before every other
      // customer route: the brief ended on a question and said they could reply,
      // so this is the answer to it. A ledger read, no model call, unless the
      // sender has a brief whose call is still ahead. Closed or used-up threads
      // fall through or reach the host; nothing here answers after the call.
      if (hasBriefThread(senderEmail)) {
        const r = await handleBriefReply({ meta, body, senderEmail, contact, mark, log });
        if (r.handled) { await saveState(state); continue; }
        if (r.escalate) {
          await escalate({ inbound: meta, body, contact, reason: r.escalate });
          await saveState(state); continue;
        }
        // fallthrough: the thread closed (cancelled, or the call started)
      }

      // open bespoke-deck offer from the re-engagement agent? a clear YES
      // builds and sends the deck; anything else falls through to normal routing
      if (hasOfferedThread(senderEmail)) {
        const r = await handleReengageReply({ meta, body, senderEmail, contact, mark });
        if (r.handled) { await saveState(state); continue; }
        if (r.escalate) {
          await escalate({ inbound: meta, body, contact, reason: r.escalate });
          mark("reengage-deck-failed", { reason: String(r.escalate).slice(0, 200) });
          await saveState(state); continue;
        }
        // fallthrough: not a deck answer — normal routing continues
      }

      // Reply to a SALES FOLLOW-UP. Must run before the customer-success path,
      // which otherwise treats it as a support question and sends a grounded
      // answer — so a prospect writing "yes, let's talk" got a help-desk reply
      // and no Sales task, and nothing recorded that they had raised a hand.
      //
      // Detected from the contact memo the follow-up agent writes on send,
      // matched on that exact literal prefix. Deliberately not a keyword search
      // on the body: intent classification here would be a model call on every
      // inbound, and a loose match is what broke the demo-video cooldown.
      //
      // Never auto-answers. A human gets the reply and a Sales task; judging
      // what a buying signal deserves is not this agent's call.
      const fu = await recentFollowupMemo(contact);
      if (fu) {
        await handleFollowupReply({ meta, body, senderEmail, contact, sentOn: fu, mark });
        await saveState(state); continue;
      }

      // education course: open offer or live enrollment? Must run
      // BEFORE the customer-success path below, which otherwise swallows every
      // subscriber reply. Cheap ledger lookup first — no model call unless the
      // sender actually has a course thread.
      if (COURSE_ON && hasCourseThread(senderEmail)) {
        const r = await handleCourseReply({ meta, body, senderEmail, contact, mark });
        if (r.handled) { await saveState(state); continue; }
        if (r.escalate) {
          await escalate({ inbound: meta, body, contact, reason: r.escalate });
          mark("course-escalated", { reason: String(r.escalate).slice(0, 200) });
          await saveState(state); continue;
        }
        // fallthrough: not a course answer — normal routing continues
      }

      // …and a Subscriber with NO course thread can simply ASK to start one
      // (added 2026-08-06): keyword prefilter + conservative classifier, then
      // the agent asks their goals + starting area; the answer builds the course.
      if (COURSE_ON && !hasCourseThread(senderEmail) && isUserContact(contact)) {
        const r = await maybeCourseStartAsk({ meta, body, senderEmail, contact, mark });
        if (r.handled) { await saveState(state); continue; }
        if (r.escalate) {
          await escalate({ inbound: meta, body, contact, reason: r.escalate });
          mark("course-start-failed", { reason: String(r.escalate).slice(0, 200) });
          await saveState(state); continue;
        }
        // fallthrough: not a course ask — normal routing continues
      }

      // implementation workstream (IMPLEMENTATION-PLAN §13): the headless
      // intake. Same placement and the same reasons as the course above — it
      // must outrank the customer-success path, which would otherwise answer
      // a one-line reply to "what makes this hard?" as a support ticket. The
      // thread check is one indexed row lookup, and no model runs unless the
      // sender is actually mid-conversation.
      if (intakeOn() && (await hasImplementationThread(senderEmail))) {
        const r = await handleImplementationReply({ meta, body, senderEmail, contact, mark });
        if (r.handled) { await saveState(state); continue; }
        if (r.escalate) {
          await escalate({ inbound: meta, body, contact, reason: r.escalate });
          mark("implementation-escalated", { reason: String(r.escalate).slice(0, 200) });
          await saveState(state); continue;
        }
        // fallthrough: not an intake answer — normal routing continues
      }

      // …and a Subscriber with no thread can ask to be put on it.
      if (intakeOn() && !(await hasImplementationThread(senderEmail)) &&
          (contact.tags || []).some(t => String(t?.name ?? t).toLowerCase() === SUBSCRIBER_TAG)) {
        const r = await maybeImplementationStartAsk({ meta, body, senderEmail, contact, mark });
        if (r.handled) { await saveState(state); continue; }
        if (r.escalate) {
          await escalate({ inbound: meta, body, contact, reason: r.escalate });
          mark("implementation-start-failed", { reason: String(r.escalate).slice(0, 200) });
          await saveState(state); continue;
        }
        // fallthrough: not an implementation ask — normal routing continues
      }

      // customer asking to set up time with a teammate? (2026-07-25 — a customer's
      // ask got escalated instead of scheduled) Keyword pre-filter, then a
      // conservative classifier; on a clear ask, offer slots from the named
      // teammate's calendar (default owner) and enter the offered-thread flow.
      if (MEETING_RX.test(body)) {
        try {
          const ask = await interpretCustomerAsk({ inbound: meta, body, teammates: [...COMMANDERS] });
          if (ask?.wants_meeting) {
            const rawOwner = (ask.with_teammate_email || "").toLowerCase();
            const owner = COMMANDERS.has(rawOwner) ? rawOwner : SCHEDULE_DEFAULT_OWNER;
            const handled = await startCustomerSchedule({
              meta, contact, owner,
              topic: ask.topic || "", durationMin: ask.duration_min,
              firstName: ask.first_name || "", state, mark,
            });
            if (handled) { await saveState(state); continue; }
          }
        } catch (e) { log(`  warn: customer-schedule classify failed (${e.message}) — falling through to normal routing`); }
      }

      // customer-success path: SUBSCRIBERS get the full conversational case
      // flow on direct email. Non-subscribers only continue a case a teammate
      // CC'd them into or a support task opened — a cold direct email from a
      // non-subscriber falls through to the one-shot reply agent below.
      const isSubscriber = (contact.tags || []).some(t => String(t?.name ?? t).toLowerCase() === SUBSCRIBER_TAG);
      const hasOpenCase = state.cases?.[senderEmail]?.status === "open";
      if (isSubscriber || hasOpenCase) {
        const csHandled = await handleSupportTurn({ meta, body, senderEmail, contact, state, mark, today });
        if (csHandled) { await saveState(state); continue; }
      }

      const sentKey = `${senderEmail}|${today}`;
      if ((state.sent[sentKey] || 0) >= MAX_PER_SENDER) {
        await escalate({ inbound: meta, body, contact, reason: `Already auto-replied ${MAX_PER_SENDER}× to this sender today — a human should take the thread.` });
        mark("escalated", { reason: "rate-cap" });
        log("  per-sender cap hit → escalated");
        await saveState(state); continue;
      }

      let verdict;
      try {
        const memoContext = await fetchContactMemos(contact.id);
        verdict = await runReplyAgent({ inbound: meta, body, contact, brain, memoContext, agentName: AGENT_NAME });
      } catch (e) {
        await escalate({ inbound: meta, body, contact, reason: `Drafting failed: ${e.message}` });
        mark("escalated", { reason: "draft-error" });
        log("  drafting error → escalated:", e.message);
        await saveState(state); continue;
      }

      if (verdict.action !== "reply") {
        await escalate({ inbound: meta, body, contact, reason: verdict.reason || "Model chose to escalate." });
        mark("escalated", { reason: verdict.reason || "model-escalate" });
        log(`  model escalated: ${verdict.reason || "(no reason)"}`);
        await saveState(state); continue;
      }

      const rogue = badLinks(verdict.html, verdict.text);
      if (rogue.length) {
        await escalate({ inbound: meta, body, contact, reason: `Draft contained non-NOAN links: ${rogue.join(", ")}` });
        mark("escalated", { reason: "rogue-links" });
        log("  rogue links → escalated");
        await saveState(state); continue;
      }

      const to = TEST_RECIPIENT || senderEmail;
      const subjectBase = /^re:/i.test(meta.subject || "") ? meta.subject : `Re: ${meta.subject || "your message"}`;
      const subject = TEST_RECIPIENT ? `[TEST → ${senderEmail}] ${subjectBase}` : subjectBase;

      const sendResult = await sendEmail({
        to, subject, html: verdict.html, text: verdict.text,
        headers: { "In-Reply-To": meta.message_id },   // thread it
        idempotencyKey: `${AGENT_NAME}:reply:${meta.id}`,
      });

      try {
        await addContactMemo(contact.id, `[${AGENT_NAME}] Replied in-thread — ${today}\n` +
            `Their message: ${body.slice(0, 500)}\n\n` +
            `${AGENT_NAME}'s reply (Resend ${sendResult?.id || "n/a"}):\n${verdict.text || stripHtml(verdict.html)}` +
            (TEST_RECIPIENT ? `\n(TEST — redirected to ${TEST_RECIPIENT})` : ``));
      } catch (e) { log(`  warn: memo failed: ${e.message}`); }

      state.sent[sentKey] = (state.sent[sentKey] || 0) + 1;
      mark("replied", { resend: sendResult?.id });
      log(`  ✓ replied to ${to} (resend ${sendResult?.id || "?"})`);
      await saveState(state);
    } catch (e) {
      log(`  unexpected error on ${meta.id}: ${e.message} — left unprocessed for next run`);
    }
  }
  await scanSupportTasks(getContacts, state);
  log("run complete.");
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
