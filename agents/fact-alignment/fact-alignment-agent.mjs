/**
 * The fact-alignment synthesis agent.
 *
 * Same shape as the other review agents upstream: the worker gathers everything up front (in-scope
 * blocks + their current fact content, gap blocks, capture-queue candidates, notes-scan
 * candidates, the stray-fact anomaly list) and hands it to Claude in one no-tools
 * callClaudeJSON call. There is nothing for the model to write even in principle — every
 * fact correction this automation produces is a recommendation a human reviews and posts
 * separately (see the Agent Config: "You never write a business fact directly").
 *
 * The model's job is the part that needs actual reading comprehension across blocks —
 * drafting gap-fill content, spotting contradictions/overlaps between blocks whose topics
 * visibly overlap, and drafting a ready-to-post recommendation for every candidate fact.
 * Final report assembly is deterministic (renderReport) per the Playbook's fixed section
 * order — the model never freeforms the report text.
 */

import { callClaudeJSON } from "../shared/anthropic.mjs";
import { LABEL_SPECIFIC, LABEL_DECISION, handleFooter } from "../shared/report-handles.mjs";
import { NOTE_CONTENT_CAP } from "../shared/noan.mjs";

const MODEL = process.env.FACT_ALIGNMENT_MODEL || "claude-opus-5";

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    gaps: {
      type: "array",
      description: "One entry per in-scope block that currently has no fact recorded.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          blockSlug: { type: "string" },
          blockTitle: { type: "string" },
          stackTitle: { type: "string" },
          whyItMatters: { type: "string", description: "Why this gap is worth filling, concretely." },
          recommendedContent: { type: ["string", "null"], description: "Full ready-to-post fact content for this block, GROUNDED in facts or context actually provided to you in this prompt. Null if you don't have enough real information to draft genuine content (e.g. a legal policy's actual text, financial specifics, HR criteria, or partnership terms not shown to you anywhere in this input) — never invent plausible-sounding boilerplate to fill the field. Flagging the gap with null content and a clear whyItMatters is more useful than confident-sounding fabrication a human has to first realize is fake." },
        },
        required: ["blockSlug", "blockTitle", "stackTitle", "whyItMatters", "recommendedContent"],
      },
    },
    contradictions: {
      type: "array",
      description: "Pairs of in-scope blocks that assert different things about the same fact (different numbers, dates, or mutually exclusive claims). Only report genuine disagreements, not incidental shared context.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          blockASlug: { type: "string" },
          blockATitle: { type: "string" },
          blockAQuote: { type: "string", description: "The specific conflicting excerpt from block A." },
          blockBSlug: { type: "string" },
          blockBTitle: { type: "string" },
          blockBQuote: { type: "string", description: "The specific conflicting excerpt from block B." },
          targetBlockSlug: { type: "string", description: "Which block's content should be rewritten to resolve this." },
          oldExcerpt: { type: "string", description: "The exact span of targetBlockSlug's CURRENT fact to be replaced, copied VERBATIM — character for character, including punctuation, capitalisation, markdown and line breaks — from the block content shown to you. It must appear EXACTLY ONCE in that fact: if the span you want to change is short or repeated (a bare table cell, a common phrase), widen it with surrounding context until it is unique. Never paraphrase, never re-type from memory, never abbreviate with an ellipsis. A human has to locate this span in the live fact to make the edit, so it must match verbatim and occur exactly once — an approximate or ambiguous quote makes the recommendation unusable." },
          newExcerpt: { type: "string", description: "What oldExcerpt should become. Just the replacement span, in the same style and formatting as the surrounding document — NOT the whole document, and NOT an instruction like \"replace the trial line with...\". Everything outside oldExcerpt is preserved automatically, so never restate unrelated content here." },
        },
        required: ["blockASlug", "blockATitle", "blockAQuote", "blockBSlug", "blockBTitle", "blockBQuote", "targetBlockSlug", "oldExcerpt", "newExcerpt"],
      },
    },
    overlaps: {
      type: "array",
      description: "Pairs of in-scope blocks that restate the same specific value without (yet) disagreeing — a leading indicator of future drift. Detail blocks should own specific values; strategy/summary blocks should reference the detail block instead of restating it. Use judgment on materiality — don't flag incidental shared wording.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          blockASlug: { type: "string" },
          blockATitle: { type: "string" },
          blockBSlug: { type: "string" },
          blockBTitle: { type: "string" },
          whatsDuplicated: { type: "string" },
          targetBlockSlug: { type: "string", description: "Which block's content should be rewritten to remove the restatement." },
          oldExcerpt: { type: "string", description: "The exact span of targetBlockSlug's CURRENT fact to be replaced, copied VERBATIM — character for character, including punctuation, capitalisation, markdown and line breaks — from the block content shown to you. It must appear EXACTLY ONCE in that fact: widen it with surrounding context until it is unique. Never paraphrase, never re-type from memory, never abbreviate with an ellipsis." },
          newExcerpt: { type: "string", description: "What oldExcerpt should become — typically the restatement replaced by a short reference to the block that owns the value. Just the replacement span, NOT the whole document and NOT an edit instruction. Everything outside oldExcerpt is preserved automatically." },
        },
        required: ["blockASlug", "blockATitle", "blockBSlug", "blockBTitle", "whatsDuplicated", "targetBlockSlug", "oldExcerpt", "newExcerpt"],
      },
    },
    candidates: {
      type: "array",
      description: "One entry per candidate PROCESSED this run, from either the capture-queue tasks or the notes scan — including ones you reject (isGenuineFact:false), so the worker can still close out consumed capture-queue tasks correctly. Only isGenuineFact:true entries are shown in the report; rejected ones are dropped from it entirely, not shown as a 'nothing here' placeholder.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          source: { type: "string", enum: ["task", "notes-scan"] },
          sourceLabel: { type: "string", description: "Task title (for source=task) or the note's title + createdAt date (for source=notes-scan)." },
          isGenuineFact: { type: "boolean", description: "true only for a real, durable, ready-to-post business-fact recommendation that isn't already reflected elsewhere in the fact base. false for operational escalations, contact-specific context, engineering/repo conventions, or anything thin/already-covered — this is the correct, expected outcome for most notes-scan items and most capture-queue tasks. Don't force a rejection into a 'no fact recommended' placeholder just to have an entry; set isGenuineFact:false and let the worker drop it." },
          recommendedContent: { type: ["string", "null"], description: "Full ready-to-post fact content. Required (non-null) when isGenuineFact is true; null when isGenuineFact is false — never a 'no fact recommended' sentence here, that's what isGenuineFact:false already communicates." },
          targetBlockSlug: { type: ["string", "null"], description: "An existing block slug this maps to, or null if it needs a new block. Only meaningful when isGenuineFact is true." },
          newBlockTitle: { type: ["string", "null"], description: "Suggested new block title, only if targetBlockSlug is null and isGenuineFact is true." },
          newBlockDescription: { type: ["string", "null"], description: "Suggested new block description, only if targetBlockSlug is null and isGenuineFact is true." },
          newStackTitle: { type: ["string", "null"], description: "Which existing stack the new block belongs in (by title), or a suggested new custom stack title if genuinely warranted (rare). Only meaningful when isGenuineFact is true." },
        },
        required: ["source", "sourceLabel", "isGenuineFact", "recommendedContent", "targetBlockSlug", "newBlockTitle", "newBlockDescription", "newStackTitle"],
      },
    },
    summary: {
      type: "array",
      description: "AT MOST 5 bullet points (fewer is fine), EACH AT MOST TWO SENTENCES, covering what's most worth knowing from this run: the headline counts (gaps/contradictions/overlaps/genuine candidates), the single most notable finding if any stands out, and a brief characterization of the anomalies list — patterns and counts (e.g. 'most are orphaned facts on deleted early-stage business-plan templates; 2 are automation state facts that belong in Supabase, not NOAN'), never a line-by-line restatement. Hard cap: never return more than 5 items in this array.",
      items: { type: "string" },
    },
  },
  required: ["gaps", "contradictions", "overlaps", "candidates", "summary"],
};

