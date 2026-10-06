#!/usr/bin/env node
/**
 * The scheduling lane with no Google Calendar connected.
 *
 * The agent pack ships the scheduling lane, and most people who install it will
 * not have connected a calendar. Until 2026-10-03 that went badly: freeBusy threw
 * "No Google credentials", a teammate's "find a time with X" was left
 * "unprocessed for next run", and every later run retried the same email while
 * the teammate heard nothing. A customer's "can we meet?" got a classifier call
 * and a log line blaming the classifier.
 *
 * Now: calendarConfigured() says whether a credential exists, the teammate is told
 * once ("not configured yet: GOOGLE_SERVICE_ACCOUNT_JSON") and the email is marked
 * handled, and a customer's ask routes as ordinary mail.
 *
 * No network, no keys.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { agentFile } from "../shared/pack-paths.mjs";
import { calendarConfigured, CALENDAR_SECRET, freeBusy } from "./google-cal.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); } };

/* ---------- 1. the check matches the files google-cal.mjs reads ---------- */

const dir = path.dirname(agentFile("google-cal.mjs"));
const has = f => existsSync(path.join(dir, f));
const expected = has("google-service-account.json") || (has("google-oauth-client.json") && has("google-token.json"));
ok("calendarConfigured() matches the credential files on disk", calendarConfigured() === expected,
  `got ${calendarConfigured()}, files say ${expected}`);
ok("the secret named to the user is the one CI writes", CALENDAR_SECRET === "GOOGLE_SERVICE_ACCOUNT_JSON");

if (!calendarConfigured()) {
  // Why the guard exists: without it, this is what every scheduling email hit.
  let err = null;
  try { await freeBusy(new Date().toISOString(), new Date(Date.now() + 864e5).toISOString(), "someone@example.com"); }
  catch (e) { err = e; }
  ok("unconfigured, a calendar call throws rather than returning empty", /No Google credentials/.test(err?.message || ""), err?.message || "no error");
}

/* ---------- 2. reply-worker checks before it calls ---------- */

const rw = readFileSync(agentFile("reply-worker.mjs"), "utf8");

const guardAt = rw.indexOf("init?.is_scheduling && !calendarConfigured()");
const initAt = rw.indexOf("await handleScheduleInit(");
ok("a teammate's scheduling ask checks for a calendar first", guardAt !== -1 && initAt !== -1 && guardAt < initAt);
const guard = guardAt === -1 ? "" : rw.slice(guardAt, initAt);
ok("…tells the teammate, naming the missing secret", /notifyRequester\(/.test(guard) && /not configured yet: \$\{CALENDAR_SECRET\}/.test(guard));
ok("…and marks the email handled, so it is not retried every run",
  /mark\("schedule-not-configured"\)/.test(guard) && /saveState\(state\);\s*continue;/.test(guard));

const askAt = rw.indexOf("await interpretCustomerAsk(");
const gate = askAt === -1 ? "" : rw.slice(rw.lastIndexOf("if (", askAt), askAt);
ok("a customer's meeting ask is only classified when a calendar is connected", /calendarConfigured\(\)/.test(gate), gate.trim().slice(0, 80));

ok("the run log says once that scheduling is off", /if \(!calendarConfigured\(\)\) log\(`scheduling lane: not configured yet: \$\{CALENDAR_SECRET\}/.test(rw));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
