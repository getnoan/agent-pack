/**
 * Words said in a Slack thread, carried onto a task as a comment, with who
 * said them made checkable.
 *
 * WHY THIS EXISTS. A task comment is attributed to the owner of the API key
 * that posted it. The hosted Slack app posts under the workspace owner's key,
 * so every reply it carries from a thread arrives as a comment "by" the owner,
 * whoever actually spoke. Read naively, a workspace member's "send it" becomes
 * the owner's approval of a customer email. So the comment says who spoke, and
 * proves it: an HMAC over the task id, the speaker's email, the message's
 * Slack ts and the words, keyed by the SHA-256 of the workspace's relay token.
 * The hosted app stores exactly that hash; the agents hold the token itself;
 * nobody else has either. No new secret to hand around.
 *
 * FAIL-SAFE BY SHAPE, as agent-comment.mjs is. A comment that LOOKS relayed is
 * never attributed to the key owner, whether or not it verifies: verified, it
 * belongs to the speaker; unverified, it belongs to nobody and is dropped. The
 * shape check also catches the unsigned form the hosted app wrote for a day
 * (2026-09-18), so those are dropped too rather than read as the owner's.
 *
 * Pure: no network, no state.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const RELAY_TOKEN_ENV = "VERITY_SLACK_RELAY_TOKEN";

/** Constant-time signature compare. `===` on a secret-derived digest leaks, byte by byte, how
 *  much of a forged signature was right — and this digest is the only thing standing between a
 *  workspace member and words attributed to a commander. Lengths are compared first because
 *  timingSafeEqual throws on a mismatch, and a length difference is not a secret. */
function sigEqual(expected, given) {
  const a = Buffer.from(String(expected), "utf8"), b = Buffer.from(String(given ?? ""), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
const HEAD_RX = /^(\S+@\S+) · said in Slack \(([^)\n]{0,40})\)\n/;
const TAIL_RX = /\n\[slack-relay v1 (\d+\.\d+) ([0-9a-f]{32}|unsigned)\]\s*$/;
const LEGACY_RX = /^(\S+@\S+|<@[A-Z0-9]+>) in Slack \([^)\n]{0,40}\):\n/;

const sha256hex = s => createHash("sha256").update(String(s)).digest("hex");
/** The shared key: SHA-256 of the relay token. "" when there is no token. */
export function relayKeyFromToken(token) { const t = String(token || "").trim(); return t ? sha256hex(t) : ""; }
export function relayKey(env = process.env) { return relayKeyFromToken(env[RELAY_TOKEN_ENV]); }

const sign = (key, taskId, email, ts, text) => createHmac("sha256", key).update(`${taskId}\n${email}\n${ts}\n${text}`).digest("hex").slice(0, 32);

/** The comment to post. `key` is the SHA-256 of the relay token (the hosted app's stored hash); without one the comment is marked unsigned and will steer nothing. */
export function buildRelayedComment({ taskId, email, ts, text, stamp = "", key = "" }) {
  const e = String(email || "").toLowerCase().trim(), body = String(text || "").trim(), when = String(ts || "");
  return `${e} · said in Slack (${stamp})\n${body}\n[slack-relay v1 ${when} ${key ? sign(key, taskId, e, when, body) : "unsigned"}]`;
}

/** Shape only. { relayed, legacy, email, ts, text, sig } — `relayed` is true for anything that must never be read as the key owner's own words. */
export function parseRelayed(raw) {
  const s = String(raw ?? "");
  const head = HEAD_RX.exec(s), tail = TAIL_RX.exec(s);
  if (head && tail) return { relayed: true, legacy: false, email: head[1].toLowerCase(), ts: tail[1], sig: tail[2], text: s.slice(head[0].length, tail.index).trim() };
  if (head || tail || LEGACY_RX.test(s)) return { relayed: true, legacy: true, email: "", ts: "", sig: "", text: "" };
  return { relayed: false };
}

/** { relayed, valid, reason, email, ts, text } — `valid` only when the signature matches this task, speaker, time and words. */
export function verifyRelayed(raw, taskId, key = relayKey()) {
  const p = parseRelayed(raw);
  if (!p.relayed) return { relayed: false, valid: false, reason: "not relayed" };
  if (p.legacy) return { relayed: true, valid: false, reason: "relayed from Slack without a signature" };
  if (p.sig === "unsigned") return { relayed: true, valid: false, reason: "the workspace has no relay token, so the words are unsigned" };
  if (!key) return { relayed: true, valid: false, reason: `${RELAY_TOKEN_ENV} is not set, so the speaker cannot be verified` };
  return sigEqual(sign(key, taskId, p.email, p.ts, p.text), p.sig)
    ? { relayed: true, valid: true, reason: "", email: p.email, ts: p.ts, text: p.text }
    : { relayed: true, valid: false, reason: "signature does not match this task, speaker and words" };
}
