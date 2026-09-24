#!/usr/bin/env node
/**
 * Starter Config + Playbook facts for the SALES DECK agent.
 *
 * STARTER text, not fixed behaviour. Edit it in NOAN and the next run behaves
 * differently — no deploy, no code change.
 *
 * Run:  node --env-file=.env seed-deck.mjs
 */

import { runSeed } from "../shared/agent-config-seed.mjs";

export const CONFIG_FACT = `# Deck Agent Config

Scope: this governs the bespoke sales deck agent. It builds an on-brand deck for a named prospect, renders it to PDF, and either emails it straight to that prospect or routes it to a human for review. This fact describes what it does; change it here rather than in code.

## Trigger

A task in **backlog** carrying your deck tag with this agent among the assignees. Backlog-only is deliberate: other agents that create deck tasks can put them straight into in-progress so the scanner never double-builds the same deck.

## What to ground the deck in

**The deck is written from your facts, never invented.** The grounding set lives here rather than in code so you can retune it:

- Brand identity and the visual design system, for look and feel.
- Brand tone, brand positioning, and the value proposition.
- Your ideal customer and sales customer profile, so the angle fits who they are.
- Product vision, user segmentation, customer quotes and qualitative insights, for substance and proof.
- Pricing, when pricing belongs in the story.

Plus, for personalisation only: the task's title and details as the brief, and the linked contact's memo history. **Memos are internal.** They may steer the angle, but nothing from them may be quoted or referenced in a way the prospect would not already know. A prospect discovering you kept notes on them is a worse outcome than a slightly less tailored deck.

## Send policy

The deck goes straight to the prospect only when all of these hold:

- direct-to-customer sending is switched on,
- at least one linked contact has a resolvable email address,
- the deck is clean, and
- the cover note drafted without tripping a guard.

Otherwise it parks for a human: a review copy is emailed and the task stays open. A deck going to several linked contacts is sent reply-all style; having more than one recipient is not by itself a reason to involve a human.

A deck is **not clean** if either holds:

- a mandatory slide is missing its intended link or screenshot when one exists in the shot bank;
- any embedded product screenshot is older than your staleness threshold. Stale screenshots are the main way a deck goes quietly wrong, because the product changes faster than the image library.

These are hard gates in code, not model judgement. **The model never decides whether its own deck is safe to send.**

## Completion

The task moves to done only once the deck actually reached the customer.

A deck routed to review is **parked**, not closed: the task stays in backlog tagged for a human, the agent unassigns itself, and a dated line is appended to the details with the reason and where the stored copy lives. The PDF is kept at park time so a later send ships exactly the file the human saw.

Three ways back, all from the board:
- a comment of **send** ships the stored deck as-is with the cover note the review email showed; **send: <text>** uses those words instead;
- a comment of **retry**, with any guidance after it, rebuilds;
- **re-assigning the agent** rebuilds too, reading every comment and appended note as guidance.

Only a teammate's comment steers — the agent's own comments never do, and the identity is checked against the verified sender address, not a display name. Every customer send is recorded as a memo on the contact: that memo is the audit trail.

Closing the task on the review email was the earlier behaviour and it was wrong — it left a human forwarding the PDF by hand, because a closed task cannot be re-triggered. A transient send failure likewise leaves the task in backlog so the next scan retries, rather than marking finished work that never reached anyone.

## Follow-up

A deck that actually reached the prospect arms a follow-up task, due the next working day, with the contact linked and the cover email's subject in the details so the follow-up can reference the deck rather than resend it.

This fires **only on a confirmed send to the customer.** A deck routed to a human has not reached anyone, and a follow-up chasing a prospect about something they never received is worse than no follow-up at all. If arming fails, the deck still stands and a note records that the follow-up did not arm — silently losing the next step is the failure this arrangement exists to prevent.

## Explicitly out of scope

- Does not decide **who** gets a deck. That comes from whoever created the task.
- Does not decide what the follow-up says. It arms the task; the follow-up's content is its own agent's business.
- Does not choose recipients beyond the contacts linked to the task.
- Does not touch pricing, legal, or any claim that is not in the facts.

## Stays in code, deliberately

PDF rendering, the headless-browser pipeline, file storage, screenshot selection and staleness detection, and the email transport. Third-party and rendering mechanics that you should never have to touch in order to change what the deck *says*.`;

export const PLAYBOOK_FACT = `# Deck Playbook

Scope: voice and output shape for the deck agent. What to build and when to send it lives in the Deck Agent Config. These rules govern the cover email the deck rides in on, and they are read at run time — editing them here changes what prospects receive, with no deploy.

## Cover email

Hard rules:
- **Body under 110 words.** Warm, natural, first person, like a colleague sending over something they made for them. No corporate filler, no exclamation marks, no pressure, no extra asks.
- Open with the recipient's first name, or the names joined naturally when the deck goes to several people.
- Reference that the deck is attached and made for their business specifically. One concrete hook from the slides or their history is good. **Never invent a detail, never quote private notes, and never mention internal meetings unless the history shows a real meeting with them.**
- At most one link, and only to your own site. No other URLs.
- Sign off with your agent's name and a one-line description of what it is, so the recipient knows they are reading something an agent sent on a person's behalf.

Subject line: under 60 characters, no clickbait.

## Tone notes

- **The deck is the thing being sent.** The email is a note attached to it, not a pitch in its own right — if the email is doing the selling, it is too long.
- Specific beats clever. One real detail about their business earns more than a polished generality.
- Never imply a relationship that does not exist. If the history shows no meeting, do not write as though there was one.

## Slide design

The deck agent pastes this section into its build prompt, after your Visual Design System fact, as the resolved values for rendering that system as print slides. Replace the bullets with your own: the code carries no palette, typeface or leading of its own, and a design system written for a website rarely says how it should behave on a slide.

- Where the design system and the brand identity fact disagree, the design system wins. List the known conflicts here, resolved in its favour (for example: ground #RRGGBB, not #RRGGBB; buttons fully rounded, not 4px).
- Ground colour, one elevated surface colour, foreground with its opacity ladder, one accent colour and how sparingly it appears (one accent moment per slide is a good rule), border hairlines, radii.
- Typefaces: which are installed on the machine that renders the PDF (use them directly, no web fonts), and which is display versus body. Body never below 14px.
- Display line-height and letter-spacing as literal values (a condensed uppercase face usually wants around 1.1 and slightly positive tracking); body line-height about 1.6, never below 1.5.`;

runSeed({
  agent: "sales deck",
  blocks: [
    {
      title: "Deck Agent Config",
      description: "What the deck agent builds, what it grounds in, and when it may send.",
      content: CONFIG_FACT,
      envVar: "DECK_CONFIG_BLOCK_SLUG",
    },
    {
      title: "Deck Playbook",
      description: "Voice and shape of the cover email a deck rides in on.",
      content: PLAYBOOK_FACT,
      envVar: "DECK_PLAYBOOK_BLOCK_SLUG",
    },
  ],
});
