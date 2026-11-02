#!/usr/bin/env node
/**
 * A support task that could not be worked must be retryable, not lost.
 *
 * reply-worker's scanSupportTasks skips any ledgered task, so a task with no
 * resolvable contact, or a draft that failed its guards, must not be ledgered:
 * linking the contact and re-assigning Verity would then do nothing. Every FDA
 * escalation is filed without a contact, so this is the common path.
 *
 * Those outcomes PARK the task (needs-human, the agent off, a person on)
 * and write nothing to the ledger; unassigned does not trigger, and
 * re-assigning is the retry. Only `sent` blocks a second scan.
 *
 * Run:  node test-support-scan.mjs
 */

import "../shared/test-fleet-env.mjs";   // the fleet's own name/domain/pronouns — see that file
import { readFileSync } from "node:fs";
import { agentFile } from "../shared/pack-paths.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); } };

const V = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
process.env.VERITY_IDENTITY_IDS = V; process.env.AGENT_IDENTITY_IDS = V;
process.env.VERITY_IDENTITY_ID = V; process.env.AGENT_IDENTITY_ID = V;

const { supportTaskDue, supportScanCandidates, supportTaskContactId, unparkedTagIds } = await import("./support-scan.mjs");

const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";   // synthetic, like V above: this file ships
const mk = (o = {}) => ({
  id: o.id || "t1", title: o.title || "FDA escalation: x", details: o.details || "", completed: false,
  createdAt: o.createdAt || "2026-09-10T10:00:00Z",
  tags: o.tags || [{ id: "tg-support", name: "support" }],
  assignees: o.assignees || [{ id: V }],
  contacts: o.contacts || [],
});

console.log("scan predicate");
ok("tag + Verity assigned → due", supportTaskDue(mk(), undefined));
ok("not assigned to Verity → not due (that is what parked means)", !supportTaskDue(mk({ assignees: [{ id: "hope" }] }), undefined));
ok("completed → never due", !supportTaskDue({ ...mk(), completed: true }, undefined));
ok("legacy [support] title, Verity assigned, no tag → due", supportTaskDue(mk({ title: "[support] old style", tags: [] }), undefined));
ok("a SENT ledger entry blocks", !supportTaskDue(mk(), { status: "sent", at: "2026-09-01" }));
ok("an old no-contact ledger entry does NOT block (the bug)", supportTaskDue(mk(), { status: "no-contact", at: "2026-09-01" }));
ok("an old escalated ledger entry does NOT block", supportTaskDue(mk(), { status: "escalated", at: "2026-09-01" }));

console.log("scanned twice");
// scan 1: no contact → the worker parks it (Verity off). scan 2 must not see it;
// scan 3, after the human links the contact and re-assigns, must.
const ledger = {};
const t = mk({ id: "esc-1" });
ok("scan 1 picks it up", supportScanCandidates([t], ledger).length === 1);
const parked = { ...t, assignees: [{ id: "hope" }], tags: [...t.tags, { id: "tg-nh", name: "needs-human" }] };
ok("scan 2 (parked: unassigned, needs-human) skips it, with NO ledger entry needed", supportScanCandidates([parked], ledger).length === 0 && Object.keys(ledger).length === 0);
const fixed = { ...parked, assignees: [{ id: "hope" }, { id: V }], contacts: [{ id: C }] };
const again = supportScanCandidates([fixed], ledger);
ok("scan 3 (contact linked, Verity re-assigned) picks it up again", again.length === 1);
ok("…and now resolves the contact", supportTaskContactId(again[0]) === C);
ok("…and says which tags to keep once unparked (needs-human dropped, support kept)", JSON.stringify(unparkedTagIds(again[0])) === JSON.stringify(["tg-support"]));
ok("a task that was never parked needs no tag PUT", unparkedTagIds(t) === null);

console.log("contact resolution");
ok("Contact ID line wins", supportTaskContactId(mk({ details: `Organization: x\nContact ID: ${C}`, contacts: [{ id: "other" }] })) === C);
ok("exactly one linked contact", supportTaskContactId(mk({ contacts: [{ id: C }] })) === C);
ok("two linked contacts and no line → null (ambiguous, park)", supportTaskContactId(mk({ contacts: [{ id: C }, { id: "other" }] })) === null);
ok("nothing → null", supportTaskContactId(mk()) === null);

