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
    def __init__(self, status, body):
        super().__init__(f"Firecrawl returned HTTP {status}: {body}")
        self.status = status
        self.body = body


def _firecrawl_post(path, payload):
    # Shells out to curl rather than using urllib, matching the other automations'
    # fetch scripts in this project — relies on the system trust store, not Python's.
    key = os.environ["FIRECRAWL_API_KEY"]
    result = subprocess.run(
        [
            "curl", "-s", "-w", "\n%{http_code}",
            "-X", "POST", f"{FIRECRAWL_BASE}{path}",
            "-H", f"Authorization: Bearer {key}",
            "-H", "Content-Type: application/json",
            "-d", json.dumps(payload),
        ],
        capture_output=True, text=True, check=True,
    )
    body, _, status = result.stdout.rpartition("\n")
    if not status.startswith("2"):
        raise FirecrawlHTTPError(status, body)
    return json.loads(body)


def search(query, limit):
    payload = {
        "query": query,
        "limit": limit,
        "scrapeOptions": {"formats": ["markdown"], "onlyMainContent": True},
    }
    response = _firecrawl_post("/search", payload)
    if not response.get("success", False):
        raise FirecrawlHTTPError("200-with-error", json.dumps(response))
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


if __name__ == "__main__":
    try:
        main()
    except FirecrawlHTTPError as e:
        print(json.dumps({"error": "firecrawl_http_error", "status": e.status, "detail": e.body}), file=sys.stderr)
        sys.exit(1)
    except KeyError as e:
        print(json.dumps({"error": "missing_env_var", "detail": str(e)}), file=sys.stderr)
        sys.exit(1)
