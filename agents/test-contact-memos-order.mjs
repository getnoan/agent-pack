#!/usr/bin/env node
/**
 * Contact memos come back NEWEST-FIRST, and the reader must respect that.
 *
 * `GET /contacts/{id}` returns `notes` (and `memos`) with the most recent entry
 * at index 0 — verified live 2026-09-04 by writing a memo and finding it at [0].
 * fetchContactMemos read it as newest-LAST: `slice(-maxNotes).reverse()`.
 *
 * That did not merely invert the order. Past maxNotes it dropped the newest
 * memos outright. Live at the time of the fix:
 *
 *   John Marshall      13 memos — the five most recent (2026-09-02) all fell
 *                      outside slice(-8); agents read his history as ending
 *                      2026-08-31.
 *   Stephanie Wiseman   9 memos — lost exactly one, the newest.
 *
 * Twelve workers ground on contact history through this helper, several to
 * answer "what did we last say to this person?" — the question the old slice
 * answered with the oldest thing on file. It hid for months because a contact
 * needs MORE than maxNotes memos before anything is lost, and most have fewer.
 *
 * Run:  node test-contact-memos-order.mjs
 */

import { selectRecentMemos } from "./noan.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); } };

console.log("contact memo ordering");

// Newest-first, as the API returns it.
const notes = ["day-09 newest", "day-08", "day-07", "day-06", "day-05", "day-04", "day-03", "day-02", "day-01 oldest"];

const out = selectRecentMemos(notes, { maxNotes: 3 });
ok("returns exactly maxNotes entries", out.split("\n\n---\n\n").length === 3);
ok("keeps the NEWEST, not the oldest", out.includes("day-09 newest"),
   "this is the regression: slice(-3) would have taken day-03..day-01");
ok("drops the oldest", !out.includes("day-01 oldest"));
ok("preserves newest-first order", out.indexOf("day-09") < out.indexOf("day-08"));

// The exact live shape that exposed it: more memos than the default cap.
const thirteen = Array.from({ length: 13 }, (_, i) => `memo ${13 - i}`); // "memo 13" newest
const dflt = selectRecentMemos(thirteen);
ok("default cap keeps the newest memo", dflt.includes("memo 13"));
ok("default cap excludes the oldest", !dflt.includes("memo 1\n") && !dflt.endsWith("memo 1"));

// Fewer memos than the cap — the case that kept this hidden.
const few = selectRecentMemos(["b newest", "a oldest"], { maxNotes: 8 });
ok("a short history returns everything", few.includes("b newest") && few.includes("a oldest"));
ok("and still newest-first", few.indexOf("b newest") < few.indexOf("a oldest"));

// Budget and per-memo truncation still hold.
const long = selectRecentMemos(["x".repeat(5000), "y"], { maxNotes: 8, maxCharsPer: 100 });
ok("a long memo is truncated, marked", long.includes("[...memo truncated]") && long.length < 1000);
const budgeted = selectRecentMemos(Array.from({ length: 8 }, () => "z".repeat(900)), { maxCharsPer: 900, budget: 2000 });
ok("the budget stops accumulation", budgeted.length <= 2000 + 40);

// Degenerate input must not throw.
for (const [label, v] of [["null", null], ["undefined", undefined], ["empty", []], ["not an array", "nope"]]) {
  let threw = false, r;
  try { r = selectRecentMemos(v); } catch { threw = true; }
  ok(`${label} input returns null without throwing`, !threw && r === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
