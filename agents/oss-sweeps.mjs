/**
 * The sweeps that decide whether a module is generic enough to ship in the
 * open-source agent pack. ONE implementation, used by three readers:
 *   - test-generic-config.mjs, which ships with the pack and runs downstream
 *   - scripts/oss-readiness.mjs, run upstream against a candidate before export
 *   - anything else that needs to say "this file names our company"
 *
 * Every pattern here was paid for once (OPEN-SOURCING-AN-AGENT.md §4). Adding a
 * pattern here adds it to every reader; do not copy one into a test.
 */

/** JS: blank out block and line comments, keeping line numbers. */
export const stripComments = src =>
  src.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, " ")).split("\n").map(l => l.replace(/(^|\s)\/\/.*$/, "")).join("\n");

/** Python: blank out # comments and triple-quoted docstrings, keeping line numbers. */
export const stripPython = src =>
  src.replace(/"""[\s\S]*?"""/g, m => m.replace(/[^\n]/g, " ")).split("\n").map(l => l.replace(/(^|\s)#.*$/, "")).join("\n");

/** The inverse: only the comments (JS block/line, Python docstrings/#), as [line, text]. */
export const onlyComments = src => {
  const out = [];
  for (const m of src.matchAll(/\/\*[\s\S]*?\*\//g)) out.push([src.slice(0, m.index).split("\n").length, m[0]]);
  for (const m of src.matchAll(/"""[\s\S]*?"""/g)) out.push([src.slice(0, m.index).split("\n").length, m[0]]);
  src.split("\n").forEach((l, n) => { const c = l.match(/(?:^|\s)(\/\/.*|#.*)$/); if (c && !/https?:\/\/[^\s]*#/.test(l)) out.push([n + 1, c[1]]); });
  return out;
};

export const ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** RFC 2606 documentation domains, Resend's inbound domain, and template placeholders. */
export const RESERVED = /@(?:[A-Za-z0-9.-]+\.)?(?:example\.(?:com|net|org)|invalid|test|localhost)\b|@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.example(?![A-Za-z0-9.-])|\.resend\.app$|@\{|\$\{/i;
/** In comments: the old agent name, the fleet's teammates by first name, the company possessive, the bare domain. */
export const PROSE = /\bVerity\b|\bNeal\b|\bDan\b|\bHope\b|\bEmre\b|\bNOAN's\b|(?<![\w.])getnoan\.com/;
/** In code: a brand literal that has no business in a shipped prompt. */
export const BRAND_LITERAL = /#[0-9a-fA-F]{6}\b|\bTusker\b|\bInter\b|\bAktiv\b|leading-(?:tight|relaxed)/g;
/** A bare UUID: a row id out of SOMEONE's workspace. Generic code never needs one — in a
 *  stranger's project every such id 404s, so it is dead weight that also ships our internals.
 *  The nil UUID is the documented placeholder and is allowed.
 *
 *  ONE source, spliced into both passes below. Written out twice it drifted immediately: the
 *  prose copy shipped without the nil-UUID exemption, so the same placeholder was legal in code
 *  and a private pointer in a comment. */
const UUID = String.raw`\b(?!00000000-0000-0000-0000-000000000000\b)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b`;
export const WORKSPACE_ID = new RegExp(UUID, "gi");

/** The synthetic form a fixture may use: ONE repeated hex character throughout, with the version
 *  and variant nibbles (4, 8) in their required places — `cccccccc-cccc-4ccc-8ccc-cccccccccccc`.
 *
 *  Deliberately the WHOLE id, not just the first group. `^(.)\1{7}-` let `11111111-` carry an
 *  arbitrary real tail, so an id could look synthetic at a glance and be anything at all. */
export const SYNTHETIC_ID = /^([0-9a-f])\1{7}-\1{4}-4\1{3}-8\1{3}-\1{12}$/i;

/** The fleet tests the pack ships, so a comment may cite them. ONE list: the exporter reads it
 *  as EXTRA_TESTS, and the shipped sweep reads it to know what a pack reader can actually open.
 *  It lives in this module because this is the sweep's own knowledge AND this module ships —
 *  the exporter does not, so the shipped copy could not import it from there. Written out twice
 *  it would drift, and the drift is silent: a citation to a shipped test would read as an
 *  offence, and a reviewer "fixing" it deletes a pointer the reader could have followed. That
 *  happened while this rule was being written — three valid citations were rewritten before the
 *  list was complete. */
/** The design/ files the pack ships. Here for the same reason as SHIPPED_TESTS: the sweeps need
 *  to know what a pack reader can open, and importing the exporter to ask it RUNS the export —
 *  it has no main guard, so `await import(...)` of it performed a full export as a side effect
 *  of a readiness check. Found by test-oss-readiness.mjs, which is exactly its job. */
export const DESIGN_FILES = [
  "deck.py", "park_assignees.py", "slack_pointer.py", "comment_grammar.py", "agent_comment.py",
  "config.example.json",
];

/** The tools the pack ships beside the agents. Here for the same reason as SHIPPED_TESTS and
 *  DESIGN_FILES: nothing imports them, so the closure walk never reaches them, and a sweep that
 *  does not know they ship reads a comment citing one as a reference the reader cannot follow.
 *  One list, in the module that ships, so the exporter and the sweeps cannot disagree. */
export const SHIPPED_TOOLS = ["grounding-check.mjs", "oss-sweeps.mjs"];

/** The data files the agents read at run time. Here for the reason SHIPPED_TESTS, DESIGN_FILES
 *  and SHIPPED_TOOLS are here: the exporter needs the list (as ASSETS, pre-flighted so a missing
 *  one aborts the export) and so does the shipped sweep, and the exporter does not ship — so the
 *  shipped copy could not import it from there. Written out twice it drifts silently, and the
 *  drift that matters is a file the exporter ships and the sweep does not know to open. */
export const SHIPPED_ASSETS = ["comment-grammar.json", "agent-comment-marker.json"];

export const SHIPPED_TESTS = [
  "test-fleet-env.mjs", "test-generic-config.mjs", "test-optional-lane.mjs", "test-grounding-check.mjs",
  "test-commander-auth.mjs", "test-contact-email-lookup.mjs", "test-contact-memos-order.mjs",
  "test-noan-getall-filters.mjs", "test-resend-env-guard.mjs", "test-support-scan.mjs",
  "test-fact-alignment-notes-scan.mjs", "test-fact-alignment-capture-intake.mjs",
  "test-weekly-report-memos.mjs", "test-weekly-report-notes-section.mjs",
  "test-llm-endpoint-config.mjs", "test-deck-model-endpoint.mjs",
];

/** Pointers into private history that mean nothing to a stranger, WITHOUT the id half.
 *  Split out because the readers differ. A comment sweep wants both halves; the shipped-test
 *  sweep runs ids separately, with the synthetic-fixture exemption — `aaaaaaaa-aaaa-4aaa-8aaa-…`
 *  is a legal fixture and must not read as a pointer — and a data file gets the same treatment.
 *
 *  ONE source, spliced into both, for the reason UUID is spliced rather than written twice:
 *  the copies drift, and the weaker of the two is always the one that ships. */
const POINTERS = String.raw`(?<![\w:;#])#\d{3,4}\b(?![0-9a-fA-F;'"])|fleet loop task|\b[A-Z][A-Z0-9-]+-PLAN\.md\b|VERITY-AGENT-STANDARD|AGENT-IDENTITY-STANDARD|\b(?:notes?|tasks?) [0-9a-f]{8}\b|getnoan\/[a-z-]+#\d+|\bcommit [0-9a-f]{7,40}\b|\(\s*[0-9a-f]{7,40}\s*\)`;
export const PRIVATE_POINTER_NO_ID = new RegExp(POINTERS);
/** Pointers into private history that mean nothing to a stranger. */
export const PRIVATE_POINTER = new RegExp(POINTERS + "|" + UUID);

/** A contact create that bypasses createContact(). Lives here, not in a test, because TWO
 *  readers need it: test-contact-create-409.mjs upstream, which also reads fleet-only paths
 *  (slack-hosted/) and therefore cannot ship, and test-generic-config.mjs, which does ship and
 *  is the only place the rule can be enforced downstream. noan.mjs promised that guard in a
 *  docblock a pack reader can see, where it did not exist. */
export const RAW_CREATE = /(?:noanPost|\braw\.post|\bapi\.post|deps\.noanPost)\(\s*[`"']\/contacts(?:\?[^`"']*)?[`"']\s*,/;

/** A multi-tenant client that cannot import noan.mjs may handle the refusal inline instead.
 *  Allowed only when the handling is actually there: "a 409 within a few lines of the post",
 *  never "this file is special". */
export const handles409 = (lines, i) => lines.slice(i, i + 7).some(l => /\b409\b/.test(l));

/** Offending line numbers in one file, as `name:line`. `noan.mjs` is the wrapper itself and
 *  its own raw POST is the one legitimate call, so callers skip it. */
export function sweepRawContactCreate(name, src) {
  const out = [], lines = src.split("\n");
  lines.forEach((line, i) => {
    if (!RAW_CREATE.test(line.replace(/(^|\s)\/\/.*$/, ""))) return;
    if (handles409(lines, i)) return;
    out.push(`${name}:${i + 1}`);
  });
  return out;
}

/** Code sweep of one file's source (comments already stripped by the caller's language). */
export function sweepCode(name, code) {
  const out = [];
  // The file that defines the patterns necessarily spells them out; it ships, and it is not an offender.
  if (/oss-sweeps\.mjs$/.test(name)) return out;
  for (const [i, line] of code.split("\n").entries()) {
    if (/getnoan\.com/.test(line) && !/api\.getnoan\.com\/v1/.test(line)) out.push(`${name}:${i + 1} getnoan.com — ${line.trim().slice(0, 90)}`);
    if (/\bVerity\b/.test(line)) out.push(`${name}:${i + 1} Verity — ${line.trim().slice(0, 90)}`);
    // required-env.mjs is the one place the old VERITY_* names are read, as the fallback behind AGENT_*.
    // NOTE: this matches only `process.env.VERITY_`. The destructured form (`env.VERITY_SLACK_RELAY_URL`)
    // and the name-as-a-string form (`"VERITY_SLACK_RELAY_TOKEN"`) both read the same variable and both
    // pass. Broadening it to the NAME is correct and was measured (9 hits, 4 lines, all in the Slack
    // relay), but it cannot land alone: those names are a live contract with the hosted Slack app, so
    // the detection has to travel with the AGENT_*-with-VERITY_*-fallback rename. Deliberately left
    // narrow here rather than broadened-and-waived, which would read as "checked" when it is not.
    if (/process\.env\.VERITY_/.test(line) && !/required-env\.mjs$/.test(name)) out.push(`${name}:${i + 1} VERITY_ env — ${line.trim().slice(0, 90)}`);
    for (const a of line.match(ADDRESS) || []) if (!RESERVED.test(a) && !/@\$\{|\$\{/.test(line)) out.push(`${name}:${i + 1} address ${a}`);
    for (const u of line.match(WORKSPACE_ID) || []) out.push(`${name}:${i + 1} workspace id ${u}`);
  }
  return out;
}

/** Prose sweep of one file's source: comments and docstrings only. */
export function sweepProse(name, src, { pointers = false, shipped = null } = {}) {
  const out = [];
  if (/oss-sweeps\.mjs$/.test(name)) return out;   // same reason as sweepCode: this file spells the patterns out
  for (const [line, text] of onlyComments(src)) {
    const hit = text.match(PROSE); if (hit) out.push(`${name}:${line} ${hit[0]} — ${text.trim().slice(0, 80)}`);
    // A row id in a COMMENT is the same disclosure as one in code, and it is exactly how the
    // usage-log.mjs session id reached the pack: truncated so no pattern matched, in a comment so
    // the code sweep never looked. Unconditional, unlike the rest of PRIVATE_POINTER — plan docs
    // and PR numbers are noisy enough to stay behind `pointers`, an id never is.
    const uid = text.match(WORKSPACE_ID); if (uid) out.push(`${name}:${line} workspace id ${uid[0]}`);
    // An address in a comment reaches a stranger exactly as an address in code does, and the code
    // sweep cannot see it: it runs on comment-stripped source. Same RESERVED exemption, so the
    // documentation domains an example needs stay legal.
    for (const a of text.match(ADDRESS) || []) if (!RESERVED.test(a)) out.push(`${name}:${line} address ${a}`);
    if (pointers) { const p = text.match(PRIVATE_POINTER); if (p) out.push(`${name}:${line} pointer ${p[0].trim()} — ${text.trim().slice(0, 80)}`); }
    // A comment that cites a file the reader does not have. Worse than useless when the citation
    // is a PROMISE: noan.mjs told a pack reader that test-general-tools-comments.mjs enforced the
    // details rule, and that test does not ship — a guard claimed where none exists. Keyed off the
    // exporter's own closure rather than a list of fleet-only names, so it cannot go stale: a file
    // that starts or stops shipping changes this sweep's answer with no edit here.
    for (const ref of unshippedRefs(text, shipped)) {
      out.push(`${name}:${line} unshipped ${ref} — ${text.trim().slice(0, 80)}`);
    }
  }
  return out;
}

/** Data files the agents read at run time (JSON). Nothing swept them, and the hole is
 *  structural rather than a missing pattern: sweepProse reads comments, and a .json has no
 *  comment syntax; sweepCode reads comment-stripped SOURCE, which a .json is not. So
 *  `comment-grammar.json` carried a fleet task pointer in its `_readme` array straight through
 *  the first public export, with `fleet loop task` already in PRIVATE_POINTER and matching it.
 *
 *  Every line is content here, so there is no comment/code split to make — one pass, both
 *  halves' patterns. Deliberately NOT extended to README.md / SECURITY.md: those are
 *  DOWNSTREAM_OWNED, written by and for the pack's publisher, and naming that publisher (and
 *  carrying its security contact) is the whole point of them. */
export function sweepData(name, src) {
  const out = [];
  for (const [i, line] of src.split("\n").entries()) {
    const p = line.match(PRIVATE_POINTER_NO_ID);
    if (p) out.push(`${name}:${i + 1} pointer ${p[0].trim()} — ${line.trim().slice(0, 80)}`);
    for (const u of line.match(WORKSPACE_ID) || []) if (!SYNTHETIC_ID.test(u)) out.push(`${name}:${i + 1} workspace id ${u}`);
    for (const a of line.match(ADDRESS) || []) if (!RESERVED.test(a)) out.push(`${name}:${i + 1} address ${a}`);
    const pr = line.match(PROSE);
    if (pr) out.push(`${name}:${i + 1} ${pr[0]} — ${line.trim().slice(0, 80)}`);
  }
  return out;
}

/** Files and agents named in prose that the pack does not contain. `shipped` is the set of
 *  basenames the export ships; null disables the check (callers without a closure to hand).
 *
 *  A path is reduced to its basename, so `fda/server.mjs` is judged as `server.mjs` — the
 *  directory is fleet-only too, and a pack reader has neither. */
export function unshippedRefs(text, shipped) {
  if (!shipped) return [];
  const out = new Set();
  for (const m of text.match(/\b[\w.-]+\.(?:mjs|py)\b/g) || []) {
    if (!shipped.has(m)) out.add(m);
  }
  // ONLY explicit filenames. A bare agent name ("voice-agent") was tried and removed: deciding
  // whether such a token names a real module meant reading the agents directory, and that
  // directory is DIFFERENT in the fleet and in the pack — the same tree scored 60 upstream and
  // 34 downstream, so no single baseline could hold and the ratchet failed wherever it was not
  // measured. An environment-dependent count is not a ratchet. The filename spelling is the
  // common one and the one that produced the guard-that-does-not-ship case; bare names are left
  // to review, which is where they were caught in the first place.
  return [...out];
}

/** The deck prompt: mechanics only, no brand literal. Returns the literals found. */
export function sweepDeckPrompt(deckPy) {
  const start = deckPy.indexOf("def build_prompt("), end = deckPy.indexOf("# RETURN (read carefully", start);
  const prompt = start >= 0 && end > start ? deckPy.slice(start, end) : "";
  return { promptLength: prompt.length, literals: [...prompt.matchAll(BRAND_LITERAL)].map(m => m[0]) };
}