function buildSystemPrompt(brain) {
  return [
    `You are the fact-alignment automation's synthesis step — a single structured-extraction call, not a conversation. You never write a business fact directly; everything you return is a recommendation a human reviews and posts separately.`,
    `\n\n`,
    brain.config,
    brain.playbook ? `\n\n## Fact Alignment Playbook (tone/structure reference — the actual report is assembled in code from your structured answer, not written freeform by you)\n${brain.playbook}` : "",
    `\n\n## Hard rules`,
    `- You don't write the final report text except for the summary field. You return structured judgments; the system assembles the report from them in a fixed section order the Playbook specifies.`,
    `- Every recommendation must be concrete and ready-to-post, never just "this needs updating." Gaps and candidates carry FULL ready-to-post content. Contradictions and overlaps carry an EXCERPT PAIR instead — see the excerpt rule below.`,
    `- CONTRADICTIONS AND OVERLAPS USE EXCERPT PAIRS, NOT WHOLE-DOCUMENT REWRITES. You return oldExcerpt (copied verbatim from the target block's current fact, unique within it) and newExcerpt (what that span becomes). Everything outside oldExcerpt stays exactly as it is — you must NOT restate it, summarise it, or re-type it from memory. Two failure modes are equally wrong and both destroy data: (a) writing an INSTRUCTION such as "In section 5, replace the trial line with: ..." into newExcerpt, and (b) putting the whole rewritten document into newExcerpt. newExcerpt replaces ONLY the span oldExcerpt covers.`,
    `- oldExcerpt must be copied character-for-character from the block content given to you below — same punctuation, capitalisation, markdown, and line breaks — and must appear EXACTLY ONCE in that fact. If your span is short or repeated (a bare number, a table cell, a common phrase), widen it with surrounding lines until it is unique. A reader has to find that span verbatim in the live fact to act on it, so an approximate or repeated quote is a discarded recommendation, not a near miss.`,
    `- Only flag a contradiction or overlap for materiality — a fact briefly quoted or paraphrased for context isn't automatically an overlap. Don't manufacture findings to fill a quota; empty arrays are a valid, expected outcome in a healthy fact base.`,
    `- Gaps, contradictions, and overlaps are scoped to the in-scope blocks provided below only — every block you were handed is already in scope, don't second-guess that scoping.`,
    `- Do not fabricate or hallucinate block slugs, titles, or content — only reference blocks provided in the input below.`,
    `- Never fabricate content to fill a gap. Only draft a gap's recommendedContent when you can genuinely ground it in facts or context actually given to you in this prompt. If a gap concerns something you have no real information about — a legal policy's actual text, financial specifics, HR criteria, partnership terms, anything not shown to you here — set recommendedContent to null and explain the gap in whyItMatters instead. Confident-sounding invented content is worse than an honest null: a human has to first realize it's fake before they can fix it.`,
    `- Most notes-scan items and most capture-queue tasks are NOT genuine fact candidates — operational escalations, one-off contact context, and engineering/repo conventions are all isGenuineFact:false. Set it plainly rather than stretching a thin note into a "no fact recommended" placeholder; an empty Candidate Facts section is a valid, expected, good outcome in a healthy week.`,
    `- The summary is the only place you write freeform prose. Keep it to 2-5 short bullets, at most two sentences each — this is what a busy reader sees first, so lead with what's actually worth their attention, not an exhaustive restatement of every list below it.`,
  ].join("");
}

