/**
 * Blocks an App Kit app renders as a sheet of labeled values (`fields <- <block>`), and how a draft for one has to
 * look to show up at all.
 *
 * Why this exists: the fact-alignment report once drafted a Space's empty Brief as headed
 * prose ("# Brief", "## Goal", a paragraph per section). The Space's /brief page reads that block through
 * `fields <- Brief`, which shows only `Label: value` lines, and its owner's edit form is built on the template labels
 * (Goal, Audience, Message, Channels, Budget, Dates for a campaign). Posted as drafted, every heading and paragraph
 * would have been invisible, and a prose sentence with a colon in it would have rendered as a bogus field.
 *
 * This is a TWIN of App Kit code, because this file ships in the public agent pack and cannot import the Kit: its
 * parseFields (the `fields` view's reader), BRIEF_FIELDS and spaceKindOfSpec (the Space template), and ownStackOfSpec
 * (a Space's own stack). A fleet test holds the twin to the originals, so a change on the Kit's side fails CI here.
 * Pure: facts and blocks in, answers out.
 */

/** What a Space's Brief holds, in template order (the owner's edit form shows these first, in this order). */
export const BRIEF_FIELDS = { campaign: ["Goal", "Audience", "Message", "Channels", "Budget", "Dates"], event: ["Date", "Venue", "Capacity", "Goal", "Budget"] };
const BRIEF_BLOCK = "Brief";
const EVENT_STAGES = ["Invited", "Registered", "Attended"];

const norm = t => String(t ?? "").normalize("NFC").toLowerCase().replace(/&/g, "and").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const unquote = s => String(s ?? "").trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1").trim();
const stripMarks = s => String(s).replace(/\*\*|__|`/g, "").trim();

const FIELD_LINE = /^\s*(?:[-*]\s+)?\*{0,2}([A-Za-z][A-Za-z0-9 ()\/&'.-]{0,40}?)\*{0,2}\s*:\*{0,2}\s+(\S.*)$/;
const NOT_A_LABEL = /^(visibility|https?|mailto|note|internal|tip|warning)$/i;

/** Labeled values in a block, exactly as the App Kit's `fields` view reads them: a two-column table with a blank
 *  header, or `Label: value` lines (bold or bulleted). One value per line, in order. */
export function parseFields(body) {
  const out = [];
  const lines = String(body ?? "").replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\|/.test(lines[i])) {
      const block = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) block.push(lines[i++]);
      const rows = block.filter(l => !/^\s*\|?\s*:?-{2,}/.test(l)).map(l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim()));
      if (rows.length >= 2 && rows.every(r => r.length === 2) && rows[0].every(c => !c)) {
        for (const r of rows.slice(1)) if (r[0] && r[1]) out.push({ label: stripMarks(r[0]), value: stripMarks(r[1]) });
      }
      continue;
    }
    const m = lines[i].match(FIELD_LINE);
    if (m && !NOT_A_LABEL.test(m[1].trim()) && !/^#/.test(lines[i])) out.push({ label: stripMarks(m[1]), value: stripMarks(m[2]) });
    i++;
  }
  return out;
}

/** An App spec's header and its `fields <-` bindings, or null for text that is no App spec. */
function readSpec(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  let name = null, context = null, inRoutes = false;
  const fields = [];
  let event = false;
  for (const line of lines) {
    if (/^\s*\//.test(line)) inRoutes = true;
    if (!inRoutes) {
      const app = line.match(/^\s*App:\s*(.+?)\s*$/i);
      if (app && name === null) name = app[1].trim();
      const ctx = line.match(/^\s*context:\s*(.+?)\s*$/i);
      if (ctx && context === null) context = ctx[1];
      continue;
    }
    const head = line.split("|")[0].trim();
    const c = head.match(/^([a-z]+)\s*(?:<-|←)\s*(.+?)\s*$/i);
    if (!c) continue;
    const b = c[2].match(/^(.+?)(?:\s+in\s+"([^"]*)")?$/);
    const binding = { title: unquote(b[1]), stack: b[2] ?? null };
    const kind = c[1].toLowerCase();
    if (kind === "fields") fields.push(binding);
    // spaceKindOfSpec: an event's Brief has a Run of show page (`table <- Brief`).
    if (kind === "table" && norm(binding.title) === norm(BRIEF_BLOCK)) event = true;
  }
  if (!name) return null;
  const part = (context || "").split("|").map(p => p.trim()).find(p => /^stacks\s/i.test(p));
  const stacks = part ? part.replace(/^stacks\s+/i, "").split(",").map(unquote).filter(Boolean) : [];
  // spaceKindOfSpec: or its guests move through the Space's own stage tags ("Annual Summit: Registered").
  const stages = new Set(EVENT_STAGES.map(s => norm(`${name}: ${s}`)));
  for (const line of lines) {
    const tags = line.match(/\|\s*(?:people by )?tags?\s+([^|]+)/i);
    if (tags && tags[1].split(",").some(t => stages.has(norm(t)))) event = true;
  }
  // ownStackOfSpec: the context's stack that carries the Space's name, else its first.
  const ownStack = stacks.find(t => norm(t) === norm(name)) ?? stacks[0] ?? null;
  // A spec is a Space when it has a `context:` line (the Kit's spec.isSpace).
  return { name, stacks, ownStack: context ? ownStack : null, fields, kind: event ? "event" : "campaign" };
}

/**
 * Which of `blocks` ({slug, title, stackTitle}) the App Kit reads as `Label: value` fields, off every App spec among
 * `factContents` (the content of each current fact; a spec is any fact whose header has an `App:` line): a block an
 * app binds with `fields <-`, and every Space's own Brief (titled Brief, in the stack the Space keeps as its own),
 * whether or not the Space has a Brief page yet. A Space with none still has its Brief read field by field by its
 * assistant's starters, and the Library can add the page later, at which point a prose Brief renders as nothing.
 * Returns a Map of slug -> {app, title, kind, labels, page}: `kind` is "campaign" or "event" for a Space's Brief, with
 * `labels` its template in order, else null and []; `page` whether a `fields <-` line renders it. A binding that
 * names its stack (`in "Product Launch"`) matches only that stack; one that does not matches the block's title within the
 * spec's context stacks (or anywhere, if the spec names none).
 */
export function fieldsBoundBlocks(blocks, factContents) {
  const specs = (factContents || []).map(readSpec).filter(s => s && (s.fields.length || s.ownStack));
  const out = new Map();
  for (const b of blocks || []) {
    for (const s of specs) {
      const hit = s.fields.find(f => norm(f.title) === norm(b.title) && (f.stack != null
        ? norm(f.stack) === norm(b.stackTitle)
        : !s.stacks.length || s.stacks.some(t => norm(t) === norm(b.stackTitle))));
      const brief = norm(b.title) === norm(BRIEF_BLOCK) && !!s.ownStack && norm(s.ownStack) === norm(b.stackTitle);
      if (!hit && !brief) continue;
      out.set(b.slug, { app: s.name, title: b.title, kind: brief ? s.kind : null, labels: brief ? BRIEF_FIELDS[s.kind] : [], page: !!hit });
      break;
    }
  }
  return out;
}

/** The drafting instruction for one fields-bound gap block, for the model's prompt. */
export function fieldsDraftRule(bound) {
  const shape = "draft ONLY `- **Label**: value` lines, one per line: no headings, no paragraphs, no table, and no other line containing a colon (the page shows Label: value lines only, so anything else is invisible or renders as a bogus field). Omit a label you have nothing on record for; never write a placeholder like TBD.";
  return bound.kind
    ? `the "${bound.app}" Space's own Brief, ${bound.page ? "rendered by its Brief page (\`fields <- Brief\`)" : "read field by field by the Space's assistant, and by its Brief page once it has one"} (${bound.kind} template) — ${shape} Use the template labels in this order: ${bound.labels.join(", ")}. Add another label only for something on record that none of those covers.`
    : `rendered by the "${bound.app}" app as a sheet of labeled values (\`fields <- ${bound.title}\`) — ${shape}`;
}

