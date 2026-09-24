/**
 * The newsletter's own markdown, and the shell it is sent in.
 *
 * Split out of markdown-email.mjs because the two
 * renderers answer different readers. The report emails are generated
 * markdown read by the team on a white page; an issue is written by a person,
 * or captured by the agent from Slack, and read by customers on the dark ground.
 * Every rule below was bent toward the issues, and the reports must not move
 * when it is.
 *
 * WHAT THE ISSUES ACTUALLY LOOK LIKE (the 14 Newsletter-tagged assets, read
 * 2026-09-21). A subheading is written three ways, and the old converter
 * understood one:
 *
 *   `## Heading`            2 older team issues. Rendered, but styled only by
 *                           <style>, which Outlook and Gmail on non-Google
 *                           accounts drop, and at 20px over 17px body text.
 *   `**Heading**` alone     7 issues, the MCP release among them. Came out as
 *                           a bold paragraph.
 *   a bare short line       the latest issue (the Slack capture). JOINED INTO
 *                           THE PARAGRAPH BELOW IT: "Your whole team, wherever
 *                           she is Anyone from your company can use...".
 *
 * All three now become a heading, and every element carries its style INLINE
 * as well as in <style>, from one constant, so no client falls back to its
 * defaults. The bare-line and bold-line promotions are heuristics, so they are
 * reported: parseIssue() returns the lines it promoted and the worker prints
 * them in the dry-run and test summary, before anything goes live.
 *
 * BUTTONS. A line that is ONLY `[Words](https://...)` becomes a button saying
 * Words (decided 2026-09-21). A bare URL on its own line stays a link, because
 * there is no honest way to guess the words, and a label over 40 characters
 * stays a link, because a sentence is not a button.
 *
 * Also: `---` is a rule (it printed as "---"), `1.` is an ordered list (the
 * lines ran together), `* ` and `+ ` are bullets, `>` is a pull quote, bare
 * URLs are links, backslash escapes are unescaped, and two trailing spaces are
 * a line break. The plain-text part comes from the same parse (blocksToText),
 * not the raw markdown.
 *
 * No em dashes anywhere in this file's output: it ships inside customer email,
 * and its test holds the shell to the external copy rule.
 */
