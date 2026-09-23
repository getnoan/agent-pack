#!/usr/bin/env node
/**
 * A missing RESEND_API_KEY or MAIL_FROM must be a NAMED error before any
 * request, never a request that Resend rejects.
 *
 * Why: resend.mjs used to read the key once at import and send whatever it
 * held. Unset, that was `Authorization: Bearer undefined`, and Resend answered
 * 401 "invalid API key" — byte-for-byte the message a revoked key produces. The
 * Slack companion's hand-built Render service shipped without the variable on
 * 2026-08-31 and reported a bad key for nine days while the key was fine, the
 * Actions fleet kept sending with it, and the Resend dashboard showed nothing
 * (unauthenticated requests are not logged). The delivery-stats tool had the
 * same hole: fetchEmailStatus produced 50/50 "lookup_failed", which read as a
 * fleet-wide auth failure. A missing variable and a bad credential are
 * different problems with different owners; the error must say which.
 *
 * Run:  node test-resend-env-guard.mjs
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate the best-effort send log / spend ledger from the real state dir.
process.env.STATE_DIR = mkdtempSync(path.join(tmpdir(), "resend-guard-"));
delete process.env.STATE_BACKEND;
delete process.env.RESEND_API_KEY;
delete process.env.MAIL_FROM;

const { sendEmail, fetchEmailStatus } = await import("./resend.mjs");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); } };

console.log("resend env guard");

let calls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { calls++; return new Response(JSON.stringify({ id: "em_test" }), { status: 200, headers: { "content-type": "application/json" } }); };

const msg = async (fn) => { try { await fn(); return null; } catch (e) { return e.message; } };
const args = { to: "someone@example.com", subject: "t", html: "<p>t</p>" };

// --- key missing ------------------------------------------------------------
let m = await msg(() => sendEmail(args));
ok("sendEmail without RESEND_API_KEY throws", m !== null);
ok("…and the error names the variable, not the key's validity", /RESEND_API_KEY is not set/.test(m || ""), m);
ok("…and no request was made", calls === 0, `fetch called ${calls}×`);

m = await msg(() => fetchEmailStatus("em_x"));
ok("fetchEmailStatus without RESEND_API_KEY throws the same named error", /RESEND_API_KEY is not set/.test(m || ""), m);
ok("…and no request was made", calls === 0, `fetch called ${calls}×`);

// --- key present, from missing (the second thing the Render service lacked) --
process.env.RESEND_API_KEY = "re_test_not_a_real_key";
m = await msg(() => sendEmail(args));
ok("sendEmail with a key but no MAIL_FROM names MAIL_FROM", /MAIL_FROM is not set/.test(m || ""), m);
ok("…and no request was made", calls === 0, `fetch called ${calls}×`);

m = await msg(() => fetchEmailStatus("em_x"));
ok("fetchEmailStatus needs only the key (status lookups have no sender)", m === null, m);
ok("…and did make its request", calls === 1, `fetch called ${calls}×`);

// --- both present: the guard is read at call time, so setting env after import works
process.env.MAIL_FROM = "Verity <verity@example.com>";
const r = await sendEmail(args);
ok("with both set the send goes through", r?.id === "em_test", JSON.stringify(r));
ok("env is read at call time, not import time", calls === 2, `fetch called ${calls}×`);

globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
