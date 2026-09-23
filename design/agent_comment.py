"""An agent's own task comment, marked so the agent can recognise it later.

The Python half of agents/agent-comment.mjs. Both compile the SAME strings
from agents/agent-comment-marker.json, so the deck lane cannot drift from the
Node lanes — the drift that made the 2026-09-18 comment outage silent in two
places at once.

See that JSON for why a marker exists and why recognition is by SHAPE rather
than by a valid signature: an unrecognised agent comment is read as human
steering (dangerous), a wrongly-recognised human comment is merely dropped.

Pure: no network, no state.
"""
import hashlib
import hmac
import json
import os
import re

_HERE = os.path.dirname(os.path.abspath(__file__))
SPEC_PATH = os.environ.get(
    "AGENT_COMMENT_MARKER_PATH",
    os.path.join(_HERE, os.pardir, "agents", "agent-comment-marker.json"),
)

with open(SPEC_PATH, encoding="utf-8") as _f:
    SPEC = json.load(_f)

_SIG_RX = re.compile(SPEC["signature_pattern"])
_SECRET_ENV = SPEC["sign"]["secret_env"]
_DIGEST_CHARS = SPEC["sign"]["digest_chars"]


def comment_secret():
    """The signing secret, or "" when unset. Never logged."""
    return (os.environ.get(_SECRET_ENV) or "").strip()


def strip_signature(text):
    """The body with any signature line and trailing whitespace removed."""
    return re.sub(r"\s+$", "", _SIG_RX.sub("", str(text or "")))


def _digest(task_id, body, secret):
    return hmac.new(
        secret.encode("utf-8"),
        f"{task_id}\n{body}".encode("utf-8"),
        getattr(hashlib, SPEC["sign"]["algorithm"]),
    ).hexdigest()[:_DIGEST_CHARS]


def has_agent_marker(text):
    """Does this text carry the agent-comment marker? Shape only, on purpose."""
    return bool(_SIG_RX.search(str(text or "")))


def verify_agent_comment(text, task_id):
    """(marked, valid, reason). `valid` is meaningful only when `marked`.

    A marked comment that does not verify is still the agent's own for
    classification; the caller says so loudly rather than reclassifying it.
    """
    s = str(text or "")
    m = _SIG_RX.search(s)
    if not m:
        return False, False, "no marker"
    secret = comment_secret()
    got = re.search(r":v1:([0-9a-f]{%d}|unsigned)\u27e7" % _DIGEST_CHARS, m.group(0)).group(1)
    if got == SPEC["unsigned_sig"]:
        return True, False, f"written without {_SECRET_ENV} — marked but unsigned"
    if not secret:
        return True, False, f"{_SECRET_ENV} is not set — cannot verify"
    want = _digest(task_id, strip_signature(s), secret)
    if got == want:
        return True, True, ""
    return True, False, "signature does not match this body and task"


def build_agent_comment(body, task_id, name=None):
    """The full comment text to post: visible label, body, signature line."""
    name = name or os.environ.get("AGENT_NAME") or "Agent"
    text = f"{name}{SPEC['label_suffix']}\n{str(body or '').strip()}"
    secret = comment_secret()
    # ALWAYS a signature line — see the marker JSON for why an unsigned comment
    # must still be recognisable.
    sig = _digest(task_id, text, secret) if secret else SPEC["unsigned_sig"]
    return text + "\n" + SPEC["signature_template"].format(sig=sig)