function buildUserPrompt({ windowLabel, isFirstRun, inScopeBlocks, gapBlocks, taskCandidates, notesCandidates, anomalies }) {
  const filledBlocks = inScopeBlocks.filter(b => b.content);
  const blockLines = filledBlocks.map(b =>
    `### ${b.stackTitle} / ${b.title} (blockSlug: ${b.slug})\n${b.content}`
  ).join("\n\n---\n\n");

  const gapLines = gapBlocks.map(b => `- ${b.stackTitle} / ${b.title} (blockSlug: ${b.slug}) — no fact recorded`).join("\n") || "(none)";

  const taskLines = taskCandidates.map(t => `- [task ${t.id}] "${t.title}"\n  ${(t.details || "").slice(0, 2000)}`).join("\n\n") || "(none)";

  const noteLines = notesCandidates.map(n => `- [note ${n.id}, ${n.createdAt}] "${n.title || "(untitled)"}"\n  ${(n.content || "").slice(0, 2000)}`).join("\n\n") || "(none)";

  const anomalyLines = anomalies.map(a => `- blockSlug ${a.blockSlug} (${a.blockTitle || "unknown title"}) has a fact but is outside the in-scope stack set${a.note ? ` — ${a.note}` : ""}`).join("\n") || "(none)";

  return [
    `Run the fact-alignment audit for ${windowLabel}${isFirstRun ? " (first run — no prior relevantStackSlugs baseline)" : ""}.`,
    ``,
    `## In-scope blocks with a current fact (${filledBlocks.length} total) — read for contradictions and overlaps`,
    filledBlocks.length ? blockLines : "(none)",
    ``,
    `## In-scope blocks with NO current fact — gaps (${gapBlocks.length} total)`,
    gapLines,
    ``,
    `## Capture queue candidates — from [Fact Candidate] backlog tasks (${taskCandidates.length} total)`,
    taskLines,
    ``,
    `## Notes-scan candidates — plausible durable business facts surfaced from recent notes (${notesCandidates.length} total)`,
    noteLines,
    ``,
    `## Worker-computed anomalies: facts sitting on out-of-scope blocks (${anomalies.length} total) — don't list these individually anywhere in your output, characterize them briefly (patterns, counts) in your summary instead`,
    anomalyLines,
    ``,
    `Return gaps (one per gap block above — null recommendedContent where you lack real grounding, never invented content), contradictions and overlaps (both read from the in-scope filled blocks above, each as a verbatim oldExcerpt from the target block's current fact plus the newExcerpt it becomes — never a whole-document rewrite and never an edit instruction), candidates (one per capture-queue + notes-scan item above, isGenuineFact:false for the majority that aren't real fact recommendations), and summary (2-5 short bullets covering the headline counts, anything notable, and the anomalies pattern).`,
  ].join("\n");
}

// Every gap and candidate needs a full ready-to-post recommendedContent draft (see SCHEMA),
// so this call's output grows with the fact base. It has now truncated outright twice, both
// confirmed on live runs rather than reasoned about: 16000 died at 223 in-scope blocks (12
// gaps + 9 candidates needing full drafts at once), and 32000 died at 280 in-scope blocks on
// 2026-09-21. Configurable so the next raise needs no code change.
//
// This is the ceiling on the model's response, not a spend commitment — tokens are billed as
// generated, and the only hard bound is the model's own 128k max output. anthropic.mjs
// streams every request on a 15-minute budget, so a long response does not trip a
// transport timeout either.
//
// 64000 since 2026-09-22. That 32000 failure threw six minutes in, before
// anything was rendered or posted — the generation is paid for and the week's report is lost.
// An immediate retry of the IDENTICAL dispatch succeeded: same 93 notes-scan candidates, same
// 280 blocks, same 86 anomalies. Same input, different outcome is the signature of a ceiling
// sitting on the edge of this fact base's output, not of a run that is too big.
//
// market-research-refresh-agent.mjs is the precedent, not a guess: same model, same
// failure ("the first real run died ... having written nothing"), and it settled on
// 64000 for the same reason. This is the other long-form drafting call in the fleet and
// it now sizes the same. Judgment/classification calls stay in the 2.5k-8k band; only
// these two draft whole documents.
const MAX_TOKENS = parseInt(process.env.FACT_ALIGNMENT_MAX_TOKENS || "64000", 10);

