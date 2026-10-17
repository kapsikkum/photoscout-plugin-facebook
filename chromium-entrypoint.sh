#!/bin/sh
set -e

INTERNAL_PORT="${CHROMIUM_INTERNAL_PORT:-9221}"
PUBLIC_PORT="${CHROMIUM_PORT:-9222}"

# Clear locks from any prior container run
rm -rf /profile/Singleton* /profile/lockfile 2>/dev/null || true

# Socat relay: Chromium binds to loopback, socat relays from 0.0.0.0
socat "TCP-LISTEN:${PUBLIC_PORT},fork,reuseaddr,bind=0.0.0.0" \
      "TCP:127.0.0.1:${INTERNAL_PORT}" &

exec chromium \
  --headless=new \
  --remote-debugging-port="${INTERNAL_PORT}" \
  --user-data-dir=/profile \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-blink-features=AutomationControlled \
  --disable-features=Translate,AutomationControlled \
  --disable-infobars \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-sync \
  --mute-audio \
  --window-size=1920,1080 \
  about:blank
