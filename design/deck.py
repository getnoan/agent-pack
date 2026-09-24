#!/usr/bin/env python3
"""
Sales follow-up deck generator.

Given a NOAN task (a post-meeting follow-up for a specific customer), builds a
PERSONALIZED sales deck that frames YOUR company's value for THAT prospect, grounded
in the task context + your value facts (positioning, value-prop, ICP, product
vision, usage metrics, case-study quotes, pricing). Renders a multi-slide HTML
document to a PDF via headless Chrome (--print-to-pdf, 16:9), and copies it into
the Google Drive folder named by deck_drive_dir.

Against NOAN it reads (GET /tasks, GET /facts) and writes only to the task it
is working: closed (status "done" + completed true) once the deck REACHED THE
PROSPECT, or PARKED for a human (needs-human tag, the agent unassigned, reason and
deck location appended to the details) when it was routed to review instead.
A parked task is worked from the board: a teammate comment "send" ships the
stored PDF as-is, "send: <text>" ships it with those words as the cover note,
"retry" (plus any guidance) rebuilds, and re-assigning the agent rebuilds too,
with every teammate comment and [Note] read as guidance. The PDF is hosted in
a private Supabase bucket at park time so a later send ships exactly the file
the human approved, after the CI runner that built it is gone. Stdlib-only
(urllib).

The per-customer context currently comes from the task title + details. When the
memo endpoint is exposed, meeting notes can be folded into build_prompt() as an
extra context block with no structural change.

Usage:
  python3 deck.py --task <taskId>          # generate a deck for one follow-up task
  python3 deck.py --task <taskId> --dry     # fetch + print what it would use, no gen
"""
import json, os, sys, time, argparse, urllib.request, urllib.error, urllib.parse
import datetime, re, subprocess, base64, shutil

# Portable paths (GitHub migration): DESIGN_DIR env wins; else the launchd-era
# home dir if it exists; else the script's own directory (repo checkout).
_SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
_HOME_BASE = os.path.expanduser("~/.noan-design-agent")
BASE = os.environ.get("DESIGN_DIR") or (_HOME_BASE if os.path.isdir(_HOME_BASE) else _SCRIPT_DIR)
CONFIG = os.path.join(BASE, "config.json")
CONFIG_DEFAULTS = os.path.join(_SCRIPT_DIR, "config.defaults.json")  # committed, no secrets
LOG = os.path.join(BASE, "deck.log")
OUTDIR = os.path.join(BASE, "decks")
STATE = os.path.join(BASE, "deck_state.json")  # dedup ledger for --scan (local backend)
SHOTS_DIR = os.path.join(BASE, "product-shots")
if not os.path.isdir(SHOTS_DIR):
    SHOTS_DIR = os.path.join(_SCRIPT_DIR, "product-shots")

STATE_BACKEND = (os.environ.get("STATE_BACKEND") or "local").strip().lower()
STATE_AGENT = "deck"  # agent_state row name

# 16:9 widescreen, PowerPoint's canonical size — used for @page and rendering.
SLIDE_W_IN, SLIDE_H_IN = 13.333, 7.5


def _required_cfg(cfg, key):
    """Config that must be supplied, never guessed.

    These used to default to our own addresses, which meant a downstream copy of
    this agent mailed a stranger's decks and review copies to the fleet's own
    inboxes. Caught by the
    export secret scan on 2026-09-14. An unset value now stops the run and says
    which key to set — a deck that does not send is recoverable; a deck sent to
    the wrong company is not.
    """
    v = (cfg.get(key) or "").strip()
    if not v:
        log(f"FATAL: '{key}' is not set in your deck config, and it has no default.")
        log("  Set it in design/config.json (see config.example.json) and run again.")
        sys.exit(1)
    return v


# Nothing about OUR company is a default in this file either: it ships in the
# public agent pack, and a downstream copy would otherwise sign as our agent,
# name our company in its decks, and treat our staff as its teammates. Our
# values live in config.defaults.json / agents/config.defaults.env, which never
# ship. The same rule as agents/required-env.mjs, in Python.

def agent_name(cfg):
    """How the agent signs: config agent_name, else AGENT_NAME, else "Agent"."""
    return (cfg.get("agent_name") or os.environ.get("AGENT_NAME") or "").strip() or "Agent"


def company_name(cfg):
    """Whose deck this is: config company_name, else COMPANY_NAME, else the NOAN
    workspace's own project name from GET /me (fetched once per run)."""
    v = (cfg.get("company_name") or os.environ.get("COMPANY_NAME") or "").strip()
    if v:
        return v
    if cfg.get("_company_name"):
        return cfg["_company_name"]
    name = None
    try:
        st, data = http("GET", f"{cfg['noan_base']}/me", noan_headers(cfg))
        if st == 200 and data:
            name = ((data.get("project") or {}).get("name") or "").strip()
    except Exception as e:  # a naming blip must not stop a deck
        log(f"  ! GET /me failed ({e}); the deck will say 'the company'")
    cfg["_company_name"] = name or "the company"
    return cfg["_company_name"]


def teammate_domain():
    """TEAMMATE_DOMAIN, or None: with no domain configured only COMMANDERS steer."""
    return (os.environ.get("TEAMMATE_DOMAIN") or "").strip().lower().lstrip("@") or None


def is_teammate_email(email, commanders):
    e = (email or "").lower().strip()
    if "@" not in e:
        return False
    d = teammate_domain()
    return e in commanders or bool(d and e.endswith("@" + d))


def agent_identity_ids(cfg):
    """The agent's NOAN identity ids (config agent_identity_ids; the older
    verity_identity_ids key is still read)."""
    return list(cfg.get("agent_identity_ids") or cfg.get("verity_identity_ids") or [])


def log(msg):
    line = f"{datetime.datetime.now().isoformat(timespec='seconds')} {msg}"
    print(line)
    with open(LOG, "a") as f:
        f.write(line + "\n")


def load_json(path, default=None):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save_state_deck(state):
    if STATE_BACKEND == "supabase":
        _sb_save_state(state)
        return
    with open(STATE, "w") as f:
        json.dump(state, f, indent=2)


# --- portability (GitHub migration): env-first config + optional Supabase state.
# With no env set, behavior is exactly the launchd era: config.json + local files.

