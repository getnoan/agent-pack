"""Who a park goes to, and why — the Python half of parkForHuman's resolver.

The twin of `resolveParkAssignees` in agents/noan.mjs. Both read the SAME
settings (agents/config.defaults.env) and both are checked against the SAME
cases (agents/park-resolver-fixtures.json), so the deck cannot drift from the
Node lanes — the shape agents/comment-grammar.json already uses for the
comment verbs.

Why this exists: deck.py's park_task tagged
needs-human, moved the task to backlog and wrote `assignees = existing minus
the agent`. It added NO human. On a task the agent alone held — which is every task
the deck agent is working — that is the empty set, so a guard-tripped deck
parked to nobody: the exact "handed to nobody" shape the board sweep escalates
weekly, in the one language the park guard could not see.

Resolution order, identical to the Node half:
  1. an explicit list the caller pins (the agent's own ids filtered out)
  2. the requester, when the task names one and HUMAN_IDENTITIES maps it
  3. PARK_ASSIGNEES_<AGENT>
  4. the lane default PARK_ASSIGNEES_CS|SALES|ENG
  5. PARK_ASSIGNEES_ENG as a last resort, flagged in `source`
  6. nothing — ids == [], source == "none", which the caller must treat loudly
"""
import os
import re

_HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_ENV_PATH = os.environ.get(
    "FLEET_CONFIG_DEFAULTS", os.path.join(_HERE, os.pardir, "agents", "config.defaults.env")
)

PARK_LANES = ("cs", "sales", "eng")


def load_fleet_config(path=None, env=None):
    """agents/config.defaults.env, with the real environment winning.

    Same precedence as agents/config-defaults.mjs: a value already set in the
    environment is never overridden, so a workflow can pin one without editing
    the file. A missing file is not an error — the caller's own checks report
    what is actually absent."""
    env = os.environ if env is None else env
    out = {}
    try:
        with open(path or CONFIG_ENV_PATH, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        text = ""
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        i = line.find("=")
        if i <= 0:
            continue
        key = line[:i].strip()
        if not re.match(r"^[A-Z][A-Z0-9_]*$", key):
            continue
        out[key] = line[i + 1:].strip()
    for k, v in env.items():
        if v not in (None, ""):
            out[k] = v
    return out


def _id_list(v):
    return [s.strip() for s in str(v or "").split(",") if s.strip()]


def agent_ids(cfg):
    """The agent's own identity ids: AGENT_IDENTITY_IDS / AGENT_IDENTITY_ID, with
    the fleet's VERITY_* names read as a fallback."""
    return _id_list(cfg.get("AGENT_IDENTITY_IDS") or cfg.get("AGENT_IDENTITY_ID")
                    or cfg.get("VERITY_IDENTITY_IDS") or cfg.get("VERITY_IDENTITY_ID"))


verity_ids = agent_ids  # historical name


def human_identities(cfg):
    """HUMAN_IDENTITIES="a@x=id,b@y=id" -> {email: id}, lowercased keys."""
    m = {}
    for pair in str(cfg.get("HUMAN_IDENTITIES") or "").split(","):
        i = pair.find("=")
        if i < 1:
            continue
        email = pair[:i].strip().lower()
        ident = pair[i + 1:].strip()
        if email and ident:
            m[email] = ident
    return m


def human_identity_for(email, cfg):
    """The workspace id for a human's email, or None. The agent's own addresses
    never resolve: it is not a human, whatever HUMAN_IDENTITIES says."""
    e = str(email or "").strip().lower()
    if not e:
        return None
    ident = human_identities(cfg).get(e)
    if ident and ident in verity_ids(cfg):
        return None
    return ident


def resolve_park_assignees(lane=None, agent=None, requester_email=None, assignees=None, cfg=None):
    """-> {"ids": [...], "source": "..."}. Pure: no HTTP, no side effects."""
    cfg = load_fleet_config() if cfg is None else cfg
    self_ids = set(verity_ids(cfg))

    # An explicit list wins — but never lets the agent through as "the human".
    # Parking a task to the agent that just gave up on it is not a hand-back.
    explicit = [a for a in (assignees or []) if a and a not in self_ids]
    if explicit:
        return {"ids": explicit, "source": "explicit"}

    req = human_identity_for(requester_email, cfg)
    if req:
        return {"ids": [req], "source": "requester %s" % str(requester_email).strip().lower()}

    if agent:
        key = "PARK_ASSIGNEES_" + re.sub(r"[^A-Z0-9]+", "_", str(agent).upper())
        ids = _id_list(cfg.get(key))
        if ids:
            return {"ids": ids, "source": key}

    ln = str(lane or "").lower()
    if ln in PARK_LANES:
        ids = _id_list(cfg.get("PARK_ASSIGNEES_" + ln.upper()))
        if ids:
            return {"ids": ids, "source": "PARK_ASSIGNEES_" + ln.upper()}

    eng = _id_list(cfg.get("PARK_ASSIGNEES_ENG"))
    if eng:
        return {"ids": eng, "source": "PARK_ASSIGNEES_ENG (fallback)"}
    return {"ids": [], "source": "none"}
