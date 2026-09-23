#!/usr/bin/env node
/**
 * Market research refresh — worker. Refreshes the 4 blocks of the "Market Research"
 * stack (Company Context, Culture Signals, Category Dynamics, Customer Insights) with
 * real external research, posting a refined fact directly to each — no review gate,
 * unattended by design. Ports .claude/skills/noan-market-research-refresh/SKILL.md.
 *
 * Deliberately stateless (confirmed in the Agent Config: the facts' own content/
 * createdAt already serve as baseline and staleness signal) — no state row for this
 * automation.
 *
 * Cron fires weekly (Mondays) but the automation itself must no-op unless today falls
 * in the 1st-7th of the month ("first Monday" cadence) — checked before ANY API call,
 * per the source skill's explicit instruction.
 *
 * This repo's runtime has no live web-search/fetch tool, so the original skill's
 * WebSearch/WebFetch research step is ported onto Firecrawl (the search and scrape scripts
 * under scripts/), called deterministically by the WORKER, not the model — a
 * two-phase design (plan, then execute) rather than a live tool loop, matching the
 * fleet's read-tools-only-via-worker discipline:
 *   1. Cadence gate.
 *   2. Resolve the Market Research stack + its 4 blocks (title-matched, not hardcoded
 *      slugs) and read back each one's current fact as baseline; flag any mismatch.
 *   3. Ground Company Context ONLY against the company's own internal facts FIRST (product,
 *      strategy, monetization, positioning, pricing blocks) — internal facts are ground
 *      truth that supersedes web content on conflict; this ordering is load-bearing per
 *      a documented past incident.
 *   4. Model call #1 (no tools): plan up to 3 search queries + up to 2 direct-scrape
 *      URLs per block.
 *   5. Worker executes that plan deterministically via the Firecrawl scripts, capped in
 *      code regardless of what the model asked for, logging (not aborting) on a failed
 *      fetch.
 *   6. Model call #2 (no tools): classify + draft refined content per block, plus the
 *      report's Key Takeaways / Discussion Points / executive summary.
 *   7. Post all 4 facts (retry once per block on failure, continue + flag rather than
 *      abort the whole run), post a NOAN note, email the report recipients (with the
 *      email-only executive summary prepended to a COPY of the report).
 *
 * Env:
 *   NOAN_PERSONAL_API_KEY, ANTHROPIC_API_KEY, RESEND_API_KEY, MAIL_FROM,
 *   FIRECRAWL_API_KEY                                                    required
 *   MARKET_RESEARCH_CONFIG_BLOCK_SLUG, MARKET_RESEARCH_PLAYBOOK_BLOCK_SLUG   required
 *   MARKET_RESEARCH_MODEL       default "claude-opus-5"
 *   MARKET_RESEARCH_FORCE_RUN=1 bypass the first-Monday cadence gate (manual testing only)
 *   DRY_RUN=1                   still runs research + drafting, skips NOAN/email writes
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { noanGet, noanGetAll, noanPost, assertNoanKey, postNote } from "./noan.mjs";
import { assertModelKey } from "./anthropic.mjs";
import { sendReportEmail } from "./resend.mjs";
import { renderReportEmailHtml } from "./markdown-email.mjs";
import { planResearch, draftBlocks, renderReport } from "./market-research-refresh-agent.mjs";

const CONFIG_SLUG = process.env.MARKET_RESEARCH_CONFIG_BLOCK_SLUG;
const PLAYBOOK_SLUG = process.env.MARKET_RESEARCH_PLAYBOOK_BLOCK_SLUG;
const DRY_RUN = process.env.DRY_RUN === "1";
const FORCE_RUN = process.env.MARKET_RESEARCH_FORCE_RUN === "1";
// The stack this agent maintains. MARKET_RESEARCH_STACK_SLUG names it; our own
// is set in config.defaults.env, a downstream copy names theirs (the seed
// script prints it). No slug is built in: a stack slug belongs to one workspace.
const MARKET_RESEARCH_STACK_SLUG = (process.env.MARKET_RESEARCH_STACK_SLUG || "").trim();
const EXPECTED_BLOCK_TITLES = ["Company Context", "Culture Signals", "Category Dynamics", "Customer Insights"];
// Grounding slug lists live in the Agent Config fact, per the agent standard (judgement lives in facts, not code) — so
// they can be retuned in the NOAN UI with no redeploy, and so each customer's copy of this
// automation can name their own blocks. These arrays are only the fallback for a config fact
// that has no fence yet. Same [[FENCE]] convention as the other grounding workers upstream.
//
// Slugs, not title keywords (which is what this used to do). Keyword matching silently failed
// in both directions: "mission vision" never matched the block actually titled "Mission &
// Vision", so that fact had never once reached the prompt, while "value proposition" also
// matched the recruitment stack's Employer Value Proposition and fed it to Company Context.
// Managed (every-workspace) slugs only. Workspace-specific ones — a workspace's own
// pricing blocks carry a workspace hash — come from MARKET_RESEARCH_GROUNDING_EXTRA_SLUGS.
const DEFAULT_COMPANY_CONTEXT_GROUNDING = [
  "product-list", "product-strategy", "product-roadmap", "product-faq", "monetization-model",
  "business-vision", "mission-vision", "value-proposition", "brand-positioning",
  ...(process.env.MARKET_RESEARCH_GROUNDING_EXTRA_SLUGS || "").split(",").map(x => x.trim()).filter(Boolean),
];
// Customer Insights is the ICP block, and until now it was the only target block researched
// with no internal anchor at all — rewritten unattended from web research about buyers in
// general. These are the company's own decisions about who it sells to; same set x-prospector grounds
// its ICP scoring in. Audience Pain Points is deliberately excluded: thin, stale since April,
// and covered by the others.
const DEFAULT_ICP_GROUNDING = [
  "ideal-customer", "sales-customer-profile", "sales-buyer-persona", "sales-buyer-segments",
  "sales-ICP-triggers", "audience-segments",
];
const GROUNDING_FACT_CHAR_CAP = 9000; // the multi-block grounding cap

const AGENTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const SEARCH_SCRIPT = path.join(AGENTS_DIR, "scripts", "firecrawl_search.py");
const SCRAPE_SCRIPT = path.join(AGENTS_DIR, "scripts", "firecrawl_scrape.py");

function log(...a) { console.log(new Date().toISOString(), ...a); }

/* ---------------- cadence gate — must run before ANY API call ---------------- */

