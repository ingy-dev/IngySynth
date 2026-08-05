#!/usr/bin/env bash
# Serve INGYSYNTH locally (ES modules require HTTP, not file://)
cd "$(dirname "$0")"
PORT="${1:-8000}"
echo "INGYSYNTH → http://localhost:${PORT}"
exec python3 -m http.server "$PORT"
