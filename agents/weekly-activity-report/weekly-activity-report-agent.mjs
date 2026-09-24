/**
 * The weekly-activity-report synthesis agent.
 *
 * Same shape as pr-sweep-agent.mjs and fact-alignment-agent.mjs: the worker gathers
 * everything mechanically up front (tasks completed/opened, fact updates, assets
 * created, contact-note deltas, standalone notes) and hands it to Claude in one
 * no-tools callClaudeJSON call. This automation only narrates what already happened —
 * it writes no business facts and creates no review task, so there is nothing for the
 * model to write even in principle.
 *
 * The model's job is the part that needs actual reading comprehension ACROSS the
 * gathered sections together (per the Agent Config: "this step is reasoning, not
 * mechanical grouping") — synthesizing 2-4 themes and the overall summary narrative.
 * Final report assembly is deterministic (renderReport) per the Playbook's fixed
 * section order and its two firm formatting rules (bullet lists, a real markdown table
 * for Fact Updates) — the model never freeforms the report text.
 */

import { callClaudeJSON } from "../shared/anthropic.mjs";
import { LABEL_DECISION, handleFooter } from "../shared/report-handles.mjs";

const MODEL = process.env.ACTIVITY_REPORT_MODEL || "claude-opus-5";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: {
      type: "string",
      description: "2-4 sentence narrative: how did the company evolve this week, synthesized across all themes — not a restatement of counts.",
    },
    themes: {
      type: "array",
      description: "2-4 themes. A theme is a cluster of activity that shares a real subject, not just a shared week. Empty array if the week's activity was too scattered to cluster meaningfully — don't force artificial groupings.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          heading: { type: "string" },
          narrative: { type: "string", description: "2-4 sentences." },
          items: { type: "array", items: { type: "string" }, description: "The specific tasks/facts/assets/notes that make up this theme, as short bullet strings." },
        },
        required: ["heading", "narrative", "items"],
      },
    },
    noThemesReason: {
      type: ["string", "null"],
      description: "If themes is empty, explain plainly why the week's activity didn't cluster into themes. Null if themes is non-empty.",
    },
  },
  required: ["summary", "themes", "noThemesReason"],
};

const HEADLINE_MAX = 100;

const clip = s => (s.length > HEADLINE_MAX ? `${s.slice(0, HEADLINE_MAX - 1).trimEnd()}\u2026` : s);

/**
 * One scannable line for a standalone note: its title, else the first sentence of
 * its body.
 *
 * WHY NOT THE OLD 150-CHARACTER SLICE. Notes Captured used to reproduce a blind
 * 150-char cut of every note, which lands mid-word and mid-thought, and the section
 * was the report's last remaining unbounded axis after the Tasks enumeration was
 * removed on 2026-09-02 for blowing the NOAN 25,000-char POST /notes cap.
 *
 * The abbreviation case ("Dr. Smith called") would otherwise cut at "Dr." and render
 * as a two-character headline, so a suspiciously short first sentence falls back to
 * the whole first line rather than a fragment.
 */