/** The model's own hard limit on output. A retry may not ask for more than this. */
export const MODEL_MAX_OUTPUT = 128000;
/** Truncation is the one failure worth one more try: the response is structured output, so a
 *  cut one is invalid JSON with nothing salvageable — there is no "report what was drafted"
 *  to fall back to. But the generation is already paid for and the alternative is losing the
 *  week's report outright, so one retry at double the ceiling turns a dead run into a slow
 *  one. Anything else (a refusal, a transport error, unparseable JSON at a ceiling that was
 *  never reached) still throws on the first failure — retrying those just burns the budget
 *  twice for the same answer. */
const TRUNCATED_RX = /truncated at max_tokens/;

/** Returns the model's structured judgment. Throws on hard failure.
 *  `call` is injectable for tests; production always uses callClaudeJSON. */
export async function runFactAlignmentAgent({ windowLabel, isFirstRun, inScopeBlocks, gapBlocks, taskCandidates, notesCandidates, anomalies, brain }, { call = callClaudeJSON, log = console.log } = {}) {
  const system = buildSystemPrompt(brain);
  const user = buildUserPrompt({ windowLabel, isFirstRun, inScopeBlocks, gapBlocks, taskCandidates, notesCandidates, anomalies });
  try {
    return await call({ system, user, schema: SCHEMA, model: MODEL, maxTokens: MAX_TOKENS });
  } catch (e) {
    const retryTokens = Math.min(MAX_TOKENS * 2, MODEL_MAX_OUTPUT);
    if (!TRUNCATED_RX.test(e.message) || retryTokens <= MAX_TOKENS) throw e;
    log(`  warn: the model's response hit the ${MAX_TOKENS}-token ceiling and was truncated — retrying once at ${retryTokens}. If this recurs, raise FACT_ALIGNMENT_MAX_TOKENS rather than relying on the retry.`);
    return await call({ system, user, schema: SCHEMA, model: MODEL, maxTokens: retryTokens });
  }
}

/** Candidates the model judged to be genuine, ready-to-post fact recommendations —
 *  used both for the report's Candidate Facts section and anywhere a candidate count is
 *  shown, so a raw "9 candidates" (mostly rejections) never appears anywhere. */
export function genuineCandidates(result) {
  return Array.isArray(result.candidates) ? result.candidates.filter(c => c.isGenuineFact) : [];
}

/* ---------------- recommendation manifest ---------------- */

/**
 * 2 — contradiction/overlap entries carry an excerpt PAIR (mode "excerpt") instead of a
 * whole-document `content`, after v1's full-document apply path destroyed three facts on
 * 2026-08-17 by posting a model-drafted edit instruction verbatim. That apply path was removed
 * entirely on 2026-08-31; the excerpt pair outlived it as the report's presentation format,
 * because showing one exact span to swap is also the clearest thing to hand a human.
 *
 * Retained v1 manifests keep their old shape for up to FACT_ALIGNMENT_MANIFEST_RETENTION_DAYS
 * (60) after the change, so both shapes coexist in the ledger for about two months. A v1 entry
 * simply has no `mode` — the field postdates it.
 */
export const MANIFEST_VERSION = 2;

// G/C/O/F mirror the report's four finding sections. Hyphen-and-uppercase only, no
// underscores: the NOAN UI markdown-escapes underscores inside fact content (`TRIGGER_TAGS`
// is stored as `TRIGGER\_TAGS`), which silently broke the general agent's tuning line for
// its entire lifetime. These ids are quoted back by humans and will eventually be parsed
// out of replies, so keep them free of any character the UI rewrites.
const KIND_PREFIX = { gap: "G", contradiction: "C", overlap: "O", candidate: "F", website: "W" };

/** Stable per-run key: the window START date, not the run date. The window is
 *  calendar-anchored (see the worker's calendarWeekWindow), so a delayed cron or an ad hoc
 *  re-run of the same week mints the SAME ids for the same findings instead of a second
 *  set that silently competes with the first. */
export function manifestWindowKey(windowStartIso) {
  return windowStartIso.slice(0, 10);
}

export function manifestEntryKey(kind, index) {
  return `${kind}:${index}`;
}

/**
 * Derives the run's recommendation manifest from the model's structured judgment.
 *
 * Nothing here asks the model for anything new — ids, targets and base fact ids are all
 * computed deterministically from what it already returns plus the worker's facts map. That
 * matters: the manifest is what the report's ids are rendered from, so it must be a
 * mechanical projection of the report, not a second thing the model could get wrong.
 *
 * `baseFactId` is the id of the fact currently on the target block — the version the
 * recommendation was reasoned against. Comparing it to the block's CURRENT fact id is the
 * staleness check before acting on a recommendation by hand: if they differ the fact moved on
 * after the report was drafted, and applying the draft as-is would silently revert that later
 * edit. `null` is meaningful: for a gap it means the block was empty, so a fact appearing
 * later is itself a reason to re-read before acting.
 *
 * Entry order MUST match renderReport's iteration order — ids are assigned by position, and
 * renderReport throws if the two disagree.
 */