function inFirstMondayWindow(now = new Date()) {
  const day = now.getDate(); // respects TZ env, matching the workflow's Europe/Lisbon setting
  return day >= 1 && day <= 7;
}

function required(name) {
  if (!process.env[name]) { console.error(`Missing required env var: ${name}`); process.exit(1); }
}

/* ---------------- brain (editable in the NOAN UI) ---------------- */

// Same fence convention as another worker upstream (which has its own copy, exercised by
// its own test). Kept local rather than imported: that module is a whole live agent,
// and importing it here to borrow four lines would drag its dependency graph into this run.
//
// Deliberately stricter than that copy: the delimiters must each sit alone on their own line.
// The loose version anchors on the first `[[NAME]]` anywhere in the text, so a config fact that
// merely *mentions* its own fence in prose — which this one's step 3 did — opens the match
// early and swallows the whole document as "slugs". Caught before first run; the fence returned
// 26 and 33 entries instead of 12 and 6.
function parseFence(text, name) {
  const m = String(text).match(
    new RegExp(`^\\[\\[${name}\\]\\][ \\t]*\\r?\\n([\\s\\S]*?)\\r?\\n[ \\t]*\\[\\[\\/${name}\\]\\][ \\t]*$`, "m"));
  return m ? m[1].trim() : null;
}

