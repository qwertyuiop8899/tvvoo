# TvVoo — VAVOO Clean Addon for Stremio 📺⚡

Stremio addon that lists VAVOO channels by country and resolves “clean” HLS using the viewer’s IP.

Badges: Node.js ≥ 18 • TypeScript • Express • stremio-addon-sdk

## ⚠️ IMPORTANT DISCLAIMER

CHANNELS ARE NOT GENERATED OR HOSTED BY THIS PROJECT. They are the result of automated scraping from public third‑party sources. The author is not responsible for outages, blocks, geo restrictions, wrong names/links, or any use of this software. Bandwidth usage depends solely on your own Internet connection and provider.

## Features ✨

- Country catalogs: IT, UK, FR, DE, PT, ES, AL, TR, NL, AR, BK, RU, RO, PL, BG
- Stream resolution with the viewer IP (ping + rewritten signature), minimal headers, WAF-safe fallback
- Channel logos: tv-logo integration + M3U enrichment, fuzzy match, on-disk cache
- Poster/Logo/Background with absolute fallback, landscape poster shape
- Landing page with flag icons, multi-select, “Copy” button with feedback, Stremio gear “Configure” entry
- Compatible configure routes: `/configure`, `/:cfg/configure`, `/configure/:cfg`, `/cfg-:cfg/configure`
- Diagnostics: `/health`, `/debug/ip`, `/debug/resolve`, `/cache/status`

## Installation 🧩

1) Run locally

```bash
npm install
npm run build
PORT=7019 npm start
```

Open in Stremio: `http://localhost:7019/manifest.json`

2) Select countries (optional)

- Safe path: `http://localhost:7019/cfg-it-uk-fr/manifest.json`
- Exclusions: `http://localhost:7019/cfg-it-uk-fr-ex-de-pt/manifest.json`
- Query variant: `http://localhost:7019/manifest.json?include=it,uk&exclude=de`

3) Configure from the gear

Stremio shows the “Configure” gear. It opens the `/configure` landing where you can quickly build and copy the manifest URL (with flag selection and a “Copy” button).

## Main routes 🔗

- Manifests
	- `GET /manifest.json`
	- `GET /:cfg/manifest.json` (path style: `include=it,uk&exclude=de`)
	- `GET /cfg-:cfg/manifest.json` (safe path: `cfg-it-uk[-ex-de]`)
	- `GET /configure/:cfg/manifest.json` (compatibility)
- Catalog/Stream (also available with cfg prefixes)
	- `GET /catalog/...` • `GET /stream/...`
- Configure (landing)
	- `GET /configure`
	- `GET /:cfg/configure` • `GET /configure/:cfg` (redirect to `/configure?cfg=...`)
	- `GET /cfg-:cfg/configure`
- Diagnostics
	- `GET /health` • `GET /debug/ip` • `GET /debug/resolve?name=...&url=...` • `GET /cache/status`

## Technical notes 🛠️

- Minimal IP forwarding; the signature (`addonSig`) is decoded/rewritten to prioritize the viewer IP
- Catalog cache on disk with daily refresh at 02:00 Europe/Rome
- Logos updated from GitHub (tv-logo) and enriched via M3U
- Useful environment variables:
	- `VAVOO_DEBUG=1` enable HTTP logs
	- `VAVOO_LOG_SIG_FULL=1` log full signature (avoid in production)
	- `VAVOO_BOOT_REFRESH=0` skip refresh at boot

## Deploy 🚀

- Node: project is self-contained (`Procfile` present). Run `npm run build` then `npm start`.
- Docker: use the `Dockerfile` in this folder to build and publish quickly.

## License & responsibility 📜

This software is provided “as is”, without warranties. The author is not responsible for usage, third‑party content, blocks, or channel errors. Always check your local laws and the terms of the involved platforms.
