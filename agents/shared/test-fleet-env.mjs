#!/usr/bin/env node
/**
 * A fleet-shaped environment for tests that assert the fleet's own prose or
 * authorisation — the agent's name, its pronouns, the teammate domain, the
 * commanders.
 *
 * Since 2026-09-16 none of those is a default in code, because the code ships
 * in the public agent pack. So a bare `node test-x.mjs` sees "Agent", they/them
 * and no teammate domain, and every assertion written against "Verity" or a
 * getnoan.com commenter fails for the wrong reason. Import this FIRST (ESM
 * evaluates imports in order) and the test sees what a fleet run sees:
 * agents/config.defaults.env where it exists (upstream), else the same handful
 * of values as fixtures — the exported pack ships this file but never that one.
 * Nothing already set in the environment is overridden.
 *
 * Runs as a harmless no-op when the test loop picks it up by its name.
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const file = fileURLToPath(new URL("./config.defaults.env", import.meta.url));
const FIXTURES = { AGENT_NAME: "Verity", AGENT_PRONOUNS: "she/her", TEAMMATE_DOMAIN: "getnoan.com" };

if (existsSync(file)) {
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || process.env[k] != null) continue;
    process.env[k] = line.slice(i + 1).trim();
  }
} else {
  for (const [k, v] of Object.entries(FIXTURES)) if (process.env[k] == null) process.env[k] = v;
}
