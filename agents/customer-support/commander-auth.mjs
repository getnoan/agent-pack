/**
 * Commander authentication: the pure, testable half of reply-worker's
 * "is this really a teammate?" gate.
 *
 * From: is forgeable and COMMANDERS is a list of From addresses, so a command
 * runs only with proof from the Authentication-Results header stamped by the
 * receiving MTA. Resend Inbound runs on Amazon SES, which stamps authserv-id
 * `amazonses.com`, for example:
 *   amazonses.com; spf=pass (…); dkim=pass header.i=@example.com; dmarc=pass header.from=example.com;
 *
 * All of these are required, else NOT verified (the caller escalates it as a
 * possible spoof, so failing closed means a human reads an email):
 *
 *   1. Exactly one From header, matching the sender Resend reports, whose domain
 *      is the teammate domain (TEAMMATE_DOMAIN; unset, the From address's own domain).
 *   2. The first Authentication-Results header is SES's, and no other one claims
 *      that authserv-id. A second `amazonses.com` header fails closed. Headers from
 *      other authservs (mx.google.com on a forward) are ignored, never trusted.
 *   3. In SES's header, a `dkim=pass` whose signing domain (`header.d`, or the
 *      domain part of `header.i`) is that domain or a subdomain. Other signers
 *      alongside it are fine. A signer that merely CONTAINS the domain
 *      (`example.com.attacker.example`, `notexample.com`) is not.
 *   4. In SES's header, `dmarc=pass` with `header.from` equal to the From domain,
 *      in addition to (1) and (3). The teammate domain must publish a DMARC policy.
 *
 * Never match these as substrings of the joined header values: an attacker's own
 * DKIM pass plus a forged From satisfies independent regexes. Comments `(…)` are
 * stripped before parsing, so nothing inside one counts. The dkim-signature header
 * is no fallback: Resend truncates it to "v=1".
 *
 * Resend's header encoding, all handled by headerValues(): a header that appears
 * once is a string; one that repeats is a JSON-ENCODED STRING of an array (not a
 * native array); structured headers can be a JSON string of `[{value, params}]`.
 * A native array or `{value}` object is accepted too.
 *
 * Tests: test-commander-auth.mjs.
 */
import { teammateDomain } from "../shared/required-env.mjs";

export const RECEIVING_AUTHSERV_ID = "amazonses.com";
/** The domain a commander's mail must be signed for. TEAMMATE_DOMAIN when it is
 *  set; otherwise the From address's own domain — DKIM plus DMARC alignment
 *  then prove the sending domain, and the COMMANDERS allowlist does the
 *  authorising. No domain is built in: this file ships in the public pack. */
export function commanderDomain(fromDomain) {
  return teammateDomain() || fromDomain || null;
}