import { agentName } from "./required-env.mjs";
import { dimsFromUrl } from "./newsletter-images.mjs";

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ---------------- the palette ----------------
 * The company site's design system: the ground, ivory text at the site's
 * alphas, teal for the live glyph and links, the lit orange of the site's
 * primary button (.u-btn-primary), Tusker Grotesk uppercase for display type,
 * the readout grammar for the eyebrow and footer, the white wordmark.
 *
 * Colors are hex, not rgba, because email clients composite rgba unreliably:
 * ivory (#ece9e2) on the ground (#0a0b10) at 0.92 / 0.72 / 0.55 / 0.38, the rim
 * at 0.12, and the site's lit (254 134 71) at 0.6 for the button's border and
 * 0.07 for its fill. */
export const NL = {
  ground: "#0a0b10", surface: "#111319",
  ivory92: "#dad8d2", ivory72: "#b1afab", ivory55: "#8b8a88", ivory38: "#636362",
  rim: "#262830", teal: "#5ee8c0",
  litRim: "#9c5531", litFill: "#1b1414", litText: "#ffb48a", lit: "#fe8647",
  // The wordmark and the font files are the company's own assets, so they
  // come from the environment (read at render time, not import time, so a
  // service that loads config.defaults.env after importing this still sees
  // them). Unset: a text wordmark in the company's name and no @font-face;
  // the stacks below fall through to system faces.
  get wordmark() { return (process.env.EMAIL_WORDMARK_URL || "").trim(); },
  get fonts() { return (process.env.EMAIL_FONTS_URL || "").trim().replace(/\/+$/, ""); },
  // Synchronous by design: COMPANY_NAME, else the agent's name, so an unset
  // company never renders an empty wordmark or footer.
  get company() { return (process.env.COMPANY_NAME || "").trim() || agentName(); },
};

const BODY_FACE = `'Aktiv Grotesk',-apple-system,'Helvetica Neue',Helvetica,Arial,sans-serif`;
const MONO_FACE = `ui-monospace,Menlo,Consolas,monospace`;
export const NL_TITLE_FACE = `'Tusker Grotesk','Aktiv Grotesk',Impact,'Helvetica Neue',Arial,sans-serif`;

/*
 * The display title's type, in ONE place: the <style> rule and the inline
 * attribute both interpolate it, so they cannot drift.
 *
 * Leading follows the site's fluid scale (its stylesheet), which loosens as
 * size drops: display 48-96px is 1.08, h1 36-60px is 1.1. This title is 40px,
 * so it sits in the h1 band. It was 0.95, the DECK's leading at slide size,
 * which read as cramped over three wrapped lines of caps (decided 2026-09-15).
 * Tracking -0.01em matches the site's .font-display.
 */
export const NL_TITLE_TYPE = "font-size:40px;line-height:1.1;letter-spacing:-0.01em;text-transform:uppercase;";

/*
 * Every body element's style, once. Used inline on the element (the copy every
 * client honors) AND as the <style> rule (the copy that wins in a client that
 * strips inline styles it dislikes). The old shell styled headings only in
 * <style>, which is why a subheading could arrive as browser-default type.
 *
 * The section head is the display face at 26px: a clear step down from the
 * 40px title and a clear step up from the 17px body. The minor head is the
 * body face in bold at 19px, for `###` and deeper.
 */
export const S = {
  p: `margin:0 0 18px;font-family:${BODY_FACE};font-size:17px;line-height:1.6;color:${NL.ivory72};`,
  h2: `margin:40px 0 12px;font-family:${NL_TITLE_FACE};font-size:26px;line-height:1.15;letter-spacing:0;text-transform:uppercase;font-weight:400;color:${NL.ivory92};`,
  h3: `margin:28px 0 8px;font-family:${BODY_FACE};font-size:19px;line-height:1.35;font-weight:700;color:${NL.ivory92};`,
  list: `margin:0 0 18px;padding:0 0 0 22px;font-family:${BODY_FACE};font-size:17px;line-height:1.6;color:${NL.ivory72};`,
  li: `margin:0 0 8px;`,
  quote: `margin:6px 0 24px;padding:2px 0 2px 18px;border-left:2px solid ${NL.teal};font-family:${BODY_FACE};font-size:19px;line-height:1.5;color:${NL.ivory92};`,
  a: `color:${NL.teal};text-decoration:underline;`,
  strong: `color:${NL.ivory92};font-weight:700;`,
  code: `font-family:${MONO_FACE};font-size:15px;color:${NL.ivory92};`,
  table: `border-collapse:collapse;margin:0 0 18px;width:100%;font-family:${BODY_FACE};font-size:15px;line-height:1.5;color:${NL.ivory72};`,
  th: `border-bottom:1px solid ${NL.rim};padding:8px 10px;text-align:left;vertical-align:top;color:${NL.ivory92};font-weight:700;`,
  td: `border-bottom:1px solid ${NL.rim};padding:8px 10px;text-align:left;vertical-align:top;`,
  // The site's .u-btn-primary: mono, uppercase, tracked, 6px radius, the lit
  // border over a faint lit fill, lit text. The glyph is the site's.
  button: `display:inline-block;padding:14px 22px;border:1px solid ${NL.litRim};border-radius:6px;background:${NL.litFill};font-family:${MONO_FACE};font-size:13px;line-height:1;letter-spacing:0.12em;text-transform:uppercase;text-decoration:none;color:${NL.litText};`,
};

/* ---------------- inline markdown ---------------- */

// Private-use characters stand in for backslash-escaped markdown characters
// and for code spans while the inline rules run, so `\*` and `a_b_c` in code
// never turn into emphasis.
const ESC_BASE = 0xe000;
const ESCAPABLE = /\\([\\`*_{}[\]()#+\-.!>|~])/g;
const URL_TAIL = /[.,;:!?)\]'"]+$/;

function protect(text) {
  const saved = [];
  const hold = (s) => { saved.push(s); return String.fromCharCode(ESC_BASE + saved.length - 1); };
  let t = String(text).replace(ESCAPABLE, (_, c) => hold({ kind: "char", value: c }));
  t = t.replace(/`([^`]+)`/g, (_, c) => hold({ kind: "code", value: c }));
  return { t, saved };
}
function restore(t, saved, render) {
  return t.replace(/[-]/g, ch => {
    const item = saved[ch.charCodeAt(0) - ESC_BASE];
    return item ? render(item) : ch;
  });
}

/** One line of inline markdown to HTML, every element styled inline. */
export function inlineHtml(text) {
  const { t: held, saved } = protect(text);
  const links = [];
  const linkToken = (html) => { links.push(html); return `\u0000${links.length - 1}\u0000`; };
  let t = escapeHtml(held);
  // [label](url): labels are already escaped; the href is escaped again in
  // attribute context (the quote was not in the text escape before 2026-09-21).
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g, (_, label, url) =>
    linkToken(`<a href="${url.replace(/"/g, "&quot;")}" style="${S.a}">${label}</a>`));
  // Bare URLs, with trailing sentence punctuation left outside the link.
  t = t.replace(/https?:\/\/[^\s<]+/g, (m) => {
    const tail = (m.match(URL_TAIL) || [""])[0];
    const url = tail ? m.slice(0, -tail.length) : m;
    return linkToken(`<a href="${url}" style="${S.a}">${url}</a>`) + tail;
  });
  t = t.replace(/\*\*(.+?)\*\*/g, `<strong style="${S.strong}">$1</strong>`);
  t = t.replace(/(^|[^\w])__(.+?)__(?!\w)/g, `$1<strong style="${S.strong}">$2</strong>`);
  t = t.replace(/(?<![*\w])\*(?!\s)([^*]+?)\*(?![*\w])/g, "<em>$1</em>");
  t = t.replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, "$1<em>$2</em>");
  t = t.replace(/\u0000(\d+)\u0000/g, (_, i) => links[Number(i)]);
  return restore(t, saved, item => item.kind === "code"
    ? `<code style="${S.code}">${escapeHtml(item.value)}</code>`
    : escapeHtml(item.value));
}

/** One line of inline markdown to plain text: `label (url)`, no markers. */
export function inlineText(text) {
  const { t: held, saved } = protect(text);
  let t = held.replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, (_, label, url) => (label === url ? url : `${label} (${url})`));
  t = t.replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/(^|[^\w])__(.+?)__(?!\w)/g, "$1$2")
    .replace(/(?<![*\w])\*(?!\s)([^*]+?)\*(?![*\w])/g, "$1")
    .replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, "$1$2");
  return restore(t, saved, item => item.value);
}