export function noteHeadline(note) {
  const title = String(note?.title || "").trim();
  if (title) return clip(title);
  const body = String(note?.content || "").trim();
  if (!body) return "(untitled note)";
  const firstLine = (body.split(/\r?\n/).map(l => l.trim()).find(Boolean) || "")
    .replace(/^#{1,6}\s*/, "")      // markdown heading
    .replace(/^[-*+]\s+/, "")       // leading bullet
    .trim();
  const m = firstLine.match(/^([\s\S]*?[.!?])(\s|$)/);
  const sentence = m && m[1].length >= 20 ? m[1] : firstLine;
  return clip(sentence) || "(untitled note)";
}

function buildSystemPrompt(brain) {
  return [
    `You are the weekly activity-report automation's synthesis step — a single structured-extraction call, not a conversation. This is a retrospective digest: you only narrate what already happened, you write no business facts and there is no review task.`,
    `\n\n`,
    brain.config,
    brain.playbook ? `\n\n## Weekly Activity Report Playbook (tone/structure reference — the actual report is assembled in code from your structured answer, not written freeform by you)\n${brain.playbook}` : "",
    `\n\n## Hard rules`,
    `- You don't write the final report text. You return a summary and themes; the system assembles the full report (Fact Updates/Assets Created/Notes Captured/Data Notes) from data it already computed deterministically. There is no Tasks section and no contact-memo section.`,
    `- Contact memos are given to you below, but they are rendered NOWHERE in the report — Notes Captured lists standalone notes only. A memo reaches the reader this week only if you fold it into a theme. Weigh them accordingly.`,
    `- A theme must be read across sections together (a task, a fact, an asset, or a note that share a real subject) — not just "everything that happened in Tasks this week." Read every section provided below before deciding themes.`,
    `- If the week's activity is too scattered to cluster meaningfully, return an empty themes array and explain in noThemesReason — don't invent a theme to fill a quota.`,
    `- If this is a first/bootstrap run, say so plainly in the summary — there's no prior baseline for note deltas by design, not because nothing happened.`,
  ].join("");
}

function buildUserPrompt({ windowLabel, isFirstRun, baselineSeeded = false, tasksCompleted, tasksOpened, factUpdates, assetsCreated, contactNoteDeltas, standaloneNotes }) {
  const taskLines = (label, arr) => arr.length
    ? arr.map(t => `- ${t.title}${t.bothOpenedAndCompleted ? " (opened and completed this week)" : ""}`).join("\n")
    : `(none)`;

  const factLines = factUpdates.length
    ? factUpdates.map(f => `- ${f.stackTitle} / ${f.blockTitle} (\`${f.blockSlug}\`) — ${f.updatedDate}`).join("\n")
    : "(none)";

  const assetLines = assetsCreated.length
    ? assetsCreated.map(a => `- "${a.title}" — tags: ${a.tags.join(", ") || "(none)"}`).join("\n")
    : "(none)";

  const contactNoteLines = contactNoteDeltas.length
    ? contactNoteDeltas.map(c => c.replaced
        ? `- ${c.contactName}: note history was replaced since last run, delta not reliably computable`
        : `- ${c.contactName}: ${c.newNotes.length} new note(s) — ${c.newNotes.map(n => `"${n.slice(0, 150)}"`).join("; ")}`).join("\n")
    : "(none)";

  const standaloneNoteLines = standaloneNotes.length
    ? standaloneNotes.map(n => `- [${n.inferredSource}] "${n.titleOrGist}"`).join("\n")
    : "(none)";

  return [
    `Synthesize the weekly activity retrospective for ${windowLabel}${isFirstRun ? " (first/bootstrap run — no prior baseline)" : baselineSeeded ? " (contact-memo deltas suppressed this run while their baseline is seeded — this is NOT a first run and NOT a quiet week; do not describe it as either)" : ""}.`,
    ``,
    `## Tasks completed this week (${tasksCompleted.length})`,
    taskLines("completed", tasksCompleted),
    ``,
    `## Tasks opened this week (${tasksOpened.length})`,
    taskLines("opened", tasksOpened),
    ``,
    `## Fact updates this week (${factUpdates.length})`,
    factLines,
    ``,
    `## Assets created this week (${assetsCreated.length})`,
    assetLines,
    ``,
    `## Contact note deltas (${contactNoteDeltas.length})`,
    contactNoteLines,
    ``,
    `## Standalone notes this week (${standaloneNotes.length})`,
    standaloneNoteLines,
    ``,
    `Return summary, themes (2-4, or empty with noThemesReason if genuinely too scattered).`,
  ].join("\n");
}

/** Returns the model's structured judgment. Throws on hard failure. */
export async function runWeeklyActivityReportAgent({ windowLabel, isFirstRun, baselineSeeded = false, tasksCompleted, tasksOpened, factUpdates, assetsCreated, contactNoteDeltas, standaloneNotes, brain }) {
  const system = buildSystemPrompt(brain);
  const user = buildUserPrompt({ windowLabel, isFirstRun, baselineSeeded, tasksCompleted, tasksOpened, factUpdates, assetsCreated, contactNoteDeltas, standaloneNotes });
  return callClaudeJSON({ system, user, schema: SCHEMA, model: MODEL, maxTokens: 8000 });
}

/**
 * Deterministic rendering from the model's summary/themes + the worker's own
 * precomputed sections, per the Weekly Activity Report Playbook's fixed structure.
 * Every itemized list is a markdown bullet list (never prose), and Fact Updates is a
 * real markdown table — both firm Playbook rules, enforced here rather than left to
 * the model's phrasing.
 *
 * NOTES CAPTURED IS STANDALONE NOTES ONLY, and one headline per note. It used to
 * carry contact-memo deltas as well — every new memo quoted to 150 characters, so a
 * single contact with five new memos emitted ~750 characters on one line, unbounded in
 * contacts × memos. Memos are still gathered and still feed theme synthesis, but they
 * are not reproduced here: they already live on the contact record, which is the
 * durable place to read them. Their delta count and every caveat about them (a failed
 * read, a replaced history, a seeding run) surface under Data Notes.
 *
 * There is deliberately no Tasks section: the raw completed/opened enumeration was a
 * long list nobody read, and it was also the bulk of the note body — 355 completed
 * tasks on 2026-09-02 pushed the report past the NOAN 25,000-char POST /notes cap and
 * failed the run outright. Tasks still reach the model via buildUserPrompt, so they
 * shape the themes; they are just no longer dumped verbatim into the output.
 */
export function renderReport({ windowLabel, windowStartDate, windowEndDate, isFirstRun, baselineSeeded = false, result, factUpdates, assetsCreated, standaloneNotes, dataNotes }) {
  const parts = [
    `# Weekly Activity Report — ${windowEndDate}`,
    `Covering ${windowStartDate} to ${windowEndDate}.${isFirstRun ? " This is a first/bootstrap run — there is no prior baseline, so contact-memo deltas are suppressed by design; see Data Notes." : baselineSeeded ? " Contact-memo deltas are suppressed this run while their baseline is seeded — see Data Notes. This is not a quiet week." : ""}`,
    "",
    "## Summary",
    result.summary,
  ];

  // Handles (report-handles.mjs): themes are numbered
  // W1, W2… and ALWAYS [Needs a decision]. This report is observational — a
  // theme is a reading of the week, never an action ready to take — so a reply
  // naming one ("look into W2") asks the agent to investigate, and "go ahead"
  // releases nothing here because nothing is [Specific].
  parts.push("", "## Themes");
  if (result.themes.length) {
    result.themes.forEach((t, i) => {
      parts.push(`### W${i + 1} ${LABEL_DECISION} ${t.heading}`, t.narrative, ...t.items.map(x => `- ${x}`));
    });
  } else {
    parts.push(`Activity this week was too scattered to cluster into clear themes.${result.noThemesReason ? ` ${result.noThemesReason}` : ""}`);
  }

  parts.push("", "## Fact Updates");
  if (factUpdates.length) {
    parts.push("| Stack | Block | Updated |", "| --- | --- | --- |");
    for (const f of factUpdates) parts.push(`| ${f.stackTitle} | ${f.blockTitle} | ${f.updatedDate} |`);
  } else {
    parts.push("No fact updates this week.");
  }

  parts.push("", "## Assets Created");
  parts.push(assetsCreated.length
    ? assetsCreated.map(a => `- "${a.title}" — tags: ${a.tags.join(", ") || "(none)"}`).join("\n")
    : "No assets created this week.");

  parts.push("", "## Notes Captured");
  parts.push(standaloneNotes.length
    ? standaloneNotes.map(n => `- [${n.inferredSource}] "${noteHeadline(n)}"`).join("\n")
    : "No standalone notes this week.");

  parts.push("", "## Data Notes");
  parts.push(dataNotes.length ? dataNotes.map(d => `- ${d}`).join("\n") : "No data-quality caveats this run.");

  parts.push(...handleFooter(result.themes.length ? "look into W1" : "go ahead"));
  return parts.join("\n");
}
