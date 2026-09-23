#!/usr/bin/env node
/** optional-lane.mjs — absent is a fallback, present is the module, broken throws. */
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadLane } from "./optional-lane.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? ` — ${d}` : ""}`); } };

console.log("optional lanes");
const dir = mkdtempSync(path.join(tmpdir(), "lane-"));
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} });
const base = pathToFileURL(path.join(dir, "worker.mjs")).href;
writeFileSync(path.join(dir, "present-lane.mjs"), "export const hasThread = () => true;\n");
writeFileSync(path.join(dir, "broken-lane.mjs"), "export const hasThread = ;\n");

const absent = await loadLane("absent-lane", { hasThread: () => false }, base);
ok("an absent lane returns the fallback, marked absent", absent.present === false && absent.hasThread() === false);

const present = await loadLane("present-lane", { hasThread: () => false }, base);
ok("a present lane returns the module, marked present", present.present === true && present.hasThread() === true);

let threw = null;
try { await loadLane("broken-lane", { hasThread: () => false }, base); } catch (e) { threw = e; }
ok("a lane that exists but fails to load THROWS (never reads as switched off)", threw instanceof SyntaxError, String(threw));

let bad = null;
try { await loadLane("../etc/passwd", {}, base); } catch (e) { bad = e; }
ok("a lane name is a bare module name, nothing path-like", /not a lane name/.test(String(bad)));

// The whole point: the closure walk must not be able to see through this.
const src = (await import("node:fs")).readFileSync(new URL("./optional-lane.mjs", import.meta.url), "utf8");
ok("optional-lane.mjs carries no literal './x.mjs' import a closure walk could follow",
   !/(?:from\s+|import\()\s*["']\.\/[^"']+\.mjs["']/.test(src));

console.log(`\n${fail ? "FAILED" : "PASSED"}  ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
