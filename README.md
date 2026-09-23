# NOAN Agent Pack

Open-source agents that run against **your** NOAN fact layer. You supply
environment variables; you do not change code.

Each agent reads its operating instructions from facts stored in your own NOAN
project. Edit one of those facts in the NOAN app and that agent behaves
differently on its next run — no deploy, no pull request, no engineer. That is
not a configuration convenience bolted on the side; it is the whole idea.

> **Status: beta.** All six agents are here — workers, workflows, starter
> Config and Playbook facts, and the tests that travel with them — cut from our
> production fleet by a one-way export. Every agent starts in safe mode. Treat
> your first run as a rehearsal: read the dry run before switching anything
> live, and tell us what breaks. Because this tree is an export, changes to
> anything other than the docs, the seed scripts and the workflows belong
> upstream; CI's provenance check says so on the pull request.

## The agents

| Agent | What it does | Beyond the baseline |
|---|---|---|
| **weekly activity report** | Narrates a week of your NOAN activity — tasks, facts, assets, notes — as a retrospective digest | — |
| **fact alignment** | Audits your fact base for gaps, contradictions and overlap. Recommends; never writes a business fact | — |
| **market research refresh** | Researches your market and refreshes your Market Research facts | Firecrawl |
| **customer support** | Answers inbound email from your facts, or escalates to a human | — |
| **sales deck** | Builds a personalised deck for a named prospect, renders a PDF, sends it or parks it for approval | headless Chrome, object storage |
| **newsletter** | Sends a NOAN asset to every contact carrying a tag, exactly once each | — |

Baseline for everything: a NOAN API key, an Anthropic API key, and a Resend
API key for email.

## Start here

**The quickest way is the NOAN wizard.** One command takes your NOAN key, and with
`--agents` it forks this repository to your account, stores your keys as repository
secrets, runs the seed scripts, records the block slugs as variables, and triggers one
dry run. Safe mode stays on; the switch is yours.

```bash
npx -y @getnoan/wizard@latest --agents
```

**By hand, run the market research agent first.** It is the only one that needs no
database, so you can watch an agent do real work before setting anything else
up. Three keys and you are going.

```bash
cp .env.example .env      # add your three keys
node agents/seed-market-research-refresh.mjs
DRY_RUN=1 node agents/market-research-refresh-worker.mjs
```

The seed script writes that agent's starter instructions into your NOAN
project and prints the two `.env` lines to add. The worker then shows you
exactly what it would post, without posting anything.

When you are happy, drop `DRY_RUN=1`.

## Safe mode

**Every agent ships dry-run by default.** A first run shows you what it would
do instead of doing it, and you turn that off deliberately, one agent at a
time.

This matters more for some than others. The market research agent writes facts
to your project unattended. The newsletter agent emails your contact list. The
support agent replies to real customers. Read a dry run before you let any of
those go live.

The support agent also honours `TEST_RECIPIENT`: while it is set, every reply
*and* every escalation forward goes to that address instead of the real sender.

## State

Five of the six agents keep a small ledger — what they have already done, so
they do not do it twice. That ledger has to outlive a CI run.

```bash
STATE_BACKEND=postgres
DATABASE_URL=postgres://…      # any Postgres: Supabase, Neon, RDS, your own
```

No database? Supabase's free tier fits comfortably — the ledgers are a few
kilobytes against a 500 MB limit. One thing to know: **free Supabase projects
pause after a week of inactivity**, so if you only run the weekly agents,
enable the keepalive workflow in this repo. It does one cheap read every few
days and costs nothing.

Self-hosting on a machine with a real disk? `STATE_BACKEND=local` writes a
file and needs no database at all.

A missing ledger is treated as an error, never as a first run. That is
deliberate: a lost ledger that looked like day one would re-send everything.

## Running it on GitHub Actions

Each agent has a workflow in `.github/workflows/`. Fork or clone this repo, add
the secrets and variables below in **Settings → Secrets and variables →
Actions**, and the schedules start themselves.

Enabled Actions before the secrets are in? Each run then prints
`not configured yet: <SECRET>` for whatever is missing and stops, green, with
nothing run — until the secrets are there.

**Secrets** (encrypted, never printed):

| Secret | Needed by |
|---|---|
| `NOAN_PERSONAL_API_KEY` | every agent |
| `RESEND_API_KEY` | every agent |
| `ANTHROPIC_API_KEY` | every agent except the newsletter |
| `DATABASE_URL` | every agent except market research |
| `FIRECRAWL_API_KEY` | market research |
| `NEWSLETTER_UNSUB_SECRET` | newsletter |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | sales deck, only if you want send-later |

**Variables** (plain configuration): `MAIL_FROM`, `REPLY_TO`, `ESCALATE_TO`,
`STATE_BACKEND`, the block slugs each seed script prints when you run it, and
the identity set under *Whose agents these are* below: `AGENT_NAME`,
`COMPANY_NAME`, `AGENT_IDENTITY_IDS`, `COMMANDERS`, `TEAMMATE_DOMAIN`,
`AGENT_ALLOWED_LINKS`, `REPORT_RECIPIENT_TAG`, plus `MARKET_RESEARCH_STACK_SLUG`
for market research. Every workflow forwards them; leave one unset and that
agent takes the cautious default.

**Turning safe mode off** is a deliberate act: set the repository variable
`DRY_RUN` to `0`, or leave it and pass `dry_run: 0` on a single manual run to
try one agent live. CI enforces that every agent workflow still defaults to
safe mode, so it cannot be switched off for everyone by accident.

