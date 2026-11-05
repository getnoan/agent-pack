#!/usr/bin/env node
/**
 * One-time setup for the NEWSLETTER agent: the two tags it reads and its ledger.
 *
 * Idempotent: an existing tag or ledger is left alone. Unlike the other seed
 * scripts this writes no facts, because no model reads instructions here.
 *
 * Run:  node --env-file=.env seed-newsletter.mjs
 */

import { pathToFileURL } from "node:url";
import { findTagId, noanPost } from "../shared/noan.mjs";
import { seedLocalState } from "../shared/state-local.mjs";

const TAGS = {
  Newsletter: "For assets only. Marks an asset as a newsletter issue the newsletter agent may send. Its title is the subject, its description the headline, its text the body.",
  Unsubscribed: "Hard stop for every bulk send. Your unsubscribe page applies it when a contact clicks the link in an issue. Agents never remove it; a person may, only at the contact's own request.",
};

export async function seedNewsletter({ log = console.log } = {}) {
  for (const [name, usageInstructions] of Object.entries(TAGS)) {
    if (await findTagId(name)) { log(`tag "${name}" exists`); continue; }
    await noanPost("/tags", { name, usageInstructions });
    log(`created tag "${name}"`);
  }
  const ledger = seedLocalState("newsletter", { sent: {}, tested: {}, issues: [] });
  log(`${ledger.created ? "created" : "found"} ledger ${ledger.file}`);
}

const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entry && import.meta.url === entry) {
  seedNewsletter().catch((e) => { console.error(e?.message || e); process.exit(1); });
}
