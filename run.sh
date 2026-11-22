#!/usr/bin/env bash
# Start TorqueForge: serves this folder locally and opens it in your browser.
cd "$(dirname "$0")"
PORT="${PORT:-8765}"
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null' EXIT
sleep 0.5
URL="http://127.0.0.1:$PORT/"
echo "TorqueForge running at $URL  (Ctrl+C to stop)"
xdg-open "$URL" >/dev/null 2>&1 || true
wait $SERVER