Adding an agent of your own? Copy `templates/agent-workflow.yml`: it carries the
configured-check, the safe-mode default CI enforces, and the identity variables
already forwarded, so only the secrets list, the worker path and the slugs change.

Two workflows are not agents. **Keepalive** touches your database every three
days so a free-tier project is not paused for inactivity — delete it if your
database does not pause. **CI** checks syntax, scans for secrets, and enforces
the safe-mode default.

Nothing needs installing: Node, Python and Chrome are all preinstalled on
GitHub's Ubuntu runners.

## Editing what the agents do

After the seed scripts run, open your NOAN project and find the **Agent
Config** stack. Each agent has two facts:

- **Agent Config** — what it does: what to fetch, how to decide, what to judge.
- **Playbook** — how it reads: tone, structure, output shape.

They are separate on purpose. Retuning how a report *reads* should never mean
touching the decision logic, and vice versa.

The text we ship is a **starting point**, not a default to be preserved. Each
Config ends by naming the judgement calls most worth changing for your
business. Change them. The next run picks them up.

Re-running a seed script never overwrites your edits: it writes a fact only
when it created the block in that same run.

## What each agent reads

The Config and Playbook facts say how an agent behaves. The agents also ground
their work in your **business** facts, and those start empty. Every block below
is a managed block your workspace already has; nothing needs creating, only
filling. An agent grounded in an empty block fails quietly, so the seed scripts
run a **grounding check** after seeding: for every block an agent reads that
holds no fact, it files one task on your NOAN board saying which agent needs it
and why, and never files the same one twice.

| Agent | Reads | If empty |
|---|---|---|
| **customer support** | Product FAQs, Product Features, Product List | escalates most questions to a human |
| **market research** | Product List, Strategy, Roadmap, FAQs, Monetization Model, Business Vision, Mission & Vision, Value Proposition, Brand Positioning; Ideal Customer, Sales Customer Profile, Buyer Persona, Buyer Segments, ICP Triggers, Audience Segments | researches with no anchor in what you already know |
| **sales deck** | Brand Identity, Brand Tone, Brand Positioning, Value Proposition, Ideal Customer, Sales Customer Profile, plus your design-system block and the `## Slide design` section of the Deck Playbook | thin decks in no particular visual system |
| **activity report**, **fact alignment**, **newsletter** | your activity, the whole fact base, assets by tag | nothing to fill |

Run the check by hand at any time:

```bash
node --env-file=.env agents/grounding-check.mjs --dry-run
```

Drop `--dry-run` to file the tasks. The NOAN skill's first-connect procedure fills
most of these blocks when it seeds a new workspace, so a workspace set up that
way usually passes.

## Getting facts to the fact-alignment agent

The fact-alignment agent audits what is already in your fact layer. It also
looks for what *should* be in there and is not, and it has two ways of finding
that. Both are on by default; neither needs a key beyond the ones above.

**Your notes.** Every run reads the notes written in the past week and asks
whether any of them contain a durable business fact the fact base is missing —
a pricing change, a positioning shift, a customer insight. Write notes however
you like; the agent does the noticing. This needs no setup at all and is the
floor: it works from day one, and it is deliberately conservative, so most
notes produce nothing.

**A flagged task.** A backlog task whose title starts with `[Fact Candidate]`
is read as a deliberate capture. Put the summary in `details` — that is what
the agent reads; the title alone is not enough. A capture is a suggestion, not
a correction: the agent still judges it, most are rejected, and that is the
healthy outcome.

```
title:   [Fact Candidate] Starter plan moved to $59/mo
details: <2-4 lines: what changed, why it will still be true next quarter,
          and which block it belongs on>
status:  backlog
```

Two things are load-bearing. The title must **start** with the literal
`[Fact Candidate]`, brackets included, nothing before it. `status` must be
`backlog`. Both are matched exactly — but a near miss is not lost. Anything on
the board that reads like a capture and misses the prefix is named in the
report under **Malformed Captures**: still open, still yours to rename, and
picked up properly on the next run once it is. Nothing is closed out until it
has been read.

Every consumed capture is closed out (`completed: true`, `status: "done"`)
whether or not it was accepted, so a capture task disappearing from the board
is normal, not a sign it was taken up.

**Having your coding agent do the capturing.** The point of a capture is that
someone notices at the moment the fact surfaces, which is usually in the
middle of a conversation and rarely when anyone wants to stop and write a
task. The
[NOAN skill](https://github.com/getnoan/skills) teaches an agent to do it for
you, in the right shape, from any session:

```bash
npx skills add getnoan/skills
```

Optional. The notes route above needs nothing installed.

## Whose agents these are

Nothing in the code names a company, an agent, or a team. The agents sign as
`AGENT_NAME`, speak for `COMPANY_NAME` (or, unset, your NOAN project's
name), treat `COMMANDERS` and anyone at `TEAMMATE_DOMAIN` as teammates who
may steer them, link only to `AGENT_ALLOWED_LINKS`, and email their reports
to the contacts carrying `REPORT_RECIPIENT_TAG`. Leave a value unset and the
agent does the cautious thing: signs as "Agent", accepts steering from nobody,
puts no links in what it sends, and says in its log that a report had no
recipients. `.env.example` lists every one of these with its default.

## Licence

MIT. See [LICENSE](LICENSE). Security policy: [SECURITY.md](SECURITY.md).
