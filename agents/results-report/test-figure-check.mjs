#!/usr/bin/env node
/** figure-check.mjs: a document traces to its facts by value, qualifier and metric, never by value alone. */
import { traceFigures, sourceFactIds, periodOf, renderTrace } from "./figure-check.mjs";

let pass = 0, fail = 0;
const ok = (n, c, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n}${d ? `: ${d}` : ""}`); } };
console.log("figure check");

const HEADER = "Period: FY2030 Q2 (ended 2030-06-30) · Report type: quarterly results · Released: 2030-07-20 · Source: example · Units: USD millions unless stated · Basis: US GAAP";
const facts = [
  { id: "f-headline", block: "Headline Results", content: `${HEADER}
- Total revenue: $80.4M, up 5.2% vs last year (last year $76.4M); consensus $79.0M
- Net income: $9.8M (last year $8.1M)
- Adjusted EPS: $1.12; diluted EPS $0.97
- Domestic same-store sales: +3.4%; international same-store sales +6.0%` },
  { id: "f-cash", block: "Cash Flow", content: `${HEADER}
- Operating cash flow: $14.0M; capital expenditure $4.2M; free cash flow $9.8M` },
  { id: "f-history", block: "Earnings History", content: `${HEADER}

| Quarter | Revenue $M | Same-store sales |
|---|---|---|
| FY2030 Q2 | 80.4 | +3.4% |
| FY2030 Q1 (restated) | 77.9 | +2.9% |` },
  { id: "f-unused", block: "People", content: `${HEADER}
- Employees: 1,240` },
];

ok("the period comes from the first fact header", JSON.stringify(periodOf(facts)) === JSON.stringify({ label: "FY2030 Q2", end: "2030-06-30" }));

const clean = `Example Co reported results for Q2 FY2030 on July 20, 2030.

Total revenue was $80.4 million, up 5.2%, against consensus of $79.0 million. Net income was $9.8 million, from $8.1 million a year earlier. Adjusted EPS was $1.12 and diluted EPS was $0.97. Domestic same-store sales rose 3.4% and international same-store sales rose 6.0%.

Free cash flow was $9.8 million after capital expenditure of $4.2 million.

| Quarter | Revenue $M | Same-store sales |
|---|---|---|
| FY2030 Q1 (restated) | 77.9 | +2.9% |`;

const good = traceFigures(clean, facts);
ok("a document written from the facts traces every figure", good.untraced.length === 0, good.untraced.map(f => `${f.raw} (${f.qualifier})`).join(", "));
ok("…figures with metric words trace by label, the date by value only",
   good.traced.length >= 12 && good.valueOnly.some(f => f.raw === "July 20, 2030"), `${good.traced.length} / ${good.valueOnly.map(f => f.raw)}`);
ok("…and the history row traces as a history row, not as the current quarter",
   good.traced.some(f => f.raw === "77.9" && f.qualifier === "history FY2030 Q1"));
ok("the source ids are the facts a figure came from, unused facts left out",
   JSON.stringify(sourceFactIds(good, facts)) === JSON.stringify(["f-headline", "f-cash", "f-history"]), sourceFactIds(good, facts).join(","));

// Each line carries one wrong figure that a value-only match would let through.
const stale = `Net income was $9.8 million.
Operating cash flow was $9.8 million.
Adjusted EPS was $0.97.
Domestic same-store sales rose 6.0%.
Total revenue was $80.4 million, from $80.4 million a year earlier.`;
const byLabel = traceFigures(stale, facts);
const notTraced = byLabel.untraced.map(f => f.raw);
ok("a figure that borrows another metric's value is not traced (operating vs free cash flow)",
   byLabel.untraced.some(f => f.raw === "$9.8 million" && f.label.includes("operating")), JSON.stringify(notTraced));
ok("…adjusted is not diluted", byLabel.untraced.some(f => f.raw === "$0.97"));
ok("…domestic is not international", byLabel.untraced.some(f => f.raw === "6.0%"));
ok("…and a current figure written as last year's is not traced", byLabel.untraced.some(f => f.raw === "$80.4 million" && f.qualifier === "prior year"));
ok("…while net income at $9.8M still traces", byLabel.traced.some(f => f.raw === "$9.8 million" && f.label.includes("income")));
const byValue = traceFigures(stale, facts, { valueOnly: true });
ok("matching by value alone passes every one of those", byValue.untraced.length === 0, byValue.untraced.map(f => f.raw).join(","));

const balances = [{ id: "f-bal", block: "Balance Sheet", content: `${HEADER}
- Cash and equivalents: $43.6M at period end ($55.6M at the end of FY2030 Q1)