def _sb(method, path_q, body=None):
    base = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    if not base or not key:
        log("FATAL: STATE_BACKEND=supabase but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing")
        sys.exit(2)
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if method == "POST":
        headers["Prefer"] = "resolution=merge-duplicates,return=minimal"
    req = urllib.request.Request(f"{base}/rest/v1/{path_q}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        text = r.read().decode()
    return json.loads(text) if text.strip() else None


def _sb_load_state():
    rows = _sb("GET", f"agent_state?agent=eq.{STATE_AGENT}&select=data")
    if not rows:
        # Missing row is NEVER a first run — an empty dedup ledger would
        # re-generate (and re-email) decks. Migrate/seed explicitly first.
        log(f"FATAL: agent_state row '{STATE_AGENT}' missing in Supabase -- run scripts/migrate-state.mjs first.")
        sys.exit(2)
    return rows[0]["data"]


def _log_usage(model, usage, action="deck"):
    """Spend ledger: one api_usage row per Claude call.
    Best-effort by contract — cost_usd stays 0 here; spend-worker re-prices
    token rows so Python needs no pricing table. Never raises, never exits."""
    try:
        base = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
        key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
        if not base or not key or os.environ.get("USAGE_LOG") == "0":
            return
        u = usage or {}
        row = {"agent": STATE_AGENT, "action": action, "provider": "anthropic",
               "model": model, "input_tokens": u.get("input_tokens"),
               "output_tokens": u.get("output_tokens"),
               "cache_read_tokens": u.get("cache_read_input_tokens"),
               "cache_write_tokens": u.get("cache_creation_input_tokens"),
               "cost_usd": 0, "run_id": os.environ.get("GITHUB_RUN_ID")}
        req = urllib.request.Request(
            f"{base}/rest/v1/api_usage", method="POST",
            data=json.dumps([row]).encode(),
            headers={"apikey": key, "Authorization": f"Bearer {key}",
                     "Content-Type": "application/json", "Prefer": "return=minimal"})
        with urllib.request.urlopen(req, timeout=10):
            pass
    except Exception as e:  # logging must never break the deck run
        log(f"  usage-log skipped: {e}")


def _sb_save_state(state):
    _sb("POST", "agent_state?on_conflict=agent",
        [{"agent": STATE_AGENT, "data": state,
          "updated_at": datetime.datetime.now(datetime.timezone.utc).isoformat()}])


def load_cfg():
    cfg = load_json(CONFIG) or load_json(CONFIG_DEFAULTS) or {}
    # NOAN_AGENT_API_KEY last so it WINS: later entries overwrite. This script
    # reads the key itself rather than going through agents/noan.mjs, so it has
    # to honour the per-category key on its own.
    for ck, ev in [("noan_api_key", "NOAN_PERSONAL_API_KEY"),
                   ("noan_api_key", "NOAN_AGENT_API_KEY"),
                   # The model key has two accepted names, matching resolveKey() in
                   # agents/anthropic.mjs: ANTHROPIC_API_KEY is canonical, LLM_API_KEY is for a
                   # user whose endpoint is not Anthropic and for whom that name is a lie. The
                   # canonical one is listed LAST so it WINS, by the same rule as the NOAN pair.
                   ("anthropic_api_key", "LLM_API_KEY"),
                   ("anthropic_api_key", "ANTHROPIC_API_KEY"),
                   # Model ids, so the deck is retuned the way every other agent is. The JSON
                   # config keeps working and still wins when the variable is unset.
                   ("design_model", "DESIGN_MODEL"),
                   ("cover_model", "COVER_MODEL"),
                   ("resend_api_key", "RESEND_API_KEY"),
                   ("deck_test_recipient", "DECK_TEST_RECIPIENT")]:
        v = os.environ.get(ev, "").strip()
        if v:
            cfg[ck] = v
    # The endpoint, from the same variable the JS agents read, so one setting moves the whole
    # pack rather than the deck needing its own. NOTE the shapes differ and that is deliberate:
    # ANTHROPIC_BASE_URL is the BARE base (agents/anthropic.mjs appends "/v1/messages"), while
    # this config key has always carried the version segment and appends only "/messages". So
    # the segment is added here rather than the variable being documented two different ways.
    #
    # Not forgiving of a "/v1" already on the variable, on purpose: anthropic.mjs would build
    # ".../v1/v1/messages" from the same value, and a deck that quietly worked where the other
    # five agents failed would hide the misconfiguration rather than surface it.
    base = os.environ.get("ANTHROPIC_BASE_URL", "").strip()
    if base:
        cfg["anthropic_base"] = base.rstrip("/") + "/v1"
    # A default, because the call sites index this key rather than .get() it, and a tree with no
    # config.json yet has nothing to index — config.defaults.json is on the export's forbidden
    # list, so in the pack it is absent by design. Before this, the deck raised KeyError on a
    # fresh checkout instead of saying what was unset. Same default as agents/anthropic.mjs, so
    # the two clients agree when nothing is configured as well as when something is.
    cfg.setdefault("anthropic_base", "https://api.anthropic.com/v1")
    return cfg


def http(method, url, headers, body=None, retries=4):
    data = json.dumps(body).encode() if body is not None else None
    # Some APIs sit behind Cloudflare, which blocks urllib's default UA (err 1010).
    headers = {"User-Agent": "noan-design-agent/1.0", **headers}
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    last = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                raw = r.read().decode()
                return r.status, (json.loads(raw) if raw.strip() else None)
        except urllib.error.HTTPError as e:
            code = e.code
            detail = e.read().decode()[:300]
            last = f"HTTP {code}: {detail}"
            if code == 429 or code >= 500:
                time.sleep(2 ** attempt)
                continue
            return code, {"error": detail}
        except urllib.error.URLError as e:
            last = f"URLError: {e}"
            time.sleep(2 ** attempt)
    raise RuntimeError(f"request failed after {retries} tries: {last}")


# ---------- NOAN ----------

def noan_headers(cfg):
    return {"Authorization": f"Bearer {cfg['noan_api_key']}",
            "Content-Type": "application/json"}


def find_task(cfg, task_id):
    """No GET /tasks/{id} exists — page the list and match by id."""
    page = 1
    while True:
        url = f"{cfg['noan_base']}/tasks?page={page}&per_page=100"
        status, data = http("GET", url, noan_headers(cfg))
        if status != 200 or not data:
            break
        for t in data.get("items", []):
            if t.get("id") == task_id:
                return t
        if not data.get("meta", {}).get("hasNext"):
            break
        page += 1
    return None


def fetch_facts(cfg, slug):
    url = f"{cfg['noan_base']}/facts?block_slug={slug}&per_page=50"
    status, data = http("GET", url, noan_headers(cfg))
    if status != 200 or not data:
        return []
    return [i.get("content", "") for i in data.get("items", [])]


def find_tag_id(cfg, name):
    """Resolve a NOAN tag name to its id. Case-insensitive but LITERAL — there
    is no POST /tags, so a near-miss resolves to nothing rather than creating
    anything. Returns None when absent.

    Pages rather than assuming the tag is in the first 100: there is no
    server-side name filter, and this project is already at ~80 tags. Falling
    off page one would resolve to None and create the follow-up UNTAGGED, which
    no agent would ever claim.
    """
    page = 1
    while page <= 20:
        status, data = http("GET", f"{cfg['noan_base']}/tags?page={page}&per_page=100", noan_headers(cfg))
        if not (200 <= status < 300):
            return None
        items = (data or {}).get("items", [])
        for t in items:
            if (t.get("name") or "").lower() == name.lower():
                return t.get("id")
        if not ((data or {}).get("links") or {}).get("next"):
            return None
        page += 1
    return None


def find_task_by_external_id(cfg, ext):
    """Existing task carrying this externalId, or None.

    POST /tasks does NOT enforce externalId uniqueness — the OpenAPI spec types
    it as a plain string, and both general-tools.mjs and reengage-worker.mjs
    check for an existing one before creating for exactly this reason. Without
    this check a retried deck send would create a SECOND follow-up task, and
    the follow-up agent would mail the prospect twice.
    """
    page = 1
    while page <= 20:
        status, data = http("GET", f"{cfg['noan_base']}/tasks?page={page}&per_page=100", noan_headers(cfg))
        if not (200 <= status < 300):
            return None
        for t in (data or {}).get("items", []):
            if t.get("externalId") == ext:
                return t
        if not ((data or {}).get("links") or {}).get("next"):
            return None
        page += 1
    return None


def next_working_day_9am_london():
    """~09:00 London on the next working day, as an ISO timestamp. Mirrors
    meetings.mjs's nextWorkingDay9amLondon so a follow-up armed here lands in
    the same slot as one armed by the meeting pipeline."""
    d = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(days=1)
    while d.weekday() >= 5:                      # 5=Sat, 6=Sun
        d += datetime.timedelta(days=1)
    return d.replace(hour=8, minute=0, second=0, microsecond=0).isoformat().replace("+00:00", "Z")


def arm_followup(cfg, task, contacts, prospect, subject):
    """Queue a follow-up for a deck that actually reached the prospect.

    The point: a deck landing in an
    inbox is one of the strongest buying signals the fleet produces, and until
    now it generated no next step at all. The follow-up agent is a one-shot
    sender triggered by tag + assignment, so arming it is just creating the
    task it looks for.

    Deliberately called ONLY after a confirmed send TO THE CUSTOMER. A deck
    routed to a human for review has not reached anyone, and arming a follow-up
    for it would have the agent chase a prospect about something they never got.

    Idempotent by an explicit externalId LOOKUP, not by the API (which does
    not enforce uniqueness). Failure here is logged and noted, never fatal:
    the deck has already gone out and nothing is served by unwinding that.
    """
    tag = cfg.get("deck_followup_tag", "follow up")
    delay_note = "next working day, ~09:00 London"
    ext = f"deck-followup:{task['id']}"
    who = ", ".join(c.get("name") or c.get("email") for c in contacts)
    details = "\n".join([
        f"Follow up on the deck sent to {who}.",
        "",
        f'Deck: "{prospect}" — cover email subject: "{subject}"',
        "Sent by the deck agent, so they have already received it. Reference it, do not resend it.",
        "",
        *[f"Contact ID: {c['id']}" for c in contacts[:1]],
        *[f"Email: {c.get('email','')}" for c in contacts[:1]],
        f"Armed automatically after the deck send ({time.strftime('%Y-%m-%d')}).",
    ])
    # externalId is not enforced unique by the API, so check first. A deck send
    # can be retried (a transient failure leaves the task in backlog for the
    # next scan), and a duplicate here means a second follow-up EMAIL.
    existing = find_task_by_external_id(cfg, ext)
    if existing:
        log(f"  follow-up already armed for this deck (task {existing['id']}) — not creating another")
        return existing["id"]

    body = {"title": f"Follow up on the deck sent to {who}"[:256],
            "details": details[:2000], "status": "backlog",
            "dueDate": next_working_day_9am_london(), "externalId": ext}
    status, data = http("POST", f"{cfg['noan_base']}/tasks", noan_headers(cfg), body)
    if not (200 <= status < 300):
        log(f"  ! follow-up NOT armed ({status}): {json.dumps(data)[:150]}")
        note_followup_failure(cfg, task, who, f"task creation returned {status}")
        return None
    new_id = ((data or {}).get("task") or data or {}).get("id")
    if not new_id:
        log("  ! follow-up NOT armed: task creation returned no id")
        note_followup_failure(cfg, task, who, "task creation returned no id")
        return None

    tag_id = find_tag_id(cfg, tag)
    if tag_id:
        http("PUT", f"{cfg['noan_base']}/tasks/{new_id}/tags", noan_headers(cfg), {"tagIds": [tag_id]})
    else:
        log(f"  ! follow-up tag '{tag}' not found in NOAN — task created UNTAGGED and no agent will claim it")
        note_followup_failure(cfg, task, who, f"tag '{tag}' does not exist in NOAN")

    if contacts:
        http("PUT", f"{cfg['noan_base']}/tasks/{new_id}/contacts", noan_headers(cfg),
             {"contactIds": [c["id"] for c in contacts]})
    # assignment LAST: it is the trigger, and the task should be fully built
    # before the follow-up agent can claim it
    verity = list(agent_identity_ids(cfg))
    if verity:
        http("PUT", f"{cfg['noan_base']}/tasks/{new_id}/assignees", noan_headers(cfg),
             {"assigneeIds": verity[:1]})
    else:
        log("  ! no verity_identity_ids configured — follow-up created but unassigned, so nothing will claim it")
        note_followup_failure(cfg, task, who, "no verity_identity_ids configured")

    log(f"  ✓ follow-up armed ({tag}, due {delay_note}) → task {new_id}")
    return new_id


def note_followup_failure(cfg, task, who, reason):
    """A deck went out but its follow-up did not arm. Leave a trace: the deck
    task is about to be closed, so without this the gap is invisible — which is
    the exact failure mode this whole phase exists to remove."""
    http("POST", f"{cfg['noan_base']}/notes", noan_headers(cfg), {
        "title": f"[deck] follow-up NOT armed — {who}"[:256],
        "content": (f"The deck for {who} was sent, but the follow-up task could not be armed.\n"
                    f"Reason: {reason}\n"
                    f"Originating deck task: {task['id']}\n"
                    "Queue a follow-up by hand, or fix the cause and re-arm."),
        "externalId": f"deck-followup-failed:{task['id']}",
    })


def mark_task_done(cfg, task_id):
    """Move a task to the Done column once its deck has been emailed for review.

    The ONLY write this job makes to NOAN. `completed` is set alongside `status`
    so the flag and the board stay consistent.
    """
    url = f"{cfg['noan_base']}/tasks/{task_id}"
    status, data = http("PATCH", url, noan_headers(cfg),
                        {"status": "done", "completed": True})
    if 200 <= status < 300:
        return True
    log(f"  ! could not move task to done ({status}): {json.dumps(data)[:150]}")
    return False


# ---------- parking (since 2026-09-08) ----------
# A deck routed to review used to CLOSE the task: the review email to the reviewer had
# no handler, re-assign cannot revive a done task, and so every guard trip
# ended with a human forwarding the PDF by hand. Now the task is parked the way
# the rest of the fleet parks (general-worker's flagForHuman, demo-worker's
# reach refusal): needs-human tag + the agent unassigned + the reason in the
# details, status left in backlog. Unassignment is what stops the scanner
# rebuilding it every run; re-assigning the agent is the hand-back, and the [Note]
# a human adds first rides into the next build through the task details.

PARK_MARKER = "[deck parked"
TASK_DETAILS_CAP = 2048          # POST/PATCH /tasks rejects longer details outright
PARK_TAG = "needs-human"


def strip_park_blocks(details):
    """Details without any earlier park block: a block runs from its marker
    line to the next blank line. The brief and any human [Note] survive; the
    prompt reads this so a re-run is not steered by the previous failure
    report, and a re-park replaces the old block instead of stacking."""
    out, skipping = [], False
    for line in (details or "").split("\n"):
        if line.startswith(PARK_MARKER):
            skipping = True
            continue
        if skipping:
            if line.strip() == "":
                skipping = False
            continue
        out.append(line)
    return "\n".join(out).rstrip()


def park_block(reason, deck_ref, review_to, when=None, as_is=None, agent=None):
    """The dated line that goes into the task details. `as_is` is None when a
    comment "send" can ship this exact deck, else the reason it cannot."""
    when = when or datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    agent = agent or os.environ.get("AGENT_NAME") or "Agent"
    send = (f'comment "send" to ship this exact deck with {agent}\'s cover note, or "send: <your text>" to use your words as the cover note; '
            if as_is is None else f'"send" is unavailable ({as_is}); ')
    return (f"{PARK_MARKER} {when}] Not sent to the prospect: {reason}. "
            f"Deck: {deck_ref}. A review copy went to {review_to}. "
            f"To act: {send}"
            f'comment "retry" (guidance after it) to rebuild; or add a [Note] and re-assign {agent}. '
            f"{agent} clears {PARK_TAG} on pick-up.")


def fit_park_details(existing, block, cap=TASK_DETAILS_CAP):
    """Existing details plus the park block, under the API's hard cap. Earlier
    park blocks are dropped first. The brief is a human's text and is never
    trimmed; when there is no room the BLOCK is shortened, and when not even a
    marker line fits the caller writes nothing (returns None)."""
    base = strip_park_blocks(existing)
    joined = f"{base}\n\n{block}" if base else block
    if len(joined) <= cap:
        return joined
    room = cap - (len(base) + 2 if base else 0)
    if room < 40:                    # the dated marker line is 34 chars; less is noise
        return None
    short = block[:room - 1].rstrip() + "…"
    return f"{base}\n\n{short}" if base else short


# Hosting (send-as-is, 2026-09-10): the review copy attached to the reviewer's email
# is not enough to send later — the runner's disk is gone by then. Same
# pattern as sdr-deck-worker's hostDeck: a PRIVATE bucket, a long-lived
# signed link for humans, and an authenticated download for the send.
DECK_BUCKET = os.environ.get("DECK_BUCKET", "decks")
DECK_LINK_DAYS = int(os.environ.get("DECK_LINK_DAYS", "90") or 90)


def _storage_env():
    base = (os.environ.get("SUPABASE_URL") or "").rstrip("/")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or ""
    return (base, key) if base and key else (None, None)


def _storage_req(method, path, body=None, content_type="application/json", timeout=90):
    """One Supabase Storage call. Returns (status, raw bytes); never raises on
    an HTTP error, so callers branch on the status."""
    base, key = _storage_env()
    headers = {"apikey": key, "Authorization": f"Bearer {key}", "User-Agent": "noan-design-agent/1.0"}
    data = None
    if body is not None:
        data = bytes(body) if isinstance(body, (bytes, bytearray)) else json.dumps(body).encode()
        headers["Content-Type"] = content_type
    req = urllib.request.Request(f"{base}/storage/v1/{path}", method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def host_pdf(cfg, pdf_path, slug):
    """Copy the PDF into the private bucket and mint a signed link. Returns
    (object_path, signed_url); (None, None) when hosting is unavailable, in
    which case the park still happens and "send" is refused with the reason."""
    if not pdf_path or not os.path.exists(pdf_path):
        return None, None
    base, _ = _storage_env()
    if not base:
        log("  ! no SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — deck not hosted; send-as-is unavailable")
        return None, None
    bucket = cfg.get("deck_bucket") or DECK_BUCKET
    try:
        st, raw = _storage_req("POST", "bucket", {"id": bucket, "name": bucket, "public": False})
        if st >= 300 and not re.search(rb"already exists|Duplicate", raw or b"", re.I):
            log(f"  ! bucket create failed ({st}): {(raw or b'')[:120]!r}")
            return None, None
        obj = f"{time.strftime('%Y-%m-%d')}/{slug}-{int(time.time() * 1000)}.pdf"
        with open(pdf_path, "rb") as f:
            st, raw = _storage_req("POST", f"object/{bucket}/{obj}", f.read(), "application/pdf")
        if st >= 300:
            log(f"  ! deck upload failed ({st}): {(raw or b'')[:120]!r}")
            return None, None
        st, raw = _storage_req("POST", f"object/sign/{bucket}/{obj}", {"expiresIn": DECK_LINK_DAYS * 86400})
        signed = None
        if st < 300:
            body = json.loads(raw or b"{}") or {}
            signed = body.get("signedURL") or body.get("signedUrl") or body.get("signed_url")
        else:
            log(f"  ! deck link signing failed ({st}); hosted without a link")
        url = f"{base}/storage/v1{'' if str(signed).startswith('/') else '/'}{signed}" if signed else None
        log(f"  ✓ deck hosted: {bucket}/{obj}")
        return obj, url
    except Exception as e:                          # hosting must never lose the park
        log(f"  ! deck hosting failed: {e}")
        return None, None


def fetch_hosted_pdf(cfg, obj, dest):
    """Download a hosted deck for a later send. Returns dest or None."""
    base, _ = _storage_env()
    if not base or not obj:
        return None
    bucket = cfg.get("deck_bucket") or DECK_BUCKET
    for path in (f"object/authenticated/{bucket}/{obj}", f"object/{bucket}/{obj}"):
        st, raw = _storage_req("GET", path)
        if st == 200 and raw:
            with open(dest, "wb") as f:
                f.write(raw)
            return dest
    log(f"  ! hosted deck not retrievable: {bucket}/{obj}")
    return None


# Comments as the steering channel. Same three kinds as agents/task-comments.mjs,
# decided in code from the API-verified creator identity, never from the text:
# teammate (a commander or an address at TEAMMATE_DOMAIN) steers; the agent's own identities
# never do; anyone else is dropped. The grammar mirrors
# sdr-approved-send.mjs: the WHOLE comment must be the instruction, so
# "don't send yet" can never match "send".
# The verb grammar (send / send: <text> / retry / steer) is SHARED with the
# Node lanes — agents/comment-grammar.json, compiled by comment_grammar.py
# here and comment-grammar.mjs there. Three hand-copied regexes used to live
# in this file and drifted from their JS twins: on 2026-09-11 "send as-is"
# sent a deck but was silently ignored on a parked demo, and "regenerate"
# rebuilt a demo but was read as guidance here.
# WHO may ask stays local, in teammate_comments below.
from park_assignees import resolve_park_assignees
from slack_pointer import notify_park
from comment_grammar import classify_comment as _classify_verb
from agent_comment import has_agent_marker, verify_agent_comment, strip_signature


def commander_emails():
    # No built-in roster: unset means nobody steers. A default here would let our
    # teammates steer a downstream copy of this agent.
    raw = os.environ.get("COMMANDERS") or ""
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def teammate_comments(task, cfg):
    """The task's comments a human teammate wrote, oldest first, each as
    {id, at, email, name, text}. Empty comments dropped.

    The JS twin of this is normalizeComments in agents/task-comments.mjs; the
    live payload shape is documented there. Keep the two in step — on
    2026-09-18 the API flattened `content` to a plain string and dropped
    creator.email, createdByAssistant and removedAt, and BOTH copies read the
    fields that vanished, so the deck lane went as quiet as the general one.

    No removedAt filter is needed: soft-deleted comments are not returned at
    all (confirmed with the API team 2026-09-18).
    """
    self_ids = set(agent_identity_ids(cfg))
    cmd = commander_emails()
    out = []
    for c in task.get("comments") or []:
        if not c:
            continue
        # `content` is a plain string since 2026-09-18. Anything else is
        # dropped rather than stringified into a steering channel.
        raw = c.get("content")
        text = raw.strip() if isinstance(raw, str) else ""
        if not text:
            continue
        creator = c.get("creator") or {}
        email = str(creator.get("email") or "").lower().strip()
        cid = creator.get("id") or c.get("creatorId")
        # Two ways a comment is the agent's own, and the second carries the
        # weight: creator.id only works where the key is genuinely the agent's
        # identity, which a deployment running under a person's key cannot
        # arrange. The marker travels in the comment itself. Twin of
        # normalizeComments in agents/task-comments.mjs.
        if cid and cid in self_ids:
            continue
        if has_agent_marker(text):
            # Recognised by shape; a bad signature does NOT reclassify it as a
            # teammate's, which would be the dangerous direction.
            _, valid, reason = verify_agent_comment(text, task.get("id"))
            if not valid:
                print(f"deck: comment {c.get('id')} carries the agent marker but does not verify "
                      f"({reason}) — treated as the agent's own and ignored")
            continue
        text = strip_signature(text)
        if not is_teammate_email(email, cmd):
            if not email:
                print(f"deck: UNCLASSIFIED comment {c.get('id')} — no creator.email on the payload, dropped")
            continue
        out.append({"id": c.get("id"), "at": str(c.get("createdAt") or ""), "email": email,
                    "name": creator.get("name") or email, "text": text})
    out.sort(key=lambda x: x["at"])
    return out


def classify_comment(text):
    """What one teammate comment asks for, in this lane's vocabulary:
         ("send", None)      ship the parked deck with the agent's cover note
         ("send", text)      ship it with these words as the cover note
         ("retry", guidance) rebuild, guidance may be empty
         ("guidance", text)  anything else: read on the next rebuild

    A thin mapping of the shared grammar's verbs onto the tuple this file's
    callers already expect."""
    verb, payload = _classify_verb(text)
    if verb == "send":
        return "send", None
    if verb == "send_with_text":
        return "send", payload
    if verb == "retry":
        return "retry", payload
    return "guidance", payload


def guidance_lines(comments):
    """Teammate words that should steer a rebuild: plain comments, and the
    text after a retry keyword. Bare instructions ("send", "retry") carry no
    guidance and are skipped."""
    lines = []
    for c in comments:
        kind, payload = classify_comment(c["text"])
        if kind in ("guidance", "retry") and payload:
            lines.append(f"- {c['name']}: {payload}")
    return lines


def park_time(task, rec):
    """When the task was parked, ISO-ish and lexically comparable with a
    comment's createdAt: the ledger record wins, else the marker line."""
    if rec and rec.get("at"):
        return rec["at"]
    m = re.search(r"\[deck parked (\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC\]", task.get("details") or "")
    return f"{m.group(1)}T{m.group(2)}:00.000Z" if m else ""


def task_requester_email(task):
    """The requester a task names in its own details: a `Notify:` line wins,
    then `Requested by <email>`. None when neither is there. Mirrors
    taskRequesterEmail in agents/noan.mjs so a deck park lands on the person
    who asked, exactly as a Node lane's park would."""
    d = str((task or {}).get("details") or "")
    m = re.search(r"^Notify:\s*([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})", d, re.I | re.M)
    if m:
        return m.group(1).lower()
    m = re.search(r"Requested by\s+([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})", d, re.I)
    return m.group(1).lower() if m else None


def park_task(cfg, task, reason, deck_ref, as_is=None):
    """Park a deck task for a human instead of closing it. Returns True only if
    the agent was actually unassigned — that is the write that stops the scanner
    rebuilding the deck every run, so the caller falls back to closing the task
    when it fails. The details and tag writes are best-effort and logged."""
    base = cfg["noan_base"]
    h = noan_headers(cfg)
    tid = task["id"]
    block = park_block(reason, deck_ref, _required_cfg(cfg, "deck_email_to"), as_is=as_is, agent=agent_name(cfg))
    details = fit_park_details(task.get("details") or "", block)
    if details is None:
        log(f"  ! details already at the {TASK_DETAILS_CAP}-char cap — park note not written")
    else:
        # status backlog explicitly: the fleet's park state, and where the
        # scanner's predicate looks for a re-assigned task.
        st, data = http("PATCH", f"{base}/tasks/{tid}", h, {"details": details, "status": "backlog"})
        if not (200 <= st < 300):
            log(f"  ! park note not written ({st}): {json.dumps(data)[:150]}")
    tag_id = find_tag_id(cfg, PARK_TAG)
    if tag_id:
        ids = {t.get("id") for t in (task.get("tags") or []) if t.get("id")} | {tag_id}
        st, data = http("PUT", f"{base}/tasks/{tid}/tags", h, {"tagIds": sorted(ids)})
        if not (200 <= st < 300):
            log(f"  ! {PARK_TAG} tag not applied ({st}): {json.dumps(data)[:150]}")
    else:
        log(f"  ! tag '{PARK_TAG}' not found in NOAN — parked task carries no tag")
    verity = set(agent_identity_ids(cfg))
    keep = [a.get("id") for a in (task.get("assignees") or []) if a.get("id") and a.get("id") not in verity]
    # A park PUTS A HUMAN ON THE TASK. Until 2026-09-11 this wrote `keep`
    # alone - the assignees minus the agent - which on a task the agent alone held
    # is the empty set: the deck parked to NOBODY, the exact shape the board
    # sweep escalates weekly, in the one language the park guard could not see
    # The resolver is shared with the Node lanes
    # through agents/config.defaults.env, so "who owns a deck park" is
    # answered in one place: PARK_ASSIGNEES_SALES.
    who = resolve_park_assignees(lane="sales", agent="deck",
                                 requester_email=task_requester_email(task))
    if not who["ids"]:
        log("  ! NO HUMAN RESOLVED for this park — set PARK_ASSIGNEES_SALES or PARK_ASSIGNEES_ENG "
            "in agents/config.defaults.env; parking anyway, but this task is owned by nobody")
    assignee_ids = sorted(set(keep) | set(who["ids"]))
    # PUT sub-resources answer with an empty body: branch on the status only.
    st, data = http("PUT", f"{base}/tasks/{tid}/assignees", h, {"assigneeIds": assignee_ids})
    if not (200 <= st < 300):
        log(f"  ! could not unassign {agent_name(cfg)} ({st}): {json.dumps(data)[:150]}")
        return False
    # A task born in a Slack thread is answered IN that thread. The deck is
    # the lane a Slack user is most likely to delegate to ("make me a deck"),
    # and it was the one that answered by email.
    # Same rule, same wording and the same fail-soft as parkForHuman's
    # notifyParkThread on the Node side.
    told = notify_park(task, reason, agent="deck", assigned=assignee_ids, log=log)
    log(f"  ✓ parked ({PARK_TAG}, {agent_name(cfg)} unassigned, {len(who['ids'])} human via {who['source']}): "
        f"{reason} — re-assign {agent_name(cfg)} to re-run" + (" — and told the Slack thread" if told else ""))
    return True


def clear_park_tag(cfg, task):
    """A human re-assigned the agent on a parked task: drop needs-human so the
    board stops showing it as waiting on a person. Returns True if it changed."""
    tags = task.get("tags") or []
    keep = [t.get("id") for t in tags if t.get("id") and (t.get("name") or "").lower() != PARK_TAG]
    if len(keep) == len(tags):
        return False
    st, data = http("PUT", f"{cfg['noan_base']}/tasks/{task['id']}/tags", noan_headers(cfg), {"tagIds": keep})
    if 200 <= st < 300:
        log(f"  hand-back: {PARK_TAG} cleared ({agent_name(cfg)} re-assigned by a human)")
        return True
    log(f"  ! could not clear {PARK_TAG} ({st}): {json.dumps(data)[:150]}")
    return False


# ---------- confidence (2026-09-11) ----------
# Decks send to the prospect without a human reading them. The exception asked
# for is "unless confidence is low or information is lacking", and until now
# there was nothing in this file that could answer either half: every gate was
# about the ARTEFACT (is the demo slide linked, is a shot stale), none about
# whether we had enough to say about this prospect in the first place.
#
# Two signals, deliberately different in kind:
#   - brief_is_thin()  — deterministic, code-owned. There was provably nothing
#                        to personalise on. Not a judgment call.
#   - the model's own  — declared in DECK_META as confidence:"low" plus a
#     declaration        why_low. WHEN to declare it is business judgment, so
#                        the rules live in the Deck Agent Config fact and are
#                        read at runtime; the constant below is the fallback
#                        AND the restore source (test-deck-confidence.mjs
#                        asserts it matches the seed).
#
# Fail direction, matching reengage-agent.mjs: ONLY an explicit "low" parks. A
# missing or unparseable confidence field sends, because omission is not a
# declaration and the sales lead's instruction is to send by default. The deterministic
# gate still applies either way.
SLIDE_RULES_DEFAULT = """## Slide design (built-in default)
No `## Slide design` section was found in the Deck Playbook fact, so these generic rules apply. Put your own resolved values there (hex colours, typefaces, display line-height and tracking, radii) and the agent pastes that section here verbatim on the next run.
- The design system fact is the authoritative visual source. Where it conflicts with the brand identity fact, the design system wins.
- Take colours, type, radii, spacing and component shapes from it and write them as literal CSS values.
- Every slide has an explicit background fill (never transparent) so it prints; keep one consistent ground across the deck.
- At most one accent moment per slide; never a background wash or gradient unless the system calls for it.
- Use the system's typefaces only if they are installed on the render machine; otherwise a system sans-serif. Display line-height at least 1.1, body line-height at least 1.5, body never below 14px."""


def load_slide_rules(cfg):
    """The `## Slide design` section of the Deck Playbook fact: the resolved
    values for rendering this company's design system as print slides (its
    hex, typefaces, display leading and tracking). Read at run time so the
    brand lives in the fact layer, never in this file. Returns (text, source);
    fail-soft to the generic built-in default, like load_playbook."""
    text = load_playbook(cfg) or ""
    m = re.search(r"^## Slide design[^\n]*\n(?:.*\n?)*?(?=^## |\Z)", text, re.M)
    if not m:
        return SLIDE_RULES_DEFAULT, "built-in default"
    return m.group(0).strip(), "Deck Playbook fact"


CONFIDENCE_RULES = """## Confidence rules

You decide whether this deck is safe to send to the prospect WITHOUT a human reading it first. Declare confidence in the metadata line: "high" or "low".

Declare LOW when any of these is true:

- The brief gives you nothing specific about THIS prospect's business, so the deck could have been written for anyone in the ICP.
- You had to guess at what they do, what they want, or why they are talking to you.
- The brief implies a conversation, commitment, or context you cannot see, so the deck risks referring to something that did not happen.
- Anything you would need to state about the company to make the argument land is absent from the value facts, and you found yourself reaching.
- The brief looks like a test record, a placeholder, or an internal note rather than a real prospect.

Declare HIGH when the brief (plus any customer history) gives you at least one concrete, specific thing about their business to build the argument on, and every claim about the company rests on the value facts.

Write the best deck you can BEFORE deciding confidence, never a placeholder: a low-confidence deck is stored and shown to a human, who usually sends it with a small edit. When you declare low, why_low must say in one or two sentences what specifically was missing. That text is read by a colleague and never by the prospect."""


def load_confidence_rules(cfg):
    """The confidence rules, read from the Deck Agent Config fact at runtime.

    Mirrors load_playbook's fail-soft contract: any NOAN blip falls back to the
    built-in CONFIDENCE_RULES rather than changing what the model is asked. The
    `config` slug has been in deck_fact_slugs since the Config fact was seeded
    but was never read by this file — the fact was documentation only. This is
    the first thing that reads it, so the section heading is now load-bearing:
    the fact must keep a "## Confidence rules" heading, and that section must
    stay addressed to the model, because it is injected verbatim. The fact's
    separate "## Confidence" section is the human-facing half and is NOT sent
    to the model; splitting them is what keeps prose about config flags out of
    the prompt.
    """
    slug = (cfg.get("deck_fact_slugs") or {}).get("config")
    if not slug:
        return CONFIDENCE_RULES
    try:
        text = "\n\n".join(fetch_facts(cfg, slug)).strip()
    except Exception as e:
        log(f"  ! deck config fetch failed ({e}); using built-in confidence rules")
        return CONFIDENCE_RULES
    section = extract_section(text, "Confidence rules")
    if not section:
        log("  ! Deck Agent Config carries no '## Confidence rules' section; using built-in confidence rules")
        return CONFIDENCE_RULES
    return section


def extract_section(text, heading):
    """A markdown section by heading name, at any heading level, up to the next
    heading of the same or shallower depth. Returns "" when absent."""
    m = re.search(r"^(#{1,6})\s*" + re.escape(heading) + r"\s*$", text or "", re.M | re.I)
    if not m:
        return ""
    depth = len(m.group(1))
    rest = text[m.end():]
    nxt = re.search(r"^#{1," + str(depth) + r"}\s+\S", rest, re.M)
    body = rest[:nxt.start()] if nxt else rest
    # The heading line is kept exactly as the fact spells it, not
    # re-cased: the section is injected into a prompt, and a fact editor's
    # capitalisation is theirs to choose.
    return (m.group(0).strip() + "\n" + body).strip()


def brief_is_thin(task_title, details, guidance=None, history=None):
    """Was there anything to personalise on? Returns a reason string, or None.

    Pure and exported for testing: this is the "information lacking" half of
    the sales lead's exception and it must be decidable without standing up a task.

    Deliberately narrow. Measured 2026-09-11: 11 of the first 12 contacts on
    the board carry one memo or none, and the richest carries 8 — so a gate
    that demanded memo history would park nearly every deck and the exception
    would swallow the rule. A deck is thin only when the brief says nothing
    beyond the title AND no colleague added guidance AND there is no customer
    history at all: the case where there is provably nothing prospect-specific
    in front of the model.
    """
    body = strip_park_blocks(details or "")
    # The park block is the agent's own previous failure report, and a re-park
    # rewrites it — it is never prospect information. [Note] lines ARE.
    body = re.sub(r"^\s*(\(none\))\s*$", "", body, flags=re.M).strip()
    if body or (guidance or []) or (history or "").strip():
        return None
    if len((task_title or "").strip()) >= 60:
        # A long descriptive title can carry a real brief on its own
        # ("Deck for Acme, mid-market logistics, wants the fact layer story").
        return None
    return ("the brief is empty: the task has no details, no teammate guidance and no "
            "customer history, so there was nothing prospect-specific to build on")


# ---------- Claude ----------

def build_prompt(customer_ctx, design_system, visual, value_facts, shots=None,
                 subscribe_url=None, demo_url=None,
                 cold_origin=False, confidence_rules=None, company="the company",
                 slide_rules=None):
    """The deck prompt. `company` is whose deck this is (company_name()); the
    two URLs are optional — with no demo_url there is no demo slide, and with
    no subscribe_url the subscribe CTAs stay unlinked text."""
    facts_block = "\n\n".join(f"### {name}\n{txt}" for name, txt in value_facts if txt)
    C = company
    # A demo shot only makes sense on a demo slide, and there is one only when
    # demo_url is configured; without it the shot rules would demand a slide the
    # structure below says does not exist.
    has_demo_shot = bool(demo_url) and any(s.get("id") == "demo-player" for s in (shots or []))
    demo_shot_rule = (
        "- The `demo-player` shot is RESERVED for the mandatory DEMO slide (see the "
        "deck structure) — it MUST appear there and NOWHERE else, and it does NOT "
        "count toward the shot cap below.\n") if has_demo_shot else ""
    demo_shot_inline = "the `demo-player` screenshot, " if has_demo_shot else ""
    demo_shot_line = (
        "- The `demo-player` product shot MUST appear on this slide, inside the "
        "standard contained shot card (same card rules as the other shots).\n"
        if has_demo_shot else "")
    if shots:
        shot_list = "\n".join(
            f"- id: `{s['id']}` — {s['shows']} (suits: {', '.join(s.get('good_for', []))})"
            for s in shots)
        shots_block = f"""
# PRODUCT SHOTS (real screenshots of the product — available to you)
{shot_list}

## How to use them (hard rules)
- Reference a shot with EXACTLY `<img src="SHOT:<id>" alt="...">` using an id from the list above. The build step swaps it for the real image. NEVER invent an id, never use a URL or file path, never use a placeholder service.
{demo_shot_rule}- **Use the other shots SPARINGLY: at most 2 in the ENTIRE deck, and 1 per slide.** A deck with no shots beyond the demo slide is acceptable if none genuinely earn their place. Pick the shot(s) whose subject matches that slide's argument.
- Apart from the demo slide, shots are ONLY allowed on the "what {C} is" or "how it works for them" slides. NEVER on the cover, the proof/quote slide, the pricing slide, or the final CTA slide.
- Most shots are LIGHT-MODE UI on a dark deck (the `demo-player` shot is dark with its own gradient frame). Either way they must be CONTAINED, never full-bleed: place each inside a card using the elevated surface, hairline border and card radius from the slide design rules — sized to at most ~55% of the slide width, sitting in its own column/zone beside the text.
- The shot occupies its own zone inside the CONTENT block — it must never overlap the headline, body text, or the footer. The card must stay fully inside the content block: `max-height:100%; min-height:0;` on the card and `display:block; width:100%; max-height:100%; height:auto; object-fit:contain;` on the `<img>`. If the shot would be taller than its zone, it must SHRINK — never extend toward the bottom edge of the slide.
- Vertically CENTRE the shot card within the content block (e.g. `align-items:center` on the row) rather than letting it hang low. It should sit visually balanced against the text column, with clear space between its bottom edge and the footer.
- Do not add fake browser chrome or device frames around them; the screenshots already include a browser window.
"""
    else:
        shots_block = ""
    # 2026-08-12: the SDR path hands off a deck request with no meeting behind
    # it at all — a prospect replying "yes" to the agent's cold email. The default
    # opener below is correct for the tool's original case (a real sales call
    # already happened) but would bias a cold-origin deck toward
    # meeting-reflective language ("great chatting", "as discussed") for a
    # relationship that is, so far, entirely written. There is already a guard
    # against fabricating specific meeting details from customer history; this
    # is the framing half of that same honesty requirement.
    opener = (
        f"You are {C}'s head of sales, building a PERSONALIZED deck to send a prospect who just "
        "replied to your cold outbound email asking for one. No meeting has happened yet, so "
        "write accordingly: reference their reply and what they asked about, never a conversation "
        "that never took place."
        if cold_origin else
        f"You are {C}'s head of sales, building a PERSONALIZED follow-up deck to send a prospect after a meeting."
    )
    # The demo slide and the CTA links exist only when a URL was configured.
    if demo_url:
        demo_structure = "6. DEMO — MANDATORY, see the demo slide rules below\n"
        demo_section = f"""# THE DEMO SLIDE (MANDATORY — every deck includes this slide, no exceptions)
A slide inviting the prospect to watch the {C} demo, placed right after "how it works for them":
- Keep it simple and uncluttered: an eyebrow, a short ALL-CAPS display headline inviting them to see {C} in action (e.g. "SEE IT FOR YOURSELF"), ONE short supporting line (may nod to the prospect's use case), {demo_shot_inline}and the CTA. Nothing else competes on this slide.
{demo_shot_line}- The CTA is a real clickable link: `<a href="{demo_url}">Watch the demo</a>` styled as the primary button from the slide design rules (its colours and radius; `text-decoration:none; display:inline-block`). This button is the slide's single orange moment.
"""
        demo_never = "the DEMO slide is NEVER merged or dropped. "
    else:
        demo_structure = ""
        demo_section = "# THE DEMO SLIDE\nNo demo URL is configured, so there is NO demo slide in this deck and no \"watch the demo\" CTA anywhere.\n"
        demo_never = ""
    allowed_urls = [u for u in (subscribe_url, demo_url) if u]
    if subscribe_url:
        cta_rule = (f"- CTA LINKS: the subscribe / start-trial / join CTA MUST be a real clickable hyperlink to **{subscribe_url}** — wrap it as `<a href=\"{subscribe_url}\">`, styled as the primary button from the slide design rules (its colours and radius; `text-decoration:none; display:inline-block`). This applies to EVERY subscribe-flavoured CTA anywhere in the deck (cover, pricing slide, final slide) — whatever its label (\"Subscribe\", \"Start your free trial\", \"Subscribe & start onboarding\", \"Get started\"). Chrome's print-to-PDF preserves it, so the prospect can click it in the PDF. Never use a bare <button>, a plain <div>, or a `#` href for a subscribe CTA."
                    + (f" The demo slide's \"Watch the demo\" CTA links to **{demo_url}** the same way." if demo_url else ""))
    else:
        cta_rule = ("- CTA LINKS: no subscribe URL is configured, so subscribe-flavoured CTAs stay as unlinked text styled as the primary button."
                    + (f" The demo slide's \"Watch the demo\" CTA links to **{demo_url}** as a real `<a href>`." if demo_url else ""))
    if allowed_urls:
        cta_rule += (f" {'These are the ONLY ' + str(len(allowed_urls)) + ' URLs' if len(allowed_urls) > 1 else 'This is the ONLY URL'} allowed in the deck — do NOT invent any other; "
                     "a different CTA (e.g. \"book a call\") stays unlinked text unless you were given a URL for it.")
    else:
        cta_rule += " No URL is allowed anywhere in the deck; every CTA is unlinked text."
    return f"""{opener} The deck's job: remind them of the value {C} delivers for THEIR specific situation and move them to commit.

# THE PROSPECT (from the follow-up task — this is who the deck is FOR)
{customer_ctx}

Personalize throughout: name them, speak to their business, their goals, and the specific next step implied by the task. Do not invent facts about the prospect beyond what is given; you may reason about how {C} helps their stated situation.

# VISUAL DESIGN SYSTEM (THE AUTHORITATIVE VISUAL SOURCE)
This is the canonical design system. **Where it conflicts with the brand identity below, THIS DOCUMENT WINS — always.**

{design_system}

## Translating the design system to these slides (important)
The system may be written for a web app (utility classes, an icon library, a build step). This deck is standalone print HTML with NO framework, NO icon library, and NO build step. So:
- Use the system's TOKEN VALUES as literal inline CSS (the hex and size values it gives), not class names. Define them as CSS custom properties on :root and reference them.
- Use the system's type scale, spacing rhythm, radius scale, and component recipes (buttons, cards, chips, eyebrows) translated into plain CSS.
- Do NOT emit utility classes, component-library imports, @apply, or @plugin — none of it will render.
- Icons: if you need one, draw it as inline SVG with 1px strokes using currentColor. No icon library.

{slide_rules or SLIDE_RULES_DEFAULT}

# BRAND IDENTITY (secondary — for mood, voice, and composition principles ONLY; the design system above overrules any visual conflict)
{visual}

# VALUE FACTS (ground all claims about {C} in these — never invent metrics, pricing, or features)
{facts_block}

# CONFIDENTIALITY — THE COMPANY'S INTERNAL BUSINESS NUMBERS ARE BANNED FROM THIS DECK
This deck is sent to a PROSPECT. Some facts above are internal analyses and contain {C}'s own business figures. Those figures are confidential AND unpersuasive (telling a prospect how few users you have argues against you). They must NEVER appear, in any slide, in any form — not as a stat, a caption, a footnote, or prose.

BANNED — do not state, paraphrase, round, or allude to any of these:
- Counts of {C}'s users, customers, businesses, accounts or teams (e.g. "149 businesses analyzed", "300 conversations", "active users", "142 founders").
- Usage volumes or activity totals (e.g. "2,228 user actions", "6,898 in the last 30 days", "best week ever").
- Feature-usage percentages (e.g. "Facts 29.5%, Tasks 26.4%"), retention, growth rates, revenue, ARR, funding, or benchmarks.
- {C}'s internal strategy, roadmap, market/competitive analysis, "target growth segments", "white space", data-quality notes, or methodology.
If a number describes {C}'s own business rather than the PROSPECT's, assume it is banned.

ALLOWED as proof instead — this is what the proof slide MUST be built from:
- **Attributed customer quotes from the value facts — this is the PRIMARY proof source.** Use only real, attributed testimonials present in the facts. Quote them VERBATIM with their attribution. Pick 1–3 whose THEME best mirrors this prospect's situation. Do not alter wording or invent attributions; use only quotes present in the facts.
- **What customers actually use {C} for** — supporting context from any segmentation or use-case fact: the kinds of businesses using it and what they use it for. Describe qualitatively — the SHAPE of usage, never the counts behind it.
- Additional named case-study quotes from a qualitative-insights fact are also fine if a better thematic match exists there.
- Lead with the proof closest to the PROSPECT's own business. The proof slide is about *what {C} does for people like them*, not how big {C} is.
{shots_block}

# DECK STRUCTURE (a tight sales follow-up arc — aim for 9-11 slides)
1. Title / cover — personalized ("Prepared for <name>", the core value line)
2. Their situation — reflect back the prospect's goal/pain in their words
3. The shift — the insight {C} represents
4. What {C} is — plainly
5. How it works for them — mapped to their use case
{demo_structure}7. Proof — 1–3 attributed customer quotes from the value facts, chosen by theme to mirror this prospect, optionally alongside the use cases people like them run on {C}. NEVER a {C} business metric — see the confidentiality rule above.
8. Pricing — the actual plan from the facts, framed for their commitment
9. The next step — one clear CTA tied to the task (e.g. subscribe / book onboarding)
Merge or add a slide only if the arc needs it — {demo_never}Every factual claim traces to a value fact.

{demo_section}
# LAYOUT & RENDER RULES (hard constraints — this renders to PDF via Chrome print)
- Output ONE complete HTML document containing all slides.
- CSS: `@page {{ size: {SLIDE_W_IN}in {SLIDE_H_IN}in; margin: 0; }}` and `html,body {{ margin:0; -webkit-print-color-adjust:exact; print-color-adjust:exact; }}`.
- Each slide is `<section class="slide">` sized EXACTLY {SLIDE_W_IN}in x {SLIDE_H_IN}in, `position:relative; overflow:hidden; page-break-after:always;` (last slide no break). Every slide's background must be an explicit fill taken from the slide design rules (never transparent) so it prints.
- Obey the design system and the slide design rules above for colour, type, accents, borders, radii and spacing.
- CTA BUTTON SIZE: a button hugs its label — `width:fit-content` plus `align-self:flex-start` (or `align-self:center` when the layout centres it). The slide is a flex column whose default `align-self:stretch` will otherwise stretch the CTA into a full-width orange bar spanning the page — that is a DEFECT, not a button. Padding ~16px 44px; the button should read as a pill a thumb could press, clearly narrower than the text column above it.
- FLOW LAYOUT, NOT OVERLAP (most important rule): lay each slide out with NORMAL DOCUMENT FLOW — the slide is a `display:flex; flex-direction:column` container with padding >=0.5in and an explicit `gap` (>=0.25in) between blocks. The eyebrow, headline, sub-head, body, and CTA are SEPARATE sibling blocks that push each other apart in flow. A taller headline must move the sub-head DOWN, never sit on top of it.
- **NOTHING may be `position:absolute` — not text, not images, and NOT the footer.** Absolute elements reserve no space, so other content slides underneath them and collides. This is banned outright. Also no negative margins and no overlapping stacked layers.
- SLIDE SKELETON (use this structure): the slide is a flex column of exactly three flex children — a header/eyebrow block, a `flex:1; min-height:0;` CONTENT block, and a FOOTER block as the LAST child with `margin-top:auto`. Because the footer is a real flex child it reserves its own row, so no content can ever land on top of it. Everything (headline, body, cards, product shots) lives INSIDE the content block and is bounded by it.
- The content block must not overflow: give it `min-height:0` and give any product-shot card `max-height:100%; min-height:0;` with the `<img>` at `max-height:100%; width:100%; object-fit:contain;` so a tall screenshot SHRINKS to fit its zone instead of pushing past the footer or off the slide.
- Display line-height and tracking: use the LITERAL values the slide design rules give, never relative leading tokens for display type, and never let consecutive display lines collide or clip.
- Body copy line-height per the slide design rules, never below 1.5.
- No headline line may overlap the block below it. If content is too tall to fit the slide at comfortable sizes, REDUCE font-sizes (or split into two slides) — never let blocks overlap or clip.
- Every element sits fully inside its slide with >=0.5in margins; nothing clipped; text blocks and any diagram occupy separate, non-overlapping regions.
- No external ASSETS: no stock photos, no <script>, no web fonts, no remotely-loaded images/CSS/JS. Type, hairlines, and inline SVG line-work — plus the `SHOT:<id>` product screenshots described above, which are the ONLY permitted <img> tags. (This bans remote *resources*; hyperlinks are fine — see the CTA link rule below.)
{cta_rule}

{confidence_rules or CONFIDENCE_RULES}

# RETURN (read carefully — do NOT wrap the HTML in JSON)
Return the COMPLETE HTML document and nothing else. No prose, no markdown fence.
The VERY FIRST line must be a single HTML comment carrying small metadata (no HTML inside it), exactly this shape:
<!--DECK_META {{"deck_title":"...","prospect":"...","slides":["slide 1 summary","slide 2 summary","..."],"confidence":"high","why_low":""}}-->
Then, starting on the next line, the full `<!DOCTYPE html>` document with all slides.
The metadata JSON must be valid and on ONE line. Everything after the comment is the raw HTML."""


def call_claude(cfg, prompt):
    url = f"{cfg['anthropic_base']}/messages"
    headers = {
        "x-api-key": cfg["anthropic_api_key"],
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
    }
    body = {
        "model": cfg.get("design_model", "claude-opus-4-8"),
        "max_tokens": 20000,
        "messages": [{"role": "user", "content": prompt}],
    }
    status, data = http("POST", url, headers, body)
    if status != 200:
        raise RuntimeError(f"Claude API {status}: {json.dumps(data)[:300]}")
    _log_usage(body["model"], data.get("usage"), "deck")
    return "".join(b.get("text", "") for b in data.get("content", [])
                   if b.get("type") == "text")


def parse_deck(text):
    """Split the response into (metadata dict, html document).

    The model returns a leading `<!--DECK_META {json}-->` comment (small, no HTML
    inside → parses reliably) followed by the raw HTML document. We do NOT try to
    JSON-decode the HTML itself — that was the fragile part.
    """
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```[a-zA-Z]*\n", "", t)
        t = re.sub(r"\n```$", "", t)
    meta = {}
    m = re.search(r"<!--\s*DECK_META\s*(\{.*?\})\s*-->", t, re.DOTALL)
    if m:
        try:
            meta = json.loads(m.group(1))
        except Exception:
            meta = {}
        html = t[m.end():].lstrip()
    else:
        html = t  # no meta comment; still salvage the HTML
    # Trim anything before the doctype/html start, if present.
    idx = html.lower().find("<!doctype")
    if idx == -1:
        idx = html.lower().find("<html")
    if idx > 0:
        html = html[idx:]
    return meta, html


# ---------- render + deliver ----------

def render_pdf(cfg, html_path, pdf_path):
    chrome = cfg.get("chrome_path")
    if not chrome or not os.path.exists(chrome):
        chrome = next((shutil.which(c) for c in
                       ("google-chrome", "google-chrome-stable", "chromium-browser", "chromium")
                       if shutil.which(c)), None)
    if not chrome:
        log("  ! chrome not found; skipping PDF render")
        return None
    cmd = [
        chrome, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
        f"--print-to-pdf={pdf_path}", f"file://{html_path}",
    ]
    try:
        subprocess.run(cmd, timeout=120, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=False)
    except Exception as e:
        log(f"  ! chrome render error: {e}")
        return None
    if os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 0:
        return pdf_path
    log("  ! render produced no PDF")
    return None


def deliver_to_drive(cfg, src_dir, date, slug):
    import shutil
    drive = cfg.get("deck_drive_dir")
    if not drive:
        return None
    if not os.path.isdir(os.path.dirname(os.path.dirname(drive))):
        log("  ! Google Drive mount not present; kept local copy only")
        return None
    dest = os.path.join(drive, date, slug)
    try:
        os.makedirs(dest, exist_ok=True)
        for name in os.listdir(src_dir):
            shutil.copy2(os.path.join(src_dir, name), os.path.join(dest, name))
    except Exception as e:
        log(f"  ! drive delivery failed: {e}")
        return None
    return dest


# ---------- product shots ----------

def load_shots(cfg):
    """Read the product-shot manifest. Returns (shots list, stale list)."""
    man = load_json(os.path.join(SHOTS_DIR, "manifest.json"))
    if not man:
        return [], []
    shots, stale = [], []
    max_age = cfg.get("shot_stale_days", 90)
    today = datetime.date.today()
    for s in man.get("shots", []):
        path = os.path.join(SHOTS_DIR, s.get("file", ""))
        if not os.path.exists(path):
            log(f"  ! manifest lists missing file: {s.get('file')}")
            continue
        try:
            age = (today - datetime.date.fromisoformat(s["captured_at"])).days
        except Exception:
            age = 0
        s = {**s, "_path": path, "_age_days": age}
        if age > max_age:
            stale.append(s)
        shots.append(s)
    return shots, stale


def web_copy(path, max_px=1600):
    """Downscale a shot for embedding (base64 of a 3600px PNG would bloat the PDF).
    Cached in .web/; regenerated if the source is newer."""
    cache_dir = os.path.join(SHOTS_DIR, ".web")
    os.makedirs(cache_dir, exist_ok=True)
    out = os.path.join(cache_dir, os.path.basename(path))
    if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(path):
        return out
    # sips is macOS-only; on Linux runners fall back to ImageMagick.
    resizers = [["sips", "-Z", str(max_px), path, "--out", out]]
    for im in ("magick", "convert"):
        if shutil.which(im):
            resizers.append([im, path, "-resize", f"{max_px}x{max_px}>", out])
            break
    for cmd in resizers:
        if not shutil.which(cmd[0]):
            continue
        try:
            subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                           timeout=60, check=False)
        except Exception as e:
            log(f"  ! {cmd[0]} resize failed ({e})")
        if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(path):
            return out
    # No resizer on this host (GitHub runners ship neither sips nor
    # ImageMagick). The repo commits a pre-generated .web cache — git checkout
    # scrambles mtimes so the freshness test above can't pass, but the
    # committed copy is always current for a checkout. Prefer it over
    # embedding a full-resolution shot (multi-MB PDFs).
    if os.path.exists(out):
        log("  ~ using committed web copy (no resizer on this host)")
        return out
    log("  ! no resizer produced a web copy; using original")
    return path


def embed_shots(html, shots):
    """Replace SHOT:<id> placeholders with base64 data URIs so the HTML/PDF are
    self-contained (local paths would break once copied to Drive). Returns
    (html, list of ids actually used)."""
    used = []
    for s in shots:
        token = f"SHOT:{s['id']}"
        if token not in html:
            continue
        with open(web_copy(s["_path"]), "rb") as f:
            b64 = base64.b64encode(f.read()).decode()
        html = html.replace(token, f"data:image/png;base64,{b64}")
        used.append(s["id"])
    # Any placeholder the model invented that we don't have — strip the whole tag
    # rather than ship a broken image.
    leftover = re.findall(r"SHOT:[a-zA-Z0-9\-_]+", html)
    if leftover:
        log(f"  ! unknown shot ids referenced, removing: {set(leftover)}")
        html = re.sub(r"<img[^>]*SHOT:[a-zA-Z0-9\-_]+[^>]*>", "", html)
    return html, used


def send_review_email(cfg, prospect, deck_title, slides, pdf_path, drive_dest,
                      shots_used=None, stale_used=None, warnings=None, parked=False,
                      link=None, cover=None, as_is=None, recipients=None):
    """Email the generated deck PDF to the reviewer (deck_email_to), via Resend. Returns True on 2xx.
    `parked` switches the footer to the ways the task can be worked from the
    board — comment "send" / "send: <text>" / "retry", or [Note] + re-assign —
    with the hosted `link`, the `cover` note a "send" would use, and `as_is`
    (None when "send" is available, else why not)."""
    key = cfg.get("resend_api_key")
    if not key:
        log("  ! no resend_api_key; skipping email")
        return False
    if not pdf_path or not os.path.exists(pdf_path):
        log("  ! no PDF to attach; skipping email")
        return False
    with open(pdf_path, "rb") as f:
        pdf_b64 = base64.b64encode(f.read()).decode()
    slide_list = "".join(f"<li>{s}</li>" for s in slides)
    shots_line = ""
    if shots_used:
        shots_line = f"<p>Product shots used: {', '.join(shots_used)}</p>"
    stale_line = ""
    if stale_used:
        warn = "".join(
            f"<li><b>{s['id']}</b> — captured {s['_age_days']} days ago "
            f"({s['captured_at']}); check the UI still looks like this</li>"
            for s in stale_used)
        stale_line = (
            f"<p style='background:#fff4e5;border-left:3px solid #999999;padding:8px'>"
            f"<b>⚠ Stale product shots in this deck:</b><ul>{warn}</ul></p>")
    warn_line = ""
    if warnings:
        items = "".join(f"<li>{w}</li>" for w in warnings)
        warn_line = (
            f"<p style='background:#fdecea;border-left:3px solid #d64545;padding:8px'>"
            f"<b>⚠ Check before sending:</b><ul>{items}</ul></p>")
    html = (
        f"<p>{agent_name(cfg)} generated a sales follow-up deck for <b>{prospect}</b> — "
        f"review before sending to the prospect.</p>"
        f"<p><b>{deck_title}</b></p><ol>{slide_list}</ol>"
        f"{shots_line}{stale_line}{warn_line}"
        f"<p>PDF attached. Also in Google Drive:<br>{drive_dest or '(local only)'}</p>"
        + (f"<p>Hosted copy (the file a \"send\" ships): <a href='{link}'>{link}</a></p>" if link else "")
        + (parked_footer_html(cover, as_is, recipients, agent_name(cfg)) if parked else
           f"<p style='color:#888'>Auto-generated from a [deck]-marked NOAN task. "
           f"Not sent to the prospect — this is for your review only.</p>")
    )
    body = {
        "from": _required_cfg(cfg, "deck_email_from"),
        "to": [_required_cfg(cfg, "deck_email_to")],
        "subject": f"Deck ready for review: {prospect}",
        "html": html,
        "attachments": [{"filename": f"{slugify(prospect)}-deck.pdf", "content": pdf_b64}],
    }
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    status, data = http("POST", "https://api.resend.com/emails", headers, body)
    if 200 <= status < 300:
        return True
    log(f"  ! Resend error {status}: {json.dumps(data)[:200]}")
    return False


def parked_footer_html(cover, as_is, recipients, agent="the agent"):
    """The review email's footer for a parked deck: what a comment can do."""
    who = ", ".join(recipients or []) or "the linked contact"
    out = ("<p style='color:#888'>Not sent to the prospect. The task is parked on the board "
           f"(tagged needs-human, {agent} unassigned) with the reason and the deck location in its details.</p>")
    if cover:
        body = cover[1].replace("\n", "<br>")
        out += (f"<p style='background:#f4f6f8;border-left:3px solid #999;padding:8px'>"
                f"<b>Cover note a \"send\" would go out with</b> (to {who}):<br>"
                f"<i>Subject: {cover[0]}</i><br>{body}</p>")
    out += "<p style='color:#888'><b>To act, comment on the task</b> (as yourself, from your NOAN account):<ul>"
    if as_is is None:
        out += (f"<li><b>send</b> — ships this exact PDF to {who} with the cover note above</li>"
                "<li><b>send: &lt;your text&gt;</b> — ships it with your words as the cover note</li>")
    else:
        out += f"<li><b>send</b> is unavailable: {as_is}</li>"
    out += ("<li><b>retry</b> — rebuilds the deck; anything you write after the word is read as guidance</li>"
            f"<li>or add a [Note] to the task and re-assign {agent}</li></ul>"
            "Or forward this PDF yourself and close the task.</p>")
    return out


def slugify(s):
    s = re.sub(r"[^a-zA-Z0-9]+", "-", s.lower()).strip("-")
    return s[:60] or "deck"


# ---------- direct-to-customer send (2026-07-24) ----------
# [deck] tasks now email the deck straight to the linked contact with a natural
# cover note drafted by the agent. The review email remains the fallback:
# no resolvable contact email, quality warnings/stale shots, or a cover note
# that trips the guards all route back to review instead of a bad customer send.

def resolve_contacts(cfg, task):
    """The task's contact records that have an email (possibly several —
    granola deck tasks link EVERY external meeting attendee, and the deck email
    goes to all of them, reply-all style). A 'Contact ID: <uuid>' details line
    wins as a single-recipient override; else all linked contacts. Returns []
    when nothing resolves (→ review-email fallback)."""
    m = re.search(r"contact id:?\s*([0-9a-f-]{36})", task.get("details", "") or "", re.I)
    if m:
        ids = [m.group(1)]
    else:
        ids = [l.get("id") for l in (task.get("contacts") or []) if l.get("id")]
    out = []
    for cid in ids[:5]:
        st, data = http("GET", f"{cfg['noan_base']}/contacts/{cid}", noan_headers(cfg))
        if st == 200 and data:
            c = data.get("contact") or data
            if c.get("email"):
                out.append(c)
    return out


def draft_cover_note(cfg, contacts, deck_title, slides, history, playbook=None):
    """The agent drafts the short natural email the deck rides in on.
    Returns (subject, text) or None if drafting fails or a guard trips.

    The voice rules come from the Deck Playbook fact when it loads, so they can
    be retuned in the NOAN UI with no deploy. The built-in text below is the
    fallback AND the restore source, and is kept byte-identical in substance to
    the seeded fact (seed-deck.mjs) — if you change one, change the other.
    """
    firsts = [(c.get("name") or "there").split()[0] for c in contacts]
    if len(firsts) == 1:
        first = firsts[0]
    elif len(firsts) == 2:
        first = f"{firsts[0]} and {firsts[1]}"
    else:
        first = ", ".join(firsts[:-1]) + f" and {firsts[-1]}"
    agent, company = agent_name(cfg), company_name(cfg)
    demo_url = cfg.get("demo_url") or None
    link_rule = (f"- At most one link, and only {demo_url}. No other URLs.\n" if demo_url
                 else "- No links at all.\n")
    system = (
        f"You are {agent}, {company}'s AI agent. A deck has been prepared for a prospect and "
        "will be ATTACHED to this email, sent from you. Write the short cover email it "
        "rides in on, plus a subject line.\n\n"
        "Hard rules:\n"
        "- Body under 110 words. Warm, natural, first person, like a colleague sending "
        "over something they made for them. No corporate filler, no exclamation marks, "
        "no pressure, no extra asks.\n"
        f"- Open with 'Hi {first},'.\n"
        "- Reference that the deck is attached and made for their business specifically. "
        "One concrete hook from the slides or history is good; NEVER invent detail, "
        "never quote private memos, never mention internal notes or meetings unless the "
        "history shows a real meeting with them.\n"
        + link_rule +
        "- No em dashes anywhere. Use commas, colons, or separate sentences.\n"
        f"- Sign off exactly:\n{agent}\n{company}'s AI agent\n\n"
        "Return EXACTLY this format:\nSUBJECT: <subject, under 60 chars, no clickbait>\n\n<email body>"
    )
    if playbook:
        system = (
            f"You are {agent}, {company}'s AI agent. A deck has been prepared for a prospect and "
            "will be ATTACHED to this email, sent from you. Write the short cover email it "
            "rides in on, plus a subject line.\n\n"
            f"{playbook}\n\n"
            f"Open with 'Hi {first},'.\n"
            "Return EXACTLY this format:\nSUBJECT: <subject>\n\n<email body>"
        )
    user = (
        f"Deck title: {deck_title}\n"
        f"Slides:\n" + "\n".join(f"- {s}" for s in slides) +
        (f"\n\nContact history (INTERNAL, for choosing the hook only):\n{history[:2000]}" if history else "") +
        "\n\n" + "\n".join(f"Contact: {c.get('name','')} <{c.get('email','')}>" for c in contacts)
    )
    url = f"{cfg['anthropic_base']}/messages"
    headers = {"x-api-key": cfg["anthropic_api_key"],
               "anthropic-version": "2023-06-01", "Content-Type": "application/json"}
    body = {"model": cfg.get("cover_model", cfg.get("design_model", "claude-opus-4-8")),
            "max_tokens": 700, "system": system,
            "messages": [{"role": "user", "content": user}]}
    status, data = http("POST", url, headers, body)
    if status != 200:
        log(f"  ! cover-note draft HTTP {status}; falling back to review email")
        return None
    _log_usage(body["model"], (data or {}).get("usage"), "cover-note")
    text = "".join(b.get("text", "") for b in (data or {}).get("content", [])
                   if b.get("type") == "text").strip()
    m = re.match(r"SUBJECT:\s*(.+?)\n+(.*)", text, re.S)
    if not m:
        log("  ! cover note missing SUBJECT line; falling back to review email")
        return None
    subject, note = m.group(1).strip(), m.group(2).strip()
    note = re.sub(r"\s*[—―]\s*", " - ", note)
    subject = re.sub(r"\s*[—―]\s*", " - ", subject)[:80]
    urls = re.findall(r"https?://[^\s\"'<>)]+", note)
    allowed_hosts = {urllib.parse.urlparse(u).hostname for u in (cfg.get("subscribe_url"), cfg.get("demo_url")) if u}
    if any(urllib.parse.urlparse(u).hostname not in allowed_hosts for u in urls):
        log("  ! cover note contains a link outside the configured URLs; falling back to review email")
        return None
    if len(note) > 1200 or len(note.split()) > 160:
        log("  ! cover note too long; falling back to review email")
        return None
    if not re.search(r"deck|attach", note, re.I):
        log("  ! cover note never mentions the deck; falling back to review email")
        return None
    if agent not in note:
        log("  ! cover note missing sign-off; falling back to review email")
        return None
    return subject, note


def send_deck_to_customer(cfg, contacts, subject, note, prospect, pdf_path, idempotency_key=None):
    """Send the deck straight to the contact(s) with the agent's cover note.
    Returns True on 2xx. Test redirect via cfg['deck_test_recipient'].
    `idempotency_key` goes to Resend as Idempotency-Key (the comment-approved
    send passes one, so a retried run cannot ship the same approval twice)."""
    key = cfg.get("resend_api_key")
    if not key or not pdf_path or not os.path.exists(pdf_path):
        return False
    with open(pdf_path, "rb") as f:
        pdf_b64 = base64.b64encode(f.read()).decode()
    demo_url = cfg.get("demo_url") or None
    def _para(p):
        p = p.replace("\n", "<br>")
        if demo_url:
            p = p.replace(demo_url, f"<a href='{demo_url}'>{urllib.parse.urlparse(demo_url).hostname}</a>")
        return "<p>" + p + "</p>"
    html = "".join(_para(p) for p in note.split("\n\n"))
    test = cfg.get("deck_test_recipient") or None
    emails = [c["email"] for c in contacts]
    to = [test] if test else emails
    body = {
        "from": _required_cfg(cfg, "deck_email_from"),
        "to": to,
        "subject": (f"[TEST → {', '.join(emails)}] {subject}" if test else subject),
        "html": html,
        "text": note,
        "attachments": [{"filename": f"{company_name(cfg)} - {prospect}.pdf".replace("/", "-"),
                         "content": pdf_b64}],
    }
    # No CC by default (2026-07-24) — set cfg deck_email_cc to add one.
    cc = cfg.get("deck_email_cc")
    if cc and not test:
        body["cc"] = [cc]
    reply_to = cfg.get("deck_reply_to") or os.environ.get("REPLY_TO") or ""
    if reply_to:
        body["reply_to"] = [reply_to]
    headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
    if idempotency_key:
        headers["Idempotency-Key"] = idempotency_key
    status, data = http("POST", "https://api.resend.com/emails", headers, body)
    if 200 <= status < 300:
        return True
    log(f"  ! Resend error {status}: {json.dumps(data)[:200]}")
    return False


def memo_customer_send(cfg, contact, subject, note, prospect, via=None):
    """Record the send as a memo on the contact (fail-soft). `via` names a
    human approval ("approved as-is by <email> via task comment")."""
    memo = (f"[{agent_name(cfg)}] Bespoke deck emailed - {time.strftime('%Y-%m-%d')}"
            + (f" ({via})" if via else "") + "\n"
            f"To: {contact.get('email','')}\nSubject: {subject}\n\n--- body ---\n{note}")
    st, _ = http("POST", f"{cfg['noan_base']}/contacts/{contact['id']}/memos",
                 noan_headers(cfg), {"memos": [{"content": memo}]})
    if st not in (200, 201, 204):
        log(f"  ! contact memo failed ({st})")


# ---------- working a parked task from its comments (2026-09-10) ----------

def append_detail_line(cfg, task, line):
    """Add one line to the task details (fail-soft, respects the cap). Used
    to tell the human why a comment was not honoured — the board is where
    they are looking, not the poller log."""
    details = ((task.get("details") or "").rstrip() + "\n" + line).strip()
    if len(details) > TASK_DETAILS_CAP:
        log(f"  ! details at the cap — could not note: {line[:80]}")
        return False
    st, data = http("PATCH", f"{cfg['noan_base']}/tasks/{task['id']}", noan_headers(cfg), {"details": details})
    if 200 <= st < 300:
        task["details"] = details
        return True
    log(f"  ! could not note on the task ({st}): {json.dumps(data)[:120]}")
    return False


def send_as_is(cfg, task, rec, override_text, comment, state):
    """A teammate commented "send" (or "send: <text>") on a parked deck: ship
    the STORED PDF — the file the human saw — to the task's contacts, memo
    the contacts, close the task and arm the follow-up, exactly as a clean
    direct send would. No rebuild: the point of this lane is that the deck in
    the review email is what goes out.

    Once only. The comment id is written to the ledger as `sending` BEFORE
    the Resend call and the send carries it as an Idempotency-Key, so a run
    that dies between the two cannot ship the same approval twice, and a
    second "send" comment after a success finds the task closed. A Resend
    rejection (non-2xx) clears `sending`: nothing went out, and the key makes
    a repeat safe.
    Returns True if the deck was sent."""
    tid = task["id"]
    stamp = time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime())

    def refuse(why):
        log(f"  ✗ send refused: {why}")
        append_detail_line(cfg, task, f"[deck] send by {comment['email']} not done ({stamp}): {why}")
        return False

    if rec.get("sending"):
        return refuse(f"a send for an earlier comment was already attempted at {rec.get('sending_at')} and did not finish cleanly; "
                      "check the contact's memos before sending again")
    contacts = resolve_contacts(cfg, task)
    if not contacts:
        return refuse("no contact with an email is linked to the task; link one and comment send again")
    if not rec.get("pdf"):
        return refuse("this deck was not stored when it was parked; comment retry or re-assign " + agent_name(cfg) + " to rebuild")
    tmp_dir = os.path.join(OUTDIR, "as-is")
    os.makedirs(tmp_dir, exist_ok=True)
    pdf = fetch_hosted_pdf(cfg, rec["pdf"], os.path.join(tmp_dir, f"{tid}.pdf"))
    if not pdf:
        return refuse("the stored deck could not be retrieved; comment retry to rebuild")
    prospect = rec.get("prospect") or task.get("title", "deck")
    deck_title = rec.get("deck_title") or f"{company_name(cfg)} deck"
    if override_text:
        subject = (rec.get("cover") or [None])[0] or deck_title
        note = override_text
    elif rec.get("cover"):
        subject, note = rec["cover"]
    else:
        cover = draft_cover_note(cfg, contacts, deck_title, rec.get("slides") or [],
                                 fetch_contact_context(cfg, task), load_playbook(cfg))
        if not cover:
            return refuse('the cover note tripped a guard; comment "send: <your cover text>" to supply it')
        subject, note = cover

    rec["sending"], rec["sending_at"] = comment["id"], stamp     # intent FIRST
    save_state_deck(state)
    ok = send_deck_to_customer(cfg, contacts, subject, note, prospect, pdf,
                               idempotency_key=f"deck-as-is:{tid}:{comment['id']}")
    if not ok:
        rec.pop("sending", None)
        rec["send_failed_at"] = stamp
        save_state_deck(state)
        return refuse("the email provider rejected the send (see the poller log); comment send again to retry")
    via = f"approved as-is by {comment['email']} via task comment"
    for c in contacts:
        memo_customer_send(cfg, c, subject, note, prospect, via=via)
    log(f"  ✓ deck sent AS-IS to {cfg.get('deck_test_recipient') or ', '.join(c['email'] for c in contacts)} ({via})")
    moved = mark_task_done(cfg, tid)
    followup_id = None
    if cfg.get("deck_arm_followup", True):
        try:
            followup_id = arm_followup(cfg, task, contacts, prospect, subject)
        except Exception as e:                      # never unwind a delivered deck
            log(f"  ! follow-up arming raised: {e}")
            try:
                note_followup_failure(cfg, task, prospect, f"exception: {e}")
            except Exception:
                pass
    rec["sent_at"], rec["sent_comment"] = stamp, comment["id"]
    state.setdefault("parked", {}).pop(tid, None)
    state["processed"] = sorted(set(state.get("processed", [])) | {tid})[-2000:]
    save_state_deck(state)
    log(f"  task={'done' if moved else 'NOT closed'}  followup={'armed' if followup_id else 'FAILED'}")
    return True