function fenceSlugs(config, name, fallback) {
  const raw = parseFence(config, name);
  if (!raw) {
    log(`  no [[${name}]] fence in the config fact — falling back to the ${fallback.length} slug(s) hardcoded in this worker`);
    return fallback;
  }
  const slugs = raw.split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#"));
  if (!slugs.length) {
    log(`  warn: [[${name}]] fence is present but empty — falling back to the ${fallback.length} slug(s) hardcoded in this worker`);
    return fallback;
  }
  return slugs;
}

async function loadAgentBrain() {
  const cfg  = await noanGet(`/facts?block_slug=${encodeURIComponent(CONFIG_SLUG)}`);
  const play = await noanGet(`/facts?block_slug=${encodeURIComponent(PLAYBOOK_SLUG)}`);
  const config   = (cfg.items  || []).map(f => f.content).join("\n\n").trim();
  const playbook = (play.items || []).map(f => f.content).join("\n\n").trim();
  if (!config) throw new Error(`No facts in market-research-refresh config block '${CONFIG_SLUG}'. Refusing to run un-instructed.`);
  return {
    config,
    playbook,
    companyContextSlugs: fenceSlugs(config, "GROUNDING_COMPANY_CONTEXT", DEFAULT_COMPANY_CONTEXT_GROUNDING),
    icpSlugs: fenceSlugs(config, "GROUNDING_CUSTOMER_INSIGHTS", DEFAULT_ICP_GROUNDING),
  };
}

/* ---------------- resolve the Market Research stack + its 4 blocks ---------------- */

async function resolveMarketResearchBlocks() {
  const stacksRes = await noanGet(`/stacks?slug=${encodeURIComponent(MARKET_RESEARCH_STACK_SLUG)}`);
  const stack = (stacksRes.items || [])[0];
  if (!stack) throw new Error(`Market Research stack not found via GET /stacks?slug=${MARKET_RESEARCH_STACK_SLUG}`);
  const stackBlockSlugs = (stack.blocks || []).map(b => b.slug);
  if (!stackBlockSlugs.length) throw new Error(`Market Research stack ${stack.slug} has no blocks.`);
  const qs = stackBlockSlugs.map(s => `slug=${encodeURIComponent(s)}`).join("&");
  const blocks = await noanGetAll(`/blocks?${qs}&per_page=100`);

  const matched = EXPECTED_BLOCK_TITLES.map(title => blocks.find(b => b.title === title)).filter(Boolean);
  let mismatchNote = null;
  if (matched.length !== EXPECTED_BLOCK_TITLES.length || blocks.length !== EXPECTED_BLOCK_TITLES.length) {
    const missing = EXPECTED_BLOCK_TITLES.filter(t => !blocks.find(b => b.title === t));
    mismatchNote = `Market Research stack's block set differs from the expected 4 (Company Context, Culture Signals, Category Dynamics, Customer Insights). Found: ${blocks.map(b => b.title).join(", ") || "(none)"}.${missing.length ? ` Missing: ${missing.join(", ")}.` : ""} Proceeding only with matched blocks.`;
  }
  return { matched, mismatchNote };
}

async function loadBaselineFacts(blocks) {
  const qs = blocks.map(b => `block_slug=${encodeURIComponent(b.slug)}`).join("&");
  // per_page=100 for the same reason as loadGroundingFacts below — 4 blocks is under the
  // default page size today, but this is one managed-stack change away from truncating.
  const res = await noanGet(`/facts?${qs}&per_page=100`);
  const bySlug = new Map((res.items || []).map(f => [f.blockSlug, f]));
  return blocks
    .map(b => ({ slug: b.slug, title: b.title, content: bySlug.get(b.slug)?.content || null, createdAt: bySlug.get(b.slug)?.createdAt || null }))
    .sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "")); // oldest (or no-fact) first
}

/* ---------------- internal grounding: the company's own facts first ---------------- */

