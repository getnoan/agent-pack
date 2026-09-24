#!/usr/bin/env node
/**
 * noanGetAll keeps the query filter on every page.
 *
 * The API's `links.next` drops every query param: measured 2026-09-11,
 * `GET /tasks?completed=false&per_page=100` reports totalItems 120 and a next
 * link of `…/tasks?page=2&per_page=100`. sweepOnce used to follow that link, so
 * a filtered list over one page silently became the whole board from page two
 * (1215 rows, 1095 completed, for 120 open). ~32 call sites pass a filtered
 * /tasks path; `status=backlog` was one page short of the general lane
 * claiming tasks from every status.
 *
 * The API is faked at the fetch layer (the way test-bootstrap.mjs does it), so
 * this exercises the real call() → sweepOnce → union path.
 *
 * Run:  node test-noan-getall-filters.mjs
 */

process.env.NOAN_AGENT_API_KEY ||= "test-key";
const { noanGetAll, pageUrl, hasNextPage } = await import("./noan.mjs");

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); } };

console.log("noanGetAll keeps the filter");

/* ---------- pure helpers ---------- */
ok("page 1 leaves the path untouched", pageUrl("/tasks?completed=false&per_page=100", 1) === "/tasks?completed=false&per_page=100");
ok("page 2 keeps every original param", pageUrl("/tasks?completed=false&per_page=100", 2) === "/tasks?completed=false&per_page=100&page=2");
ok("a path with no query still pages", pageUrl("/notes", 3) === "/notes?page=3");
ok("an existing page param is replaced, not doubled", pageUrl("/tasks?page=1&status=backlog", 2) === "/tasks?page=2&status=backlog");
ok("sort/order survive (assets lost theirs via links.next too)", pageUrl("/assets?sort=createdAt&order=desc&per_page=100", 2).includes("sort=createdAt&order=desc"));
ok("meta.hasNext wins over a present links.next", hasNextPage({ meta: { hasNext: false }, links: { next: "https://x/tasks?page=2" } }) === false);
ok("no meta: links.next presence decides", hasNextPage({ links: { next: "https://x/notes?page=2" } }) === true && hasNextPage({ links: { next: null } }) === false);
ok("nothing at all: stop", hasNextPage(null) === false && hasNextPage({}) === false);

/* ---------- the walk, against a fake API ---------- */
const calls = [];
let fake;
const realFetch = globalThis.fetch;   // restored at the end — keep this file copy-safe as a template
globalThis.fetch = async (url, opts = {}) => {
  calls.push(String(url));
  const u = new URL(String(url));
  const body = fake(u);
  return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify(body), headers: new Map() };
};
const rows = (prefix, n, from = 1) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${from + i}` }));

// 1. A two-page filtered list. The server's next link drops the filter (as live).
//    Unfiltered pages carry MORE rows (the closed ones); if the walk followed the
//    link, page 2 would return them.
calls.length = 0;
fake = (u) => {
  const page = parseInt(u.searchParams.get("page") || "1", 10);
  const filtered = u.searchParams.get("completed") === "false";
  if (!filtered) return { items: rows("CLOSED-", 100, (page - 1) * 100 + 1), meta: { page, totalItems: 1215, hasNext: page < 13 }, links: { next: page < 13 ? `https://api.getnoan.com/api/tasks?page=${page + 1}&per_page=100` : null } };
  if (page === 1) return { items: rows("open-", 100), meta: { page: 1, totalItems: 120, hasNext: true }, links: { next: "https://api.getnoan.com/api/tasks?page=2&per_page=100" } };
  return { items: rows("open-", 20, 101), meta: { page: 2, totalItems: 120, hasNext: false }, links: { next: null } };
};
const open = await noanGetAll("/tasks?completed=false&per_page=100");
ok("two filtered pages, 120 rows, none of them the closed ones", open.length === 120 && open.every(r => r.id.startsWith("open-")));
ok("page 2 was requested WITH the filter", calls.length === 2 && /completed=false/.test(calls[1]) && /page=2/.test(calls[1]));
ok("page 1 was requested exactly as given", /\/tasks\?completed=false&per_page=100$/.test(calls[0]));

// 2. The trap itself: hasNext false while links.next still points somewhere.
calls.length = 0;
fake = (u) => ({ items: rows("r", 3), meta: { page: 1, totalItems: 3, hasNext: false }, links: { next: "https://api.getnoan.com/api/tasks?page=2&per_page=100" } });
const trap = await noanGetAll("/tasks?status=backlog&per_page=100");
ok("stops on meta.hasNext=false even though links.next is present", trap.length === 3 && calls.length === 1);

// 3. No meta at all: fall back to links.next presence, still rebuilding the URL from the path.
calls.length = 0;
fake = (u) => {
  const page = parseInt(u.searchParams.get("page") || "1", 10);
  return page === 1
    ? { items: rows("n", 2), links: { next: "https://api.getnoan.com/api/notes?page=2&per_page=2" } }
    : { items: rows("n", 1, 3), links: { next: null } };
};
const notes = await noanGetAll("/notes?per_page=2&externalId=x");
ok("meta-less response walks by links.next presence", notes.length === 3 && calls.length === 2);
ok("…and still keeps the original query on page 2", /externalId=x/.test(calls[1]) && /page=2/.test(calls[1]));

// 4. The union passes (75/50/25) still fire when the first pass comes up short,
//    and every one of them carries the filter.
calls.length = 0;
fake = (u) => {
  const per = parseInt(u.searchParams.get("per_page") || "100", 10);
  const page = parseInt(u.searchParams.get("page") || "1", 10);
  if (u.searchParams.get("status") !== "done") throw new Error("filter lost");
  // per_page=100 returns 90 of 100 (lossy); per_page=75 returns the missing ten on page 2
  if (per === 100) return { items: rows("d", 90), meta: { page: 1, totalItems: 100, hasNext: false } };
  if (per === 75) return page === 1
    ? { items: rows("d", 75), meta: { page: 1, totalItems: 100, hasNext: true } }
    : { items: rows("d", 25, 76), meta: { page: 2, totalItems: 100, hasNext: false } };
  return { items: [], meta: { page, totalItems: 100, hasNext: false } };
};
const done = await noanGetAll("/tasks?status=done&per_page=100");
ok("union pass recovers the missing rows and dedupes by id", done.length === 100 && new Set(done.map(r => r.id)).size === 100);
ok("every request in the union carried the filter", calls.every(c => /status=done/.test(c)) && calls.some(c => /per_page=75/.test(c) && /page=2/.test(c)));

// 5. Guard: a server that always says hasNext=true cannot loop forever.
calls.length = 0;
fake = (u) => ({ items: rows("g", 1, calls.length), meta: { page: calls.length, totalItems: 10_000, hasNext: true } });
await noanGetAll("/tasks?per_page=100");
ok("the 50-page guard still holds", calls.length === 50 || calls.length === 50 * 4, `${calls.length} calls`);

globalThis.fetch = realFetch;

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