/* ---------------- block parse ---------------- */

const RX = {
  heading: /^(#{1,6})\s+(.*?)\s*#*\s*$/,
  hr: /^([-*_])(?:\s*\1){2,}\s*$/,
  ul: /^[-*+]\s+(.*)$/,
  ol: /^(\d{1,3})[.)]\s+(.*)$/,
  quote: /^>\s?(.*)$/,
  table: /^\|/,
  fence: /^(```|~~~)/,
  // ![description](url) alone on a line: a picture.
  image: /^!\[([^\]]*)\]\((\S+?)\)$/,
  // A line that is only emphasis: **Heading**, __Heading__, optionally with
  // the colon inside or outside the markers.
  boldLine: /^(\*\*|__)([^*_].*?)\1\s*:?\s*$/,
  // [Words](url) and nothing else on the line, optionally after an arrow an
  // author used to point at it ("→ [Get my stack preview](...)", the Claude
  // issue). The button draws its own glyph, so the arrow is dropped.
  button: /^(?:→|->|»|▸|&rarr;)?\s*\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/,
};
export const BUTTON_MAX = 40;
export const BARE_HEAD_MAX = 70;

function kindOf(stripped) {
  if (!stripped) return "blank";
  if (RX.fence.test(stripped)) return "fence";
  if (RX.table.test(stripped)) return "table";
  if (RX.image.test(stripped)) return "image";
  if (RX.heading.test(stripped)) return "heading";
  if (RX.hr.test(stripped)) return "hr";
  if (RX.ul.test(stripped)) return "ul";
  if (RX.ol.test(stripped)) return "ol";
  if (RX.quote.test(stripped)) return "quote";
  return "text";
}

/**
 * A bare line that is really a subheading: short, no closing punctuation, not
 * a link or a URL, and followed directly by a longer line of prose that reads
 * as a sentence. "Hi there," ends in a comma; a two-line sign-off (a name
 * over a role) is followed by a shorter line; neither is promoted.
 */
export function looksLikeBareHead(line, next) {
  const l = line.trim(), n = (next || "").trim();
  if (l.length < 2 || l.length > BARE_HEAD_MAX) return false;
  if (/[.,:;?!…]$/.test(l)) return false;
  if (/https?:\/\/|\]\(/.test(l)) return false;
  if (RX.boldLine.test(l)) return false;
  if (kindOf(n) !== "text" || RX.button.test(n)) return false;
  if (n.length <= l.length) return false;
  return /[.!?]["'”’)]?(\s|$)/.test(n);
}

function stripTrailingColon(s) { return s.replace(/\s*:\s*$/, ""); }

/**
 * Markdown to blocks. `promote` turns on the two heuristics (bold-only lines
 * and bare lines as subheadings); the internal send report passes false, since
 * it is generated and its bold lines mean bold.
 *
 * Returns { blocks, promoted, buttons }: promoted is every line a heuristic
 * turned into a heading, buttons every CTA with its words, both for the
 * summary a person reads before the issue goes live.
 */
export function parseIssue(md, { promote = true } = {}) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [], promoted = [], buttons = [], images = [], inlineImages = [];
  let para = null, list = null, quote = null, table = null;

  const flushPara = () => { if (para) { blocks.push({ type: "p", lines: para }); para = null; } };
  const flushList = () => { if (list) { blocks.push(list); list = null; } };
  const flushQuote = () => { if (quote) { blocks.push({ type: "quote", lines: quote }); quote = null; } };
  const flushTable = () => { if (table) { blocks.push({ type: "table", rows: table }); table = null; } };
  const flushAll = () => { flushPara(); flushList(); flushQuote(); flushTable(); };
  const nextNonBlank = (i) => { for (let j = i + 1; j < lines.length; j++) if (lines[j].trim()) return lines[j]; return null; };
  // A hard break is two trailing spaces; keep the flag, drop the spaces.
  const lineOf = (raw) => ({ text: raw.trim(), br: / {2,}$/.test(raw) });

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const stripped = raw.trim();
    const kind = kindOf(stripped);

    if (kind !== "table") flushTable();
    if (kind !== "quote") flushQuote();

    if (kind === "blank") { flushPara(); flushList(); continue; }

    if (kind === "table") {
      flushPara(); flushList();
      (table ||= []).push(stripped);
      continue;
    }
    if (kind === "heading") {
      flushAll();
      const [, hashes, text] = RX.heading.exec(stripped);
      if (text) blocks.push({ type: hashes.length <= 2 ? "h2" : "h3", text });
      continue;
    }
    if (kind === "hr") { flushAll(); blocks.push({ type: "hr" }); continue; }
    // A fenced block. The agent's Slack reply hands the picture line back inside a
    // code block so it copies cleanly, and the fences come with it when a person
    // selects the whole thing (the first issue with a picture, 2026-09-21, showed
    // "```" above and below it). Fence lines never reach the reader: the lines
    // between them are parsed as if the fences were not there, and an unclosed
    // fence is just dropped.
    if (kind === "fence") { flushPara(); continue; }
    if (kind === "image") {
      flushAll();
      const [, alt, url] = RX.image.exec(stripped);
      blocks.push({ type: "image", alt: alt.trim(), url });
      images.push({ alt: alt.trim(), url });
      continue;
    }
    // A picture written inside a sentence cannot be laid out in an email; the
    // worker refuses it with the fix (put it on its own line).
    for (const m of stripped.matchAll(/!\[([^\]]*)\]\((\S+?)\)/g)) inlineImages.push({ alt: m[1].trim(), url: m[2] });
    if (kind === "ul" || kind === "ol") {
      flushPara();
      if (list && list.type !== kind) flushList();
      if (!list) list = { type: kind, start: kind === "ol" ? Number(RX.ol.exec(stripped)[1]) : 1, items: [] };
      list.items.push([lineOf(raw.replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, ""))]);
      continue;
    }
    if (kind === "quote") {
      flushPara(); flushList();
      (quote ||= []).push(lineOf(RX.quote.exec(stripped)[1] + (/ {2,}$/.test(raw) ? "  " : "")));
      continue;
    }

    // Plain text from here.
    if (list) { list.items[list.items.length - 1].push(lineOf(raw)); continue; }   // wrapped item

    if (!para) {
      const next = lines[i + 1];
      const nextBlankOrEnd = next === undefined || !next.trim();
      const btn = RX.button.exec(stripped);
      if (btn && nextBlankOrEnd && btn[1].trim().length <= BUTTON_MAX) {
        const label = btn[1].trim();
        blocks.push({ type: "button", label, url: btn[2] });
        buttons.push(label);
        continue;
      }
      if (promote) {
        const bold = RX.boldLine.exec(stripped);
        const hasContentAfter = nextNonBlank(i) !== null;
        // Several sentences in bold ("Stay epic. Stay banging. Let's go.") are
        // a sign-off, not a heading.
        // A leading "1. " numbers a section; it is not a sentence end.
        const sentences = bold ? bold[2].trim().replace(/^\d{1,3}[.)]\s+/, "").split(/[.!?]\s+(?=\S)/).length : 0;
        if (bold && bold[2].trim().length <= BARE_HEAD_MAX && hasContentAfter && !bold[2].includes("**") && sentences === 1) {
          const text = stripTrailingColon(bold[2].trim());
          blocks.push({ type: "h2", text, promoted: "bold" });
          promoted.push(text);
          continue;
        }
        if (blocks.length && looksLikeBareHead(stripped, next)) {
          blocks.push({ type: "h2", text: stripped, promoted: "bare" });
          promoted.push(stripped);
          continue;
        }
      }
    }
    (para ||= []).push(lineOf(raw));
  }
  flushAll();
  return { blocks, promoted, buttons, images, inlineImages };
}