async function loadGroundingFacts(slugs, label) {
  const unique = [...new Set(slugs)];
  if (!unique.length) return [];
  // Titles are only for prompt readability — GET /facts returns blockSlug and no title. A slug
  // that resolves to no block still gets its fact used, under the slug as its heading.
  const blockQs = unique.map(s => `slug=${encodeURIComponent(s)}`).join("&");
  const blocks = await noanGetAll(`/blocks?${blockQs}&per_page=100`).catch(() => []);
  const titleBySlug = new Map(blocks.map(b => [b.slug, b.title]));

  // per_page=100 is load-bearing, not decoration: GET /facts defaults to per_page=10, so a
  // grounding list longer than ten silently came back a page at a time. That is exactly what
  // happened here — 12 configured slugs returned 10, and product-strategy (2.3k chars) and
  // brand-positioning were dropped from Company Context's grounding on every run, reported as
  // "no fact" when both facts existed and were readable.
  //
  // Do NOT "fix" this with noanGetAll: the API's links.next drops the block_slug filters
  // (next is bare `/api/facts?page=2&per_page=10`), so following it pages through EVERY fact in
  // the project — 317 of them — and would splice unrelated facts into the grounding prompt.
  // Same is true of /blocks. One page of up to 100 is the correct shape here.
  const factQs = unique.map(s => `block_slug=${encodeURIComponent(s)}`).join("&");
  const facts = await noanGet(`/facts?${factQs}&per_page=100`).catch(() => ({ items: [] }));
  const returned = facts.items || [];
  const total = facts.meta?.totalItems;
  if (typeof total === "number" && total > returned.length) {
    log(`  warn: ${label}: API reported ${total} fact(s) but returned ${returned.length} — grounding is incomplete this run`);
  }
  const factBySlug = new Map(returned.map(f => [f.blockSlug, f]));

  // A slug named in the config fact that comes back with nothing is a config error the editor
  // needs to see by name — the old keyword version could only report a count, so a typo or a
  // renamed block just silently shrank the grounding set.
  const missing = unique.filter(s => !factBySlug.get(s)?.content);
  if (missing.length) log(`  warn: ${label}: no fact for ${missing.length} configured slug(s): ${missing.join(", ")}`);

  return unique
    .map(slug => {
      const f = factBySlug.get(slug);
      if (!f?.content) return null;
      const content = f.content.length > GROUNDING_FACT_CHAR_CAP ? `${f.content.slice(0, GROUNDING_FACT_CHAR_CAP)}\n[...fact truncated]` : f.content;
      return { slug, title: titleBySlug.get(slug) || slug, content };
    })
    .filter(Boolean);
}

/* ---------------- Firecrawl mechanics scripts (worker-orchestrated, not model-orchestrated) ---------------- */

function runFirecrawlSearch(query) {
  try {
    const out = execFileSync("python3", [SEARCH_SCRIPT, query, "--limit", "4"], {
      cwd: AGENTS_DIR, env: process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000,
    });
    return JSON.parse(out);
  } catch (e) {
    log(`  warn: firecrawl_search failed for "${query}": ${(e.stderr?.toString?.() || e.message || "").slice(0, 300)}`);
    return null;
  }
}

function runFirecrawlScrape(url) {
  try {
    const out = execFileSync("python3", [SCRAPE_SCRIPT, url], {
      cwd: AGENTS_DIR, env: process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60_000,
    });
    return JSON.parse(out);
  } catch (e) {
    log(`  warn: firecrawl_scrape failed for "${url}": ${(e.stderr?.toString?.() || e.message || "").slice(0, 300)}`);
    return null;
  }
}

function executeResearchPlan(blockPlans) {
  const researchByBlock = new Map();
  let failedFetches = 0;
  for (const p of blockPlans) {
    const results = [];
    for (const q of p.queries || []) {
      const r = runFirecrawlSearch(q);
      if (!r) { failedFetches++; continue; }
      for (const item of r.results || []) {
        results.push({ kind: "search", title: item.title, url: item.url, markdown: item.markdown, accessedAt: item.accessedAt });
      }
    }
    for (const url of p.scrapeUrls || []) {
      const r = runFirecrawlScrape(url);
      if (!r) { failedFetches++; continue; }
      results.push({ kind: "scrape", title: r.title, url: r.url, markdown: r.markdown, accessedAt: r.accessedAt });
    }
    researchByBlock.set(p.blockSlug, results);
  }
  return { researchByBlock, failedFetches };
}

