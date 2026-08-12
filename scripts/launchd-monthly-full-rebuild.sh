#!/bin/bash
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

PROJECT_DIR="/Users/homecomputer/Claude Code/cinch-portal-clean"
LOG_DIR="$PROJECT_DIR/logs"
LOG_FILE="$LOG_DIR/launchd-monthly-full-rebuild.log"

mkdir -p "$LOG_DIR"
cd "$PROJECT_DIR"

{
  echo "=== $(date) — launchd monthly full rebuild ==="
  max_attempts=2
  for attempt in $(seq 1 "$max_attempts"); do
    if npm run rebuild -- --trigger-label=launchd:monthly-full-rebuild; then
      break
    fi
    status=$?
    echo "launchd monthly full rebuild attempt $attempt/$max_attempts failed with exit $status"
    if [ "$attempt" -lt "$max_attempts" ]; then
      echo "sleeping 60s before retry..."
      sleep 60
    else
      exit "$status"
    fi
  done
  echo
} >> "$LOG_FILE" 2>&1
