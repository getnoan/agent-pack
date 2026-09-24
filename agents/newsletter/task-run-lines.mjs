/**
 * Run lines on a NOAN task: the dated "[run <stamp>] <kind> — <url>" entries an
 * hourly agent appends to the task that tracks its failures, the "Failed N
 * times since …" tally that survives eviction, and the first-time details
 * under the 2048 cap. Generic on purpose: ci-alert.mjs (the fleet's CI-failure
 * lane) and newsletter-worker.mjs (which ships in the agent pack) both keep
 * their task ledgers this way, and the pack must not need the CI lane to do it.
 */
import { respondLineFor } from "../shared/respond-by.mjs";

export const DETAILS_CAP = 2048;

export function runUrl(env = process.env) {
  const { GITHUB_SERVER_URL: s, GITHUB_REPOSITORY: r, GITHUB_RUN_ID: id } = env;
  return s && r && id ? `${s}/${r}/actions/runs/${id}` : null;
}

export function runLine(kind, url, when = new Date()) {
  const stamp = when.toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return `[run ${stamp}] ${kind}${url ? ` — ${url}` : ""}`;
}

/** First-time details: diagnosis, fix, the run, the rows, the note. Always
 *  under the cap: the summary is what gets trimmed, never the instructions. */
export function buildDetails({ what, fix, line, summary, noteId, cap = DETAILS_CAP, lane = "ci-alert" }) {
  const head = [what, "", `How to resolve: ${fix}`, "", respondLineFor(lane), "", line].join("\n");
  const tail = noteId ? `\n\nFull report: note ${noteId}.` : "";
  let body = summary ? `\n\nChanged rows:\n${summary}` : "";
  let out = head + body + tail;
  if (out.length > cap) {
    const room = cap - head.length - tail.length - "\n\nChanged rows:\n…".length;
    body = room > 40 ? `\n\nChanged rows:\n${summary.slice(0, room)}…` : "";
    out = head + body + tail;
  }
  return out.slice(0, cap);
}

/** The running tally an hourly agent needs. Eviction destroys the oldest run
 *  lines, so the count and the first failure's stamp live in their own marker
 *  line at the top, which is never evicted. */
export const RUNS_MARKER_RX = /^Failed (\d+) times since ([^\n]+)$/m;
const RUN_STAMP_RX = /^\[run ([^\]]+)\]/m;

/** A repeat failure while the task is open: bump the tally, append the run
 *  line, and evict the OLDEST run lines first if the cap is hit. The
 *  diagnosis, the fix and the tally always stay — an agent failing every hour
 *  all night should read as "Failed 14 times since 02:00", not as fourteen
 *  lines that push the instructions off the task. */
export function appendRun(existing, line, cap = DETAILS_CAP) {
  let text = String(existing || "").trimEnd();
  const prior = text.match(RUNS_MARKER_RX);
  const since = prior ? prior[2] : (text.match(RUN_STAMP_RX)?.[1] || line.match(RUN_STAMP_RX)?.[1] || "this run");
  const marker = `Failed ${(prior ? parseInt(prior[1], 10) : 1) + 1} times since ${since}`;
  text = prior ? text.replace(RUNS_MARKER_RX, marker) : `${marker}\n\n${text}`;
  text = `${text}\n${line}`;
  while (text.length > cap) {
    const m = text.match(/^\[run [^\n]*\n?/m);
    if (!m) return text.slice(0, cap);
    text = text.replace(m[0], "");
  }
  return text;
}

/** The kind of the MOST RECENT run line in a task's details.
 *
 *  The run line is `[run <stamp>] <kind> — <url>`, so the details already
 *  carry the failure kind and no extra marker is needed. appendRun evicts the
 *  OLDEST run lines, so the newest always survives; buildDetails always writes
 *  at least one. Null when the details carry none (a hand-made task). */
export function lastKind(details) {
  const all = [...String(details || "").matchAll(/^\[run [^\]]+\]\s*([^\n—]+?)(?:\s+—\s|\s*$)/gm)];
  return all.length ? all[all.length - 1][1].trim() : null;
}

