// State ledgers for the fleet's agents — one ledger per agent, three backends:
//
//   local (default)          one JSON file per agent under STATE_DIR
//                            (default ~/.verity-agents/state)
//   supabase                 one row per agent in the agent_state table
//     (STATE_BACKEND=supabase; needs SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)
//   postgres                 the same table in any Postgres
//     (STATE_BACKEND=postgres; needs DATABASE_URL and psql)
//
// The API is identical and SYNCHRONOUS in every mode, so worker call sites
// never change. Supabase calls shell out to curl and Postgres calls to psql via
// execFileSync — Node has no sync fetch, and converting every ledger touch point
// in ten workers to async risks a missed await in exactly the code paths that
// guard against mass re-sends. curl exists on macOS and every GitHub runner, and
// psql on every GitHub runner.
//
// Rules, same as the fact-block era:
//   - A missing ledger is NOT a first run. Ledgers are created explicitly by
//     seedLocalState (seed-*.mjs) or scripts/migrate-state.mjs; missing or
//     corrupt state aborts so an empty ledger can never cause mass re-sends.
//   - Local writes are atomic (temp file + rename). Supabase writes are one
//     upsert per save — row-atomic, last-write-wins, same semantics as the
//     local files (workers already load fresh at each touch point to keep
//     the clobber window small).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const BACKEND = (process.env.STATE_BACKEND || "local").trim().toLowerCase();
// An unknown name must not fall through to the local file: on a CI runner that
// file is gone after the run, so a ledger would look saved and never be there.
if (!["local", "supabase", "postgres"].includes(BACKEND)) {
  throw new Error(`STATE_BACKEND must be local, supabase or postgres, got "${BACKEND}"`);
}
// STATE_DIR, else ~/.noan-agents/state. The fleet's earlier ~/.verity-agents
// location is still honoured where it already exists, so no ledger is orphaned.
const LEGACY_STATE_DIR = path.join(os.homedir(), ".verity-agents", "state");
const STATE_DIR = process.env.STATE_DIR
  || (fs.existsSync(LEGACY_STATE_DIR) ? LEGACY_STATE_DIR : path.join(os.homedir(), ".noan-agents", "state"));

export function stateFilePath(name) {
  return path.join(STATE_DIR, `${name}.json`);
}

// ---------- supabase backend ----------