/**
 * Checks a drafted body against how the page will read it. Returns null when it renders as drafted, else a short
 * reason a reviewer can act on: a non-blank line the page would not show as a field (a heading, prose, a stray
 * table), or, for a Space's Brief, no template label at all (the owner's form would show every field empty).
 */
export function fieldsDraftProblem(content, bound) {
  if (!content || !bound) return null;
  const lines = String(content).replace(/\r/g, "").split("\n").filter(l => l.trim());
  const stray = lines.filter(l => /^\s*#/.test(l) || !parseFields(l).length);
  const labels = parseFields(content).map(f => f.label.toLowerCase());
  const problems = [];
  if (stray.length) problems.push(`${stray.length} line(s) the page would not show as a field (first: "${stray[0].trim().slice(0, 80)}")`);
  if (bound.kind && !bound.labels.some(l => labels.includes(l.toLowerCase()))) problems.push(`no ${bound.kind} Brief label (${bound.labels.join(", ")})`);
  if (!bound.kind && !labels.length) problems.push("no Label: value line at all");
  return problems.length ? `not in the shape "${bound.app}" renders: ${problems.join("; ")}. Rewrite it as \`- **Label**: value\` lines before posting.` : null;
}

/** Stamps `formatProblem` on every drafted gap whose block an app renders through `fields <-` and whose draft would
 *  not render as written (fieldsDraftProblem). The report shows it and the manifest marks that entry not applicable,
 *  so a draft the page would hide is never offered as ready to post. Returns the gaps it flagged. */
export function flagFieldsDrafts(gaps, boundBySlug) {
  const flagged = [];
  for (const g of gaps || []) {
    const problem = fieldsDraftProblem(g.recommendedContent, boundBySlug.get(g.blockSlug));
    if (problem) { g.formatProblem = problem; flagged.push(g); }
  }
  return flagged;
}
