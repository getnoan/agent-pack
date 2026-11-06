#!/usr/bin/env python3
"""Firecrawl search-and-scrape mechanics for the market-research-refresh automation.

This script owns the low-level Firecrawl API mechanics — endpoint shape, request
formatting, markdown truncation — that shouldn't be re-editable via a NOAN fact. It does
NOT decide what to search for or how to weigh results: the Market Research Refresh Agent
Config (a NOAN fact) is the judgment layer that picks queries and classifies findings as
Confirmed/Refined/New. This script just turns one query into a handful of credible,
already-scraped sources in one API call, replacing a separate web-search + per-result-fetch
pair of steps.

Usage: python3 firecrawl_search.py "<query>" [--limit N]
Reads FIRECRAWL_API_KEY from the environment. Prints one JSON object to stdout: the query,
when it ran, and up to N results each with url/title/description/markdown (truncated) —
enough to both write from and cite in the report's Sources section.
"""
import json
import os
import subprocess
import sys
from datetime import datetime, timezone

FIRECRAWL_BASE = "https://api.firecrawl.dev/v1"
DEFAULT_LIMIT = 4
MARKDOWN_CHAR_CAP = 8000  # keeps per-source content bounded; full page rarely needed for a fact refresh


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
    # Shells out to curl rather than using urllib, matching the other automations'
    # fetch scripts in this project — relies on the system trust store, not Python's.
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


def search(query, limit):
    payload = {
        "query": query,
        "limit": limit,
        "scrapeOptions": {"formats": ["markdown"], "onlyMainContent": True},
    }
    where = {"url": f"{FIRECRAWL_BASE}/search", "query": query}
    response = _firecrawl_post("/search", payload, where)
    if not response.get("success", False):
        raise FirecrawlHTTPError("200-with-error", json.dumps(response), where)
    accessed_at = datetime.now(timezone.utc).isoformat()
    results = []
    for item in response.get("data", []):
        markdown = item.get("markdown") or ""
        results.append({
            "url": item.get("url"),
            "title": item.get("title"),
            "description": item.get("description"),
            "markdown": markdown[:MARKDOWN_CHAR_CAP],
            "markdownTruncated": len(markdown) > MARKDOWN_CHAR_CAP,
            "accessedAt": accessed_at,
        })
    return {"query": query, "accessedAt": accessed_at, "results": results}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "missing_argument", "detail": "usage: firecrawl_search.py \"<query>\" [--limit N]"}), file=sys.stderr)
        sys.exit(1)
    query = sys.argv[1]
    limit = DEFAULT_LIMIT
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    print(json.dumps(search(query, limit), indent=2))


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
