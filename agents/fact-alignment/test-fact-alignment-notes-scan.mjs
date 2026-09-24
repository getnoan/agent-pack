#!/usr/bin/env node
/**
 * Tests for skipNoteFromScan (fact-alignment-worker.mjs) — which notes the weekly scan
 * refuses to treat as independent fact candidates.
 *
 * Deterministic, no network: the predicate is pure, so the double-counting bug it prevents
 * is catchable without a live run.
 *
 * What earns regression cover here: the fact-candidate capture convention writes a task AND
 * a note for the same finding, and both land inside the same weekly window. Without the
 * exclusion the model is handed that one finding twice — once as source:"task", once as
 * source:"notes-scan" — and the report recommends the same fact edit twice under two ids.
 * The other half is the inverse: over-broad matching here silently swallows a real note that
 * someone wrote by hand, and a dropped candidate leaves no trace in the report at all.
 *
 * Run:  node test-fact-alignment-notes-scan.mjs
 */

import { skipNoteFromScan } from "./fact-alignment-worker.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("skipNoteFromScan — capture notes");
ok("skips a capture note", skipNoteFromScan("[Fact Candidate] Starter plan moved to $59/mo"));
ok("prefix match is case-insensitive, like the task queue's",
  skipNoteFromScan("[fact candidate] pricing change"));
ok("skips a bare prefix with nothing after it", skipNoteFromScan("[Fact Candidate]"));

console.log("skipNoteFromScan — automation reports (pre-existing behaviour, unchanged)");
for (const t of [
  "Weekly Fact Alignment Report — 2026-08-24 to 2026-08-31",
  "Growth Metrics Refresh — August 2026",
  "Product Usage Refresh — 2026-08-24",
  "Market Research Refresh — 2026-08-03",
  "Weekly Activity Report — 2026-08-26",
]) ok(`skips ${JSON.stringify(t.slice(0, 28))}…`, skipNoteFromScan(t));

console.log("skipNoteFromScan — notes the scan must still see");
ok("keeps an ordinary meeting note", !skipNoteFromScan("Call with Acme — pricing pushback"));
ok("keeps a note that only mentions the phrase mid-title",
  !skipNoteFromScan("Reviewed the Fact Candidate backlog"),
  "the prefix is anchored at the start; a mid-title mention is a normal note");
ok("keeps a note whose prefix is not bracketed",
  !skipNoteFromScan("Fact Candidate: pricing change"),
  "matches the task queue exactly — an unbracketed title is not a capture write");
ok("keeps a leading-whitespace title", !skipNoteFromScan(" [Fact Candidate] indented"),
  "FACT_CANDIDATE_RX is anchored, so capture must not emit leading whitespace either");

console.log("skipNoteFromScan — missing titles");
// GET /notes returns title as optional; a null must not throw inside the scan loop.
ok("keeps an untitled note rather than throwing", !skipNoteFromScan(null));
ok("keeps an undefined title rather than throwing", !skipNoteFromScan(undefined));
ok("keeps an empty title rather than throwing", !skipNoteFromScan(""));

// A capture written through the NOAN MCP server cannot set a title: create_note takes only
// `content`, and the server derives the title itself — and strips a bracketed prefix while
// doing so (measured live 2026-09-19: "[Fact Candidate] MCP prefix-survival probe 2026-09-19"
// came back as "MCP Prefix-Survival Probe 2026-09-19"). The title-only check missed every one
// of those, invisibly: the note has a good title, just not the one being matched on.
console.log("skipNoteFromScan — capture notes written through MCP (no title of their own)");
ok("skips a capture whose prefix is only in the content",
  skipNoteFromScan("MCP Prefix-Survival Probe 2026-09-19", "[Fact Candidate] Starter plan moved to $59/mo\n\nWhat came up..."),
  "the real shape: a server-derived title that dropped the prefix the scan matches on");
ok("case-insensitive on the content, like the title",
  skipNoteFromScan("Some Derived Title", "[fact candidate] pricing change"));
ok("finds the prefix past leading blank lines",
  skipNoteFromScan("Some Derived Title", "\n\n  [Fact Candidate] Starter plan moved"),
  "first NON-EMPTY line, trimmed — the title side stays anchored to mirror the task queue, but content is the only signal an MCP capture has");

console.log("skipNoteFromScan — notes the content check must NOT swallow");
ok("keeps a note that merely discusses the convention",
  !skipNoteFromScan("Notes on capture", "We should document that [Fact Candidate] must start the title."),
  "matching anywhere in the body would drop a real find with nothing in the report to say so");
ok("keeps a note whose second line carries the prefix",
  !skipNoteFromScan("Notes on capture", "Meeting with Acme\n[Fact Candidate] not a capture note"));
ok("keeps an unbracketed content prefix",
  !skipNoteFromScan("Derived", "Fact candidate: pricing change"),
  "same rule as the title and the task queue — unbracketed is not a capture write");

console.log("skipNoteFromScan — missing content");
ok("no content argument at all does not throw", !skipNoteFromScan("An ordinary note"));
ok("null content does not throw", !skipNoteFromScan("An ordinary note", null));
ok("empty content does not throw", !skipNoteFromScan("An ordinary note", ""));
ok("whitespace-only content does not throw", !skipNoteFromScan("An ordinary note", "\n  \n"));
ok("a capture title still wins when the content is missing",
  skipNoteFromScan("[Fact Candidate] written through the REST API", null));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
