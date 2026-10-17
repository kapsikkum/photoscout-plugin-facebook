# Facebook Events (Stealth Browser Plugin)

A PhotoScout plugin that scrapes local Facebook events using a stealth automated Chromium browser and logged-in session cookies.

## Features

- **Stealth Evasion**:
  - Uses native `--headless=new` with discrete NVIDIA GPU emulation over ANGLE.
  - Automatically suppresses `navigator.webdriver`.
  - Injects realistic client hints (`Sec-CH-UA`, `Sec-CH-UA-Platform`, etc.), hardware concurrency, device memory, and plugins.
  - Simulates smooth human-like scrolling and jittered delays to trigger GraphQL lazy-loading.
- **PhotoScout Events Integration**:
  - Contributes an event source under **Settings → Events → Sources** (`Facebook (Stealth Browser)`).
  - Contributes a link importer for **"Add from a link"** on the Events page (scrapes individual Facebook event pages on demand).
  - Adds a **Facebook Stealth** tab under **Settings → Events** with connection testing and on-demand "Scrape Now" button.
- **Zero-Dependency CDP**:
  - Connects to any Chromium DevTools Protocol (CDP) endpoint using pure Node.js (`fetch` + `WebSocket`).

## Sidecar Chromium Setup

You can run the stealth Chromium container alongside PhotoScout using the provided `docker-compose.chromium.yml`:

```sh
docker compose -f docker-compose.chromium.yml up -d
```

Or with Podman:

```sh
podman run -d --name photoscout-stealth-chromium \
  -p 127.0.0.1:9222:9222 \
  --security-opt seccomp=unconfined \
  --shm-size=1g \
  photoscout-stealth-chromium:latest
```

## Cookie Setup

1. Open `https://facebook.com` in your desktop browser and sign in (a throwaway account is recommended).
2. Open DevTools (F12) → **Application** tab → **Cookies** → `https://www.facebook.com`.
3. Copy the `c_user`, `xs`, and `datr` cookies as a string: `c_user=...; xs=...; datr=...`.
4. Paste into PhotoScout under **Settings → Plugins → Facebook Events (Stealth Browser) → Facebook Cookie**.
