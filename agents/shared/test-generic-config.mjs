#!/usr/bin/env node
/**
 * Nothing about OUR company is a default in code that ships in the agent pack.
 *
 * The pack is a one-way export of these files, run by other companies against
 * their own NOAN workspaces. The sender name, the teammate domain (comment
 * steering AND the commander DKIM gate), the allowed links, the report tag and
 * the company name in prompts all come from configuration with a neutral
 * fallback. The fleet's own values live in agents/config.defaults.env, which
 * never ships.
 *
 * Two halves: the helpers behave as documented with the variables unset and
 * set, and a sweep of the pack's actual closure proves no shipped module still
 * carries our domain, our agent's name, or an address in code.
 *
 * Run:  node agents/test-generic-config.mjs
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { AGENTS_DIR, REPO_DIR, DESIGN_DIR, LAYOUT, agentFile } from "./pack-paths.mjs";
import {
  teammateDomain, isTeammateEmail, isInternalEmail, agentName, agentIdentityIds, agentIdentityId,
  allowedLinks, linkRule, pronouns,
} from "./required-env.mjs";
import { commanderAuthVerdict, commanderDomain } from "../customer-support/commander-auth.mjs";
import { addressesAgent } from "./task-comments.mjs";
import { RESPOND_BY, LANE_RESPONSE } from "./respond-by.mjs";
import { SHIPPED_TESTS, SHIPPED_TOOLS, SHIPPED_ASSETS, SHIPPED_SCRIPTS, stripComments, stripPython, sweepCode, sweepProse, sweepData, sweepDeckPrompt, sweepRawContactCreate, WORKSPACE_ID, SYNTHETIC_ID, PRIVATE_POINTER_NO_ID } from "./oss-sweeps.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); } };
const withEnv = (vars, fn) => {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  try { return fn(); } finally { for (const k of Object.keys(vars)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
};
const CLEAR = { TEAMMATE_DOMAIN: null, AGENT_NAME: null, AGENT_IDENTITY_IDS: null, AGENT_IDENTITY_ID: null,
  VERITY_IDENTITY_IDS: null, VERITY_IDENTITY_ID: null, AGENT_ALLOWED_LINKS: null, AGENT_PRONOUNS: null, COMPANY_NAME: null };

console.log("generic configuration: the helpers");
withEnv(CLEAR, () => {
  ok("no teammate domain by default", teammateDomain() === null);
  ok("only a commander is a teammate when no domain is set", isTeammateEmail("a@getnoan.com", new Set(["b@x.com"])) === false && isTeammateEmail("b@x.com", new Set(["b@x.com"])));
  ok("nobody is internal when no domain is set", isInternalEmail("a@getnoan.com") === false);
  ok("the agent is called Agent when unnamed", agentName() === "Agent");
  ok("no identity ids by default", agentIdentityIds().length === 0 && agentIdentityId() === null);
  ok("no links allowed by default, and the rule says so", allowedLinks().length === 0 && /Do not include any hyperlink/.test(linkRule()));
  ok("pronouns default to they/them", pronouns().subj === "they" && pronouns().obj === "them" && pronouns().poss === "their");
  ok("a they/them agent takes the plural verb in respond-by prose", /they pick it up on their next poll/.test(RESPOND_BY.reassign) && /they act on the draft/.test(LANE_RESPONSE.approval) && /they review again/.test(LANE_RESPONSE["pr-review"]) && !/they (picks|acts|reviews)\b/.test(Object.values(RESPOND_BY).join(" ") + Object.values(LANE_RESPONSE).join(" ")));
  ok("the wake predicate uses the configured name", addressesAgent("@Agent look at this") && !addressesAgent("@Verity look at this") && addressesAgent("retry"));
  ok("respond-by prose names the configured agent", RESPOND_BY.email.includes("Agent picks it up") && !/Verity/.test(Object.values(RESPOND_BY).join(" ") + Object.values(LANE_RESPONSE).join(" ")));
});
withEnv({ ...CLEAR, TEAMMATE_DOMAIN: "@Example.com", AGENT_NAME: "Ada", AGENT_IDENTITY_IDS: "id-a, id-b", AGENT_ALLOWED_LINKS: "https://app.example.com, https://example.com/docs", AGENT_PRONOUNS: "she/her" }, () => {
  ok("the domain is normalised", teammateDomain() === "example.com");
  ok("anyone at the domain is a teammate; other domains are not", isTeammateEmail("X@example.com", new Set()) && !isTeammateEmail("x@example.com.evil", new Set()) && !isTeammateEmail("x@getnoan.com", new Set()));
  ok("internal means at the domain", isInternalEmail("y@example.com") && !isInternalEmail("y@other.com"));
  ok("the agent's name is read", agentName() === "Ada");
  ok("identity ids split and trim", agentIdentityIds().join("|") === "id-a|id-b" && agentIdentityId() === "id-a");
  ok("allowed links split and the rule lists them", allowedLinks().length === 2 && /ONLY hyperlinks allowed are https:\/\/app\.example\.com, https:\/\/example\.com\/docs/.test(linkRule()));
  ok("she/her pronouns", pronouns().subj === "she" && pronouns().poss === "her");
  ok("the wake predicate follows AGENT_NAME", addressesAgent("ada, please retry") && addressesAgent("@Ada thoughts?") && !addressesAgent("@Verity thoughts?"));
  ok("respond-by prose follows the name and pronouns", /^Re-assign Ada on the task/.test(RESPOND_BY.reassign) && /she picks it up on her next poll/.test(RESPOND_BY.reassign) && /she acts on the draft/.test(LANE_RESPONSE.approval));
});
withEnv({ ...CLEAR, VERITY_IDENTITY_IDS: "old-1,old-2", VERITY_IDENTITY_ID: "old-1" }, () => {
  ok("the fleet's VERITY_* names are still read as a fallback", agentIdentityIds().join("|") === "old-1|old-2" && agentIdentityId() === "old-1");
});
withEnv({ ...CLEAR, AGENT_IDENTITY_IDS: "new-1", VERITY_IDENTITY_IDS: "old-1" }, () => {
  ok("AGENT_* wins over VERITY_* when both are set", agentIdentityIds().join("|") === "new-1");
});

console.log("\ncommander DKIM: the domain is configured, else the From address's own");
const AR_OK = (d) => `amazonses.com; spf=pass; dkim=pass header.i=@${d}; dmarc=pass header.from=${d};`;
const inbound = (from, ar) => ({ from, headers: { "authentication-results": ar } });
withEnv(CLEAR, () => {
  ok("no domain configured: the From domain is what must be signed", commanderDomain("acme.example") === "acme.example");
  const v = commanderAuthVerdict(inbound('"A" <a@acme.example>', AR_OK("acme.example")));
  ok("a genuine inbound from any domain verifies against itself", v.verified === true && v.domain === "acme.example", v.reason);
  const spoof = commanderAuthVerdict(inbound('"A" <a@acme.example>', `amazonses.com; dkim=pass header.i=@attacker.example; dmarc=fail header.from=acme.example;`));
  ok("a forged From with a foreign signature still fails", spoof.verified === false, spoof.reason);
});
withEnv({ ...CLEAR, TEAMMATE_DOMAIN: "acme.example" }, () => {
  ok("configured domain wins", commanderDomain("other.example") === "acme.example");
  const v = commanderAuthVerdict(inbound('"B" <b@other.example>', AR_OK("other.example")));
  ok("mail from another domain is not a commander's, however well signed", v.verified === false && /is not acme\.example/.test(v.reason), v.reason);
});

console.log("\nthe pack's closure carries none of our identity in code");
// Upstream agents/ is flat; in the pack every file sits in an agent's folder or shared/, and
// agentFile() resolves a name through the pack's generated layout. Reads go through it so a
// sweep cannot quietly open nothing.
const REPO = REPO_DIR;
const FLEET = AGENTS_DIR;
const ENTRIES = ["weekly-activity-report-worker.mjs", "fact-alignment-worker.mjs", "market-research-refresh-worker.mjs", "reply-worker.mjs", "newsletter-worker.mjs"];
/* Upstream the closure is computed the way the export computes it. In the
 * exported pack there is no exporter — the directory IS the closure. */