export function buildManifest({ windowKey, windowLabel, result, baseFactIdOf, createdAt, websiteFindings }) {
  const entries = [];

  /**
   * `mode` records which shape of edit the entry describes. Nothing branches on it any more —
   * renderReport reads the excerpt pair straight off the model's result, and the apply path
   * that did branch on it is gone. It stays on the entry because a manifest outlives the run
   * that wrote it, and an entry read back later should still say what it is.
   *
   *   "excerpt" — contradictions/overlaps: replace oldExcerpt (verbatim, unique) with newExcerpt.
   *   "full"    — gaps/candidates: `content` is the block's whole replacement document.
   *   null      — nothing drafted (website findings, ungrounded gaps); never applicable.
   */
  const add = (kind, index, { blockSlug, content, oldExcerpt, newExcerpt, label, blockedReason }) => {
    const slug = blockSlug || null;
    const body = content ?? null;
    const isExcerpt = Boolean(oldExcerpt) && Boolean(newExcerpt);
    // An excerpt entry needs BOTH halves. Half a pair is not a weaker recommendation, it is an
    // unusable one — record it as non-applicable rather than letting it fall through to a mode
    // it was never drafted for.
    const hasBody = isExcerpt || Boolean(body);
    const mode = isExcerpt ? "excerpt" : (body ? "full" : null);
    const reason = blockedReason || (!slug ? "no target block" : !hasBody ? "no drafted content" : null);
    entries.push({
      id: `FA-${windowKey}-${KIND_PREFIX[kind]}${index + 1}`,
      kind,
      index,
      label,
      blockSlug: slug,
      mode,
      content: isExcerpt ? null : body,
      oldExcerpt: isExcerpt ? oldExcerpt : null,
      newExcerpt: isExcerpt ? newExcerpt : null,
      baseFactId: slug ? (baseFactIdOf(slug) ?? null) : null,
      // Applicable = there is a concrete block to write and exact text to write to it.
      // An ungrounded gap and a candidate needing a brand-new block are both real findings
      // worth reporting, but neither is a fact POST anyone can make from this manifest.
      applicable: Boolean(slug) && hasBody,
      blockedReason: reason,
    });
  };

  (result.gaps || []).forEach((g, i) => add("gap", i, {
    blockSlug: g.blockSlug,
    content: g.recommendedContent,
    label: `${g.blockTitle} (${g.stackTitle})`,
    blockedReason: g.recommendedContent ? null : "no drafted content — needs a human to fill in directly",
  }));

  (result.contradictions || []).forEach((c, i) => add("contradiction", i, {
    blockSlug: c.targetBlockSlug,
    oldExcerpt: c.oldExcerpt,
    newExcerpt: c.newExcerpt,
    label: `${c.blockATitle} vs ${c.blockBTitle}`,
    blockedReason: (c.oldExcerpt && c.newExcerpt) ? null : "incomplete excerpt pair — needs a human to make this edit directly",
  }));

  (result.overlaps || []).forEach((o, i) => add("overlap", i, {
    blockSlug: o.targetBlockSlug,
    oldExcerpt: o.oldExcerpt,
    newExcerpt: o.newExcerpt,
    label: `${o.blockATitle} and ${o.blockBTitle}`,
    blockedReason: (o.oldExcerpt && o.newExcerpt) ? null : "incomplete excerpt pair — needs a human to make this edit directly",
  }));

  // The report shows only genuine candidates, so the manifest indexes the same filtered
  // list — indexing result.candidates here would drift the ids out of alignment with the
  // report the moment the model rejects one.
  genuineCandidates(result).forEach((c, i) => add("candidate", i, {
    blockSlug: c.targetBlockSlug,
    content: c.recommendedContent,
    label: c.sourceLabel,
    blockedReason: c.targetBlockSlug ? null : `needs a new block "${c.newBlockTitle || "untitled"}"`,
  }));

  // Website findings come from the site scan, which never drafts a rewrite — it reports what
  // the site and the facts each say and leaves the direction to a human. So every W entry is
  // non-applicable by construction: there is no text to post. They are in the manifest anyway
  // so a reader can name one ("W2") the same way as any other finding.
  (websiteFindings || []).forEach((w, i) => add("website", i, {
    blockSlug: (w.blockSlugs || [])[0] || null,
    content: null,
    label: w.subject,
    blockedReason: w.legalReviewOnly
      ? "legal review only — no rewrite is drafted for either side"
      : "the site scan reports divergences, it does not draft rewrites",
  }));

  return { version: MANIFEST_VERSION, windowKey, windowLabel, createdAt, entries };
}

/**
 * Deterministic rendering from the model's structured judgment + worker-computed
 * anomalies/warnings, per the Fact Alignment Playbook's fixed section order.
 *
 * `manifest` is optional: without it the report renders exactly as before. With it, every
 * finding is prefixed by its stable id so a human can name one unambiguously ("do C1 and
 * O2") instead of describing it.
 */
