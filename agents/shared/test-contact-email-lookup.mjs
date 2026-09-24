#!/usr/bin/env node
/**
 * A contact lookup by EMAIL must go through findContactByEmail(), never a raw
 * `GET /contacts?q=<address>`.
 *
 * `q=` matches `name` only — it never reads `email`. So an email search returns
 * a 200 with zero items for a contact that plainly exists, which is
 * indistinguishable from "no such contact". Measured 2026-09-04 over 40 random
 * live contacts looked up by their own address: 15 missed, 38%.
 *
 * It looks like it works, which is why it spread to nine call sites: a hit
 * happens when the address fuzzy-matches the NAME, so contacts our own capture
 * surfaces created (named `email.split("@")[0]`) match themselves. Everyone
 * else's contacts don't.
 *
 * Each miss is a duplicate contact — and on the website chat it was worse:
 * `isSubscriber` came from this lookup, so a missed subscriber got the prospect
 * script with the support path switched off.
 *
 * The fix already existed in voice-web/auth.mjs (found there 2026-08-11) and sat
 * private to the investor sign-in gate while the rest of the fleet kept the
 * broken call. That is the failure this file exists to stop repeating — same
 * spirit as test-note-char-cap.mjs.
 *
 * Run:  node test-contact-email-lookup.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { agentDirs, REPO_DIR } from "./pack-paths.mjs";
import { findContactByEmail, findOrCreateContactByEmail, looksLikeEmail, searchContacts } from "./noan.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); } };

console.log("contact lookup by email");

// --- the helpers exist and are shaped as callers expect -------------------
ok("findContactByEmail is exported", typeof findContactByEmail === "function");
ok("findOrCreateContactByEmail is exported", typeof findOrCreateContactByEmail === "function");
ok("searchContacts is exported", typeof searchContacts === "function");

// --- looksLikeEmail: the discriminator the search tools branch on ---------
for (const s of ["a@b.co", "Ada.Lovelace+tag@example.com", "ac@acme.example"]) {
  ok(`looksLikeEmail(${JSON.stringify(s)})`, looksLikeEmail(s) === true);
}
for (const s of ["Ada Lovelace", "Acme Industrial Group Ltd", "acmeindustrial", "", null, undefined, "a@b", "a b@c.co"]) {
  ok(`!looksLikeEmail(${JSON.stringify(s)})`, looksLikeEmail(s) === false);
}
ok("surrounding whitespace does not change the verdict", looksLikeEmail("  a@b.co  ") === true);

// --- findOrCreateContactByEmail refuses a non-address without writing -----
// A bad needle must fail loudly here rather than POST a junk contact whose
// name is the whole malformed string.
let threw = false;
try { await findOrCreateContactByEmail("Ada Lovelace"); } catch { threw = true; }
ok("findOrCreateContactByEmail rejects a non-email needle", threw);

// --- source guard: no raw email lookups anywhere in the fleet -------------
/* Matches a `/contacts?q=${...}` whose interpolated expression names an
 * address (email / mail / recipient / `to`). A name lookup is legitimate and
 * must keep passing — precog's name fallback and worker.mjs's id/name lookups
 * are the deliberate survivors. */
const RAW_Q = /\/contacts\?q=\$\{[^}]*\b(e?mail|address|recipient|realTo)\b[^}]*\}/i;

const ALLOWED = new Set([
  "noan.mjs",                      // defines the helpers; documents the trap
  "test-contact-email-lookup.mjs", // this file
]);

/* Scan the sibling surfaces too, not just agents/. The bug's own fix was born
 * in voice-web/auth.mjs and stayed there — a guard that only reads this
 * directory would have missed the very file that knew better. */
/* agents/ itself is every directory agentDirs() names: one upstream, one per agent in the pack,
 * where "." would be only the folder this test happens to sit in. */
const OWN = agentDirs();
const DIRS = [...OWN, path.join(REPO_DIR, "voice-web"), path.join(REPO_DIR, "fda")];

const offenders = [];
for (const dir of DIRS) {
  let entries;
  try { entries = readdirSync(dir); } catch { continue; }   // optional surface
  const own = OWN.includes(dir);
  for (const f of entries.filter(f => f.endsWith(".mjs")).sort()) {
    if (own && ALLOWED.has(f)) continue;
    const src = readFileSync(path.join(dir, f), "utf8");
    for (const [i, line] of src.split("\n").entries()) {
      if (RAW_Q.test(line)) offenders.push(`${own ? "" : path.basename(dir) + "/"}${f}:${i + 1}`);
    }
  }
}
ok("no worker looks a contact up by email through a raw ?q=",
   offenders.length === 0,
   offenders.length ? `use findContactByEmail() instead — ${offenders.join(", ")}` : "");

// The guard has to be able to fail, or it is decoration.
ok("the guard actually matches the shape it bans",
   RAW_Q.test('const r = await noanGet(`/contacts?q=${encodeURIComponent(lead.email)}&per_page=10`);'));
ok("the guard leaves name lookups alone",
   !RAW_Q.test('const r = await noanGet(`/contacts?q=${encodeURIComponent(nameFromTitle)}&per_page=10`);'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
