/** A figure traces only to a fact figure with the same value, comparison basis and metric words. */

const MONTHS = "January February March April May June July August September October November December".split(" ");
const TOKEN = new RegExp(
  "(?<mdate>(?:" + MONTHS.join("|") + ") \\d{1,2}, \\d{4})"
  + "|(?<iso>\\d{4}-\\d{2}-\\d{2})"
  + "|(?<time>\\b\\d{2}:\\d{2}\\b)"
  + "|(?<money>(?<![\\w$])\\$\\d[\\d,]*(?:\\.\\d+)?(?: ?(?:million\\b|M\\b))?)"
  + "|(?<pct>(?<![\\w.])[+\\-−]?\\d[\\d,]*(?:\\.\\d+)?%)"
  + "|(?<mult>(?<![\\w.])\\d+(?:\\.\\d+)?x\\b)"
  + "|(?<num>(?<![\\w.$\\-])[+\\-]?\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?(?: million\\b)?)",
  "g");
const UP = /\b(up|rose|grew|increased)\s*$/;
const DOWN = /\b(down|fell|declined|decreased)\s*$/;

export const METRIC_WORDS = [
  "adjusted", "diluted", "gaap", "domestic", "international", "company", "supply", "royalties", "advertising",
  "digital", "loyalty", "free", "operating", "net", "cash", "debt", "notes", "dividend", "dividends", "shares",
  "gross", "total", "system-wide", "same-store", "weekly", "ebitda", "eps", "income", "revenue", "sales", "margin",
  "leverage", "capital", "expenditure", "interest", "tax", "fees", "technology", "franchise", "franchised",
  "repurchased", "repurchases", "employees", "members", "membership", "mix", "guidance", "opened", "closed",
  "depreciation", "amortization", "stock-based", "compensation", "weeks", "assets", "liabilities",
  "receivable", "inventories", "prepaid", "payable", "accrued", "deferred", "goodwill", "intangible", "property",
  "lease", "investing", "financing", "basic", "deficit", "proceeds", "repayment", "purchases", "beginning", "costs",
  "expense", "expenses", "earnings", "weighted", "customers", "subscribers", "arr", "recurring", "retention",
  "churn", "bookings", "backlog", "units", "locations", "stores", "aum", "fund", "funds", "commitments",
];
const EXCLUSIVE = [["adjusted", "diluted"], ["domestic", "international", "company"], ["free", "operating"]];
const SYNONYM = {
  "café": "cafés", dividends: "dividend", repurchases: "repurchased", membership: "members", notes: "debt",
  "company-owned": "company", totaled: "total", totalled: "total", amortisation: "amortization", store: "stores", location: "locations", customer: "customers", // british-input-ok
};

const num = (s) => Number(s.replace(/,/g, "").replace(/−/g, "-"));

function makeWords(extra) {
  const metric = new Set([...METRIC_WORDS, ...extra.map(w => w.toLowerCase())]);
  return (text) => {
    const out = new Set();
    for (let w of String(text).toLowerCase().match(/[a-zéè\-]+/g) || []) {
      w = SYNONYM[w] || w;
      if (w.startsWith("company")) w = "company";
      if (metric.has(w)) out.add(w);
    }
    return out;
  };
}

function keyOf(kind, raw, before) {
  if (kind === "mdate") {
    const [, mon, day, year] = raw.match(/^(\w+) (\d+), (\d+)/);
    return { t: "date", v: `${year}-${String(MONTHS.indexOf(mon) + 1).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}` };
  }
  if (kind === "iso") return { t: "date", v: raw };
  if (kind === "time") return { t: "time", v: raw };
  if (kind === "money") {
    const n = raw.match(/\d[\d,]*(?:\.\d+)?/)[0];
    return { t: /million|M$/.test(raw) ? "$M" : "$", v: num(n) };
  }
  if (kind === "pct") {
    let v = num(raw.slice(0, -1));
    let signed = "+-−".includes(raw[0]);
    if (!signed && UP.test(before)) signed = true;
    else if (!signed && DOWN.test(before)) { v = -v; signed = true; }
    return { t: "%", v, signed };
  }
  if (kind === "mult") return { t: "x", v: num(raw.slice(0, -1)) };
  return { t: "n", v: num(raw.replace(" million", "")) };
}

