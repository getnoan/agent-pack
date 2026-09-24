#!/usr/bin/env node
/**
 * The commander gate: an inbound email is a teammate COMMAND only if the
 * receiving MTA proved it was signed by example.com and DMARC-aligned.
 *
 * Why this earns cover: COMMANDERS mail runs capabilities (deck, audit,
 * onboard, fact splices, task creation) with no further human in the loop.
 * Until 2026-09-10 the gate was `/dkim=pass/` AND `/example\.com/` over the
 * joined Authentication-Results value — two independent substring matches.
 * Mail signed by an attacker's own domain with a forged From: alex@example.com
 * yields `dkim=pass header.i=@attacker.example; dmarc=fail
 * header.from=example.com`, which satisfies both. The first block below keeps
 * the old function verbatim and PROVES it accepts that mail, so the weakness
 * is on record and nobody "simplifies" back to it.
 *
 * Fixtures are shaped exactly like Resend's GET /emails/receiving/{id}: a
 * `headers` object keyed by lowercase name, values plain strings, and a header
 * that repeats encoded as a JSON STRING of an array (that is what Resend does —
 * verified against 49 live inbounds on 2026-09-10; a native array is accepted
 * too). The genuine Authentication-Results lines are copied from real
 * example.com inbounds, with IPs and signatures elided.
 *
 * No network, no writes.  Run:  node test-commander-auth.mjs
 */

import "../shared/test-fleet-env.mjs";   // the fleet's own name/domain/pronouns — see that file
import { commanderAuthVerdict, parseAuthResults, headerValues } from "./commander-auth.mjs";

// The fixtures below are synthetic: a reserved domain, a documentation IP range, no real
// signature. This tree ships publicly, and a fixture only ever needed a plausible SHAPE.
// Set at call time rather than in test-fleet-env: teammateDomain() is read per verdict, and
// the shared fixture env is what every OTHER fleet test asserts its prose against.
process.env.TEAMMATE_DOMAIN = "example.com";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); } };

/* ---------- fixtures ---------- */

/** Resend inbound object. `ar` is one header value or a list of them (message
 *  order, top of message first); a list is JSON-encoded the way Resend does it. */
function inbound({ from = '"Alex Commander" <alex@example.com>', topFrom, ar, extraHeaders = {} } = {}) {
  const headers = {
    "return-path": "<bounce@example.net>",
    "received": "from mail-ej1-f69.google.com by inbound-smtp.eu-west-1.amazonaws.com with SMTP",
    "x-ses-spam-verdict": "PASS",
    "dkim-signature": "v=1",           // Resend truncates this header; real value on every live sample
    "from": from,
    "to": "agent@reply.example.com",
    "subject": "deck for acme",
    ...extraHeaders,
  };
  if (ar !== undefined) headers["authentication-results"] = Array.isArray(ar) ? JSON.stringify(ar) : ar;
  return { object: "email", id: "test", from: topFrom ?? (from.match(/<([^>]+)>/)?.[1] || from), headers, text: "deck for acme" };
}

// SES's genuine stamp on a example.com → Google Workspace → Resend inbound
const SES_GENUINE = "amazonses.com; spf=pass (spfCheck: domain of example.com designates 192.0.2.50 as permitted sender) client-ip=192.0.2.50; envelope-from=alex@example.com; helo=mail-wm1-f50.google.com; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com;";
// what Google adds when the mail was forwarded through a Google inbox first (second AR header on real inbounds)
const GOOGLE_FORWARD = "mx.google.com; dkim=pass header.i=@example.com header.s=google header.b=ELIDED; arc=pass (i=1); spf=pass (google.com: domain of alex@example.com designates 192.0.2.41 as permitted sender) smtp.mailfrom=alex@example.com; dmarc=pass (p=QUARANTINE sp=NONE dis=NONE) header.from=example.com; dara=neutral header.i=@example.com";
// attacker: their own DKIM passes, DMARC fails for the forged From domain
const SES_ATTACKER = "amazonses.com; spf=pass (spfCheck: domain of attacker.example designates 203.0.113.9 as permitted sender) client-ip=203.0.113.9; envelope-from=x@attacker.example; helo=mail.attacker.example; dkim=pass header.i=@attacker.example; dmarc=fail header.from=example.com;";
// what SES actually stamps when the signature does not verify
const SES_DKIM_FAIL = "amazonses.com; spf=fail (spfCheck: domain of example.com does not designate 203.0.113.9 as permitted sender) client-ip=203.0.113.9; envelope-from=alex@example.com; helo=mail.attacker.example; dkim=fail header.i=@example.com; dmarc=fail header.from=example.com;";
// an attacker-authored header that looks exactly like SES's genuine one
const FORGED_SES = "amazonses.com; spf=pass client-ip=192.0.2.50; envelope-from=alex@example.com; helo=mail-wm1-f50.google.com; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com;";