/* ---------------- report recipients (live from NOAN, by REPORT_RECIPIENT_TAG) ---------------- */

async function fetchGrowthTeamEmails() {
  // The recipients are whoever carries REPORT_RECIPIENT_TAG. No tag configured
  // means nobody, and the run says so, rather than a built-in team name that
  // belongs to one company.
  const tag = (process.env.REPORT_RECIPIENT_TAG || "").trim().toLowerCase();
  if (!tag) { log("  warn: REPORT_RECIPIENT_TAG is not set — the report has no email recipients"); return []; }
  const contacts = await noanGetAll(`/contacts?per_page=100`);
  return contacts
    .filter(c => (c.tags || []).some(t => (t.name || "").toLowerCase() === tag))
    .map(c => c.email)
    .filter(Boolean);
}

/* ---------------- main ---------------- */

async function main() {
  // Cadence gate FIRST — before any API call, per the source skill's explicit instruction.
  const now = new Date();
  if (!FORCE_RUN && !inFirstMondayWindow(now)) {
    log(`Not in the first-Monday window (today is day ${now.getDate()} of the month) — no-op, no API calls made.`);
    return;
  }

  // Either NOAN key satisfies this. noan.mjs prefers the per-category key and refuses to run
  // with neither, so naming the shared key here would reject a correctly configured
  // per-category run — and it is why the shared key had to stay in every workflow env block.
  assertNoanKey();
  // Either model-key name satisfies this; see assertModelKey.
  assertModelKey();
  ["RESEND_API_KEY", "MAIL_FROM", "FIRECRAWL_API_KEY",
   "MARKET_RESEARCH_CONFIG_BLOCK_SLUG", "MARKET_RESEARCH_PLAYBOOK_BLOCK_SLUG"].forEach(required);

  log(`Market research refresh starting${DRY_RUN ? " (DRY-RUN)" : ""}`);

  const brain = await loadAgentBrain();
  const { matched, mismatchNote } = await resolveMarketResearchBlocks();
  if (mismatchNote) log(`  warn: ${mismatchNote}`);
  const baselineBlocks = await loadBaselineFacts(matched);
  const blockTitleBySlug = new Map(baselineBlocks.map(b => [b.slug, b.title]));
  log(`  resolved ${baselineBlocks.length}/${EXPECTED_BLOCK_TITLES.length} Market Research block(s)`);

  const companyContextGrounding = await loadGroundingFacts(brain.companyContextSlugs, "Company Context grounding");
  log(`  ${companyContextGrounding.length}/${brain.companyContextSlugs.length} internal grounding fact(s) for Company Context`);
  const customerInsightsGrounding = await loadGroundingFacts(brain.icpSlugs, "Customer Insights ICP grounding");
  log(`  ${customerInsightsGrounding.length}/${brain.icpSlugs.length} ICP grounding fact(s) for Customer Insights`);
  if (!customerInsightsGrounding.length) {
    log(`  warn: no ICP grounding facts resolved — Customer Insights will be drafted from web research alone this run`);
  }

  const plan = await planResearch({ blocks: baselineBlocks, brain });
  const totalQueries = plan.blockPlans.reduce((s, p) => s + p.queries.length, 0);
  const totalScrapes = plan.blockPlans.reduce((s, p) => s + p.scrapeUrls.length, 0);
  log(`  planned ${totalQueries} search(es), ${totalScrapes} direct scrape(s) across ${plan.blockPlans.length} block(s)`);

  const { researchByBlock, failedFetches } = executeResearchPlan(plan.blockPlans);
  if (failedFetches) log(`  warn: ${failedFetches} research fetch(es) failed — continuing with what succeeded`);

  const draft = await draftBlocks({ blocks: baselineBlocks, researchByBlock, companyContextGrounding, customerInsightsGrounding, brain: brain.config, playbook: brain.playbook });
  log(`  drafted ${draft.blocks.length} block(s), ${draft.keyTakeaways.length} key takeaway(s), ${draft.discussionPoints.length} discussion point(s)`);

  // Sources actually used, cross-referenced against what was really fetched (never trust
  // a model-asserted URL that wasn't actually in the research results).
  const sourcesByBlock = new Map();
  for (const b of draft.blocks) {
    const research = researchByBlock.get(b.blockSlug) || [];
    const byUrl = new Map(research.map(r => [r.url, r]));
    const seen = new Set();
    const used = [];
    for (const url of b.sourcesUsedUrls || []) {
      const r = byUrl.get(url);
      if (r && !seen.has(url)) { seen.add(url); used.push(r); }
    }
    sourcesByBlock.set(b.blockSlug, used);
  }

  const emails = await fetchGrowthTeamEmails().catch(e => { log(`  warn: recipient lookup failed: ${e.message}`); return []; });

  const dateLabel = now.toISOString().slice(0, 10);
  const noteReport = renderReport({
    dateLabel, result: draft, blockTitleBySlug, blockMismatchNote: mismatchNote,
    failedPosts: [], sourcesByBlock, emptyRecipients: !emails.length,
  });

  if (DRY_RUN) {
    log("  dry-run: would POST these facts —");
    for (const b of draft.blocks) log(`    [${b.blockSlug}] (${b.classification})\n` + b.refinedContent);
    log("  dry-run: would post this report —\n" + noteReport);
    log(`  dry-run: would email the report recipients (${emails.length} recipient(s)): ${emails.join(", ") || "(none found)"}`);
    return;
  }

  const failedPosts = [];
  for (const b of draft.blocks) {
    try {
      await noanPost("/facts", { blockSlug: b.blockSlug, content: b.refinedContent });
    } catch (e) {
      log(`  warn: fact POST failed for ${b.blockSlug}, retrying once: ${e.message}`);
      try {
        await noanPost("/facts", { blockSlug: b.blockSlug, content: b.refinedContent });
      } catch (e2) {
        log(`  error: fact POST failed twice for ${b.blockSlug}: ${e2.message}`);
        failedPosts.push(blockTitleBySlug.get(b.blockSlug) || b.blockSlug);
      }
    }
  }
  log(`  posted ${draft.blocks.length - failedPosts.length}/${draft.blocks.length} refreshed fact(s)`);

  // Re-render with the real failedPosts list now that writes have actually happened.
  const finalReport = failedPosts.length
    ? renderReport({ dateLabel, result: draft, blockTitleBySlug, blockMismatchNote: mismatchNote, failedPosts, sourcesByBlock, emptyRecipients: !emails.length })
    : noteReport;

  await postNote({
    title: `Market Research Briefing — ${dateLabel}`,
    content: finalReport,
    externalId: `market-research-refresh:${dateLabel}`,
  });
  log("  posted NOAN note");

  if (emails.length) {
    const emailBody = `${draft.executiveSummary}\n\n${finalReport}`; // prepended copy — the NOAN note stays unaltered
    const { deduped, reason } = await sendReportEmail({
      agent: "market-research-refresh",
      period: dateLabel,   // same window identifier as the note's externalId above
      to: emails,
      subject: `Market Research Briefing — ${dateLabel}`,
      html: renderReportEmailHtml(emailBody),
      text: emailBody,
    });
    log(deduped
      ? `  email skipped for ${dateLabel}: ${reason}`
      : `  emailed the report recipients (${emails.length} recipient(s))`);
  } else {
    log("  warn: no contacts carry REPORT_RECIPIENT_TAG — email skipped");
  }

  log("run complete. (stateless automation — nothing persisted.)");
}

main().catch(e => { console.error("fatal:", e); process.exit(1); });
