#!/usr/bin/env node
/**
 * STATE_BACKEND=postgres keeps a ledger in a real Postgres, started here in a
 * temp directory, and still refuses to treat a missing ledger as a first run.
 *
 * Run:  node test-state-postgres.mjs
 */

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const binDirs = [
  ...(process.env.PATH || "").split(path.delimiter),
  ...["/usr/lib/postgresql", "/opt/homebrew/opt"].flatMap((root) => existsSync(root)
    ? readdirSync(root).filter((d) => /^(postgresql@)?\d+$/.test(d)).map((d) => path.join(root, d, "bin"))
    : []),
];
const binDir = binDirs.find((d) => existsSync(path.join(d, "initdb")));
assert.ok(binDir, "this test needs Postgres installed: no initdb found");
process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH}`;

const freePort = () => new Promise((resolve) => {
  const server = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const dir = mkdtempSync(path.join(tmpdir(), "state-pg-"));
const data = path.join(dir, "data");
const password = "p@ss/w:rd secret";
const pwfile = path.join(dir, "pw");
writeFileSync(pwfile, password);
const port = await freePort();
// On macOS the server refuses to start without a valid LC_ALL.
const pgEnv = { ...process.env, LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C" };
execFileSync("initdb", ["-D", data, "-U", "ledger", "--auth=scram-sha-256", `--pwfile=${pwfile}`, "-E", "UTF8", "--locale=C"], { stdio: "ignore", env: pgEnv });
execFileSync("pg_ctl", ["-D", data, "-w", "-l", path.join(dir, "log"), "-o", `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=''`, "start"], { stdio: "ignore", env: pgEnv });

const urlFor = (p) => {
  const u = new URL(`postgres://127.0.0.1:${p}/postgres`);
  u.username = "ledger";
  u.password = password;
  return u.href;
};
const url = urlFor(port);

try {
  process.env.STATE_BACKEND = "postgres";
  process.env.DATABASE_URL = url;
  const { loadLocalState, saveLocalState, seedLocalState, peekState } = await import("./state-local.mjs");

  // No table yet is a missing ledger, not a first run.
  assert.throws(() => loadLocalState("demo", "sent"), /State row missing for "demo"/);
  assert.equal(peekState("demo"), null);

  // Seeding creates the table and the row once, and never overwrites.
  assert.equal(seedLocalState("demo", { sent: {} }).created, true);
  saveLocalState("demo", { ...loadLocalState("demo", "sent"), marker: 1 });
  assert.equal(seedLocalState("demo", { sent: {} }).created, false);
  assert.equal(loadLocalState("demo", "sent").marker, 1);

  // Text that means something to SQL or psql survives, and so does a ledger
  // bigger than a single command line argument may be.
  const awkward = `it's $$ $s0$ \\q \\! :name :'name' ; DROP TABLE agent_state; "é✓"\nline two`;
  const big = { initialized: true, sent: { [awkward]: awkward }, rows: "x".repeat(400_000) };
  saveLocalState("demo", big);
  assert.deepEqual(loadLocalState("demo", "sent"), big);
  saveLocalState(awkward, { initialized: true, sent: {} });
  assert.deepEqual(loadLocalState(awkward, "sent"), { initialized: true, sent: {} });
  assert.deepEqual(peekState("demo"), big);

  // A row of the wrong shape refuses, and one ledger does not read as another.
  saveLocalState("bad", { sent: {} });
  assert.throws(() => loadLocalState("bad", "sent"), /bad shape/);
  assert.throws(() => loadLocalState("other", "sent"), /State row missing/);

  // The ledgers stay out of a Supabase REST API.
  const rls = execFileSync("psql", ["-X", "-At", "-c", "SELECT relrowsecurity FROM pg_class WHERE relname = 'agent_state'", `postgres://ledger@127.0.0.1:${port}/postgres`],
    { env: { ...process.env, PGPASSWORD: password }, encoding: "utf8" }).trim();
  assert.equal(rls, "t");

  // A database that cannot be reached is an error, never a missing ledger or an
  // empty one, and the error does not carry the password.
  process.env.DATABASE_URL = urlFor(await freePort());
  for (const call of [() => loadLocalState("demo", "sent"), () => seedLocalState("fresh", { sent: {} }), () => saveLocalState("demo", big)]) {
    assert.throws(call, (e) => {
      assert.match(e.message, /postgres state failed/);
      assert.doesNotMatch(e.message, /State row missing/);
      assert.ok(!e.message.includes(password) && !e.message.includes(encodeURIComponent(password)), "password in the error");
      return true;
    });
  }
  assert.equal(peekState("demo"), null);

  // Bad settings are named.
  process.env.DATABASE_URL = "";
  assert.throws(() => loadLocalState("demo", "sent"), /DATABASE_URL is not set/);
  process.env.DATABASE_URL = "mysql://nope";
  assert.throws(() => loadLocalState("demo", "sent"), /must be a postgres:\/\/ URL/);
  process.env.DATABASE_URL = url;
  assert.equal(loadLocalState("demo", "sent").rows.length, 400_000);

  // An unknown backend name stops at once instead of writing a local file that
  // a CI runner throws away.
  const typo = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(new URL("./state-local.mjs", import.meta.url).href)})`],
    { env: { ...process.env, STATE_BACKEND: "postgress" }, encoding: "utf8" });
  assert.notEqual(typo.status, 0);
  assert.match(typo.stderr, /STATE_BACKEND must be local, supabase or postgres/);

  console.log("ok test-state-postgres");
} finally {
  spawnSync("pg_ctl", ["-D", data, "-m", "immediate", "stop"], { stdio: "ignore" });
  rmSync(dir, { recursive: true, force: true });
}