/* ---------- 1. the weakness, on record ---------- */

/** reply-worker.mjs dkimVerified() as it stood before 2026-09-10, verbatim. */
function legacyHeaderValue(full, name) {
  const h = full?.headers;
  if (!h) return "";
  const v = typeof h === "object" && !Array.isArray(h)
    ? h[name] ?? h[name.toLowerCase()]
    : (Array.isArray(h) ? h.find(x => (x.name || "").toLowerCase() === name)?.value : null);
  if (Array.isArray(v)) return v.map(x => (typeof x === "string" ? x : x?.value || JSON.stringify(x))).join(" ");
  return typeof v === "string" ? v : v ? JSON.stringify(v) : "";
}
function legacyDkimVerified(full) {
  const ar = legacyHeaderValue(full, "authentication-results");
  const dkimSig = legacyHeaderValue(full, "dkim-signature");
  const pass = /dkim=pass/i.test(ar);
  const ourDomain = /example\.com/i.test(ar) || /"?d"?[:=]"?example\.com/i.test(dkimSig);
  return pass && ourDomain;
}

console.log("the pre-2026-09-10 check accepted spoofed mail (weakness confirmed, kept on record)");
ok("legacy: genuine example.com mail passed", legacyDkimVerified(inbound({ ar: SES_GENUINE })) === true);
ok("legacy: attacker-domain dkim=pass + dmarc=fail header.from=example.com ALSO passed",
  legacyDkimVerified(inbound({ ar: SES_ATTACKER })) === true);
ok("legacy: dkim=fail with a (dkim=pass header.i=@example.com) comment ALSO passed",
  legacyDkimVerified(inbound({ ar: SES_DKIM_FAIL.replace("dkim=fail", "dkim=fail (dkim=pass header.i=@example.com)") })) === true);
ok("legacy: a forged second Authentication-Results header ALSO passed",
  legacyDkimVerified(inbound({ ar: [SES_DKIM_FAIL, FORGED_SES] })) === true);

/* ---------- 2. genuine mail still verifies ---------- */

console.log("genuine example.com mail verifies");
let v = commanderAuthVerdict(inbound({ ar: SES_GENUINE }));
ok("SES dkim=pass header.i=@example.com + dmarc=pass → verified", v.verified === true, v.reason);
v = commanderAuthVerdict(inbound({ ar: [SES_GENUINE, GOOGLE_FORWARD] }));
ok("forwarded through Google (two AR headers, SES first) → verified", v.verified === true, v.reason);
v = commanderAuthVerdict(inbound({ ar: SES_GENUINE.replace("dkim=pass header.i=@example.com;", "dkim=pass header.i=@amazonses.com; dkim=pass header.i=@example.com;") }));
ok("SES-relayed mail with amazonses.com AND example.com signers → verified", v.verified === true, v.reason);
v = commanderAuthVerdict(inbound({ ar: SES_GENUINE.replace("header.i=@example.com", "header.d=mail.example.com") }));
ok("signed by a example.com subdomain (header.d) → verified", v.verified === true, v.reason);
v = commanderAuthVerdict(inbound({ ar: SES_GENUINE.replace("header.i=@example.com", "header.i=alex@example.com") }));
ok("header.i with a local part → verified", v.verified === true, v.reason);
v = commanderAuthVerdict(inbound({ from: "sam@example.com", ar: SES_GENUINE.replace(/alex@/g, "sam@") }));
ok("bare From address (no display name) → verified", v.verified === true, v.reason);
v = commanderAuthVerdict(inbound({ ar: SES_GENUINE.replace("amazonses.com;", "AmazonSES.com 1;") }));
ok("authserv-id case and version suffix tolerated → verified", v.verified === true, v.reason);
{ const full = inbound({ ar: SES_GENUINE }); full.headers["authentication-results"] = [SES_GENUINE, GOOGLE_FORWARD];
  v = commanderAuthVerdict(full);
  ok("a native array of header values (should Resend change encoding) → verified", v.verified === true, v.reason); }

