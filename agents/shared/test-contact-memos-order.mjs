#!/usr/bin/env node
/**
 * Contact memos come back NEWEST-FIRST, and the reader must respect that.
 *
 * `GET /contacts/{id}` returns `notes` (and `memos`) with the most recent entry
 * at index 0. fetchContactMemos must take the head. A tail slice such as
 * `slice(-maxNotes).reverse()` does not merely invert the order: past maxNotes
 * it drops the newest memos outright, so "what did we last say to this
 * person?" gets the oldest thing on file. Nothing is lost until a contact has
 * MORE than maxNotes memos, so the tests cover that case.
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

// More memos than the default cap.
const thirteen = Array.from({ length: 13 }, (_, i) => `memo ${13 - i}`); // "memo 13" newest
const dflt = selectRecentMemos(thirteen);
ok("default cap keeps the newest memo", dflt.includes("memo 13"));
ok("default cap excludes the oldest", !dflt.includes("memo 1\n") && !dflt.endsWith("memo 1"));

// Fewer memos than the cap: the case where a wrong slice still looks right.
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