def record_outcome(state, task, r, send_email):
    """Ledger bookkeeping after process_task, shared by the scan pass and a
    comment-driven retry. A PARKED task is deliberately NOT recorded as
    processed: the agent is unassigned, which keeps it out of the next scan, and
    staying off the ledger is what lets a re-assign or a "retry" run it
    again. Its park record (hosted file, cover note, contacts) is kept for a
    later "send"."""
    recs = state.setdefault("parked", {})
    tid = task["id"]
    if r and r.get("parked"):
        rec = r.get("park_record") or {"at": park_time(task, None), "handled_comments": []}
        rec["handled_comments"] = (recs.get(tid) or {}).get("handled_comments") or []
        recs[tid] = rec
        log(f"  parked for a human, not recorded as processed: {task['title']}")
    elif r and (not send_email or r.get("emailed")):
        state["processed"] = sorted(set(state.get("processed", [])) | {tid})[-2000:]
        recs.pop(tid, None)
    elif r:
        log(f"  ! kept queued (email not sent): {task['title']}")
    save_state_deck(state)


def parked_pass(cfg, state, backlog_tasks, today, send_email, dry=False):
    """Work parked deck tasks from their comments. A parked task is Deck-tagged,
    in backlog, carries the park marker (or a ledger record) and has the agent
    UNASSIGNED — an assigned one is a human's re-assign and the scan pass owns
    it. Only teammate comments newer than the park count; the newest
    instruction wins ("send" / "send: <text>" / "retry …"); guidance-only
    comments are noted and read on the next rebuild. Every comment seen is
    recorded as handled, so nothing is acted on twice. Returns the count acted on."""
    trigger_tag = (cfg.get("deck_trigger_tag") or "Deck").lower()
    verity_ids = set(cfg.get("verity_identity_ids") or [])
    recs = state.setdefault("parked", {})
    facts = None
    acted = 0
    for t in backlog_tasks:
        tags = {(x.get("name") or "").lower() for x in (t.get("tags") or [])}
        assignees = {x.get("id") for x in (t.get("assignees") or [])}
        if trigger_tag not in tags or (assignees & verity_ids):
            continue
        rec = recs.get(t["id"])
        if not rec and PARK_MARKER not in (t.get("details") or ""):
            continue
        since = park_time(t, rec)
        handled = set((rec or {}).get("handled_comments") or [])
        new = [c for c in teammate_comments(t, cfg) if c["at"] > since and c["id"] not in handled]
        if not new:
            continue
        action = None
        for c in new:
            kind, payload = classify_comment(c["text"])
            if kind in ("send", "retry"):
                action = (kind, payload, c)
        if dry:
            log(f"  [parked] {t['title']}: {len(new)} new comment(s) → {action[0] if action else 'guidance only'}")
            continue
        if rec is None:                             # parked before the ledger record existed
            rec = recs[t["id"]] = {"at": since, "handled_comments": []}
        rec["handled_comments"] = sorted(handled | {c["id"] for c in new if c["id"]})[-50:]
        save_state_deck(state)
        if not action:
            log(f"  guidance noted on parked task {t['title']!r} — comment 'retry' or re-assign {agent_name(cfg)} to rebuild with it")
            continue
        kind, payload, c = action
        log(f"=== parked task {t['id']}: {kind} by {c['email']} ===\n  {t['title']}")
        if kind == "send":
            if send_as_is(cfg, t, rec, payload, c, state):
                acted += 1
            continue
        clear_park_tag(cfg, t)
        if facts is None:
            facts = load_facts(cfg)
        r = process_task(cfg, t, today, *facts, send_email)
        record_outcome(state, t, r, send_email)
        acted += 1
    return acted


