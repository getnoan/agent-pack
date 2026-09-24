#!/usr/bin/env node
/**
 * Tests contact-memos.mjs — the fix for the weekly activity report's dead
 * contact-memo delta section.
 *
 * The section read `c.notes` off a GET /contacts sweep. That endpoint returns
 * ContactSummary, which has no notes and no memos, so the length was always 0
 * and the report showed zero deltas every week since the schema split. It
 * failed closed, which is why it read as a quiet week rather than a broken one.
 *
 * Two properties matter more than the arithmetic, and both are the kind a
 * mirror-style test would miss:
 *   1. A FAILED READ MUST NOT COUNT AS ZERO — that would report a contact's
 *      history as "replaced" and reset their baseline so the next run reports
 *      everything as new.
 *   2. A FAKE BASELINE MUST NOT DETONATE — stored counts have been {} for
 *      months, so the naive fix reports years of history as "new this week".
 *
 * Run:  node test-weekly-report-memos.mjs
 */

import { memoTexts, fetchMemosByContact, mergeCounts, shouldSeedBaseline, computeMemoDeltas } from "./contact-memos.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); } };

console.log("weekly report — contact memo deltas");

// ---- memoTexts ----
ok("reads the memos array (objects)",
   JSON.stringify(memoTexts({ contact: { memos: [{ content: "a" }, { content: "b" }] } })) === '["a","b"]');
ok("falls back to the deprecated notes array (strings)",
   JSON.stringify(memoTexts({ contact: { notes: ["a", "b"] } })) === '["a","b"]');
ok("prefers memos when both are present (API mirrors one into the other)",
   memoTexts({ contact: { memos: [{ content: "x" }], notes: ["a", "b", "c"] } }).length === 1);
ok("a ContactSummary yields nothing rather than throwing",
   JSON.stringify(memoTexts({ contact: { id: "c1" } })) === "[]");
ok("bare (unnested) shape also works",
   memoTexts({ memos: [{ content: "a" }] }).length === 1);
ok("null is safe", JSON.stringify(memoTexts(null)) === "[]");

// ---- fetchMemosByContact ----
{
  const get = async (p) => ({ contact: { memos: [{ content: `memo for ${p}` }] } });
  const { memosById, failures } = await fetchMemosByContact([{ id: "a" }, { id: "b" }, { id: "c" }], { get, concurrency: 2 });
  ok("resolves every contact", memosById.size === 3 && failures === 0);
  ok("reads the single-contact route", memosById.get("a")[0].includes("/contacts/a"));
}
{
  const get = async (p) => { if (p.endsWith("/b")) throw new Error("boom"); return { contact: { memos: [{ content: "m" }] } }; };
  const { memosById, failures } = await fetchMemosByContact([{ id: "a" }, { id: "b" }, { id: "c" }], { get, concurrency: 2 });
  ok("a failed read is counted as a failure", failures === 1);
  ok("a failed read is ABSENT, not zero", !memosById.has("b") && memosById.size === 2,
     "absent means unknown; zero would look like a wholesale replacement");
}
{
  const { memosById, failures } = await fetchMemosByContact([], { get: async () => ({}), concurrency: 8 });
  ok("an empty contact list does not hang", memosById.size === 0 && failures === 0);
}
{
  // Distinct causes must stay distinct: a permanent 403 and a transient 429
  // need opposite responses, and a bare count cannot tell them apart.
  const get = async (p) => {
    if (p.endsWith("/a")) throw Object.assign(new Error("denied"), { noan: { status: 403 } });
    if (p.endsWith("/b")) throw Object.assign(new Error("slow down"), { noan: { status: 429 } });
    if (p.endsWith("/c")) throw Object.assign(new Error("denied"), { noan: { status: 403 } });
    return { contact: { memos: [{ content: "m" }] } };
  };
  const { failures, failureKinds } = await fetchMemosByContact(
    [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }], { get, concurrency: 2 });
  ok("failure count is right", failures === 3);
  ok("failure REASONS are kept, not collapsed into a bare count",
     failureKinds.get("HTTP 403") === 2 && failureKinds.get("HTTP 429") === 1,
     JSON.stringify([...failureKinds]));
}

// ---- mergeCounts ----
ok("live counts overwrite the stored baseline",
   JSON.stringify(mergeCounts({ a: 1 }, new Map([["a", ["x", "y"]]]))) === '{"a":2}');
