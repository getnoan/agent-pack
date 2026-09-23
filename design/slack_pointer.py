"""Which Slack thread a task came from — the Python half of slack-pointer.mjs.

The deck parks in Python, outside parkForHuman, so the rule that "a task born
in a Slack thread is answered in that thread" has to hold here too or the one
lane a Slack user is most likely to delegate to (make me a deck) is the one
that answers by email.

Same two sources, same order, same refusal as the Node half, and the SAME
fixtures prove it (agents/slack-pointer-fixtures.json) — the shape
park_assignees.py and comment_grammar.py already use.

Deliberately NOT derived from slack-worker's `slack:<channel>:<ts>`
externalId: that ts is the mention MESSAGE's, not the thread's, so a mention
posted as a reply would resolve to a thread that does not exist. A wrong
thread is worse than an email.
"""
import json
import os
import re
import urllib.request

SLACK_PTR_RX = re.compile(r"^Slack:\s*([A-Z0-9]+)/(\d+\.\d+)", re.M)
COMPANION_EXT_RX = re.compile(r"^slack:companion:([A-Z0-9]+):(\d+\.\d+)$")


def slack_pointer_from(task):
    """-> {"channel": ..., "ts": ...} or None."""
    m = SLACK_PTR_RX.search(str((task or {}).get("details") or ""))
    if m:
        return {"channel": m.group(1), "ts": m.group(2)}
    e = COMPANION_EXT_RX.match(str((task or {}).get("externalId") or ""))
    if e:
        return {"channel": e.group(1), "ts": e.group(2)}
    return None


def post_thread(channel, thread_ts, text, token=None, log=print):
    """Reply in a thread. Never raises: a Slack failure must not cost the deck
    its park. Returns True only when Slack says ok."""
    token = token or os.environ.get("SLACK_BOT_TOKEN", "")
    if not token:
        return False
    # No em dashes in delivered copy (the fleet's house rule), and Slack's own
    # 3500-char ceiling, both matching agents/slack.mjs postThread.
    body = json.dumps({
        "channel": channel, "thread_ts": thread_ts,
        "text": re.sub(r"\s*[—―]\s*", " - ", str(text))[:3500],
        "unfurl_links": False,
    }).encode()
    req = urllib.request.Request(
        "https://slack.com/api/chat.postMessage", data=body, method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json; charset=utf-8"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            out = json.loads(r.read().decode() or "{}")
        if not out.get("ok"):
            log(f"  ! slack notify failed: {out.get('error')}")
            return False
        return True
    except Exception as e:                                  # noqa: BLE001
        log(f"  ! slack notify failed: {e}")
        return False


def notify_park(task, reason, agent="deck", assigned=None, token=None, log=print):
    """Tell the originating thread the task is now waiting on a human.
    False for every reason not to: not from Slack, no token, or the post
    failed. Mirrors notifyParkThread in agents/noan.mjs."""
    ptr = slack_pointer_from(task)
    if not ptr:
        return False
    who = "It is on a human now" if (assigned or []) else "Nobody is on it yet"
    text = "\n".join([
        f"I have parked this one for a human ({agent}).",
        *( [f"Why: {str(reason)[:400]}"] if reason else [] ),
        f"{who}. Re-assign me on the task once it is sorted and I will pick it up.",
    ])
    return post_thread(ptr["channel"], ptr["ts"], text, token=token, log=log)