# ---------- pipeline ----------

def load_playbook(cfg):
    """The cover-note voice rules, read from the Deck Playbook fact at runtime.

    Returns None if the fact is missing or unreachable, in which case
    draft_cover_note falls back to the built-in rules. Fail-soft on purpose: a
    NOAN blip must not change what a prospect receives, and must never block a
    send that would otherwise have gone out clean.
    """
    slug = (cfg.get("deck_fact_slugs") or {}).get("playbook")
    if not slug:
        return None
    try:
        text = "\n\n".join(fetch_facts(cfg, slug)).strip()
    except Exception as e:
        # fetch_facts RAISES on a failed request rather than returning empty,
        # and this is called after the PDF has already been rendered — letting
        # it propagate would throw away a finished deck over a transient NOAN
        # blip. Fall back to the built-in rules instead.
        log(f"  ! deck playbook fetch failed ({e}); using built-in cover-note rules")
        return None
    return text or None


def load_facts(cfg):
    slugs = cfg["deck_fact_slugs"]
    visual = "\n\n".join(fetch_facts(cfg, slugs["visual"])) or "(no brand-identity fact)"
    design_system = ""
    if slugs.get("design_system"):
        design_system = "\n\n".join(fetch_facts(cfg, slugs["design_system"]))
    value_facts = []
    for slug in slugs["value"]:
        c = fetch_facts(cfg, slug)
        if c:
            value_facts.append((slug, "\n\n".join(c)))
    return design_system, visual, value_facts