/* ---------------- blocks to HTML and text ---------------- */

/*
 * Where one line of a paragraph meets the next. A soft wrap (the author's
 * editor wrapped a long line) joins with a space; a short line is a line the
 * author ENDED, and keeps its break: a two-line sign-off (a name over a role)
 * ran together onto one line when every newline was a space.
 * Hard-wrapped prose wraps at 70-80 characters, so a line under 60 was ended
 * on purpose. Two trailing spaces are a break whatever the length.
 */
export const SOFT_WRAP_MIN = 60;
function joinLines(ls, render, br) {
  return ls.map((l, i) => render(l.text) + (i < ls.length - 1 ? (l.br || l.text.length < SOFT_WRAP_MIN ? br : " ") : "")).join("");
}

function tableCells(row) {
  let l = row.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split("|").map(c => c.trim());
}
function isSeparatorRow(row) { return /^\|?[\s:|-]+\|?$/.test(row.trim()) && row.includes("-"); }

function buttonHtml({ label, url }) {
  const href = url.replace(/"/g, "&quot;");
  // Table-built so Outlook keeps the padding and the border; the <a> carries
  // every style again for the clients that honor it over the cell.
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 26px;border-collapse:separate;"><tr><td style="border-radius:6px;background:${NL.litFill};">`
    + `<a href="${href}" style="${S.button}"><span style="color:${NL.lit};">&#9656;</span>&nbsp; ${escapeHtml(label)}</a>`
    + `</td></tr></table>`;
}

/*
 * A picture: full column width at most, never wider than it really is. Width
 * and height come from the stored name (`-1200x630.jpg`, newsletter-images.mjs)
 * because Outlook lays out an <img> by its attributes and ignores CSS max-width;
 * the inline style makes every other client scale it down on a phone. The alt
 * text is styled so a client that blocks images shows a readable line instead
 * of a broken-image box.
 */
function imageHtml({ alt, url }) {
  const d = dimsFromUrl(url);
  const w = d ? Math.min(600, d.width) : 600;
  const h = d ? Math.round((w * d.height) / d.width) : null;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:6px 0 26px;">`
    + `<img src="${url.replace(/"/g, "&quot;")}" alt="${escapeHtml(alt)}" width="${w}"${h ? ` height="${h}"` : ""} style="display:block;width:100%;max-width:${w}px;height:auto;border:0;outline:none;text-decoration:none;border-radius:6px;font-family:${BODY_FACE};font-size:14px;line-height:1.4;color:${NL.ivory55};">`
    + `</td></tr></table>`;
}

const HR_HTML = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:14px 0 30px;"><div style="height:1px;line-height:1px;font-size:1px;background:${NL.rim};">&nbsp;</div></td></tr></table>`;

export function blocksToHtml(blocks) {
  const out = [];
  blocks.forEach((b, idx) => {
    switch (b.type) {
      case "h2":
      case "h3": {
        // The first block sits right under the title, which has its own margin.
        const style = idx === 0 ? S[b.type].replace(/^margin:\d+px/, "margin:0") : S[b.type];
        out.push(`<${b.type} style="${style}">${inlineHtml(b.text)}</${b.type}>`);
        break;
      }
      case "p": out.push(`<p style="${S.p}">${joinLines(b.lines, inlineHtml, "<br>")}</p>`); break;
      case "quote": out.push(`<blockquote style="${S.quote}">${joinLines(b.lines, inlineHtml, "<br>")}</blockquote>`); break;
      case "hr": out.push(HR_HTML); break;
      case "button": out.push(buttonHtml(b)); break;
      case "image": out.push(imageHtml(b)); break;
      case "ul":
      case "ol": {
        const start = b.type === "ol" && b.start !== 1 ? ` start="${b.start}"` : "";
        const items = b.items.map(ls => `<li style="${S.li}">${joinLines(ls, inlineHtml, "<br>")}</li>`).join("");
        out.push(`<${b.type}${start} style="${S.list}">${items}</${b.type}>`);
        break;
      }
      case "table": {
        const rows = b.rows.filter(r => !isSeparatorRow(r)).map(tableCells);
        const hasHead = b.rows.length > 1 && isSeparatorRow(b.rows[1]);
        const [head, ...body] = hasHead ? rows : [null, ...rows];
        const th = head ? `<thead><tr>${head.map(c => `<th style="${S.th}">${inlineHtml(c)}</th>`).join("")}</tr></thead>` : "";
        const trs = body.map(r => `<tr>${r.map(c => `<td style="${S.td}">${inlineHtml(c)}</td>`).join("")}</tr>`).join("");
        out.push(`<table role="presentation" cellpadding="0" cellspacing="0" style="${S.table}">${th}<tbody>${trs}</tbody></table>`);
        break;
      }
    }
  });
  return out.join("\n");
}

/** The plain-text part, from the same blocks: reads as text, not as markdown. */
export function blocksToText(blocks) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case "h2": out.push(inlineText(b.text).toUpperCase()); break;
      case "h3": out.push(inlineText(b.text)); break;
      case "p": out.push(joinLines(b.lines, inlineText, "\n")); break;
      case "quote": out.push(joinLines(b.lines, inlineText, "\n").split("\n").map(l => `> ${l}`).join("\n")); break;
      case "hr": out.push("---"); break;
      case "button": out.push(`${b.label}: ${b.url}`); break;
      case "image": out.push(`[Image: ${b.alt || "picture"}]`); break;
      case "ul": out.push(b.items.map(ls => `- ${joinLines(ls, inlineText, "\n  ")}`).join("\n")); break;
      case "ol": out.push(b.items.map((ls, i) => `${b.start + i}. ${joinLines(ls, inlineText, "\n   ")}`).join("\n")); break;
      case "table": out.push(b.rows.filter(r => !isSeparatorRow(r)).map(r => tableCells(r).map(inlineText).join(" | ")).join("\n")); break;
    }
  }
  return out.join("\n\n");
}

