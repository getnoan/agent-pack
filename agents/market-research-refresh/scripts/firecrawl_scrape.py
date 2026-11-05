#!/usr/bin/env python3
"""Firecrawl single-page scrape mechanics for the market-research-refresh automation.

Companion to firecrawl_search.py, for when the Agent Config's procedure already knows the
specific URL to check (e.g. a named competitor's pricing page) rather than needing a search
first. Same division of labor: this owns the API mechanics, the Agent Config fact decides
which URLs matter and what to make of their content.

Usage: python3 firecrawl_scrape.py "<url>" [--max-chars N]
--max-chars raises the markdown cap for a caller that needs the whole page (the
Verified issue agent checks a quote anywhere in a report, often a long PDF). Reads FIRECRAWL_API_KEY from the environment. Prints one JSON object to stdout: the url,
when it was accessed, page title, and markdown content (truncated).
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

FIRECRAWL_BASE = "https://api.firecrawl.dev/v1"
MARKDOWN_CHAR_CAP = 8000


class FirecrawlHTTPError(RuntimeError):
    def __init__(self, status, body, where):
        super().__init__(f"Firecrawl returned HTTP {status}")
        self.status = status
        self.body = body
        self.where = where


class FirecrawlCurlError(RuntimeError):
    """curl itself failed. Deliberately not CalledProcessError, whose text is the full command."""

    def __init__(self, exit_code, status, detail, where):
        super().__init__(f"curl exited {exit_code}")
        self.exit_code = exit_code
        self.status = status
        self.detail = detail
        self.where = where


class FirecrawlKeyError(RuntimeError):
    pass


def _curl_config(key):
    """The auth header as curl config, written to curl's stdin so the key is never in its
    argv, where ps, a traceback or anything logging the command could read it."""
    key = key.strip()
    if "\n" in key or "\r" in key:
        raise FirecrawlKeyError("FIRECRAWL_API_KEY contains a line break")
    escaped = key.replace("\\", "\\\\").replace('"', '\\"')
    return f'header = "Authorization: Bearer {escaped}"\n'


def _firecrawl_post(path, payload, where):
    key = os.environ["FIRECRAWL_API_KEY"]
    result = subprocess.run(
        [
            "curl", "-sS", "-w", "\n%{http_code}",
            "--config", "-",
            "-X", "POST", f"{FIRECRAWL_BASE}{path}",
            "-H", "Content-Type: application/json",
            "-d", json.dumps(payload),
        ],
        input=_curl_config(key), capture_output=True, text=True,
    )
    body, _, status = result.stdout.rpartition("\n")
    if result.returncode != 0:
        raise FirecrawlCurlError(result.returncode, status, result.stderr.strip(), where)
    if not status.startswith("2"):
        raise FirecrawlHTTPError(status, body, where)
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        raise FirecrawlHTTPError(status, "response was not JSON", where) from None


def scrape(url, cap=MARKDOWN_CHAR_CAP):
    payload = {"url": url, "formats": ["markdown"], "onlyMainContent": True}
    where = {"url": url}
    response = _firecrawl_post("/scrape", payload, where)
    if not response.get("success", False):
        raise FirecrawlHTTPError("200-with-error", json.dumps(response), where)
    data = response.get("data", {})
    markdown = data.get("markdown") or ""
    metadata = data.get("metadata", {}) or {}
    return {
        "url": url,
        "title": metadata.get("title"),
        "markdown": markdown[:cap],
        "markdownTruncated": len(markdown) > cap,
        "accessedAt": datetime.now(timezone.utc).isoformat(),
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing_argument", "detail": "usage: firecrawl_scrape.py \"<url>\" [--max-chars N]"}), file=sys.stderr)
        sys.exit(1)
    cap = MARKDOWN_CHAR_CAP
    if "--max-chars" in sys.argv:
        i = sys.argv.index("--max-chars") + 1
        if i >= len(sys.argv) or not sys.argv[i].isdigit():
            print(json.dumps({"error": "bad_argument", "detail": "--max-chars needs a whole number of characters"}), file=sys.stderr)
            sys.exit(1)
        cap = int(sys.argv[i])
    print(json.dumps(scrape(sys.argv[1], cap), indent=2))


def _report_failure(report):
    """Print one JSON error to stderr, with the key removed from anything a response echoed."""
    text = json.dumps(report)
    key = os.environ.get("FIRECRAWL_API_KEY", "").strip()
    if key:
        text = text.replace(json.dumps(key)[1:-1], "[redacted]")
    print(text, file=sys.stderr)
    sys.exit(1)


def run():
    try:
        main()
    except FirecrawlCurlError as e:
        _report_failure({"error": "firecrawl_curl_error", "curl_exit": e.exit_code, "status": e.status, **e.where, "detail": e.detail})
    except FirecrawlHTTPError as e:
        _report_failure({"error": "firecrawl_http_error", "status": e.status, **e.where, "detail": e.body})
    except FirecrawlKeyError as e:
        _report_failure({"error": "bad_env_var", "detail": str(e)})
    except KeyError as e:
        _report_failure({"error": "missing_env_var", "detail": str(e)})


if __name__ == "__main__":
    run()