/**
 * The site scan runs monthly; this report is weekly. Rendering the same findings in full four
 * weeks running is how a section teaches its readers to skip it, so an unchanged scan collapses
 * to one line. `isNew` is decided by the worker (scan newer than the previous report), not here.
 */
export function renderWebsiteSection({ site, manifest, bodyBudget = null }) {
  if (!site) return ["", "## Website Divergences", "No site scan has run yet."];

  const scanDate = (site.at || "").slice(0, 10);
  const findings = site.findings || [];
  const cov = site.coverage || {};
  const coverageLine = `Scan of ${scanDate}: ${cov.pagesFetched ?? "?"}/${cov.pagesConfigured ?? "?"} page(s) read, ${cov.claims ?? 0} checkable claim(s), ${cov.agreed ?? 0} agreed with the facts.` +
    (cov.pagesMissed?.length ? ` Not read: ${cov.pagesMissed.join(", ")}.` : "");

  if (!findings.length) return ["", "## Website Divergences", coverageLine, "", "The site and the facts agree everywhere the scan looked."];

  if (!site.isNew) {
    return ["", "## Website Divergences",
      `${coverageLine} Unchanged since the last report — ${findings.length} finding(s) still open. Re-run the site scan, or see the report for ${scanDate}.`];
  }

  const idIndex = new Map((manifest?.entries || []).filter(e => e.kind === "website").map(e => [e.index, e.id]));
  const parts = ["", "## Website Divergences", coverageLine, ""];
  parts.push(findings.map((f, i) => {
    const id = idIndex.get(i);
    const head = `- ${id ? `\`${id}\` ${LABEL_DECISION} ` : ""}**${f.subject}**${f.legalReviewOnly ? " — ⚖ LEGAL REVIEW ONLY" : ""}`;
    const lines = [head];
    lines.push(`  Site: ${f.siteValue}`);
    lines.push(`  Fact (${(f.blockSlugs || []).map(b => `\`${b}\``).join(", ") || "none mapped"}): ${f.factExcerpt ? clipBody(f.factExcerpt, bodyBudget) : "silent — no record either way"}`);
    lines.push(`  Evidence favours: ${f.favours}. ${f.rationale}`);
    if (f.items?.length) {
      lines.push(`  Items (${f.items.length}): ${f.items.map(it => it.subject).join("; ")}`);
    }
    lines.push(f.legalReviewOnly
      ? `  Action: take to legal review. No rewrite is drafted for either side.`
      : `  Action: decide which side to correct — the fact may be stale, or the page may be. The scan does not draft a rewrite.`);
    return lines.join("\n");
  }).join("\n\n"));
  return parts;
}

/* ---------------- fitting the report into a NOAN note ----------------
 * The report is delivered twice: emailed in full, and posted as a NOAN note that is the
 * durable archive a later session reads back. `POST /notes` hard-caps content at 25,000
 * characters, and by September 2026 the report had outgrown it on EVERY run — 31,807 chars
 * on 2026-09-07, 27,252 on 2026-09-21. postNote() cut the tail at a line boundary with a
 * marker, so the runs stayed green while the note silently lost whole sections. Both of
 * those runs lost part or all of Candidate Facts, which is the section proposing new facts
 * — precisely the content someone comes back to act on.
 *
 * The fix is not a bigger cap (there isn't one) and not dropping findings. The bulk of the
 * length is the quoted bodies — `Recommended content:` blocks and the before/after excerpt
 * pairs — so the note clips THOSE, smallest budget that fits, and keeps every finding's id,
 * label, title, slug and rationale intact. A reader of the note still sees every
 * recommendation and its disposition; only the drafted prose is abbreviated, with a pointer
 * to the emailed copy that still carries it in full.
 *
 * The email is never clipped: renderReport's default budget is null. */

/** Bounds on the per-body budget the search below picks from. The ceiling is above any body
 *  the report has ever carried (the longest real recommended-content block to date is ~2,600
 *  characters), so a report that fits is never clipped for no reason. The floor is low enough
 *  that a pathological run still fits; below it the entries themselves would have to go, which
 *  is the one thing this is designed never to do. */
export const NOTE_MAX_BODY_BUDGET = 3000;
export const NOTE_MIN_BODY_BUDGET = 80;

/** Clip one quoted body to `budget`, cutting at a line boundary when that doesn't throw away
 *  most of the allowance, and marking the cut with where the full text lives. Returns the text
 *  unchanged when it already fits or no budget is set. */
export function clipBody(text, budget) {
  const s = String(text ?? "");
  if (!budget || s.length <= budget) return s;
  const head = s.slice(0, budget);
  const nl = head.lastIndexOf("\n");
  const kept = (nl > budget * 0.5 ? head.slice(0, nl) : head).trimEnd();
  const dropped = s.length - kept.length;
  return `${kept}\n[... ${dropped} more character(s) — this is the NOAN note's abbreviated copy; the emailed report carries this block in full]`;
}

/** An excerpt edit, shown as the change it actually is: the two exact strings to swap, not a
 *  prose summary of them. Whoever makes the edit has to find `oldExcerpt` verbatim in the live
 *  fact, so the report shows it exactly as drafted. */
function renderExcerptPair(targetSlug, oldExcerpt, newExcerpt, bodyBudget = null) {
  if (!oldExcerpt || !newExcerpt) {
    return `  Recommended edit (target \`${targetSlug}\`): INCOMPLETE — the excerpt pair is missing a half, so there is no exact span to swap; work the edit out from the finding above.`;
  }
  const quote = t => clipBody(t, bodyBudget).replace(/\n/g, "\n  > ");
  return [
    `  Recommended edit (target \`${targetSlug}\`) — replace:`,
    `  > ${quote(oldExcerpt)}`,
    ``,
    `  with:`,
    `  > ${quote(newExcerpt)}`,
  ].join("\n");
}

export function renderReport({ windowLabel, result, manifest, site, missingFactReviewTag, malformedCaptures = [], emptyRecipients, bodyBudget = null }) {
  const candidates = genuineCandidates(result);

  // Ids are assigned by position, so a manifest that doesn't line up with what's about to
  // be rendered means the two describe different things. Fail loudly rather than emit a
  // report whose ids point somewhere else — a silently mismatched id would send a reader to
  // the wrong finding. Absent manifest = no ids, which is fine.
  const entryIndex = new Map((manifest?.entries || []).map(e => [manifestEntryKey(e.kind, e.index), e]));
  const tag = (kind, i) => {
    if (!manifest) return "";
    const entry = entryIndex.get(manifestEntryKey(kind, i));
    if (!entry) throw new Error(`Manifest is missing an entry for ${kind}[${i}] — manifest and report are out of sync; refusing to render ids that may point at the wrong finding.`);
    // The label is derived from the manifest, not the prose: applicable means a concrete
    // block AND drafted text exist, which is exactly what "ready to apply as written" means.
    return `\`${entry.id}\` ${entryLabel(entry)} `;
  };

  // maxItems isn't a supported JSON-schema keyword for structured output, so the 5-bullet
  // cap is prompt-only on the model's side — enforce it here too rather than trust compliance.
  // Array.isArray guard: a malformed response should degrade to an empty summary, not a
  // raw TypeError crash on .slice.
  const summaryLines = Array.isArray(result.summary) ? result.summary.slice(0, 5) : [];
  if (manifest) summaryLines.push(handlesSummary(manifest));
  if (missingFactReviewTag) summaryLines.push(`The "fact review" tag does not exist in NOAN — the review task was created untagged. Create the tag in the NOAN UI to fix this going forward.`);
  if (emptyRecipients) summaryLines.push(`No contacts carry the report recipient tag — this report was not emailed.`);
  if (malformedCaptures.length) summaryLines.push(`${malformedCaptures.length} backlog task(s) look like a fact capture but do not carry the \`[Fact Candidate]\` title prefix, so they were not picked up — see Malformed Captures.`);

  const parts = [`# Weekly Fact Alignment Report — ${windowLabel}`];
  // Says what the reader is holding. Without it an abbreviated body reads as the whole
  // recommendation, which is worse than a visible cut — they would apply a partial edit.
  if (bodyBudget) {
    parts.push("", `_Abbreviated copy: the full report exceeded NOAN's ${NOTE_CONTENT_CAP}-character note limit, so quoted bodies over ${bodyBudget} characters are clipped here and marked. Every finding, id and label below is complete; the emailed copy of this report carries every body in full._`);
  }
  parts.push("", "## Summary", ...summaryLines.map(s => `- ${s}`));

  parts.push("", "## Gaps");
  parts.push(result.gaps.length
    ? result.gaps.map((g, i) => `- ${tag("gap", i)}**${g.blockTitle}** (\`${g.blockSlug}\`, in ${g.stackTitle}) — ${g.whyItMatters}\n\n  ${g.recommendedContent
        ? `Recommended content:\n  > ${clipBody(g.recommendedContent, bodyBudget).replace(/\n/g, "\n  > ")}`
        : `Recommended content: insufficient context this run to draft real content — needs a human to fill this in directly.`}`).join("\n\n")
    : "No gaps found this run.");

  parts.push("", "## Contradictions");
  parts.push(result.contradictions.length
    ? result.contradictions.map((c, i) => `- ${tag("contradiction", i)}**${c.blockATitle}** (\`${c.blockASlug}\`): "${c.blockAQuote}"\n  vs. **${c.blockBTitle}** (\`${c.blockBSlug}\`): "${c.blockBQuote}"\n\n${renderExcerptPair(c.targetBlockSlug, c.oldExcerpt, c.newExcerpt, bodyBudget)}`).join("\n\n")
    : "No contradictions found this run.");

  parts.push("", "## Overlaps");
  parts.push(result.overlaps.length
    ? result.overlaps.map((o, i) => `- ${tag("overlap", i)}**${o.blockATitle}** (\`${o.blockASlug}\`) and **${o.blockBTitle}** (\`${o.blockBSlug}\`) — ${o.whatsDuplicated}\n\n${renderExcerptPair(o.targetBlockSlug, o.oldExcerpt, o.newExcerpt, bodyBudget)}`).join("\n\n")
    : "No overlaps found this run.");

  parts.push(...renderWebsiteSection({ site, manifest, bodyBudget }));

  parts.push("", "## Candidate Facts");
  parts.push(candidates.length
    ? candidates.map((c, i) => {
        const sourceLabel = c.source === "task" ? `[Fact Candidate] task: ${c.sourceLabel}` : `notes scan: ${c.sourceLabel}`;
        const target = c.targetBlockSlug ? `existing block \`${c.targetBlockSlug}\`` : `new block "${c.newBlockTitle}" (${c.newBlockDescription || "no description given"}) in ${c.newStackTitle || "an existing stack — see recommendation"}`;
        return `- ${tag("candidate", i)}Source: ${sourceLabel}\n  Target: ${target}\n\n  Recommended content:\n  > ${clipBody(c.recommendedContent, bodyBudget).replace(/\n/g, "\n  > ")}`;
      }).join("\n\n")
    : "No genuine candidate facts this run.");

  // Reported only when there is something to report: a standing empty section trains the
  // reader to skim past it, and this one only matters on the runs where it is not empty.
  // Deterministic, not model-drafted — whether a title matches a regex is not a judgment call,
  // and the reader needs it to say the same thing every week.
  if (malformedCaptures.length) {
    parts.push("", "## Malformed Captures");
    parts.push(
      `These backlog tasks read like fact captures but their titles do not start with the literal \`[Fact Candidate]\` prefix, so this run did not pick them up. Nothing was lost — they are still on the board, and they have NOT been closed out. Rename the title to start with \`[Fact Candidate]\` (brackets included, nothing before it) and the next run treats each one as a candidate.`,
      "",
      malformedCaptures.map(t => `- \`${t.id}\` — "${t.title || "(untitled)"}"`).join("\n"),
    );
  }

  // The example names an id THIS run actually has, so it never points at an absent finding.
  parts.push(...handleFooter(footerExample(manifest)));
  return parts.join("\n");
}

/**
 * The note copy: the largest body budget whose render fits inside a NOAN note, or the full
 * report unchanged when it already fits.
 *
 * Returns `{ text, condensed, budget, fits }`. `fits` false means even the smallest budget
 * was too big — postNote() would then cut the tail, so the caller must say so loudly rather
 * than let a silently truncated archive pass for a complete one. That is the failure this
 * whole path exists to make impossible, so it is reported, never swallowed.
 */
export function renderReportForNote(opts, limit = NOTE_CONTENT_CAP) {
  const full = renderReport(opts);
  if (full.length <= limit) return { text: full, condensed: false, budget: null, fits: true };

  // Binary search the LARGEST budget that still fits, rather than walking a fixed ladder.
  // Rendering is pure and costs nothing next to the model call that produced these findings,
  // and a coarse ladder wastes allowance — every character under the cap is another line of
  // drafted content the reader of the note gets to keep. The search is sound because the
  // render length is monotonic in the budget: clipBody never shortens as its budget grows.
  let lo = NOTE_MIN_BODY_BUDGET, hi = NOTE_MAX_BODY_BUDGET, best = null;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const text = renderReport({ ...opts, bodyBudget: mid });
    if (text.length <= limit) { best = { text, budget: mid }; lo = mid + 1; }
    else hi = mid - 1;
  }
  if (best) return { ...best, condensed: true, fits: true };
  return { text: renderReport({ ...opts, bodyBudget: NOTE_MIN_BODY_BUDGET }), condensed: true, budget: NOTE_MIN_BODY_BUDGET, fits: false };
}

/** A reply example built from this run's own ids — the first [Specific] one, else the first
 *  of any kind, else a plain "go ahead" — so the footer never cites an id the run lacks. */
export function footerExample(manifest) {
  const short = e => e.id.replace(/^FA-\d{4}-\d{2}-\d{2}-/, "");
  const entries = manifest?.entries || [];
  const first = entries.find(e => e.applicable) || entries[0];
  return first ? `do ${short(first)}` : "go ahead";
}

/** [Specific] when the manifest entry can be applied as written (a target block and drafted
 *  text), else [Needs a decision] — website divergences and ungrounded gaps always land here. */
export function entryLabel(entry) {
  return entry?.applicable ? LABEL_SPECIFIC : LABEL_DECISION;
}

/** The Summary's handles line: which ids are ready and which need a call, so "go ahead" has
 *  one reading — the Specific list — without the reader tallying labels across sections. */
export function handlesSummary(manifest) {
  const short = e => e.id.replace(/^FA-\d{4}-\d{2}-\d{2}-/, "");
  const entries = manifest?.entries || [];
  if (!entries.length) return `Handles: no recommendations this run.`;
  const specific = entries.filter(e => e.applicable).map(short);
  const decision = entries.filter(e => !e.applicable).map(short);
  return `Handles — ${LABEL_SPECIFIC} ready to apply: ${specific.length ? specific.join(", ") : "none"}. ${LABEL_DECISION}: ${decision.length ? decision.join(", ") : "none"}. Reply naming ids to act ("do ${specific[0] || decision[0]}").`;
}
