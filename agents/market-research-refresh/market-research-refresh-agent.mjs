/**
 * The market-research-refresh synthesis agent(s).
 *
 * Two structured-extraction calls (callClaudeJSON, no tools, no live loop), matching the
 * migration brief's requirement that Firecrawl calls stay WORKER-orchestrated rather than
 * model-orchestrated (consistent with the rest of the fleet's read-tools-only-via-worker
 * discipline — no new live tool loop for this one automation):
 *
 *   1. planResearch — given each of the 4 Market Research blocks' current content, the
 *      model proposes what to research: up to 3 search queries per block, plus up to 2
 *      specific URLs to check directly when the block's content already names a
 *      checkable page (e.g. a named competitor's pricing page). The model does NOT see
 *      search results at this stage and calls no tools — this is a single planning
 *      shot, not a loop.
 *   2. draftBlocks — after the worker has executed that plan deterministically via
 *      the Firecrawl search and scrape scripts, the model reads all of it
 *      (plus the company's own internal grounding facts: product/positioning facts for Company
 *      Context, ICP facts for Customer Insights) and
 *      returns per-block classification + a full replacement content draft, plus the
 *      report's Key Takeaways / Discussion Points / executive summary. Report assembly
 *      (Sources section, section ordering) is deterministic (renderReport) — the model
 *      never freeforms the final report structure.
 */

import { callClaudeJSON } from "../shared/anthropic.mjs";
import { LABEL_DECISION, handleFooter } from "../shared/report-handles.mjs";

const MODEL = process.env.MARKET_RESEARCH_MODEL || "claude-opus-5";

const MAX_QUERIES_PER_BLOCK = 3;
const MAX_SCRAPES_PER_BLOCK = 2;

const PLAN_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    blockPlans: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          blockSlug: { type: "string" },
          queries: {
            type: "array",
            items: { type: "string" },
            description: `1-${MAX_QUERIES_PER_BLOCK} specific web search questions to research this block's angle, biased toward the last ~3 months.`,
          },
          scrapeUrls: {
            type: "array",
            items: { type: "string" },
            description: `0-${MAX_SCRAPES_PER_BLOCK} specific URLs to check directly (e.g. a named competitor's pricing page named in the block's current content) rather than searching.`,
          },
        },
        required: ["blockSlug", "queries", "scrapeUrls"],
      },
    },
  },
  required: ["blockPlans"],
};

function buildPlanSystemPrompt(brain) {
  return [
    `You are the market-research-refresh automation's research-planning step. This is a single planning call — you do not see search results yet and you call no tools. Propose what to research; the system will execute your plan deterministically via Firecrawl and hand you the results in a separate follow-up call.`,
    `\n\n`,
    brain.config,
    `\n\n## Hard rules for this planning step`,
    `- One blockPlans entry per block you were given, in the same order.`,
    `- Queries should target real, checkable information (recent launches, pricing changes, funding, positioning shifts, industry reports) — not vague topics.`,
    `- Only propose a scrapeUrls entry when the block's CURRENT content already names a specific, checkable page (e.g. a named competitor's own pricing page) — don't invent URLs.`,
  ].join("");
}

function buildPlanUserPrompt({ blocks }) {
  const lines = blocks.map(b => [
    `### ${b.title} (blockSlug: ${b.slug})`,
    b.content ? b.content : "(no fact recorded yet — research from scratch)",
  ].join("\n")).join("\n\n---\n\n");
  return [
    `Plan this run's research for the 4 Market Research blocks below.`,
    ``,
    lines,
  ].join("\n");
}

export async function planResearch({ blocks, brain }) {
  const system = buildPlanSystemPrompt(brain);
  const user = buildPlanUserPrompt({ blocks });
  const result = await callClaudeJSON({ system, user, schema: PLAN_SCHEMA, model: MODEL, maxTokens: 4000 });
  // Deterministic safety cap regardless of what the model returned — safeguards live in
  // code, not prompts (the agent standard: mechanics in code, judgement in facts).
  for (const p of result.blockPlans) {
    p.queries = (p.queries || []).slice(0, MAX_QUERIES_PER_BLOCK);
    p.scrapeUrls = (p.scrapeUrls || []).slice(0, MAX_SCRAPES_PER_BLOCK);
  }
  return result;
}