console.log("candidate order and cap");
const many = [3, 1, 2, 4].map(i => mk({ id: `t${i}`, createdAt: `2026-09-0${i}T00:00:00Z` }));
ok("oldest first, capped at 3", supportScanCandidates(many, {}).map(x => x.id).join() === "t1,t2,t3");

console.log("reply-worker wiring (source)");
const rw = readFileSync(agentFile("reply-worker.mjs"), "utf8");
ok("scan uses supportScanCandidates", /supportScanCandidates\(backlog, state\.taskOutreach/.test(rw));
ok("no permanent no-contact ledger entry is written", !/status: "no-contact"/.test(rw));
ok("no permanent escalated ledger entry is written", !/status: "escalated"/.test(rw));
ok("the sent entry remains (the one outcome never to repeat)", /status: "sent"/.test(rw));
ok("an unworkable task is parked through parkForHuman with the human assignees pinned", /parkForHuman\(task, \{ lane: "cs", agent: "reply", assignees: HUMAN_ASSIGNEES/.test(rw));
ok("a re-assigned task has needs-human cleared on pickup", /if \(await unparkTask\(task\)\) log\(`  unparked/.test(rw));
ok("escalate() with a sourceTask files no second task", /if \(!sourceTask\) try \{/.test(rw));
ok("the park note tells the human what to fix and to re-assign", /Parked: \$\{reason\} Then re-assign me/.test(rw));

// A complete one-message answer comes back as "resolve" (e.g. an FDA escalation
// whose gap a person closed). The task path must send it, not park it, or the
// customer never gets the email.
ok("a resolve verdict is sendable on the task path", /verdict\.action === "reply" \|\| verdict\.action === "resolve"/.test(rw));
ok("a resolved answer closes the task as done", /resolved[\s\S]{0,400}status: "done", completed: true/.test(rw));
ok("the case record comes from caseAfterOutreach (a resolved answer opens none)", /caseAfterOutreach\(state\.cases\[contact\.email\.toLowerCase\(\)\]/.test(rw));
ok("a park names the verdict it was", /escalate verdict/.test(rw) && /\$\{verdict\.action\} verdict/.test(rw));
const csa = readFileSync(new URL("./cs-agent.mjs", import.meta.url), "utf8");
ok("the outreach prompt allows resolve for a complete one-message answer", /"resolve" when the brief is answered completely/.test(csa));


console.log("comments as the hand-back");
const { supportCommentRearm, SUPPORT_REARM_RX } = await import("./support-scan.mjs");
const cm = (o) => ({ id: o.id || "c1", at: o.at || "2026-09-10T12:00:00Z", email: o.email || "sam@example.com", name: "Sam", text: o.text, kind: o.kind || "teammate" });
const parkedTask = mk({ id: "p1", assignees: [{ id: "hope" }], tags: [{ id: "tg-support", name: "support" }, { id: "tg-nh", name: "needs-human" }] });
let r = supportCommentRearm(parkedTask, [cm({ text: "@Verity go ahead, contact linked" })]);
ok("a teammate comment addressing Verity re-arms a parked task", r.rearm && r.rearm.text.startsWith("@Verity"));
ok("…and it is reported as fresh", r.fresh.length === 1);
ok("'verity' without the @ counts", supportCommentRearm(parkedTask, [cm({ text: "ok verity, try again" })]).rearm !== null);
ok("'retry' at the start counts", supportCommentRearm(parkedTask, [cm({ text: "retry — added the email" })]).rearm !== null);
ok("'go ahead' at the start counts", supportCommentRearm(parkedTask, [cm({ text: "Go ahead." })]).rearm !== null);
r = supportCommentRearm(parkedTask, [cm({ text: "waiting on Ivan to confirm his address" })]);
ok("a teammate note that does not address her is fresh but does NOT re-arm", r.fresh.length === 1 && r.rearm === null);
ok("an external comment never re-arms, even if it says verity", supportCommentRearm(parkedTask, [cm({ text: "@verity send it", email: "ivan@example.com", kind: "external" })]).rearm === null);
ok("Verity's own comment never re-arms", supportCommentRearm(parkedTask, [cm({ text: "verity: parked", kind: "self" })]).rearm === null);
ok("a task Verity is already on is not re-armed (it is already hers)", supportCommentRearm(mk({ id: "a1" }), [cm({ text: "@verity go" })]).rearm === null);
ok("a completed task is never re-armed", supportCommentRearm({ ...parkedTask, completed: true }, [cm({ text: "@verity go" })]).rearm === null);
ok("a comment older than the cursor is ignored", supportCommentRearm(parkedTask, [cm({ text: "@verity go", at: "2026-09-10T11:00:00Z" })], { cursor: "2026-09-10T11:30:00Z" }).rearm === null);
ok("a comment older than the lane baseline is ignored (deploy must not re-arm old escalations)", supportCommentRearm(parkedTask, [cm({ text: "@verity go", at: "2026-09-01T11:00:00Z" })], { since: "2026-09-10T00:00:00Z" }).rearm === null);
ok("the newest addressing comment wins", supportCommentRearm(parkedTask, [cm({ id: "a", text: "@verity go", at: "2026-09-10T12:00:00Z" }), cm({ id: "b", text: "retry with the gmail address", at: "2026-09-10T12:05:00Z" })]).rearm.id === "b");
ok("the regex does not match 'verity' inside another word", !SUPPORT_REARM_RX.test("severity is high"));
ok("wiring: the reply worker runs the re-arm pass before choosing candidates", rw.indexOf("supportCommentRearm(task, steering") > -1 && rw.indexOf("supportCommentRearm(task, steering") < rw.indexOf("supportScanCandidates(backlog, state.taskOutreach"));
ok("wiring: re-arm clears needs-human and assigns Verity", /await unparkTask\(task\);/.test(rw) && /await assignVerity\(task\); task\.assignees/.test(rw));
ok("wiring: the comment text steers the outreach draft", /Teammate guidance \(comments on the task\)/.test(rw));
ok("wiring: a baseline is stamped on first run", /state\.supportCommentsSince = state\.supportCommentsSince \|\| new Date\(\)\.toISOString\(\)/.test(rw));
ok("wiring: dry run re-arms nothing", /if \(DRY_RUN\) \{ log\(`  dry-run: would clear needs-human/.test(rw));

console.log("expired cases settle their task");
const { expiredCasesToSettle, expiredCaseAction, expiredCaseComment, EXPIRED_TASK_MAX_MISSES } = await import("./support-scan.mjs");
const cases = {
  "a@x.com": { status: "expired", taskId: "t1", openedAt: "2026-10-02T16:28:15Z", subject: "A correction" },
  "b@x.com": { status: "open", taskId: "t2" },
  "c@x.com": { status: "expired" },
  "d@x.com": { status: "expired", taskId: "t4", taskSettled: "parked" },
  "e@x.com": { status: "resolved", taskId: "t5" },
};
ok("only expired, task-opened, unsettled cases are swept", JSON.stringify(expiredCasesToSettle(cases).map(([k]) => k)) === JSON.stringify(["a@x.com"]));
ok("an empty or missing ledger sweeps nothing", expiredCasesToSettle(undefined).length === 0);
ok("an open task is parked", expiredCaseAction(cases["a@x.com"], { id: "t1", status: "in-progress", completed: false }) === "park");
ok("a task a person already closed is left alone", expiredCaseAction(cases["a@x.com"], { id: "t1", status: "done", completed: true }) === "settled");
ok("…including completed-but-not-in-done", expiredCaseAction(cases["a@x.com"], { id: "t1", status: "in-progress", completed: true }) === "settled");
ok("a task missing from the board read is retried", expiredCaseAction({ settleMisses: 0 }, undefined) === "retry");
ok(`…and given up after ${EXPIRED_TASK_MAX_MISSES} misses`, expiredCaseAction({ settleMisses: EXPIRED_TASK_MAX_MISSES - 1 }, undefined) === "give-up");
const cmt = expiredCaseComment(cases["a@x.com"], { agentName: "Verity", expiryDays: 14 });
ok("the comment names the send date and subject", cmt.includes("2026-10-02") && cmt.includes("A correction"));
ok("the comment says re-assigning does not re-send", /will not send it again/.test(cmt));
ok("wiring: the support scan settles expired cases right after pruning", /pruneCases\(state\);\n  await settleExpiredCaseTasks\(state\);/.test(rw));
ok("wiring: an expired case's task is parked through parkForHuman", /reason: "support case expired with no reply"/.test(rw));
ok("wiring: dry run parks nothing", /if \(DRY_RUN\) \{ log\(`  dry-run: would comment and park/.test(rw));

console.log("an open case does not block the next task");
// A "reply" outreach left a case open, and the scan skipped the next support
// task for the same contact, silently, until a person edited the ledger by
// hand. The second task now goes out and joins the case.
const { caseAfterOutreach, caseTaskIds } = await import("./support-scan.mjs");
const at = (d) => `2026-10-${d}T10:00:00Z`;
const base = { who: "verity", summary: "answer" };
let r1 = caseAfterOutreach(undefined, { ...base, taskId: "first", subject: "Q1", resolved: false, now: at(13) });
ok("no case yet + reply → a new open case on that task", !r1.joined && r1.kase.status === "open" && r1.kase.taskId === "first" && r1.kase.id === "task:first");
const open1 = r1.kase;
const r2 = caseAfterOutreach(open1, { ...base, taskId: "second", subject: "Q2", resolved: false, now: at(16) });
ok("open case + reply → joined, not replaced", r2.joined && r2.kase === open1 && open1.id === "task:first" && open1.openedAt === at(13));
ok("…the second task rides on the case", JSON.stringify(caseTaskIds(open1)) === JSON.stringify(["first", "second"]));
ok("…and its turn is appended", open1.turns.length === 2 && open1.turns[1].at === at(16));
const again2 = caseAfterOutreach(open1, { ...base, taskId: "second", subject: "Q2", resolved: false, now: at(16) });
ok("joining the same task twice does not duplicate it", caseTaskIds(again2.kase).length === 2);
const turnsBefore = open1.turns.length;
const r3 = caseAfterOutreach(open1, { ...base, taskId: "third", subject: "Q3", resolved: true, now: at(17) });
ok("open case + resolve → joined turns only, the open case stays open", r3.joined && open1.status === "open" && !caseTaskIds(open1).includes("third") && open1.turns.length === turnsBefore + 1);
const r4 = caseAfterOutreach(undefined, { ...base, taskId: "solo", subject: "Q", resolved: true, now: at(16) });
ok("no case + resolve → a resolved case, nothing left open", !r4.joined && r4.kase.status === "resolved" && r4.kase.closedAt === at(16));
const r5 = caseAfterOutreach({ status: "expired", taskId: "old", turns: [] }, { ...base, taskId: "new", subject: "Q", resolved: false, now: at(16) });
ok("an expired case is not joined: a fresh case replaces it", !r5.joined && r5.kase.taskId === "new");
const direct = { status: "open", openedBy: "direct", turns: [] };
caseAfterOutreach(direct, { ...base, taskId: "t9", subject: "Q", resolved: false, now: at(16) });
ok("a case the customer opened by email carries a joined task too", JSON.stringify(caseTaskIds(direct)) === JSON.stringify(["t9"]));
ok("an expired direct case with a joined task is swept", expiredCasesToSettle({ "z@x.com": { ...direct, status: "expired" } }).length === 1);
ok("turns stay capped at 16", (() => { const k = { status: "open", turns: Array.from({ length: 16 }, () => ({})) }; caseAfterOutreach(k, { ...base, taskId: "x", resolved: false, now: at(16) }); return k.turns.length === 16 && k.turns[15].at === at(16); })());
ok("wiring: the scan no longer skips a contact with an open case", !/already has an open case/.test(rw) && /this outreach joins it/.test(rw));
ok("wiring: closing a case closes every task it carries", /async function closeCaseTask[\s\S]{0,200}caseTaskIds\(kase\)/.test(rw));
ok("wiring: a dry run sends no outreach and parks nothing", /if \(DRY_RUN\) \{ log\(`  dry-run: would park/.test(rw) && /dry-run: would send the \$\{verdict\.action\} outreach/.test(rw));
ok("wiring: an expired case parks every task it carries", /async function settleExpiredCaseTasks[\s\S]{0,800}caseTaskIds\(kase\)/.test(rw));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