let closure;
/* Whether the set below is the EXACT shipped closure or an approximation of it. Upstream the
 * exporter computes it; in the pack the exporter does not ship, so the directory stands in —
 * and the directory is not the same set (it carries the tools, which nothing imports). The two
 * therefore disagree by a citation or two, which matters only for the ratchets below. */
let closureExact = true;
try {
  const { walkClosure } = await import("../../scripts/export-lib.mjs");
  closure = walkClosure({ fleetDir: FLEET, entries: ENTRIES, fail: m => { throw new Error(m); } });
} catch {
  // The layout names the seed scripts too, which the pack owns and a bare export lacks: list only
  // what is actually on disk, as the directory read this replaces did.
  const present = LAYOUT ? Object.keys(LAYOUT).filter(f => existsSync(agentFile(f))) : readdirSync(FLEET);
  closure = new Set(present.filter(f => f.endsWith(".mjs") && !f.startsWith("test-")));
  closureExact = false;
}
ok(`closure resolved (${closure.size} modules)`, closure.size > 30);
/* NOAN business lanes — the course, re-engagement, prospector, brief,
 * implementation-intake, changelog and CI-alert modules — are not among the
 * six agents and must not reach the pack. The list is BUSINESS_LANES in
 * optional-lane.mjs, the same one the exporter enforces; here it is asserted
 * in the customer's copy too. */