/* ---------- 3. spoofs fail, and fail closed ---------- */

console.log("attacker-domain DKIM pass with forged From fails");
v = commanderAuthVerdict(inbound({ ar: SES_ATTACKER }));
ok("dkim=pass header.i=@attacker.example + dmarc=fail header.from=example.com → NOT verified", v.verified === false, v.reason);
ok("…and the reason names the signer", /attacker\.example/.test(v.reason), v.reason);
v = commanderAuthVerdict(inbound({ ar: SES_ATTACKER.replace("dmarc=fail", "dmarc=pass") }));
ok("same, even with dmarc=pass claimed (no example.com signer) → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ ar: SES_ATTACKER.replace("header.i=@attacker.example", "header.i=@example.com.attacker.example") }));
ok("signer example.com.attacker.example (prefix trick) → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ ar: SES_ATTACKER.replace("header.i=@attacker.example", "header.i=@notexample.com") }));
ok("signer notexample.com (suffix trick) → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ ar: SES_ATTACKER.replace("header.i=@attacker.example", "header.d=attacker.example header.i=@example.com") }));
ok("header.d=attacker.example outranks a claimed header.i=@example.com → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ ar: SES_DKIM_FAIL }));
ok("dkim=fail header.i=@example.com → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ ar: SES_DKIM_FAIL.replace("dkim=fail", "dkim=fail (dkim=pass header.i=@example.com)") }));
ok("dkim=pass inside a comment does not count → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ ar: SES_DKIM_FAIL.replace("dkim=fail", "dkim=fail (dkim=pass header.i=@example.com") }));
ok("unbalanced comment swallows the rest, never reveals a pass → NOT verified", v.verified === false, v.reason);

console.log("a spoofed extra Authentication-Results header fails");
v = commanderAuthVerdict(inbound({ ar: [SES_DKIM_FAIL, FORGED_SES] }));
ok("SES says fail, attacker appends a header claiming amazonses.com → NOT verified", v.verified === false, v.reason);
ok("…reason says ambiguous/injected", /ambiguous|injected/.test(v.reason), v.reason);
v = commanderAuthVerdict(inbound({ ar: [FORGED_SES, SES_DKIM_FAIL] }));
ok("two amazonses.com headers, forged one first → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ ar: [SES_DKIM_FAIL, GOOGLE_FORWARD] }));
ok("SES says fail, a non-SES header says pass → NOT verified (only SES is trusted)", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ ar: [GOOGLE_FORWARD] }));
ok("only a mx.google.com header, none from SES → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ ar: ["attacker.example; dkim=pass header.i=@example.com; dmarc=pass header.from=example.com", SES_GENUINE] }));
ok("SES's header not first (something sits above the receiving MTA's stamp) → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ ar: "dkim=pass header.i=@example.com; dmarc=pass header.from=example.com;" }));
ok("header with no authserv-id at all → NOT verified", v.verified === false, v.reason);

console.log("no or unusable Authentication-Results fails");
v = commanderAuthVerdict(inbound({}));
ok("no Authentication-Results header → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ ar: "" }));
ok("empty Authentication-Results → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict({ from: "alex@example.com" });
ok("no headers object at all → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict(null);
ok("null inbound → NOT verified, no throw", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ ar: "amazonses.com; spf=pass; dkim=none; dmarc=none header.from=example.com;" }));
ok("dkim=none → NOT verified", v.verified === false, v.reason);
ok("…reason says no dkim=pass", /no dkim=pass/.test(v.reason), v.reason);

console.log("DMARC and From alignment");
v = commanderAuthVerdict(inbound({ ar: SES_GENUINE.replace("dmarc=pass", "dmarc=fail") }));
ok("dkim=pass example.com but dmarc=fail → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ ar: SES_GENUINE.replace(" dmarc=pass header.from=example.com;", "") }));
ok("dkim=pass example.com but no dmarc result at all → NOT verified (fail closed)", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ ar: SES_GENUINE.replace("header.from=example.com", "header.from=attacker.example") }));
ok("dmarc=pass for a different domain than From → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ from: '"Alex Commander" <alex@example.com.attacker.example>', ar: SES_GENUINE }));
ok("From domain example.com.attacker.example with a genuine-looking SES line → NOT verified", v.verified === false, v.reason);
v = commanderAuthVerdict(inbound({ from: '"alex@example.com" <alex@attacker.example>', topFrom: "alex@attacker.example", ar: SES_GENUINE }));
ok("display name alex@example.com, real address elsewhere → NOT verified on the From domain", v.verified === false && /attacker\.example is not/.test(v.reason), v.reason);
v = commanderAuthVerdict(inbound({ from: "alex@example.com", topFrom: "x@attacker.example", ar: SES_GENUINE }));
ok("From header and Resend's reported sender disagree → NOT verified", v.verified === false, v.reason);
{ const full = inbound({ ar: SES_GENUINE }); full.headers.from = JSON.stringify(["x@attacker.example", "alex@example.com"]);
  v = commanderAuthVerdict(full);
  ok("two From headers → NOT verified", v.verified === false, v.reason); }
v = commanderAuthVerdict(inbound({ from: "", ar: SES_GENUINE }));
ok("no parseable From → NOT verified", v.verified === false, v.reason);

/* ---------- 4. the parsers ---------- */

console.log("parseAuthResults / headerValues");
{ const p = parseAuthResults(SES_GENUINE);
  ok("authserv-id parsed", p.authservId === "amazonses.com", p.authservId);
  ok("methods in order", p.results.map(r => r.method).join(",") === "spf,dkim,dmarc", p.results.map(r => r.method).join(","));
  ok("props keyed ptype.property, lowercased", p.results[1].props["header.i"] === "@example.com" && p.results[2].props["header.from"] === "example.com");
  ok("spf's parenthesised reason stripped, its result kept", !JSON.stringify(p).includes("spfCheck") && p.results[0].result === "pass");
}
{ const p = parseAuthResults("dkim=none  header.d=none;dmarc=none action=none header.from=seedgrowthco.com;");
  ok("header without authserv-id → authservId null, results still parsed", p.authservId === null && p.results.length === 2); }
{ const p = parseAuthResults('amazonses.com; dkim/1=pass header.d="example.com"');
  ok("method version suffix and quoted value handled", p.results[0].method === "dkim" && p.results[0].props["header.d"] === "example.com"); }
ok("JSON-string-encoded repeat → two values, in order",
  JSON.stringify(headerValues({ "authentication-results": JSON.stringify(["a; x=y", "b; x=y"]) }, "Authentication-Results")) === JSON.stringify(["a; x=y", "b; x=y"]));
ok("[{value,params}] structured encoding → value strings",
  JSON.stringify(headerValues({ "dkim-signature": JSON.stringify([{ value: "v=1", params: { d: "example.com" } }]) }, "dkim-signature")) === JSON.stringify(["v=1"]));
ok("a plain string that merely starts with [ stays a string",
  JSON.stringify(headerValues({ subject: "[deck] acme" }, "subject")) === JSON.stringify(["[deck] acme"]));
ok("array-of-{name,value} headers shape → values", JSON.stringify(headerValues([{ name: "From", value: "a@b.co" }], "from")) === JSON.stringify(["a@b.co"]));
ok("missing header → []", headerValues({}, "authentication-results").length === 0);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
