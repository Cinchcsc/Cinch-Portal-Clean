#!/bin/bash
# Monthly full SiteLink pull for the Cinch Portal.
# Run by hand any time with: bash scripts/monthly-pull.sh
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"   # homebrew (Apple Silicon / Intel)
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"                   # nvm, if used
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.." || exit 1
mkdir -p logs
{ echo "=== $(date) — full pull (all reports) ==="; npm run pull; echo; } >> logs/monthly-pull.log 2>&1