def fetch_contact_context(cfg, task):
    """Contact history for personalization (readable via the API since
    2026-07-24): resolve the contact from the task's linked contacts or a
    'Contact ID: <uuid>' details line, then pull their memos (meeting
    summaries, past agent emails). Internal-only context: the prompt
    instructs the model never to quote or reveal it. Fail-soft."""
    m = re.search(r"contact id:?\s*([0-9a-f-]{36})", task.get("details", "") or "", re.I)
    contact_id = m.group(1) if m else None
    if not contact_id:
        links = task.get("contacts") or []
        if len(links) == 1:
            contact_id = links[0].get("id")
    if not contact_id:
        return ""
    st, data = http("GET", f"{cfg['noan_base']}/contacts/{contact_id}", noan_headers(cfg))
    if st != 200 or not data:
        return ""
    contact = data.get("contact") or data
    parts = []
    if contact.get("name"):
        roles = "; ".join(f"{r.get('role','?')} @ {r.get('companyName','')}"
                          for r in (contact.get("companyRoles") or []))
        parts.append(f"Contact: {contact['name']}" + (f" ({roles})" if roles else ""))
    notes = contact.get("notes") or []
    # The API returns notes/memos NEWEST FIRST (verified live 2026-09-11 against
    # a contact with 8 of them; `notes` mirrors `memos` exactly, same order).
    # This was `notes[-5:][::-1]`, a TAIL slice, so on any contact with more
    # than five it fed the deck the OLDEST five and silently dropped the most
    # recent — the meeting that just happened, the reply they just sent. Take
    # the head. Same slice bug as agents/contact-memos.mjs's (fixed there).
    for n in notes[:5]:
        parts.append(str(n)[:1000])
    if not parts:
        return ""
    return (
        "\n\nCUSTOMER HISTORY (INTERNAL memos from the contact record: meetings, past emails to them. "
        "Use ONLY to choose which features, proof themes, and use cases will land. "
        "NEVER quote a memo, reference a private conversation, or put anything from "
        "this section into the deck copy itself.)\n" + "\n---\n".join(parts)
    )[:6000]