ok("a contact whose read FAILED keeps its stored count",
   JSON.stringify(mergeCounts({ a: 5 }, new Map())) === '{"a":5}',
   "absent from the map must not wipe the baseline");
ok("a contact genuinely down to zero memos is dropped",
   JSON.stringify(mergeCounts({ a: 5 }, new Map([["a", []]]))) === "{}");
ok("a newly-seen contact is added",
   JSON.stringify(mergeCounts({}, new Map([["b", ["x"]]]))) === '{"b":1}');

// ---- shouldSeedBaseline: the trap ----
ok("absent state -> seed (first run)",
   shouldSeedBaseline({ isFirstRun: true, priorCounts: {}, liveCounts: {} }).seed === true);
{
  // The exact live situation: state has existed for months, but every run wrote
  // {} because the read was broken. Must seed, NOT report everything as new.
  const r = shouldSeedBaseline({ isFirstRun: false, priorCounts: {}, liveCounts: { a: 3, b: 12 } });
  ok("state exists but stored counts are empty -> seed, do not detonate", r.seed === true);
  ok("and it names the reason distinctly", r.why === "stale-baseline");
}
ok("a real baseline reports deltas normally",
   shouldSeedBaseline({ isFirstRun: false, priorCounts: { a: 1 }, liveCounts: { a: 2 } }).seed === false);
ok("seeding cannot fire twice — after seeding, prior is populated",
   shouldSeedBaseline({ isFirstRun: false, priorCounts: { a: 3, b: 12 }, liveCounts: { a: 3, b: 13 } }).seed === false);
ok("empty prior AND empty live (a genuinely memo-less project) does not seed forever",
   shouldSeedBaseline({ isFirstRun: false, priorCounts: {}, liveCounts: {} }).seed === false);

// ---- computeMemoDeltas ----
const C = [{ id: "a", name: "Ann" }, { id: "b", name: "Bob" }, { id: "c", email: "c@x.com" }];
{
  // NEWEST-FIRST, which is how GET /contacts/{id} returns memos. The delta is the
  // FRONT of the array. Reading the tail instead (`slice(stored)`) kept the count
  // correct while handing the model this contact's oldest memo as the week's news —
  // the same inversion selectRecentMemos had in noan.mjs.
  const d = computeMemoDeltas({ contacts: C, memosById: new Map([["a", ["newest", "middle", "oldest"]]]), priorCounts: { a: 1 } });
  ok("reports only the NEW memos, not the whole history",
     d.length === 1 && d[0].newNotes.length === 2);
  ok("takes them from the FRONT — the newest — never the tail",
     JSON.stringify(d[0].newNotes) === '["newest","middle"]',
     `got ${JSON.stringify(d[0].newNotes)}`);
  ok("carries a human-readable name", d[0].contactName === "Ann");
}
ok("the single newest memo is the one reported when exactly one is new",
   computeMemoDeltas({ contacts: C, memosById: new Map([["a", ["fresh", "old1", "old2"]]]), priorCounts: { a: 2 } })[0].newNotes[0] === "fresh");
ok("no change yields no delta",
   computeMemoDeltas({ contacts: C, memosById: new Map([["a", ["1", "2"]]]), priorCounts: { a: 2 } }).length === 0);
ok("a brand-new contact's first memo is a delta",
   computeMemoDeltas({ contacts: C, memosById: new Map([["b", ["x"]]]), priorCounts: {} })[0].newNotes.length === 1);
{
  // Wholesale replacement: the tail is NOT the delta, so claim no memos rather
  // than inventing a number. This branch never fires in normal operation, which
  // is exactly why it needs a test.
  const d = computeMemoDeltas({ contacts: C, memosById: new Map([["a", ["only"]]]), priorCounts: { a: 4 } });
  ok("a shrunken array is flagged as replaced", d.length === 1 && d[0].replaced === true);
  ok("and claims no new memos rather than guessing", d[0].newNotes.length === 0);
}
ok("a contact whose read failed is skipped entirely",
   computeMemoDeltas({ contacts: C, memosById: new Map(), priorCounts: { a: 2 } }).length === 0,
   "absent must not be read as zero, which would look like replacement");
ok("a contact with no memos before or now is not reported",
   computeMemoDeltas({ contacts: C, memosById: new Map([["c", []]]), priorCounts: {} }).length === 0);
ok("falls back to email when there is no name",
   computeMemoDeltas({ contacts: C, memosById: new Map([["c", ["m"]]]), priorCounts: {} })[0].contactName === "c@x.com");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
