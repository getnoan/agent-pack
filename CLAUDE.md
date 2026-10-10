@AGENTS.md

# agent-pack

NOAN's open-source agent pack (MIT): six agents that run on GitHub Actions against a customer's own NOAN project. Node 22 ESM (`.mjs`) with no `package.json` and no dependencies. The sales deck is stdlib Python in `design/`.

## Public repo

- Anyone can read every file, commit, branch and PR here.
- No keys, customer or workspace data, internal repo names or people's names in code, fixtures, examples, commits or PR text.
- Fixtures use `example.com` addresses and synthetic ids such as `cccccccc-cccc-4ccc-8ccc-cccccccccccc`. `agents/shared/test-generic-config.mjs` fails on our domain, our agent's name, real addresses and real UUIDs (patterns in `agents/shared/oss-sweeps.mjs`).

## Most of this tree is generated

- **This repo is a one-way export from the private fleet repo.** Each export deletes the tree and writes it again from upstream.
- **Only the files in `DOWNSTREAM_OWNED` (`scripts/check-provenance.mjs`) are edited here:** README, SECURITY, LICENSE, `.gitignore`, `.gitleaks.toml`, `.env.example`, the `seed-*.mjs` scripts, `agents/shared/agent-config-seed.mjs`, every workflow, `templates/agent-workflow.yml`, `.github/dependabot.yml`.
- A fix to any other file, `agents/pack-layout.json`, `AGENTS.md` and this file included, goes upstream and comes back on an `export/*` branch. The CI `provenance` job fails a PR that edits anything else.

| Path | What |
|---|---|
| `agents/<agent>/` | worker, seed script and tests for one agent |
| `agents/shared/` | modules two or more agents use: NOAN client (`noan.mjs`), email, Slack, state, model client |
| `design/` | sales deck generator (`deck.py`) |
| `templates/agent-workflow.yml` | starting workflow for a new agent |

## Secrets and writes

- **Every agent writes to NOAN with the key it is given** (notes, tasks, contacts, memos). Market research also writes business facts with no review. Support, newsletter and deck send email through Resend.
- **Workers treat only `DRY_RUN=1` as dry.** Unset means live, so always pass `DRY_RUN=1` when running a worker by hand.
- **Workflows default to dry run:** the `dry_run` input defaults to `"1"` and `DRY_RUN` falls back to `'1'`. The CI step "Safe mode is the default" greps for both lines, so keep them as written.
- Seed scripts have no dry run. They create the Agent Config stack and blocks, write a fact only into a block they created in the same run, and file a task per empty block the agent reads.
- Workflows read secrets through `env:`, never inside `run:`. Each agent workflow starts with a `Configured?` step that prints `not configured yet: NAME` and exits green. The setup wizard parses that line.
- `GOOGLE_SERVICE_ACCOUNT_JSON` is written to `agents/customer-support/google-service-account.json` during the run (gitignored). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are only for the sales deck.
- Every `uses:` is pinned to a commit SHA. CI checks that the template uses the same pins as the workflows; Dependabot updates them monthly.

## Conventions

- No company, agent or person in code. Names come from env (`AGENT_NAME`, `COMPANY_NAME`, `COMMANDERS`, `TEAMMATE_DOMAIN`) with a neutral default; `.env.example` lists every one.
- What an agent does lives in its Config and Playbook facts in NOAN, read on every run.
- A new agent gets `agents/<agent>/`, imports from `../shared/`, and copies `templates/agent-workflow.yml`.
- `NOAN_API_URL` points the client at another API (default `https://api.getnoan.com`).

## Tests and CI

- Tests are plain Node scripts named `test-*.mjs`, no framework. Each runs from its own folder and exits non-zero on failure.
- `ci.yml` (push to `main`, every PR): template pins, `node --check`, `python3 -m compileall design`, the tests, the safe-mode check, gitleaks 8.30.1 with `.gitleaks.toml`. `provenance` runs on PRs only.

## Commands

```bash
cp .env.example .env                                            # then add keys
node --env-file=.env agents/market-research-refresh/seed-market-research-refresh.mjs
DRY_RUN=1 node --env-file=.env agents/market-research-refresh/market-research-refresh-worker.mjs
node --env-file=.env agents/shared/grounding-check.mjs --dry-run   # empty blocks, files nothing
python3 design/deck.py --task <taskId> --dry                    # deck inputs, no generation
for t in agents/*/test-*.mjs; do (cd "$(dirname "$t")" && node "$(basename "$t")") || echo "FAIL $t"; done
find agents -name '*.mjs' -exec node --check {} \;               # syntax
python3 -m compileall -q design                                  # Python syntax
```
