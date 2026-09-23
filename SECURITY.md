# Security

## Reporting a vulnerability

Please report security issues privately rather than opening a public issue.
Email **security@getnoan.com** with enough detail to reproduce. We will
acknowledge receipt and keep you updated while we work on a fix.

## How this repository handles credentials

Every credential these agents use is supplied by you at run time through
environment variables. Nothing is committed here, and nothing is bundled.

- `.env` is gitignored. Keep it `chmod 600`; it holds live secrets.
- CI runs a secret scan over every push and pull request.
- Agents log the *names* of missing environment variables, never values.

## Scope these agents run with

These agents act on your NOAN project with the permissions of the API key you
give them, and several of them can send email. Two things worth doing before
you let one run live:

1. **Start in safe mode.** Every agent ships dry-run by default and will show
   you what it would do without doing it. Turn that off deliberately, per agent.
2. **Scope the key.** Mint a key with only the access an agent needs, and give
   each agent its own, so a leaked key burns one surface and the audit trail
   stays legible.
