#!/usr/bin/env node
/**
 * Reading contact memos in bulk, and deciding whether a stored count baseline
 * can be trusted.
 *
 * WHY THIS IS A MODULE. weekly-activity-report-worker.mjs runs a pass on load,
 * so it cannot be imported by a test. Extracting the decisions here means
 * test-weekly-report-memos.mjs drives the REAL functions rather than a mirror
 * of them — and the two properties worth testing (a failed read must not read
 * as zero, and a fake baseline must not detonate) are exactly the ones a mirror
 * would not catch.
 *
 * WHY A PER-CONTACT READ AT ALL. GET /contacts returns ContactSummary, which
 * carries no memos and no notes; only GET /contacts/{id} returns them. And the
 * Memo schema is {id, content, title?} with NO createdAt, so a memo cannot be
 * window-filtered by time the way notes, facts and assets are. Counting per
 * contact is the only way to detect new ones.
 */

import { noanGet } from "./noan.mjs";

/** Memo text for one contact, NEWEST-FIRST (the order the API returns), preferring
 *  `memos` (objects) over the deprecated `notes` (bare strings). The full Contact
 *  returns both. This comment said "oldest-first" until 2026-09-09 and that was the
 *  premise computeMemoDeltas' tail slice was built on — see the note there. */
export function memoTexts(full) {
  const c = full?.contact || full || {};
  if (Array.isArray(c.memos) && c.memos.length) return c.memos.map(m => String(m?.content ?? ""));
  return (c.notes || []).map(n => String(typeof n === "string" ? n : n?.content ?? ""));
}

/**
 * Resolve every contact's memos with bounded concurrency.
 *
 * CONCURRENCY IS 4, NOT 8, AND THAT WAS MEASURED. At 8 a live run over ~800
 * contacts lost 24 reads to HTTP 429 — and noan.mjs already retries 429 through
 * a 2/4/8/15s ladder, so those had exhausted four backoffs before giving up.
 * The ceiling is the API's rate limit, not our patience. Halving it keeps the
 * whole sweep inside the report's 15-minute budget with room to spare.
 *
 * A FAILED READ IS LEFT ABSENT, NOT RECORDED AS ZERO. Zero would read as "this
 * contact's history was replaced wholesale" on this run, and would reset their
 * stored baseline so the NEXT run reports their entire history as new. Absent
 * means unknown: such contacts are skipped and keep whatever count they had.
 */
export async function fetchMemosByContact(contacts, { concurrency = Number(process.env.MEMO_READ_CONCURRENCY || 4), get = noanGet } = {}) {
  const memosById = new Map();
  // WHY THE REASONS ARE KEPT. A first version counted failures and threw the
  // errors away, so a run reporting "24 contact read(s) failed" gave no way to
  // tell a permanent 403 from a transient 429 — the same mistake as collapsing
  // every PostHog lookup outcome into one "not found". A persistent permission
  // failure and a rate-limit blip need opposite responses, so the caller is
  // told which it had.
  const failureKinds = new Map();
  let next = 0, failures = 0;
  async function worker() {
    while (next < contacts.length) {
      const c = contacts[next++];
      try { memosById.set(c.id, memoTexts(await get(`/contacts/${c.id}`))); }
      catch (e) {
        failures++;
        const kind = e?.noan?.status ? `HTTP ${e.noan.status}` : (e?.message || "unknown").slice(0, 60);
        failureKinds.set(kind, (failureKinds.get(kind) || 0) + 1);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, contacts.length)) }, worker));
  return { memosById, failures, failureKinds };
}

/** Next run's stored counts. Starts FROM the prior baseline so a contact whose
 *  read failed keeps its old count rather than silently resetting to zero. */
export function mergeCounts(priorCounts, memosById) {
  const out = { ...priorCounts };
  for (const [id, memos] of memosById) {
    if (memos.length) out[id] = memos.length;
    else delete out[id];
  }
  return out;
}

/**
 * Whether this run must seed the baseline instead of reporting deltas.
 *
 * `isFirstRun` only catches an ABSENT state row. It does not catch the case
 * this fix was written for: state had existed for months, but every run wrote
 * `contactNoteCounts: {}` because the read was broken — the worker took
 * `c.notes` off the list sweep, where that field does not exist. Stored counts
 * were therefore all zero while live counts are finally real, so a naive first
 * corrected run would find `memos.length > 0` for every contact that has ever
 * had one and report years of history as "new this week".
 *
 * Self-limiting: once seeded, stored counts are real and this cannot fire again.
 */
export function shouldSeedBaseline({ isFirstRun, priorCounts, liveCounts }) {
  if (isFirstRun) return { seed: true, why: "first-run" };
  const priorEmpty = Object.keys(priorCounts || {}).length === 0;
  const liveHas = Object.keys(liveCounts || {}).length > 0;
  if (priorEmpty && liveHas) return { seed: true, why: "stale-baseline" };
  return { seed: false, why: null };
}

/**
 * Per-contact memo deltas against the stored baseline.
 *
 * Lives here rather than inline in the worker for the same reason the rest of
 * this module does: the worker runs a pass on load and cannot be imported, and
 * the wholesale-replacement branch below is precisely the kind of edge that
 * never gets exercised in production and so must be exercised by a test.
 *
 * `newNotes` is an array of memo strings, newest first. Nothing renders them any
 * more — Notes Captured is standalone notes only — but they are still the model's
 * evidence for themes, so which memos land in here decides what a week looks like.
 *
 * ⚠ THE NEW MEMOS ARE AT THE FRONT, NOT THE TAIL. `GET /contacts/{id}` returns memos
 * newest-first, so `slice(storedCount)` — "append-only, the tail is what's new" —
 * returned the OLDEST entries instead, and a contact with 9 memos and 2 new ones fed
 * the model their 7 oldest. The count was right, which is why this survived: deltas
 * fired on the correct weeks and merely described the wrong memos. Identical mistake
 * to `selectRecentMemos` in noan.mjs (fixed 2026-09-04); this module never got the
 * same correction. Guarded by test-weekly-report-memos.mjs.
 */
export function computeMemoDeltas({ contacts, memosById, priorCounts = {} }) {
  const deltas = [];
  for (const c of contacts) {
    const memos = memosById.get(c.id);
    if (!memos) continue;                       // read failed — unknown, not zero
    const stored = priorCounts[c.id] || 0;
    if (!memos.length && !stored) continue;     // nothing now, nothing before
    const contactName = c.name || c.alias || c.email || c.id;
    if (memos.length > stored) {
      // newest-first: the first (length - stored) entries are the new ones.
      deltas.push({ contactId: c.id, contactName, newNotes: memos.slice(0, memos.length - stored), replaced: false });
    } else if (memos.length < stored) {
      // Append-only guarantee broken — the array was replaced wholesale, so the
      // tail is not the delta and there is no honest way to compute one. Say so
      // rather than inventing a number.
      deltas.push({ contactId: c.id, contactName, newNotes: [], replaced: true });
    }
    // equal: no change this window.
  }
  return deltas;
}