const DATE_KINDS = ["mdate", "iso", "time"];
const RANGE = /^\s*(?:to\s+|–\s*)[+\-−]?\$?\d/;
const PRIOR_PERIOD = /^\s*(?:at the end of (?:the )?(?:prior|previous) (?:quarter|half)|a quarter earlier|at the end of (FY\d{4} [QH][1-4]|[QH][1-4] FY\d{4}))\b/i;

function baseQualifier(kind, before, after, current) {
  if (DATE_KINDS.includes(kind)) return "current";
  const b = before.toLowerCase(), a = after.toLowerCase();
  if (b.slice(-30).includes("first reported")) return "first reported";
  if (kind === "pct" && a.slice(0, 20).includes("vs consensus")) return "vs consensus";
  if (/consensus( of)?\s*$/.test(b)) return "consensus";
  const prior = after.match(PRIOR_PERIOD);
  if (prior && !current.includes(prior[1])) return "prior period";
  if (/^\s*(a year earlier|a year ago|in the same period last year)\b/.test(a) || /\(last year\s*$/.test(b)
      || /\b(from|against)\s*$/.test(b)) return "prior year";
  // "A to B" is a range or a change, and the words don't say which, so A matches either.
  if (RANGE.test(after)) return "range low";
  if (kind === "pct" && (a.slice(0, 20).includes("vs last year") || a.slice(0, 22).includes("vs prior quarter")
      || UP.test(b) || DOWN.test(b) || /\b(up|down) from\s*$/.test(b))) return "growth";
  return "current";
}

function qualifier(kind, before, after, sentenceBefore, current) {
  const q = baseQualifier(kind, before, after, current);
  if (/year[- ]to[- ]date/i.test(sentenceBefore) && (q === "current" || q === "prior year")) {
    return q === "current" ? "ytd current" : "ytd prior";
  }
  return q;
}

const PERIOD_LABEL = /(FY\d{4}(?: Q[1-4]| H[12])?|Q[1-4] FY\d{4}|H[12] FY\d{4})/;

export function periodOf(facts) {
  for (const f of facts) {
    const m = String(f.content || "").match(new RegExp("Period: " + PERIOD_LABEL.source + "(?: \\(ended (\\d{4}-\\d{2}-\\d{2})\\))?"));
    if (m) return { label: m[1], end: m[2] || null };
  }
  return null;
}

/** "FY2026 Q3" and "Q3 FY2026" name the same period. */
function periodAliases(label) {
  const m = label.match(/^FY(\d{4}) ([QH][1-4])$/) || label.match(/^([QH][1-4]) FY(\d{4})$/);
  if (!m) return [label];
  const [year, part] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
  return [`FY${year} ${part}`, `${part} FY${year}`];
}

function makePeriodQualifier(period) {
  const aliases = period ? periodAliases(period.label) : [];
  const fy = period ? period.label.match(/FY(\d{4})/)[1] : null;
  const fullYear = period ? /Q4|H2|^FY\d{4}$/.test(period.label) : false;
  return (cell) => {
    if (aliases.includes(cell)) return "current";
    const m = cell.match(/^(YTD )?FY(\d{4})$/);
    if (m && (m[1] || fullYear)) return m[2] === fy ? "ytd current" : "ytd prior";
    if (/^\d{4}-\d{2}-\d{2}$/.test(cell)) return period && cell === period.end ? "current" : "prior year end";
    if (/^(FY\d{4} [QH][1-4]|[QH][1-4] FY\d{4})$/.test(cell)) {
      const yearAgo = period && periodAliases(period.label).map(l => l.replace(/\d{4}/, y => String(y - 1)));
      return yearAgo?.includes(cell) ? "prior year" : "prior period";
    }
    if (["growth", "change"].includes(cell.toLowerCase())) return "growth";
    return null;
  };
}

function tokens(text) {
  return [...text.matchAll(TOKEN)].map(m => ({
    kind: Object.keys(m.groups).find(k => m.groups[k] !== undefined),
    raw: m[0], start: m.index, end: m.index + m[0].length,
  }));
}

const SEP = /;\s*|\.\s+|\s·\s|,\s+(?!\d{3}\b)/g;
const stripParens = (s) => s.replace(/\(.*?\)/g, "");

function* prose(line, words, current) {
  const toks = tokens(line);
  const inToken = (i) => toks.some(t => t.start <= i && i < t.end);
  const cuts = [...line.matchAll(SEP)].map(m => m.index).filter(i => !inToken(i));
  const bounds = [0, ...cuts, line.length];
  const clauses = bounds.slice(0, -1).map((a, i) => [a, bounds[i + 1]]);
  const first = clauses.map(([a, b]) => words(line.slice(a, b))).find(w => w.size) || new Set();
  for (let idx = 0; idx < toks.length; idx++) {
    const t = toks[idx];
    const ci = clauses.findIndex(([a, b]) => a <= t.start && t.start < b);
    const [ca, cb] = clauses[ci];
    const before = line.slice(ca, t.start), after = line.slice(t.end, cb);
    const k = keyOf(t.kind, t.raw, before);
    const sentStart = Math.max(0, ...[...line.slice(0, t.start).matchAll(/\.\s+/g)].map(m => m.index + m[0].length));
    const q = qualifier(t.kind, before, after, line.slice(sentStart, t.start), current);
    if (q === "growth" && t.kind === "pct") k.signed = true;
    const prevEnd = idx && toks[idx - 1].end > ca ? toks[idx - 1].end : ca;
    const nextStart = idx + 1 < toks.length && toks[idx + 1].start < cb ? toks[idx + 1].start : cb;
    const since = words(line.slice(prevEnd, t.start)), until = words(line.slice(t.end, nextStart));
    let near = t.kind === "num" ? (until.size ? until : since) : (since.size ? since : until);
    if (!near.size) near = words(stripParens(line.slice(ca, cb)));
    for (let j = ci - 1; !near.size && j >= 0; j--) near = words(stripParens(line.slice(clauses[j][0], clauses[j][1])));
    // A date or time matches on value; the words around it are not its metric.
    if (DATE_KINDS.includes(t.kind) || (t.kind === "num" && /^20\d\d$/.test(t.raw))) near = new Set();
    else if (!near.size) near = first;
    yield { key: k, raw: t.raw, q, words: near, line: line.trim() };
  }
}

export function figures(text, { period = null, extraMetricWords = [] } = {}) {
  const words = makeWords(extraMetricWords);
  const periodQualifier = makePeriodQualifier(period);
  const current = period ? periodAliases(period.label) : [];
  const out = [];
  let header = null, above = "", hwords = new Set(), moneyTable = false;
  for (let line of String(text).split(/\r?\n/)) {
    // "Form 10-K" is a document name, not a figure.
    line = line.replace(/\b(\d+)-([A-Z])\b/g, "Form-$2");
    if (line.trim() && !line.startsWith("|")) above = line;
    if (!line.startsWith("|")) {
      header = null;
      out.push(...prose(line, words, current));
      continue;
    }
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(c => c.trim().replace(/^\*+|\*+$/g, "").trim());
    if ([...cells.join("")].every(ch => "-: ".includes(ch))) continue;
    if (header === null) {
      header = cells;
      hwords = words(cells[0]);
      moneyTable = ["$M", "$ millions"].some(m => (cells[0] + above).includes(m));
      continue;
    }
    const row = cells[0];
    const rowPeriod = row.match(/^((?:FY\d{4} [QH][1-4])|(?:[QH][1-4] FY\d{4}))( \(restated.*\))?$/);
    const rowQ = rowPeriod && !current.includes(rowPeriod[1]) ? `history ${rowPeriod[1]}` : null;
    cells.forEach((cell, j) => {
      const colQ = j < header.length ? periodQualifier(header[j]) : null;
      const colWords = j < header.length ? words(header[j]) : new Set();
      for (const t of tokens(cell)) {
        let k = keyOf(t.kind, t.raw, cell.slice(0, t.start));
        if (moneyTable && k.t === "n" && !row.toLowerCase().includes("shares")) k = { t: "$M", v: k.v };
        const q = rowQ || (!DATE_KINDS.includes(t.kind) && RANGE.test(cell.slice(t.end)) ? "range low" : null)
          || colQ || (t.kind === "pct" && k.signed ? "growth" : "current");
        if (q === "growth" && t.kind === "pct") k.signed = true;
        const w = new Set([...words(row), ...colWords, ...(j === 0 ? hwords : [])]);
        out.push({ key: k, raw: t.raw, q, words: w, line: line.trim() });
      }
    });
  }
  return out;
}

function sameValue(a, b) {
  if (a.t !== b.t) return false;
  if (a.t === "%") return a.signed ? Boolean(b.signed) && Math.abs(a.v - b.v) < 1e-9 : Math.abs(Math.abs(a.v) - Math.abs(b.v)) < 1e-9;
  return a.v === b.v;
}

/** true, false, or null when either side has no metric words to compare. */
function labelsAgree(a, b) {
  if (!a.size || !b.size) return null;
  if (![...a].some(w => b.has(w))) return false;
  return EXCLUSIVE.every(group => {
    const x = group.filter(g => a.has(g)), y = group.filter(g => b.has(g));
    return !x.length || !y.length || x.some(g => y.includes(g));
  });
}

export function traceFigures(document, facts, { extraMetricWords = [], valueOnly = false } = {}) {
  const period = periodOf(facts);
  const opts = { period, extraMetricWords };
  const index = facts.flatMap(f => [
    ...figures(f.content, opts).map(x => ({ ...x, fact: f })),
    ...[...new Set([...String(f.content).matchAll(/FY(\d{4})/g)].map(m => m[1]))]
      .map(y => ({ key: { t: "n", v: Number(y) }, q: "current", words: new Set(), line: `FY${y}`, fact: f })),
  ]);
  const traced = [], valueOnlyHits = [], untraced = [];
  for (const fig of figures(document, opts)) {
    const hits = [], loose = [];
    for (const x of index) {
      if (!sameValue(fig.key, x.key)) continue;
      if (valueOnly) { hits.push(x); continue; }
      const signedRate = fig.key.t === "%" && fig.key.signed && x.key.signed
        && ["current", "growth"].includes(fig.q) && ["current", "growth"].includes(x.q);
      const rangeLow = [fig.q, x.q].includes("range low") && [fig.q, x.q].every(q => ["range low", "prior year"].includes(q));
      if (x.q !== fig.q && !signedRate && !rangeLow) continue;
      const agree = labelsAgree(fig.words, x.words);
      if (agree) hits.push(x);
      else if (agree === null) loose.push(x);
    }
    const entry = { raw: fig.raw, qualifier: fig.q, label: [...fig.words].sort(), line: fig.line };
    if (hits.length) traced.push({ ...entry, sources: hits });
    else if (loose.length && !fig.words.size) valueOnlyHits.push({ ...entry, sources: loose });
    else untraced.push({ ...entry, near: loose });
  }
  return { period, traced, valueOnly: valueOnlyHits, untraced };
}

// A date or year matches every fact header, so only a label match names a source.
export function sourceFactIds(result, facts) {
  const used = new Set(result.traced.flatMap(f => f.sources.map(s => s.fact.id)));
  return facts.filter(f => used.has(f.id)).map(f => f.id);
}

export function renderTrace(result, { title = "Figure check" } = {}) {
  const { traced, valueOnly, untraced } = result;
  const cell = (s, n) => String(s).slice(0, n).replace(/\|/g, "/");
  const as = (f) => `${f.qualifier}; ${f.label.join(", ") || "no label"}`;
  const out = [`# ${title}`, "",
    `${traced.length + valueOnly.length + untraced.length} figures: ${traced.length} traced by label, `
    + `${valueOnly.length} traced by value only (no metric words around them), ${untraced.length} not traced.`, ""];
  if (untraced.length) {
    out.push("## Not traced", "", "| Figure | As read | Line |", "|---|---|---|",
      ...untraced.map(f => `| \`${f.raw}\` | ${as(f)} | ${cell(f.line, 110)} |`), "");
  }
  out.push("## Traced", "", "| Figure | As read | Fact block |", "|---|---|---|",
    ...[...traced, ...valueOnly].map(f => {
      const blocks = [...new Set(f.sources.map(s => s.fact.block))].sort();
      return `| \`${f.raw}\` | ${f.label.length ? as(f) : `${f.qualifier}; value only`} | ${cell(blocks.slice(0, 2).join(", "), 80)}${blocks.length > 2 ? " …" : ""} |`;
    }));
  return out.join("\n") + "\n";
}