/* ---------------- what must never reach an inbox ---------------- */

/**
 * The Slack capture's provenance line. When the agent captures an issue from
 * Slack it signs the asset "Captured by <agent> from Slack for <@U...> (Name)."
 * That line is for the workspace, not the reader, and the 2026-09 Slack issue
 * would have mailed it to the whole audience (decided 2026-09-21: remove it,
 * and list what was removed in the summary). Matched on its shape, not on
 * the agent's name, so a renamed agent's capture line goes too.
 */
export const CAPTURE_LINE = /^\s*[_*]*\s*captured by .{1,60} from slack\b.*$/i;

/** Remove capture lines. Returns the body and what was removed, for the summary. */
export function stripCaptureLines(body) {
  const removed = [];
  const kept = String(body ?? "").split("\n").filter(l => {
    if (CAPTURE_LINE.test(l)) { removed.push(l.trim()); return false; }
    return true;
  });
  return { body: kept.join("\n").trim(), removed };
}

/** A Slack token anywhere else is an unfinished issue: <@U123>, <#C123|name>, <!here>. */
export const SLACK_TOKEN = /<[@#!][A-Za-z0-9^|._ -]{1,80}>/g;

/* ---------------- the shell ---------------- */

/**
 * `title` is the document title and the subject this was sent under.
 * `headline` is the big display line at the top of the body, and it is a
 * DIFFERENT string for an issue: the subject comes from the asset's title and
 * the headline from its description (decided 2026-09-15). Defaults to `title`,
 * which is what the internal send report wants.
 *
 * `promote: false` for generated markdown (the send report), whose bold lines
 * mean bold. The unsubscribe footer is rendered HERE rather than left to the
 * author, so no issue can go out without one; `unsubscribeUrl: null` drops it,
 * for the internal report only. `preheader` is the inbox preview text: hidden,
 * padded with invisible characters so the client does not run the first body
 * line on after it.
 */
export function renderNewsletterHtml({ title, headline = "", markdown, unsubscribeUrl, preheader = "", dateLabel = "", promote = false }) {
  const display = headline || title;
  const body = blocksToHtml(parseIssue(markdown, { promote }).blocks);
  const pre = preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${NL.ground};">${escapeHtml(preheader)}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>`
    : "";
  const eyebrow = `<span style="color:${NL.teal};">&#9656;</span> newsletter${dateLabel ? ` &middot; ${escapeHtml(dateLabel)}` : ""}`;
  const footer = unsubscribeUrl
    ? `<tr><td style="padding:28px 0 0;border-top:1px solid ${NL.rim};font-family:${MONO_FACE};font-size:12px;line-height:1.7;color:${NL.ivory38};">
         You are receiving this because you are in touch with ${escapeHtml(NL.company)}.<br>
         <a href="${escapeHtml(unsubscribeUrl)}" style="color:${NL.ivory55};text-decoration:underline;">&#8599; unsubscribe</a> &middot; replies reach ${escapeHtml(agentName())}
       </td></tr>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="supported-color-schemes" content="dark">
<title>${escapeHtml(title)}</title>
<style>
${NL.fonts ? `  @font-face { font-family: "Tusker Grotesk"; src: url("${NL.fonts}/tusker-grotesk.woff2") format("woff2"); font-weight: 400; font-display: swap; }
  @font-face { font-family: "Aktiv Grotesk"; src: url("${NL.fonts}/aktiv-grotesk-400.woff2") format("woff2"); font-weight: 400; font-display: swap; }
  @font-face { font-family: "Aktiv Grotesk"; src: url("${NL.fonts}/aktiv-grotesk-700.woff2") format("woff2"); font-weight: 700; font-display: swap; }
` : ""}  body { margin: 0; background: ${NL.ground}; }
  .nl p { ${S.p} }
  .nl h2 { ${S.h2} }
  .nl h3 { ${S.h3} }
  .nl ul, .nl ol { ${S.list} }
  .nl li { ${S.li} }
  .nl blockquote { ${S.quote} }
  .nl a { ${S.a} }
  .nl strong { ${S.strong} }
  .nl code { ${S.code} }
  .nl-title { font-family: ${NL_TITLE_FACE}; ${NL_TITLE_TYPE} color: ${NL.ivory92}; margin: 0 0 26px; }
  @media (max-width: 480px) {
    .nl-title { font-size: 32px !important; }
    .nl h2 { font-size: 22px !important; }
  }
</style>
</head>
<body style="margin:0;background:${NL.ground};">
${pre}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${NL.ground};">
<tr><td align="center" style="padding:36px 16px 48px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;">
  <tr><td style="padding:0 0 34px;">
    ${NL.wordmark
      ? `<img src="${NL.wordmark}" width="96" height="21" alt="${escapeHtml(NL.company)}" style="display:block;width:96px;height:21px;border:0;">`
      : `<div style="font-family:${NL_TITLE_FACE};font-size:18px;letter-spacing:0.08em;text-transform:uppercase;color:${NL.ivory92};">${escapeHtml(NL.company)}</div>`}
  </td></tr>
  <tr><td style="padding:0 0 14px;font-family:${MONO_FACE};font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:${NL.ivory55};">${eyebrow}</td></tr>
  <tr><td><h1 class="nl-title" style="font-family:${NL_TITLE_FACE};${NL_TITLE_TYPE}color:${NL.ivory92};margin:0 0 26px;">${escapeHtml(display)}</h1></td></tr>
  <tr><td class="nl" style="font-family:${BODY_FACE};color:${NL.ivory72};font-size:17px;line-height:1.6;padding:0 0 10px;">
${body}
  </td></tr>
  ${footer}
</table>
</td></tr>
</table>
</body>
</html>`;
}
