/**
 * Shared markdown -> HTML for report emails (fact-alignment, weekly-activity-report,
 * growth-metrics-refresh, product-usage-refresh, market-research-refresh). Every one of
 * these reports is authored in markdown, posted verbatim as a NOAN note, and separately
 * rendered to HTML for the Growth Team email — this is that renderer.
 *
 * One worker upstream has its own tiny inline markdownToHtml, but several of these five
 * reports' Playbooks require real pipe tables (Fact Updates, Metrics This Period) and
 * multi-line bullet items — pr-sweep's version handles neither. Factored out once here
 * rather than duplicated five times with the same gaps.
 *
 * Ported from the report-email renderer upstream (same three fixes that
 * script's docstring calls out: wrapped paragraphs, wrapped list-item continuation lines,
 * and pipe tables as real <table> markup).
 */
import { agentName } from "./required-env.mjs";

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inline(text) {
  let t = escapeHtml(text);
  // [text](https://…) → a link. Added 2026-09-09 so the PR sweep can link each PR
  // number to GitHub: that report is worked by hand, and a click
  // beats a lookup. escapeHtml has already run, so the href is entity-safe.
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
  t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  t = t.replace(/`(.+?)`/g, "<code>$1</code>");
  t = t.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, "<em>$1</em>");
  return t;
}

function tableCells(line) {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split("|").map(c => c.trim());
}

function renderTable(rows) {
  const header = tableCells(rows[0]);
  const body = rows.length > 2 ? rows.slice(2).map(tableCells) : []; // rows[1] is the --- separator
  const th = header
    .map(h => `<th style="text-align:left;padding:8px 10px;border-bottom:2px solid #ccc;background:#f5f5f5;">${inline(h)}</th>`)
    .join("");
  const trs = body
    .map(r => `<tr>${r.map(c => `<td style="padding:8px 10px;border-bottom:1px solid #e5e5e5;vertical-align:top;">${inline(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table style="border-collapse:collapse;width:100%;font-size:13px;margin:12px 0;"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

/** Convert one report's markdown body to inner HTML (no outer wrapper). */
export function markdownToHtml(md) {
  const lines = String(md).split("\n");
  const out = [];
  let tableBuf = [];
  let paraBuf = [];
  let liBuf = null;
  let inList = false;

  const flushLi = () => {
    if (liBuf !== null) {
      out.push(`<li>${inline(liBuf.join(" "))}</li>`);
      liBuf = null;
    }
  };
  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p>${inline(paraBuf.join(" "))}</p>`);
      paraBuf = [];
    }
  };
  const flushTable = () => {
    if (tableBuf.length) {
      out.push(renderTable(tableBuf));
      tableBuf = [];
    }
  };
  const closeList = () => {
    flushLi();
    if (inList) { out.push("</ul>"); inList = false; }
  };

  for (const line of lines) {
    const stripped = line.trim();
    const isTableRow = stripped.startsWith("|");

    if (isTableRow) {
      flushPara();
      closeList();
      tableBuf.push(line);
      continue;
    }
    flushTable();

    if (stripped.startsWith("### ")) {
      flushPara(); closeList();
      out.push(`<h3>${inline(stripped.slice(4))}</h3>`);
    } else if (stripped.startsWith("## ")) {
      flushPara(); closeList();
      out.push(`<h2 style="margin-top:28px;border-bottom:1px solid #ddd;padding-bottom:4px;">${inline(stripped.slice(3))}</h2>`);
    } else if (stripped.startsWith("# ")) {
      flushPara(); closeList();
      out.push(`<h1>${inline(stripped.slice(2))}</h1>`);
    } else if (stripped.startsWith("- ")) {
      flushPara(); flushLi();
      if (!inList) { out.push("<ul>"); inList = true; }
      liBuf = [stripped.slice(2)];
    } else if (stripped === "") {
      flushPara(); closeList();
    } else if (inList && liBuf !== null) {
      // wrapped continuation line of the current list item
      liBuf.push(stripped);
    } else {
      closeList();
      paraBuf.push(stripped);
    }
  }
  flushTable();
  flushPara();
  closeList();
  return out.join("\n");
}

/* The newsletter shell moved to newsletter-email.mjs:
 * issues are written by people and read by customers, and their renderer now bends
 * toward that without moving these reports. Re-exported so existing imports hold. */
export { renderNewsletterHtml } from "./newsletter-email.mjs";

/** Full email body: the report's markdown wrapped in a readable envelope. */
export function renderReportEmailHtml(md) {
  const body = markdownToHtml(md);
  return [
    `<div style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:640px;margin:0 auto;line-height:1.5;">`,
    body,
    `<p style="margin-top:32px;padding-top:16px;border-top:1px solid #ddd;color:#666;font-size:13px;">Full detail is in NOAN. This is an automated report from a NOAN growth automation.</p>`,
    `</div>`,
  ].join("\n");
}