/* ---------------- draft ---------------- */

const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    blocks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          blockSlug: { type: "string" },
          classification: { type: "string", enum: ["confirmed", "refined", "new", "reaffirmed-no-material-change"] },
          changeSummary: { type: "string", description: "A few lines: what changed vs. baseline and why, or that it was reaffirmed only. For 'What Changed, By Block' — not the full content." },
          refinedContent: { type: "string", description: "Full replacement markdown content for this block, same subsection structure and prose style as the baseline. No raw URLs or citation markers in this text." },
          sourcesUsedUrls: { type: "array", items: { type: "string" }, description: "URLs (from the provided search/scrape results) actually drawn on for this block's content." },
        },
        required: ["blockSlug", "classification", "changeSummary", "refinedContent", "sourcesUsedUrls"],
      },
    },
    keyTakeaways: {
      type: "array",
      description: "3-6 bullets ranked by strategic relevance, each pairing a finding with its implication for NOAN in one breath.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { finding: { type: "string" }, implication: { type: "string" } },
        required: ["finding", "implication"],
      },
    },
    discussionPoints: {
      type: "array",
      description: "0-4 genuine open questions/debates worth a meeting discussion. Empty if nothing rises to this bar this week.",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { topic: { type: "string" }, openQuestion: { type: "string" }, stakes: { type: "string" } },
        required: ["topic", "openQuestion", "stakes"],
      },
    },
    executiveSummary: {
      type: "string",
      description: "1-2 sentence email-only executive summary: the single most important takeaway, plain prose, no heading.",
    },
  },
  required: ["blocks", "keyTakeaways", "discussionPoints", "executiveSummary"],
};

function buildDraftSystemPrompt(brain, playbook) {
  return [
    `You are the market-research-refresh automation's drafting step — a single structured-extraction call, not a conversation, not a tool loop. All research has already been gathered by the worker; you read it and draft.`,
    `\n\n`,
    brain,
    playbook ? `\n\n## Market Research Refresh Playbook (tone/structure reference — the final report is assembled in code from your structured answer, not written freeform by you)\n${playbook}` : "",
    `\n\n## Hard rules`,
    `- Classify each block: confirmed (leave as-is, light polish), refined (same claim, newer specifics — rewrite that subsection, preserve what's still accurate), new (append), or reaffirmed-no-material-change (redraft may be near-identical to baseline — still produce a complete content string).`,
    `- Don't delete content just because this run didn't reconfirm it — only supersede content that's now demonstrably wrong or stale.`,
    `- For Company Context specifically: if web research conflicts with an internal NOAN fact provided below, the INTERNAL fact wins in refinedContent — note the external conflict in changeSummary instead, it's still worth knowing even though it doesn't belong in the ground-truth content.`,
    `- No raw URLs or citation markers in refinedContent — citations belong only in sourcesUsedUrls, which the system uses to build the report's Sources section.`,
    `- Every keyTakeaway pairs a finding with its implication for NOAN — never a bare fact with no "so what."`,
  ].join("");
}

function buildDraftUserPrompt({ blocks, researchByBlock, companyContextGrounding, customerInsightsGrounding }) {
  const blockSections = blocks.map(b => {
    const research = researchByBlock.get(b.slug) || [];
    const researchText = research.length
      ? research.map(r => `- [${r.kind}] ${r.title || "(untitled)"} — ${r.url} (accessed ${r.accessedAt})\n  ${(r.markdown || "").slice(0, 4000)}`).join("\n\n")
      : "(no research results gathered for this block this run — searches may have failed; note that in changeSummary)";
    return [
      `### ${b.title} (blockSlug: ${b.slug})`,
      `Current content (baseline, createdAt ${b.createdAt || "never"}):`,
      b.content || "(no fact recorded yet)",
      ``,
      `Research gathered for this block:`,
      researchText,
    ].join("\n");
  }).join("\n\n---\n\n");

  const renderGrounding = (facts, emptyNote) => facts.length
    ? facts.map(g => `### ${g.title} (\`${g.slug}\`)\n${g.content}`).join("\n\n")
    : emptyNote;
  const grounding = renderGrounding(companyContextGrounding, "(no internal grounding blocks resolved this run)");
  const icpGrounding = renderGrounding(customerInsightsGrounding, "(no ICP grounding blocks resolved this run — draft Customer Insights from research alone and say so in changeSummary)");

  return [
    `Draft the refined content for all 4 blocks and the report sections.`,
    ``,
    `## The company's own internal facts to ground Company Context against (ground truth — supersedes web research on conflict, for Company Context only)`,
    grounding,
    ``,
    `## The company's own ICP facts to ground Customer Insights against (who the company has decided it sells to — a relevance filter for findings, not something web research may rewrite)`,
    icpGrounding,
    ``,
    `## Blocks + gathered research`,
    blockSections,
  ].join("\n");
}

