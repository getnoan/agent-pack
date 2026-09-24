#!/usr/bin/env node
/**
 * Tests for isMalformedCapture (fact-alignment-worker.mjs) and the Malformed Captures
 * section it feeds (fact-alignment-agent.mjs) — the report's answer to a capture that
 * was written with the wrong title.
 *
 * Deterministic, no network: both are pure.
 *
 * Why this earns regression cover. A fact capture is picked up by one thing only — a title
 * starting with the literal `[Fact Candidate]`. Miss it and the run's query never sees the
 * task: no error, no warning, nothing in the report, and no way for the person who wrote it
 * to find out. That silence is the single worst property of the capture convention, and this
 * detector is what converts it into a visible line. Over-broad matching costs a report line;
 * under-broad matching restores the silence.
 *
 * Run:  node test-fact-alignment-capture-intake.mjs
 */

import { isMalformedCapture } from "./fact-alignment-worker.mjs";
import { renderReport } from "./fact-alignment-agent.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log("isMalformedCapture — the shapes a person actually writes");
ok("colon instead of brackets", isMalformedCapture("Fact candidate: Starter plan moved to $59/mo"));
ok("bare words, no punctuation", isMalformedCapture("Fact candidate Starter plan moved to $59/mo"));
ok("leading whitespace before a correct prefix", isMalformedCapture(" [Fact Candidate] indented"),
  "the pickup regex is anchored, so a leading space is already a silent miss");
ok("hyphenated", isMalformedCapture("[fact-candidate] pricing change"));
ok("prefix in the middle of the title", isMalformedCapture("Pricing change — fact candidate"));

console.log("\nisMalformedCapture — what must NOT be flagged");
ok("a correctly formed capture", !isMalformedCapture("[Fact Candidate] Starter plan moved to $59/mo"),
  "it was picked up properly — flagging it would report a working capture as broken");
ok("case-insensitive, like the pickup regex", !isMalformedCapture("[fact candidate] pricing change"));
ok("the relevance-correction shape", !isMalformedCapture('[Fact Candidate] mark stack "pricing" as relevant'));
ok("an unrelated task", !isMalformedCapture("Renew the SSL certificate"));
ok("a task about facts that is not a capture", !isMalformedCapture("Review the fact base for Q4"));

console.log("\nisMalformedCapture — missing titles");
ok("null title does not throw", !isMalformedCapture(null));
ok("undefined title does not throw", !isMalformedCapture(undefined));
ok("empty title does not throw", !isMalformedCapture(""));

console.log("\nrenderReport — the Malformed Captures section");
const emptyResult = { gaps: [], contradictions: [], overlaps: [], candidates: [], summary: ["nothing this week"] };
const base = { windowLabel: "2026-09-07 to 2026-09-13", result: emptyResult, manifest: null, site: null, missingFactReviewTag: false, emptyRecipients: false };

const without = renderReport({ ...base });
ok("absent when there is nothing to report", !without.includes("## Malformed Captures"),
  "a standing empty section trains the reader to skim past it");

const with1 = renderReport({ ...base, malformedCaptures: [{ id: "abc-123", title: "Fact candidate: pricing" }] });
ok("section appears when there is one", with1.includes("## Malformed Captures"));
ok("names the task id so the reader can find it", with1.includes("abc-123"));
ok("quotes the offending title", with1.includes("Fact candidate: pricing"));
ok("says what to change", with1.includes("[Fact Candidate]"));
ok("says nothing was closed out", /NOT been closed out/.test(with1),
  "the reader must know the task is still on the board and fixable");
ok("surfaced in the summary, not only at the bottom", with1.includes("## Summary") && /do not carry/.test(with1.split("## Gaps")[0]),
  "the summary is what gets read; a bottom-of-report section alone is nearly as silent as dropping it");

const untitled = renderReport({ ...base, malformedCaptures: [{ id: "def-456", title: null }] });
ok("an untitled task renders rather than printing null", untitled.includes("(untitled)"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