def process_task(cfg, task, today, design_system, visual, value_facts, send_email=True):
    """Generate a deck for one task: build → render PDF → Drive → send, park or review. Returns summary."""
    # Earlier park blocks are stripped: the brief and any human [Note] steer
    # the build, the previous failure report does not. Teammate comments are
    # read as guidance the same way — that is how "retry: use the pricing
    # angle" and a comment left before a re-assign reach the build.
    customer_ctx = f"Task: {task.get('title','')}\nDetails: {strip_park_blocks(task.get('details')) or '(none)'}"
    guidance = guidance_lines(teammate_comments(task, cfg))
    if guidance:
        customer_ctx += "\n\nTEAMMATE GUIDANCE (comments on this task, oldest first — follow them):\n" + "\n".join(guidance)
        log(f"  {len(guidance)} teammate guidance line(s) from task comments")
    history = fetch_contact_context(cfg, task)
    if history:
        customer_ctx += history
        log("  contact memo history loaded for personalization")
    log(f"  generating deck for: {task.get('title','')}")
    # sdr-reply-worker.mjs stamps this externalId on its handoff — the only
    # reliable signal that no meeting happened before this deck was requested.
    cold_origin = str(task.get("externalId") or "").startswith("sdr-handoff:")
    if cold_origin:
        log("  cold-origin deck (SDR reply handoff) — using no-meeting framing")
    shots, stale = load_shots(cfg)
    confidence_rules = load_confidence_rules(cfg)
    log(f"  confidence rules: {'Deck Agent Config fact' if confidence_rules is not CONFIDENCE_RULES else 'built-in fallback'}")
    slide_rules, slide_src = load_slide_rules(cfg)
    log(f"  slide design rules: {slide_src}")
    try:
        raw = call_claude(cfg, build_prompt(customer_ctx, design_system, visual,
                                            value_facts, shots,
                                            cfg.get("subscribe_url") or None,
                                            cfg.get("demo_url") or None,
                                            cold_origin, confidence_rules,
                                            company=company_name(cfg),
                                            slide_rules=slide_rules))
        meta, html = parse_deck(raw)
    except Exception as e:
        log(f"  ! failed: {e}")
        return None
    if not html or "<" not in html:
        log("  ! no usable HTML in response")
        return None

    html, shots_used = embed_shots(html, shots)
    stale_used = [s for s in stale if s["id"] in shots_used]
    if shots_used:
        log(f"  shots embedded: {', '.join(shots_used)}"
            + (f"  (STALE: {[s['id'] for s in stale_used]})" if stale_used else ""))

    # When a demo URL is configured the demo slide is mandatory — verify its link
    # (and screenshot, if the bank has one) made it into the deck, and flag the
    # review email if not. With no demo URL there is no demo slide to check.
    warnings = []
    demo_url = cfg.get("demo_url") or None
    if demo_url and demo_url not in html:
        warnings.append(f"Demo slide link missing — no CTA to {demo_url} in the deck")
    if demo_url and any(s.get("id") == "demo-player" for s in shots) and "demo-player" not in shots_used:
        warnings.append("Demo slide screenshot missing — demo-player shot was not used")
    for w in warnings:
        log(f"  ! {w}")

    # ---- confidence verdict (2026-09-11) ----
    # Computed on EVERY run and reported whether or not the gate is enforcing,
    # so the rollout can read real verdicts before they start parking decks.
    gate_on = bool(cfg.get("deck_confidence_gate", False))
    declared = str(meta.get("confidence") or "").strip().lower()
    why_low = str(meta.get("why_low") or "").strip()
    confidence_reason = None
    thin = brief_is_thin(task.get("title"), task.get("details"), guidance, history)
    if thin:
        confidence_reason = thin
    elif declared == "low":
        # Only an explicit "low" counts; see the fail-direction note on
        # CONFIDENCE_RULES. An empty why_low is still a decline, but say so —
        # the reengage lesson was that an unexplained decline is unreviewable.
        confidence_reason = "the deck agent declared low confidence: " + (
            why_low or "no reason given (confidence low with why_low empty)")
    if not declared:
        log("  confidence: not declared by the model (treated as high — omission is not a decline)")
    else:
        log(f"  confidence: {declared}" + (f" — {why_low}" if why_low else ""))
    if confidence_reason:
        log(f"  ! {confidence_reason}")
        log(f"  confidence gate is {'ON — this deck will be parked' if gate_on else 'OFF (logging only) — this deck still sends'}")

    prospect = meta.get("prospect") or task.get("title", "deck")
    slides = meta.get("slides", [])
    slug = slugify(prospect)
    out_dir = os.path.join(OUTDIR, today, slug)
    os.makedirs(out_dir, exist_ok=True)

    with open(os.path.join(out_dir, "deck.html"), "w") as f:
        f.write(html)
    default_title = f"{company_name(cfg)} deck"
    outline = [f"# {meta.get('deck_title', default_title)}",
               f"\n**Prospect:** {prospect}\n", "## Slides"]
    outline += [f"{i+1}. {s}" for i, s in enumerate(slides)]
    with open(os.path.join(out_dir, "outline.md"), "w") as f:
        f.write("\n".join(outline))

    pdf_path = render_pdf(cfg, os.path.join(out_dir, "deck.html"),
                          os.path.join(out_dir, "deck.pdf"))
    dest = deliver_to_drive(cfg, out_dir, today, slug)
    # Autonomous delivery (2026-07-27, superseding the 2026-07-24 single-
    # contact rule): clean deck + ANY resolvable contact emails → the agent's cover
    # note straight to the customer(s). Multi-attendee meeting tasks go to every
    # linked contact, reply-all style — they no longer fall back to the reviewer. The
    # review email remains ONLY for decks that should not reach a customer
    # unreviewed (quality warnings, stale shots, guard-tripped cover note) or
    # that have no resolvable recipient at all.
    emailed = False
    # Tracked separately from `emailed`, which also covers the review email.
    # Only a deck that reached the PROSPECT may arm a follow-up.
    sent_to_customer, cover_subject = False, None
    # Set whenever direct sending was on and the deck still went to review:
    # the reason a human is now needed, and what parks the task instead of
    # closing it. Stays None when direct sending is off (review IS the
    # intended path there, and closing on the review email is still right).
    review_reason = None
    contacts, cover, hosted_obj, hosted_url, as_is = [], None, None, None, None
    if send_email:
        contacts = resolve_contacts(cfg, task)
        # The confidence verdict joins the artefact gates only when enforcing;
        # while the gate is off it is reported and nothing else.
        blocked_by_confidence = bool(confidence_reason) and gate_on
        clean = not warnings and not stale_used and not blocked_by_confidence
        direct = cfg.get("deck_direct_to_customer", True)
        if direct and contacts and clean:
            playbook = load_playbook(cfg)
            log(f"  cover-note voice: {'Deck Playbook fact' if playbook else 'built-in fallback (fact unavailable)'}")
            cover = draft_cover_note(cfg, contacts, meta.get("deck_title", default_title),
                                     slides, history, playbook)
            if cover:
                subject, note = cover
                emailed = send_deck_to_customer(cfg, contacts, subject, note, prospect, pdf_path)
                if emailed:
                    sent_to_customer, cover_subject = True, subject
                    for c in contacts:
                        memo_customer_send(cfg, c, subject, note, prospect)
                    log(f"  ✓ deck emailed to customer(s) "
                        f"{cfg.get('deck_test_recipient') or ', '.join(c['email'] for c in contacts)}")
                else:
                    review_reason = "the customer send failed"
            else:
                review_reason = "the cover note tripped a guard"
        elif direct:
            if not contacts:
                review_reason = "no resolvable contact email on the task"
            elif blocked_by_confidence and not warnings and not stale_used:
                # Read on its own, because this park is not about the artefact:
                # the deck may be perfectly rendered and still not safe to send
                # unread. The reason goes in the park block and the review mail.
                review_reason = confidence_reason
            else:
                problems = list(warnings) + [f"stale product shot {s['id']}" for s in stale_used]
                if blocked_by_confidence:
                    problems.append(confidence_reason)
                review_reason = "the deck is not clean (" + "; ".join(problems) + ")"
        if review_reason:
            log(f"  direct send skipped ({review_reason}) — sending review email instead")
        if not emailed:
            # Parking prep (send-as-is): host the exact file, and draft the
            # cover note a "send" would carry so the approver sees the whole
            # package. A cover that was never attempted (deck not clean) is
            # drafted now; one that tripped a guard stays None and "send:
            # <text>" is the way to supply it.
            will_park = bool(review_reason) and cfg.get("deck_park_on_review", True)
            if will_park:
                hosted_obj, hosted_url = host_pdf(cfg, pdf_path, slug)
                if contacts and cover is None and review_reason != "the cover note tripped a guard":
                    playbook = load_playbook(cfg)
                    cover = draft_cover_note(cfg, contacts, meta.get("deck_title", default_title),
                                             slides, history, playbook)
                if not hosted_obj:
                    as_is = "this deck could not be stored; use retry"
                elif not contacts:
                    as_is = "no contact with an email is linked to the task; link one, then comment send"
                elif cover is None:
                    as_is = 'the cover note tripped a guard; comment "send: <your cover text>" to supply it'
                else:
                    as_is = None
            emailed = send_review_email(cfg, prospect, meta.get("deck_title", default_title),
                                        slides, pdf_path, dest, shots_used, stale_used,
                                        warnings + ([confidence_reason] if blocked_by_confidence else []),
                                        parked=will_park, link=hosted_url, cover=cover,
                                        as_is=as_is, recipients=[c["email"] for c in contacts])

    # Close or park — ONLY once an email (customer or review) actually went
    # out. If the send failed the task stays put, so nothing is silently
    # marked complete and the next scan retries.
    #   reached the prospect         → Done
    #   routed to review (direct on) → parked: open, needs-human, the agent
    #                                  unassigned, reason in details
    # A park that could not unassign the agent falls back to closing, since an
    # open task still assigned would be rebuilt on every scan.
    moved, parked, park_record = False, False, None
    if emailed and review_reason and cfg.get("deck_park_on_review", True):
        try:
            # The record a later comment "send" works from: where the exact
            # file is, who it goes to, and the cover note it would carry.
            park_record = {"at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.000Z"),
                           "prospect": prospect, "deck_title": meta.get("deck_title", default_title),
                           "slides": slides, "pdf": hosted_obj, "link": hosted_url,
                           "cover": list(cover) if cover else None,
                           "contact_ids": [c["id"] for c in contacts], "reason": review_reason,
                           "handled_comments": []}
            parked = park_task(cfg, task, review_reason,
                               hosted_url or dest or "PDF attached to the review email", as_is=as_is)
        except Exception as e:                      # http() raises after retries
            log(f"  ! park raised: {e}")
        if not parked:
            park_record = None
            if cfg.get("mark_done_after_send", True):
                log("  ! park failed — closing the task as before so it is not rebuilt every scan")
                moved = mark_task_done(cfg, task["id"])
    elif emailed and cfg.get("mark_done_after_send", True):
        moved = mark_task_done(cfg, task["id"])

    # Follow-up: a deck that actually reached the
    # prospect arms a follow-up. Before this, the strongest buying signal the
    # fleet produces generated no next step at all — the chain simply ended in
    # an inbox. Armed after the task is closed so a failure here cannot leave
    # the deck task open and get the deck rebuilt.
    followup_id = None
    if sent_to_customer and cfg.get("deck_arm_followup", True):
        try:
            followup_id = arm_followup(cfg, task, contacts, prospect, cover_subject or "")
        except Exception as e:                      # never unwind a delivered deck
            log(f"  ! follow-up arming raised: {e}")
            try:
                note_followup_failure(cfg, task, prospect, f"exception: {e}")
            except Exception:
                pass

    log(f"  wrote {out_dir}  slides={len(slides)}  pdf={'ok' if pdf_path else 'no'}  "
        f"drive={'ok' if dest else 'skip'}  email={'sent' if emailed else 'no'}  "
        f"task={'done' if moved else ('parked' if parked else 'unchanged')}  "
        f"followup={'armed' if followup_id else ('n/a' if not sent_to_customer else 'FAILED')}")
    return {"prospect": prospect, "pdf": pdf_path, "emailed": emailed,
            "sent_to_customer": sent_to_customer, "followup_task": followup_id,
            "shots_used": shots_used, "moved_to_done": moved, "parked": parked,
            "review_reason": review_reason, "park_record": park_record,
            # The verdict, for the lanes that run this with --no-email and own
            # the send themselves (sdr-deck-worker.mjs, reengage-reply.mjs).
            # Those lanes discarded every quality finding this function makes
            # until 2026-09-11, so a stale-shot deck reached the coldest
            # audience there is with no gate at all.
            "verdict": {"clean": not warnings and not stale_used and not (bool(confidence_reason) and gate_on),
                        "gate": gate_on,
                        "warnings": list(warnings),
                        "stale_shots": [s["id"] for s in stale_used],
                        "confidence": declared or None,
                        "confidence_reason": confidence_reason}}