function sbCurl(method, pathAndQuery, body) {
  const url = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!url || !key) {
    throw new Error("STATE_BACKEND=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
  }
  const args = [
    "-sS", "--fail-with-body", "--max-time", "30", "--retry", "2",
    "-X", method,
    "-H", `apikey: ${key}`,
    "-H", `Authorization: Bearer ${key}`,
    "-H", "Content-Type: application/json",
  ];
  if (method === "POST") args.push("-H", "Prefer: resolution=merge-duplicates,return=minimal");
  if (body !== undefined) args.push("--data-binary", "@-");
  args.push(`${url}/rest/v1/${pathAndQuery}`);
  let out;
  try {
    out = execFileSync("curl", args, {
      input: body === undefined ? undefined : JSON.stringify(body),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    const detail = String(e.stdout || e.message || e).slice(0, 500);
    throw new Error(`supabase state ${method} ${pathAndQuery} failed: ${detail}`);
  }
  if (!out || !out.trim()) return null;
  return JSON.parse(out);
}

function sbLoad(name) {
  const rows = sbCurl("GET", `agent_state?agent=eq.${encodeURIComponent(name)}&select=data`);
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  return rows[0].data;
}

function sbSave(name, state) {
  sbCurl("POST", "agent_state?on_conflict=agent", [
    { agent: name, data: state, updated_at: new Date().toISOString() },
  ]);
}

// ---------- postgres backend ----------

/** psql arguments and env for DATABASE_URL. The password goes in the env, so it
 *  is never on a command line or in the text of a failed command. */
function pgConnection() {
  const raw = (process.env.DATABASE_URL || "").trim();
  if (!raw) throw new Error("STATE_BACKEND=postgres but DATABASE_URL is not set");
  let url;
  try { url = new URL(raw); } catch { url = null; }
  if (!url || !["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("DATABASE_URL must be a postgres:// URL");
  }
  const password = url.searchParams.get("password") ?? decodeURIComponent(url.password);
  url.password = "";
  url.searchParams.delete("password");
  return { target: url.toString(), env: { PGPASSWORD: password, PGCONNECT_TIMEOUT: "15" } };
}

function pgRun(sql) {
  const { target, env } = pgConnection();
  try {
    return execFileSync("psql", ["-X", "-q", "-A", "-t", "-v", "ON_ERROR_STOP=1", "-f", "-", target], {
      input: sql,
      encoding: "utf8",
      env: { ...process.env, ...env },
      maxBuffer: 64 * 1024 * 1024,
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch (e) {
    if (e.code === "ENOENT") throw new Error("STATE_BACKEND=postgres needs psql on the PATH");
    const detail = String(e.stderr || e.code || "psql failed").trim().slice(0, 500);
    throw new Error(`postgres state failed: ${detail}`);
  }
}

/** A dollar-quoted literal whose tag cannot appear in the value. */
function pgLiteral(value) {
  const tag = `$s${randomBytes(12).toString("hex")}$`;
  return `${tag}${value}${tag}`;
}

function pgLoad(name) {
  if (pgRun("SELECT to_regclass('agent_state') IS NOT NULL") !== "t") return undefined;
  const out = pgRun(`SELECT data::text FROM agent_state WHERE agent = ${pgLiteral(name)}`);
  return out ? JSON.parse(out) : undefined;
}

// Row level security on, with no policies: Supabase publishes the public schema
// through its REST API, and the ledgers hold email addresses. The table's owner,
// which is who connects here, is not affected.
function pgSave(name, state) {
  pgRun(`
    SET client_min_messages = warning;
    DO $create$ BEGIN
      IF to_regclass('agent_state') IS NULL THEN
        CREATE TABLE agent_state (
          agent text PRIMARY KEY,
          data jsonb NOT NULL,
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        ALTER TABLE agent_state ENABLE ROW LEVEL SECURITY;
      END IF;
    END $create$;
    INSERT INTO agent_state (agent, data, updated_at)
    VALUES (${pgLiteral(name)}, ${pgLiteral(JSON.stringify(state))}::jsonb, now())
    ON CONFLICT (agent) DO UPDATE SET data = EXCLUDED.data, updated_at = now();
  `);
}

// ---------- public API ----------

export function loadLocalState(name, requiredKey) {
  if (BACKEND === "supabase") {
    const s = sbLoad(name);
    if (s === undefined) {
      throw new Error(`State row missing for "${name}" in Supabase. If this is a new deployment, run scripts/migrate-state.mjs or the agent's seed script first.`);
    }
    if (typeof s !== "object" || !s[requiredKey] || s.initialized !== true) {
      throw new Error(`State row for "${name}" has bad shape (missing "${requiredKey}"/initialized). Fix or re-migrate it before running.`);
    }
    return s;
  }
  if (BACKEND === "postgres") {
    const s = pgLoad(name);
    if (s === undefined) {
      throw new Error(`State row missing for "${name}" in Postgres. If this is a new deployment, run the agent's seed script first.`);
    }
    if (typeof s !== "object" || !s[requiredKey] || s.initialized !== true) {
      throw new Error(`State row for "${name}" has bad shape (missing "${requiredKey}"/initialized). Fix it before running.`);
    }
    return s;
  }
  const file = stateFilePath(name);
  if (!fs.existsSync(file)) {
    throw new Error(`State file missing: ${file}. If this is a new deployment, run the agent's seed script (or restore the file from backup) first.`);
  }
  let s;
  try {
    s = JSON.parse(fs.readFileSync(file, "utf8"));
    if (typeof s !== "object" || !s[requiredKey] || s.initialized !== true) throw new Error("bad shape");
  } catch (e) {
    throw new Error(`State file unreadable (${e.message}): ${file}. Fix or restore it before running.`);
  }
  return s;
}

export function saveLocalState(name, state) {
  if (BACKEND === "supabase") {
    sbSave(name, state);
    return;
  }
  if (BACKEND === "postgres") {
    pgSave(name, state);
    return;
  }
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const file = stateFilePath(name);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

export function seedLocalState(name, defaults) {
  if (BACKEND === "supabase") {
    if (sbLoad(name) !== undefined) return { file: `supabase:${name}`, created: false };
    sbSave(name, { initialized: true, ...defaults });
    return { file: `supabase:${name}`, created: true };
  }
  if (BACKEND === "postgres") {
    if (pgLoad(name) !== undefined) return { file: `postgres:${name}`, created: false };
    pgSave(name, { initialized: true, ...defaults });
    return { file: `postgres:${name}`, created: true };
  }
  const file = stateFilePath(name);
  if (fs.existsSync(file)) return { file, created: false };
  saveLocalState(name, { initialized: true, ...defaults });
  return { file, created: true };
}

// Non-strict read for cross-agent aggregate peeks (social digest). Returns
// null on any failure — callers must treat that as "no data", never abort.
export function peekState(name) {
  try {
    if (BACKEND === "supabase") {
      const s = sbLoad(name);
      return s === undefined ? null : s;
    }
    if (BACKEND === "postgres") {
      const s = pgLoad(name);
      return s === undefined ? null : s;
    }
    return JSON.parse(fs.readFileSync(stateFilePath(name), "utf8"));
  } catch {
    return null;
  }
}