const EMAIL_RX = /([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i;

/** Every value of a header, in message order, as plain strings. */
export function headerValues(headers, name) {
  if (!headers || typeof headers !== "object") return [];
  const want = String(name).toLowerCase();
  let v;
  if (Array.isArray(headers)) {
    v = headers.filter(x => String(x?.name || "").toLowerCase() === want).map(x => x?.value);
    if (v.length === 1) v = v[0];
    else if (v.length === 0) v = undefined;
  } else {
    const key = Object.keys(headers).find(k => k.toLowerCase() === want);
    v = key === undefined ? undefined : headers[key];
  }
  return flattenHeaderValue(v);
}

function flattenHeaderValue(v) {
  if (v === undefined || v === null) return [];
  if (typeof v === "string") {
    const s = v.trim();
    if (s.startsWith("[")) {
      let parsed;
      try { parsed = JSON.parse(s); } catch { parsed = null; }
      if (Array.isArray(parsed)) return parsed.flatMap(flattenHeaderValue);
    }
    return [v];
  }
  if (Array.isArray(v)) return v.flatMap(flattenHeaderValue);
  if (typeof v === "object" && typeof v.value === "string") return [v.value];
  return [];
}

/** Drop RFC 5322 comments, including nested ones. Unbalanced parens fail closed
 *  by swallowing the rest of the line — an attacker cannot use "(" to hide a
 *  result, only to lose one. */
function stripComments(s) {
  let out = "", depth = 0;
  for (const ch of String(s)) {
    if (ch === "(") depth++;
    else if (ch === ")") { if (depth > 0) depth--; }
    else if (depth === 0) out += ch;
  }
  return out;
}

const unquote = s => s.replace(/^"(.*)"$/s, "$1");

/**
 * Parse one Authentication-Results header (RFC 8601).
 * → { authservId: string|null, results: [{ method, result, props: { "ptype.property": value } }] }
 * A header whose first clause is already a method=result (some MTAs omit the
 * authserv-id) gets authservId null.
 */
export function parseAuthResults(header) {
  const clauses = stripComments(header).split(";").map(c => c.trim()).filter(Boolean);
  const out = { authservId: null, results: [] };
  if (!clauses.length) return out;
  if (!/=/.test(clauses[0].split(/\s+/)[0])) {
    out.authservId = clauses.shift().split(/\s+/)[0].toLowerCase();
  }
  for (const clause of clauses) {
    const toks = clause.split(/\s+/).filter(Boolean);
    const m = toks[0].match(/^([a-z0-9-]+)(?:\/[0-9.]+)?=([a-z0-9-]+)$/i);
    if (!m) continue;
    const r = { method: m[1].toLowerCase(), result: m[2].toLowerCase(), props: {} };
    for (const t of toks.slice(1)) {
      const p = t.match(/^([a-z0-9-]+\.[a-z0-9-]+)=(.+)$/i);
      if (p) r.props[p[1].toLowerCase()] = unquote(p[2]).toLowerCase();
    }
    out.results.push(r);
  }
  return out;
}

const isDomainOrSub = (d, base) => d === base || d.endsWith(`.${base}`);

/** Signing domain of a dkim result: header.d, else the domain part of header.i. */
function dkimSigningDomain(r) {
  const d = r.props["header.d"];
  if (d) return d.replace(/^@/, "");
  const i = r.props["header.i"];
  if (!i) return null;
  const at = i.lastIndexOf("@");
  return at >= 0 ? i.slice(at + 1) : i;
}

/** The address in a From value. An angle-bracketed address wins over anything in
 *  the display name, so `"someone@example.com" <x@attacker.example>` is x@attacker.example. */
function bareAddress(v) {
  const s = String(v || "").trim();
  const angled = s.match(/<([^<>]+)>/);
  const m = (angled ? angled[1] : s).match(EMAIL_RX);
  return m ? m[1].toLowerCase() : null;
}

function fromDomain(full) {
  const froms = headerValues(full?.headers, "from");
  if (froms.length > 1) return { error: "more than one From header" };
  const addr = bareAddress(froms[0] ?? full?.from);
  if (!addr) return { error: "no parseable From address" };
  // the sender Resend reports at the top level must be the same address
  const top = bareAddress(full?.from);
  if (top && top !== addr) return { error: "From header and reported sender differ" };
  return { domain: addr.slice(addr.indexOf("@") + 1) };
}

/**
 * The verdict on one Resend inbound object (GET /emails/receiving/{id}).
 * → { verified: boolean, reason: string }  — reason is human-readable and
 * safe to put in an escalation email.
 */
export function commanderAuthVerdict(full, { domain = null, authservId = RECEIVING_AUTHSERV_ID } = {}) {
  const from = fromDomain(full);
  const want = domain || commanderDomain(from.domain);
  const fail = reason => ({ verified: false, reason, domain: want });
  if (from.error) return fail(from.error);
  if (from.domain !== want) return fail(`From domain ${from.domain} is not ${want}`);

  const ars = headerValues(full?.headers, "authentication-results").map(parseAuthResults);
  if (!ars.length) return fail("no Authentication-Results header on the inbound");
  const ours = ars.filter(a => a.authservId === authservId);
  if (ours.length !== 1) {
    return fail(ours.length === 0
      ? `no Authentication-Results header from ${authservId} (the receiving MTA)`
      : `${ours.length} Authentication-Results headers claim ${authservId} — ambiguous, possibly injected`);
  }
  if (ars[0] !== ours[0]) return fail(`the ${authservId} Authentication-Results header is not the first one — possibly injected`);
  const ar = ours[0];

  const dkimPass = ar.results.filter(r => r.method === "dkim" && r.result === "pass");
  const signer = dkimPass.map(dkimSigningDomain).find(d => d && isDomainOrSub(d, want));
  if (!signer) {
    const seen = ar.results.filter(r => r.method === "dkim").map(r => `${r.result}${dkimSigningDomain(r) ? ` ${dkimSigningDomain(r)}` : ""}`);
    return fail(`no dkim=pass signed by ${want}${seen.length ? ` (dkim: ${seen.join(", ")})` : " (no dkim result)"}`);
  }

  const dmarc = ar.results.filter(r => r.method === "dmarc");
  if (!dmarc.length) return fail("no dmarc result in the receiving MTA's Authentication-Results");
  const dmarcOk = dmarc.some(r => r.result === "pass" && r.props["header.from"] === from.domain);
  if (!dmarcOk) return fail(`dmarc is not pass for ${from.domain} (${dmarc.map(r => `${r.result} ${r.props["header.from"] || "?"}`).join(", ")})`);

  return { verified: true, reason: `dkim=pass ${signer}, dmarc=pass ${from.domain}, via ${authservId}`, domain: want };
}
