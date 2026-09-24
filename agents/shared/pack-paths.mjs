/**
 * Where the agents' files are, in either of the two trees this code runs in.
 *
 * Upstream every module is a sibling in one flat agents/ directory. The open-source agent pack
 * groups them — agents/<agent>/ for a file one agent uses, agents/shared/ for the rest — and
 * writes agents/pack-layout.json saying which file went where. Imports are rewritten at export
 * time, so modules never need this; it is for the code that opens a file BY NAME (the sweeps
 * that read every shipped module, a test reading a worker's source, the path to design/).
 *
 * Deliberately no fallback between the two: with a layout present, a name it does not list
 * throws. A sweep that quietly read nothing would pass over an empty set.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LAYOUT_FILE = "pack-layout.json";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = [HERE, path.dirname(HERE)].find(d => existsSync(path.join(d, LAYOUT_FILE)));

/** The agents/ directory: this file's own directory upstream, its parent in the pack. */
export const AGENTS_DIR = root ?? HERE;
/** { fleetName: "folder/fleetName" } in the pack; null upstream, where everything is flat. */
export const LAYOUT = root ? JSON.parse(readFileSync(path.join(root, LAYOUT_FILE), "utf8")).files : null;
export const REPO_DIR = path.dirname(AGENTS_DIR);
export const DESIGN_DIR = path.join(REPO_DIR, "design");

/** Absolute path of an agents/ file, named as it is upstream (`reply-worker.mjs`). */
export function agentFile(name) {
  if (!LAYOUT) return path.join(AGENTS_DIR, name);
  const rel = LAYOUT[name];
  if (!rel) throw new Error(`pack-paths: ${name} is not in ${LAYOUT_FILE}, so this tree does not ship it`);
  return path.join(AGENTS_DIR, rel);
}

/** Every directory holding agents/ files: just agents/ upstream, each agent's folder in the pack. */
export function agentDirs() {
  if (!LAYOUT) return [AGENTS_DIR];
  return [...new Set(Object.values(LAYOUT).map(rel => path.join(AGENTS_DIR, path.dirname(rel))))].sort();
}
