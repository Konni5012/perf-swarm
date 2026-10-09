#!/bin/sh
set -eu
export HOME=/tmp/perf-swarm-home
mkdir -p "$HOME"
# Everything, including native dialogs, stays inside this private X display.
Xvfb :99 -screen 0 4096x4096x24 -nolisten tcp &
xvfb_pid=$!
# Chrome's endpoint stays local to the container; only the relay is published.
socat TCP-LISTEN:9223,bind=0.0.0.0,reuseaddr,fork TCP:127.0.0.1:9222 &
relay_pid=$!
# The container replaces Chrome's OS sandbox; no host desktop/socket is mounted.
google-chrome-stable --no-sandbox --no-first-run --no-default-browser-check \
  --user-data-dir=/profile --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9222 --window-size=1440,900 about:blank &
chrome_pid=$!
cleanup() { kill "$chrome_pid" "$xvfb_pid" "$relay_pid" 2>/dev/null || true; }
trap cleanup EXIT
trap 'exit 0' TERM INT
# Stop if the owning host crashes, even when Docker itself remains alive.
while kill -0 "$chrome_pid" 2>/dev/null; do
  stamp=$(stat -c %Y /lease/heartbeat 2>/dev/null || echo 0)
  now=$(date +%s)
  if [ "$((now - stamp))" -gt 30 ]; then exit 0; fi
  sleep 2 & wait $!
done