export async function draftBlocks({ blocks, researchByBlock, companyContextGrounding, customerInsightsGrounding = [], brain, playbook }) {
  const system = buildDraftSystemPrompt(brain, playbook);
  const user = buildDraftUserPrompt({ blocks, researchByBlock, companyContextGrounding, customerInsightsGrounding });
  // 64000, not 16000: the draft must emit complete replacement content for all four
  // Market Research blocks (~22.6k chars of baseline alone, and a refined draft usually
  // runs longer), plus four changeSummaries and the report sections — JSON-escaped. At
  // 16000 the first real run of this agent died with "response truncated at max_tokens"
  // after ~4.5 minutes of research, having written nothing.
  //
  // 16k is the right cap for a NON-streaming call, where a long response trips undici's
  // 300s headers timeout. It does not apply here: anthropic.mjs streams every request
  // (see its header comment) with a 15-minute budget, so the only ceiling that matters
  // is the model's own 128k max output. This is a ceiling, not a spend — tokens are
  // billed as generated.
  return callClaudeJSON({ system, user, schema: DRAFT_SCHEMA, model: MODEL, maxTokens: 64000 });
}

/* ---------------- deterministic report rendering ---------------- */

export function renderReport({ dateLabel, result, blockTitleBySlug, blockMismatchNote, failedPosts, sourcesByBlock, emptyRecipients }) {
  const parts = [`# Market Research Briefing — ${dateLabel}`, "", "## Key Takeaways"];

  // Takeaways are findings, not actions: numbered T1… so a reply can point at one, but never
  // labelled — this report's fact writes are already posted autonomously, so there is nothing
  // "specific" left to apply. The decisions live in Discussion Points.
  const takeaways = [...result.keyTakeaways.map((t, i) => `- T${i + 1} ${t.finding} — ${t.implication}`)];
  if (blockMismatchNote) takeaways.push(`- ${blockMismatchNote}`);
  if (failedPosts.length) takeaways.push(`- Fact write failed for: ${failedPosts.join(", ")} (retried once, still failed) — those blocks were NOT updated this run.`);
  parts.push(takeaways.length ? takeaways.join("\n") : "No takeaways to report this run.");

  parts.push("", "## Discussion Points");
  parts.push(result.discussionPoints.length
    ? result.discussionPoints.map((d, i) => `**D${i + 1}** ${LABEL_DECISION} **${d.topic}** — ${d.openQuestion} ${d.stakes}`).join("\n\n")
    : "Nothing this week rises to the bar of a genuine open question.");

  parts.push("", "## What Changed, By Block");
  parts.push(result.blocks.map(b => `- **${blockTitleBySlug.get(b.blockSlug) || b.blockSlug}** (${b.classification}) — ${b.changeSummary}`).join("\n"));
  if (emptyRecipients) parts.push(`- No contacts carry the report recipient tag — this report was not emailed.`);

  parts.push("", "## Sources");
  const allSources = [...sourcesByBlock.values()].flat();
  parts.push(allSources.length
    ? allSources.map(s => `- ${s.title || s.url} — ${s.url} (accessed ${s.accessedAt?.slice(0, 10) || "unknown date"})`).join("\n")
    : "No external sources cited this run.");

  parts.push(...handleFooter(result.discussionPoints.length ? "take D1 to the next meeting" : result.keyTakeaways.length ? "revise T1" : "go ahead"));
  return parts.join("\n");
}