# ---------- main ----------

def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--task", help="generate a deck for one NOAN task id")
    g.add_argument("--scan", action="store_true",
                   help="scan backlog tasks tagged Deck + assigned to the agent and process new ones")
    ap.add_argument("--dry", action="store_true", help="show what would run, no generation")
    ap.add_argument("--no-email", action="store_true", help="generate but do not send the review email")
    args = ap.parse_args()

    cfg = load_cfg()
    if not cfg.get("noan_api_key") or not cfg.get("anthropic_api_key"):
        log("FATAL: no usable config (config.json / config.defaults.json + env keys)"); sys.exit(1)
    today = datetime.date.today().isoformat()
    send_email = not args.no_email

    # ----- scan mode: tag+assignee-triggered batch with dedup -----
    # Since 2026-07-24 GET /tasks embeds tags[] and assignees[]: the trigger is
    # the "Deck" tag + the agent among the assignees, on BACKLOG tasks only.
    # Backlog-only matters: reply-worker's auto-deck path creates its
    # Deck-tagged, the agent-assigned tasks as in-progress (and with a
    # reengage-deck: externalId, excluded as a second guard) so this scanner
    # never double-builds them. Done tasks are skipped as before — the board
    # is a second dedup source alongside the local ledger.
    if args.scan:
        trigger_tag = (cfg.get("deck_trigger_tag") or "Deck").lower()
        verity_ids = set(cfg.get("verity_identity_ids") or [])
        state = _sb_load_state() if STATE_BACKEND == "supabase" else load_json(STATE, {"last_run": None, "processed": []})
        processed = set(state.get("processed", []))
        page, marked, backlog = 1, [], []
        while True:
            url = f"{cfg['noan_base']}/tasks?page={page}&per_page=100"
            st, data = http("GET", url, noan_headers(cfg))
            if st != 200 or not data:
                break
            for t in data.get("items", []):
                if t.get("status") != "backlog" or t.get("completed"):
                    continue
                backlog.append(t)
                if str(t.get("externalId") or "").startswith("reengage-deck:"):
                    continue
                # SDR-sourced decks are delivered by sdr-deck-worker.mjs, which
                # replies INSIDE the original Smartlead thread from the lookalike
                # mailbox the prospect answered. Sending one from here would put
                # the company's primary-domain sender in front of a cold-sourced prospect, which
                # is the exact boundary SDR's separate domains exist to hold.
                if str(t.get("externalId") or "").startswith("sdr-handoff:"):
                    continue
                tags = {(x.get("name") or "").lower() for x in (t.get("tags") or [])}
                assignees = {x.get("id") for x in (t.get("assignees") or [])}
                if trigger_tag in tags and (assignees & verity_ids):
                    marked.append(t)
            if not data.get("meta", {}).get("hasNext"):
                break
            page += 1
        todo = [t for t in marked if t["id"] not in processed]
        log(f"=== scan: {len(marked)} Deck-tagged task(s), {len(todo)} new ===")
        # Parked tasks first: a "send" or "retry" comment is a human waiting,
        # and it costs no model call to find out.
        acted = parked_pass(cfg, state, backlog, today, send_email, dry=args.dry)
        if args.dry:
            for t in marked:
                mark = "done" if t["id"] in processed else "NEW"
                log(f"  [{mark}] {t['title']}")
            return
        if acted:
            log(f"  {acted} parked task(s) acted on from comments")
        if not todo:
            if not acted:
                log("  nothing new")
            state["last_run"] = datetime.datetime.now().isoformat(timespec="seconds")
            save_state_deck(state)
            return
        design_system, visual, value_facts = load_facts(cfg)
        for t in todo:
            # A parked task that a human re-assigned: the tag comes off here,
            # so the board stops showing it as waiting on a person.
            clear_park_tag(cfg, t)
            r = process_task(cfg, t, today, design_system, visual, value_facts, send_email)
            # Recorded as processed only if the deck was produced AND (email off OR
            # it actually sent); a parked task stays off the ledger — see
            # record_outcome.
            record_outcome(state, t, r, send_email)
        state["last_run"] = datetime.datetime.now().isoformat(timespec="seconds")
        save_state_deck(state)
        log("=== scan done ===")
        return

    # ----- single-task mode -----
    task = find_task(cfg, args.task)
    if not task:
        log(f"FATAL: task {args.task} not found"); sys.exit(1)
    log(f"=== deck for task {args.task} ===\n  {task.get('title','')}")
    design_system, visual, value_facts = load_facts(cfg)
    if args.dry:
        print("\n--- CUSTOMER CONTEXT ---")
        print(f"Task: {task.get('title','')}\nDetails: {task.get('details','') or '(none)'}")
        print(f"\n--- DESIGN SYSTEM (authoritative): {len(design_system)} chars")
        print(f"--- BRAND IDENTITY (secondary): {len(visual)} chars")
        sr, src = load_slide_rules(cfg)
        print(f"--- SLIDE DESIGN RULES: {src}, {len(sr)} chars")
        print("\n--- VALUE FACT BLOCKS ---")
        for name, txt in value_facts:
            print(f"  {name}: {len(txt)} chars")
        return
    r = process_task(cfg, task, today, design_system, visual, value_facts, send_email)
    if r and r.get("parked") and r.get("park_record"):
        # The record a later comment "send" needs lives in the same ledger the
        # scan uses, whichever backend is configured.
        state = _sb_load_state() if STATE_BACKEND == "supabase" else load_json(STATE, {"last_run": None, "processed": []})
        record_outcome(state, task, r, send_email)
    # machine-readable result lines — reply-worker's auto-deck path parses
    # PDF_PATH, and both --no-email lanes parse DECK_VERDICT to decide whether
    # they may send. VERDICT is printed BEFORE PDF_PATH so a lane that reads
    # line-by-line has the verdict in hand by the time it has the file.
    if r and r.get("verdict"):
        print(f"DECK_VERDICT={json.dumps(r['verdict'], separators=(',', ':'))}", flush=True)
    if r and r.get("pdf"):
        print(f"PDF_PATH={r['pdf']}", flush=True)
    log("=== done ===")


if __name__ == "__main__":
    main()
