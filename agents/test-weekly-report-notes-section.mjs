#!/usr/bin/env node
/**
 * Tests the weekly activity report's Notes Captured section — standalone notes
 * only, one headline per note.
 *
 * WHY THIS FILE EXISTS. The section used to render contact-memo deltas as well,
 * quoting every new memo to 150 characters, which made it unbounded in
 * contacts × memos — the last such axis in the report after the Tasks
 * enumeration was removed on 2026-09-02 for pushing the note body past NOAN's
 * 25,000-character POST /notes cap and failing the scheduled run outright.
 * Memos are still gathered and still feed theme synthesis; they are simply not
 * reproduced here, because they already live on the contact record.
 *
 * The regression worth guarding is quiet reintroduction: nothing about the
 * report FAILS if a future change starts printing memos here again, it just
 * grows without bound until a busy week trips the cap at 3am. So one test
 * asserts contact names never appear in this section, and the headline tests
 * pin the "one line per note" promise that keeps it bounded.
 *
 * Run:  node test-weekly-report-notes-section.mjs
 */

import { noteHeadline, renderReport } from "./weekly-activity-report-agent.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); } };

console.log("weekly report — Notes Captured section");

// ---- noteHeadline ----
ok("a title wins outright",
   noteHeadline({ title: "Pricing call with Acme", content: "Long body. More body." }) === "Pricing call with Acme");
ok("no title falls back to the first sentence, not a 150-char slab",
   noteHeadline({ content: "Acme moved to annual billing. They also asked about seats, and about SSO, and about a dozen other things that would blow past any character budget." })
   === "Acme moved to annual billing.");
ok("a markdown heading is stripped",
   noteHeadline({ content: "## Weekly Fact Alignment Report\n\nBody text here." }) === "Weekly Fact Alignment Report");
ok("a leading bullet is stripped",
   noteHeadline({ content: "- Renewal slipped to Q4" }) === "Renewal slipped to Q4");
ok("a first line with no terminal punctuation is used whole",
   noteHeadline({ content: "Renewal slipped to Q4\nsecond line" }) === "Renewal slipped to Q4");
ok("an abbreviation does not produce a two-character headline",
   noteHeadline({ content: "Dr. Okafor confirmed the pilot starts in October." })
   === "Dr. Okafor confirmed the pilot starts in October.",
   `got ${JSON.stringify(noteHeadline({ content: "Dr. Okafor confirmed the pilot starts in October." }))}`);
{
  const h = noteHeadline({ title: "x".repeat(180) });
  ok("an over-long headline is clipped, not passed through", h.length <= 100 && h.endsWith("…"));
}
ok("an empty note still renders something", noteHeadline({}) === "(untitled note)");
ok("null is safe", noteHeadline(null) === "(untitled note)");

// ---- renderReport ----
const RESULT = { summary: "A quiet week.", themes: [], noThemesReason: "Too scattered." };
const BASE = {
  windowLabel: "2026-09-02 to 2026-09-08", windowStartDate: "2026-09-02", windowEndDate: "2026-09-08",
  isFirstRun: false, result: RESULT, factUpdates: [], assetsCreated: [], dataNotes: [],
};
const section = (report, name) => (report.split(/\n## /).find(s => s.startsWith(name)) || "").split("\n").slice(1).join("\n").trim();

{
  const notes = [
    { inferredSource: "Verity follow-up", title: "[Verity] followed up — Ann Kelly", content: "" },
    { inferredSource: "unattributed", title: "", content: "Board asked for a churn breakdown. Second sentence should not appear." },
  ];
  const r = renderReport({ ...BASE, standaloneNotes: notes });
  const s = section(r, "Notes Captured");
  ok("one bullet per note", s.split("\n").filter(Boolean).length === 2);
  ok("every line is a markdown bullet — the Playbook's firm rule",
     s.split("\n").filter(Boolean).every(l => l.startsWith("- ")));
  ok("the source label is kept", s.includes("[Verity follow-up]"));
  ok("the headline is rendered, not the body",
     s.includes('"Board asked for a churn breakdown."') && !s.includes("Second sentence"));
}
{
  const r = renderReport({ ...BASE, standaloneNotes: [] });
  ok("a week with no standalone notes says so rather than rendering an empty section",
     section(r, "Notes Captured") === "No standalone notes this week.");
}
{
  // The regression guard. Memos reach the model, never this section.
  const r = renderReport({
    ...BASE,
    standaloneNotes: [{ inferredSource: "unattributed", title: "Churn review", content: "" }],
    contactNoteDeltas: [{ contactName: "Ann Kelly", newNotes: ["a memo body"], replaced: false }],
  });
  const s = section(r, "Notes Captured");
  ok("contact memos do not leak back into Notes Captured, even when passed in",
     !s.includes("Ann Kelly") && !s.includes("a memo body"),
     "the section is standalone notes only — see the header comment");
}
{
  const r = renderReport({ ...BASE, isFirstRun: true, standaloneNotes: [] });
  ok("a first run points at Data Notes for the memo suppression, not at this section",
     r.includes("see Data Notes") && !/Notes Captured reports zero/.test(r));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