| Debt ($M) | FY2030 Q2 | FY2030 Q1 | FY2029 Q2 |
|---|---|---|---|
| Notes | 598.5 | 600.0 | 590.0 |` }];
const sequential = traceFigures(`Cash was $43.6 million, from $55.6 million at the end of FY2030 Q1.

| Debt ($M) | FY2030 Q2 | FY2030 Q1 |
|---|---|---|
| Notes | 598.5 | 600.0 |`, balances);
ok("a comparison with the previous quarter end traces as prior period, in prose and in a table column",
   sequential.untraced.length === 0 && sequential.traced.filter(f => f.qualifier === "prior period").length === 2,
   JSON.stringify(sequential.untraced.map(f => `${f.raw} ${f.qualifier}`)));
const yearAgo = traceFigures("Cash was $55.6 million a year earlier. Notes were $600.0 million a year earlier.", balances);
ok("…and the same values written as a year earlier do not trace", yearAgo.untraced.length === 2, JSON.stringify(yearAgo.untraced.map(f => f.raw)));
ok("the same quarter a year earlier is still a prior-year column",
   traceFigures("| Debt ($M) | FY2029 Q2 |\n|---|---|\n| Notes | 590.0 |", balances).traced.some(f => f.qualifier === "prior year"));

const drivers = [{ id: "f-drv", block: "Results Drivers", content: `${HEADER}
- Fiscal period: FY2030 Q2, 2030-04-01 to 2030-06-30
- Domestic sales: +8.8%, from same-store sales of +3.8% and +4.8% change in the average number of stores (1,096.5 to 1,149.0)` }];
const range = traceFigures("The average number of domestic stores moved from 1,096.5 to 1,149.0, a +4.8% change. The quarter ran from April 1, 2030 to June 30, 2030.", drivers);
ok("the first figure of \"A to B\" traces to a change written from A to B, and a date range still traces",
   range.untraced.length === 0 && range.traced.some(f => f.raw === "1,096.5" && f.qualifier === "prior year"),
   JSON.stringify(range.untraced.map(f => `${f.raw} ${f.qualifier}`)));
ok("…so the same figure written as current does not trace",
   traceFigures("The average number of domestic stores was 1,096.5.", drivers).untraced.some(f => f.raw === "1,096.5"));

const guidance = [{ id: "f-gd", block: "Guidance", content: `${HEADER}\n- Adjusted EBITDA (non-GAAP): $115M–$120M\n- Capital expenditure: $32M to $36M` }];
const ranges = traceFigures("Adjusted EBITDA is expected to be $115 million to $120 million, and capital expenditure $32M–$36M.", guidance);
ok("a range traces whether it is written with \"to\" or a dash", ranges.untraced.length === 0, JSON.stringify(ranges.untraced.map(f => `${f.raw} ${f.qualifier}`)));
ok("…and in a table cell", traceFigures("| Guidance | FY2030 |\n|---|---|\n| Capital expenditure | $32M to $36M |", guidance).untraced.length === 0);
ok("…and its low end written as current does not", traceFigures("Adjusted EBITDA was $115 million.", guidance).untraced.length === 1);

const headline = traceFigures("Adjusted EPS of $1.12 against consensus of $79.0 million · Total revenue of $80.4 million.", facts);
ok("a \"·\" separates figures, so consensus revenue next to EPS takes EPS's words and does not trace",
   headline.untraced.length === 1 && headline.untraced[0].raw === "$79.0 million", JSON.stringify(headline.untraced.map(f => `${f.raw} ${f.label}`)));
const dividends = [{ id: "f-div", block: "Capital Returns", content: `${HEADER}\n- Dividends: $0.38 per share, $6.6M in total` }];
ok("\"totaled\" reads as total", traceFigures("Dividends totaled $6.6 million.", dividends).untraced.length === 0);

ok("words named in extraMetricWords become labels",
   traceFigures("Cafés opened: 12.", [{ id: "x", block: "b", content: `${HEADER}\n- Cafés opened: 12` }], { extraMetricWords: ["cafés"] })
     .traced.some(f => f.label.includes("cafés")));

const report = renderTrace(byLabel, { title: "Check" });
ok("the report puts the untraced figures first", report.indexOf("## Not traced") > 0 && report.indexOf("## Not traced") < report.indexOf("## Traced"));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
