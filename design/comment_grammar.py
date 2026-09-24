"""What a teammate's comment on a task ASKS FOR — the fleet's one verb grammar.

The Python half of agents/comment-grammar.mjs. Both compile the SAME patterns
from agents/comment-grammar.json, so the deck cannot drift from the demo and
SDR lanes again (on 2026-09-11, five of sixteen real
phrases were read differently, and the dangerous direction was the silent
no-op — "send as-is" on a parked demo sent nothing while the writer believed
they had approved it).

This module answers WHAT a comment asks for. WHO may ask stays in deck.py's
teammate_comments (a commander or an address at TEAMMATE_DOMAIN, decided from the API-verified
author), matching task-comments.mjs on the Node side.
"""
import json
import os
import re

_HERE = os.path.dirname(os.path.abspath(__file__))


def _agents_file(name):
    """agents/<name> upstream; agents/shared/<name> in the agent pack, which groups agents/ by agent."""
    for sub in (("shared",), ()):
        p = os.path.join(_HERE, os.pardir, "agents", *sub, name)
        if os.path.exists(p):
            return p
    return os.path.join(_HERE, os.pardir, "agents", name)


GRAMMAR_PATH = os.environ.get("COMMENT_GRAMMAR_PATH", _agents_file("comment-grammar.json"))

with open(GRAMMAR_PATH, encoding="utf-8") as _f:
    _G = json.load(_f)

# dict preserves insertion order (3.7+), which IS the match order: send before
# send_with_text before retry.
VERBS = {
    verb: {**spec, "rx": re.compile(spec["pattern"], re.I)}
    for verb, spec in _G["verbs"].items()
}
FALLBACK_VERB = _G["fallback"]["verb"]
FIXTURES = _G["fixtures"]


def classify_comment(text):
    """-> (verb, payload). verb is send | send_with_text | retry | steer;
    payload is the human's own words where the verb carries any ("" for a bare
    retry, the whole comment for steer), and None for a bare send."""
    t = "" if text is None else str(text)
    for verb, spec in VERBS.items():
        m = spec["rx"].match(t)
        if not m:
            continue
        if spec["payload"] is None:
            return verb, None
        captured = (m.group(spec["payload"]) or "").strip()
        # "send:" with nothing after it is not an instruction to send blank.
        if verb == "send_with_text" and not captured:
            continue
        return verb, captured
    return FALLBACK_VERB, t.strip()


def is_send(text):
    """True when the comment asks for the thing to go out as it stands, or with
    the human's own words. The one predicate a customer-facing send gates on."""
    verb, _ = classify_comment(text)
    return verb in ("send", "send_with_text")
