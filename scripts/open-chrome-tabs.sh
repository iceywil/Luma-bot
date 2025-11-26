#!/usr/bin/env bash
# Usage: ./open-chrome-tabs.sh url1 url2 ...
# Tries to open multiple URLs in Google Chrome (or Chromium). Falls back to xdg-open.
set -euo pipefail
if [ "$#" -eq 0 ]; then
  echo "Usage: $0 <url1> [url2 ...]"
  exit 1
fi
# Candidate chrome binaries
candidates=("google-chrome-stable" "google-chrome" "chromium-browser" "chromium" "chrome")
for cmd in "${candidates[@]}"; do
  if command -v "$cmd" >/dev/null 2>&1; then
    "$cmd" "$@" >/dev/null 2>&1 &
    exit 0
  fi
done
# Fallback: open each URL with xdg-open (default browser)
for u in "$@"; do
  xdg-open "$u" >/dev/null 2>&1 &
done
exit 0
