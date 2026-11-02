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
    def __init__(self, status, body):
        super().__init__(f"Firecrawl returned HTTP {status}: {body}")
        self.status = status
        self.body = body


def _firecrawl_post(path, payload):
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


def scrape(url, cap=MARKDOWN_CHAR_CAP):
    payload = {"url": url, "formats": ["markdown"], "onlyMainContent": True}
    response = _firecrawl_post("/scrape", payload)
    if not response.get("success", False):
        raise FirecrawlHTTPError("200-with-error", json.dumps(response))
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


if __name__ == "__main__":
    try:
        main()
    except FirecrawlHTTPError as e:
        print(json.dumps({"error": "firecrawl_http_error", "status": e.status, "detail": e.body}), file=sys.stderr)
        sys.exit(1)
    except KeyError as e:
        print(json.dumps({"error": "missing_env_var", "detail": str(e)}), file=sys.stderr)
        sys.exit(1)