const { BUSINESS_LANES: LANE_MODULES } = await import("../customer-support/optional-lane.mjs");
const loaded = [...readFileSync(agentFile("reply-worker.mjs"), "utf8").matchAll(/loadLane\("([\w-]+)"/g)].map(m => m[1] + ".mjs");
const unlisted = loaded.filter(m => !LANE_MODULES.includes(m));
ok("every lane reply-worker loads is on BUSINESS_LANES", loaded.length >= 5 && unlisted.length === 0, `loaded ${loaded.length}; unlisted: ${unlisted.join(", ")}`);
const leaked = LANE_MODULES.filter(m => closure.has(m));
ok("no NOAN business lane is reachable from the six agents", leaked.length === 0, leaked.join(", "));
/* ---------------- ratchets ----------------
 * Comments citing fleet-only files exist at a known count. They are RATCHETED, not gated at
 * zero: the count may never grow, and when it falls the baseline must come down with it, so the
 * ratchet never becomes a waiver.
 *
 * Lower these numbers. Never raise one to make a build pass. */
const UNSHIPPED_BASELINE = 31;   // Lower me.

/** Fail on growth, and fail on shrinkage that was not recorded.
 *
 *  `exact` is false in the exported pack, where the shipped set is approximated from the
 *  directory rather than computed (see closureExact). The count there is genuinely a different
 *  number over a different set, so holding it to the fleet's baseline would fail the pack's CI
 *  for a figure it cannot influence — and the one constant ships to both trees, so it cannot be
 *  right in each. Growth is still caught; only the "you fixed one, record it" half is skipped,
 *  because downstream there is nothing to record it in. */
function ratchet(label, hits, baseline, { exact = true } = {}) {
  const n = hits.length;
  if (!exact) {
    ok(`${label}: ${n} (at or under the baseline of ${baseline}; not this tree's to ratchet)`, n <= baseline,
       `\n      ${hits.slice(0, 25).join("\n      ")}`);
    return;
  }
  if (n > baseline) {
    ok(`${label}: ${n} (baseline ${baseline}, must not grow)`, false,
       `\n      NEW since the baseline — fix these, do not raise the number:\n      ${hits.slice(0, 25).join("\n      ")}${n > 25 ? `\n      … ${n - 25} more` : ""}`);
  } else if (n < baseline) {
    ok(`${label}: ${n} (baseline ${baseline} is stale)`, false,
       `\n      ${baseline - n} fixed — lower the baseline to ${n} in this file so it cannot drift back.`);
  } else {
    ok(`${label}: ${n}, unchanged from the baseline`, true);
  }
}

const offenders = [];
for (const f of [...closure].sort()) offenders.push(...sweepCode(f, stripComments(readFileSync(agentFile(f), "utf8"))));
const DESIGN = DESIGN_DIR;
for (const f of ["deck.py", "park_assignees.py", "slack_pointer.py", "comment_grammar.py"]) offenders.push(...sweepCode(`design/${f}`, stripPython(readFileSync(path.join(DESIGN, f), "utf8"))));
// The scripts a worker execs ship beside it (SHIPPED_SCRIPTS), so they get the same sweep.
for (const f of SHIPPED_SCRIPTS) offenders.push(...sweepCode(f, stripPython(readFileSync(agentFile(f), "utf8"))));
ok("no shipped module names our domain, our agent, or an address in code", offenders.length === 0, "\n      " + offenders.join("\n      "));

/* Every contact create goes through createContact(), which treats a duplicate refusal as a find.
 * test-contact-create-409.mjs enforces this upstream but never ships, so this applies the same
 * rule over the pack's own closure. A raw post in a fork makes permanent duplicates that `q=`
 * will not find. */
const rawCreates = [];
for (const f of [...closure].sort()) {
  if (f === "noan.mjs") continue;   // noan.mjs IS the wrapper; its own raw POST is the legitimate one
  rawCreates.push(...sweepRawContactCreate(f, readFileSync(agentFile(f), "utf8")));
}
ok("no shipped module posts a contact create raw", rawCreates.length === 0,
   `unguarded raw POST /contacts at ${rawCreates.join(", ")} — use createContact() from noan.mjs`);
ok("…and that guard matches the shape it bans",
   sweepRawContactCreate("f.mjs", "const c = await noanPost(`/contacts`, { name });").length === 1);


/* The SHIPPED TESTS, for workspace ids only.
 *
 * The closure swept above is modules; tests are excluded from it, because test-fleet-env.mjs
 * carries the fleet's own name and domain and the DKIM fixtures in test-commander-auth.mjs are
 * our domain on purpose. Real record ids are never legitimate in a fixture, which only needs a
 * plausible SHAPE, so shipped tests are swept for ids only. */
/* Which tests ship: SHIPPED_TESTS in oss-sweeps.mjs, the one list the exporter also reads as
 * EXTRA_TESTS. Import the constant. Do not parse the exporter's source for it: a regex over
 * that file can silently match the wrong set. */
const testIds = [], testPointers = [];
for (const f of [...SHIPPED_TESTS].sort()) {
  let src; try { src = readFileSync(agentFile(f), "utf8"); } catch { continue; }
  // NOT stripComments: a fixture id and a cited id are the same disclosure, and stripping
  // first is how a comment in a shipped test went unchecked.
  for (const u of src.match(WORKSPACE_ID) || []) if (!SYNTHETIC_ID.test(u)) testIds.push(`${f} ${u}`);
  /* Pointers too: a plan doc, a fleet task id or a private issue number is no more followable
   * in a FIXTURE than in a comment.
   *
   * Names stay exempt: test-fleet-env.mjs carries the fleet's name and domain on purpose, and
   * this file has to spell "Verity" out to assert its absence. */
  src.split("\n").forEach((line, i) => {
    const p = line.match(PRIVATE_POINTER_NO_ID);
    if (p) testPointers.push(`${f}:${i + 1} ${p[0].trim()} — ${line.trim().slice(0, 80)}`);
  });
}
ok(`no shipped test carries a real workspace id (${SHIPPED_TESTS.length} tests)`, testIds.length === 0,
   `${testIds.join(", ")} — use a synthetic id (aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa); this tree ships`);
ok(`no shipped test cites private history (${SHIPPED_TESTS.length} tests)`, testPointers.length === 0,
   testPointers.length ? `\n      ${testPointers.join("\n      ")}` : "");

/* The data files too: a .json has no comments for the prose sweep and is not source for the
 * code sweep, so without this neither opens it. See sweepData for why the root docs are not on
 * this list. */
const dataHits = [];
for (const f of [...SHIPPED_ASSETS].sort()) {
  let src; try { src = readFileSync(agentFile(f), "utf8"); } catch { continue; }
  dataHits.push(...sweepData(f, src));
}
ok(`no shipped data file carries our identity or private history (${SHIPPED_ASSETS.length} files)`,
   dataHits.length === 0, dataHits.length ? `\n      ${dataHits.join("\n      ")}` : "");

/* The prose too. Comments and docblocks ship with the code, and a stranger
 * reading "re-assign Verity" or a teammate's first name is reading about a
 * company they do not work for. Code was swept above with comments stripped;
 * this is the inverse: only the comments, for the old agent name, the
 * fleet's teammates by first name, the company possessive, and the bare
 * domain (the API host is not a company reference). Python too. */
const prose = [];
/* The deck's build prompt is the one place a brand could hide as a literal —
 * a hex, a typeface, a leading token — and it ships. The resolved values live
 * in the Deck Playbook fact's "## Slide design" section (load_slide_rules);
 * the prompt keeps mechanics only. */
{
  const deckPy = readFileSync(path.join(DESIGN, "deck.py"), "utf8");
  const { promptLength, literals } = sweepDeckPrompt(deckPy);
  ok("deck.py's build prompt carries no brand literal (hex, typeface, leading token)", promptLength > 1000 && literals.length === 0, literals.join(", "));
  ok("deck.py reads the slide design rules from the Deck Playbook fact", /def load_slide_rules\(/.test(deckPy) && /## Slide design/.test(deckPy));
}
// Every Python file in the exporter's DESIGN_FILES belongs here, or its comments go unswept.
const DESIGN_PY = ["deck.py", "park_assignees.py", "slack_pointer.py", "comment_grammar.py", "agent_comment.py"]
  .map(f => path.join(DESIGN, f));
// What the pack actually contains, so a comment citing anything else is caught as a reference
// the reader cannot follow. Built from the closure rather than listed, so it tracks the export.
const SHIPPED = new Set([...closure, ...DESIGN_PY.map(f => path.basename(f)), ...SHIPPED_SCRIPTS.map(f => path.basename(f)), ...SHIPPED_TESTS, ...SHIPPED_TOOLS, "config.example.json"]);
// pointers: true. A plan doc, a fleet task id, a CI run id or an internal service name in a
// comment is as useless to a stranger as our name is, so the full pointer sweep runs here too.
for (const f of [...[...closure].sort().map(f => agentFile(f)), ...DESIGN_PY, ...SHIPPED_SCRIPTS.map(f => agentFile(f))]) prose.push(...sweepProse(path.basename(f), readFileSync(f, "utf8"), { shipped: SHIPPED, pointers: true }));
const unshipped = prose.filter(p => / unshipped /.test(p));
const strictProse = prose.filter(p => !/ unshipped /.test(p));
ok("no shipped comment speaks of our company, our agent's name, or our teammates", strictProse.length === 0,
   strictProse.length ? `\n      ${strictProse.slice(0, 25).join("\n      ")}${strictProse.length > 25 ? `\n      … ${strictProse.length - 25} more` : ""}` : "");
ratchet("comments citing files the pack does not ship", unshipped, UNSHIPPED_BASELINE, { exact: closureExact });

console.log(`\n${fail ? "FAILED" : "PASSED"}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
