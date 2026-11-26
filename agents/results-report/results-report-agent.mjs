// No tools here: the worker reads the facts, checks the draft and does every write.
import { callClaude } from "../shared/anthropic.mjs";
import { companyName } from "../shared/noan.mjs";
import { renderTrace } from "./figure-check.mjs";

export const MODEL = process.env.RESULTS_REPORT_MODEL || "claude-opus-5";
const FACT_CHAR_CAP = 9000;

export function factsPrompt(facts) {
  return facts.map(f => {
    const body = f.content.length > FACT_CHAR_CAP ? `${f.content.slice(0, FACT_CHAR_CAP)}\n[...fact truncated]` : f.content;
    return `## ${f.stack} / ${f.block}\n\n${body}`;
  }).join("\n\n");
}

async function system({ config, playbook, rules = [] }) {
  return `You are the results reporting automation for ${await companyName()}. You write investor documents only from the reporting facts you are given.

# Operating procedure (Agent Config)

${config}

# Tone and templates (Playbook)

${playbook}
${rules.length ? `\n# The company's rules: follow them, never quote them\n\n${factsPrompt(rules)}\n` : ""}
# Rules the code enforces

Every figure you write is checked against the facts by value, by comparison basis (current, prior year, growth, year to date, consensus, first reported) and by the metric words around it. A figure that does not match a fact on all three stops the document from being saved. So use only figures that appear in the facts, keep each figure next to the words that name its metric, and say "a year earlier", "up", "consensus" or "first reported" exactly where the fact does. Give a cause for a movement only where a fact states it.

Return the document as markdown and nothing else. Its first line is its title, as a level-one heading.`;
}

export async function draftReport({ config, playbook, facts, rules = [], reportType, period, feedback = null, model = MODEL }) {
  const parts = [
    `Write the ${reportType} for ${period}.`,
    `# Reporting facts\n\n${factsPrompt(facts)}`,
  ];
  if (feedback) {
    parts.push(`# Your previous draft\n\n${feedback.draft}`,
      `# Figures in that draft the facts do not support\n\n${renderTrace({ ...feedback.check, traced: [], valueOnly: [] }, { title: "Not traced" })}\n`
      + "Rewrite the whole document. Correct each figure above to the one the facts give, with the same comparison basis and metric words, or remove it.");
  }
  const text = await callClaude({
    system: await system({ config, playbook, rules }),
    user: parts.join("\n\n"),
    model,
    maxTokens: 32000,
    usage: { action: feedback ? "redraft" : "draft" },
  });
  return String(text || "").trim();
}

export function titleOf(markdown) {
  return markdown.match(/^#\s+(.+)/)?.[1].trim() || null;
}
