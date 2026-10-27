# WorldTV — Agent Context

## Overview
Electron desktop app (Windows-first) for watching freely available / free-to-air
live TV worldwide, sourced from the open **iptv-org** datasets. Full-featured v1:
country/category/language/service filters, searchable logo grid, hls.js player
with fullscreen + PiP, XMLTV EPG (now/next + guide), favorites, recently-watched,
custom M3U playlists, and a background stream health-checker.

**Hard scope rule:** publicly available / free-to-air streams only (iptv-org).
**Never** add paywalled or DRM services (Netflix, Disney+, Prime, Hulu, SonyLIV).
The "Service" filter surfaces free FAST platforms (Pluto TV, Samsung TV Plus,
Plex, Tubi, Stirr, Xumo, Rakuten, Roku, LG) that are *already in* the iptv-org
data — detected from stream URLs, not from any new paid source.

## Stack
- **Electron** (main + sandboxed renderer, contextIsolation on / nodeIntegration off)
- **hls.js** for HLS playback in a Chromium `<video>`
- **electron-store** for local persistence; **sax** for streaming XMLTV parsing
- **electron-builder** for NSIS + portable Windows packaging
- No framework in the renderer — vanilla JS/CSS

## Key Dirs & Files
```
src/main/
  main.js          ← app lifecycle, window, menu, all IPC handlers, catalog assembly
  dataStore.js     ← download + cache iptv-org datasets (userData/cache), nightly refresh
  catalog.js       ← join datasets -> normalized watchable channels + computeFacets()
  providers.js     ← detectProvider(url): maps stream URLs to free FAST services
  playlist.js      ← parse custom M3U/M3U8 into catalog-shaped channels
  epg.js           ← fetch + stream-parse XMLTV (gzip aware); now/next + range lookups
  health.js        ← probe streams (main side, no CORS), cache status w/ TTL, flag dead
  persistence.js   ← electron-store: favorites, recent, settings (custom playlists, epg urls)
  preload.js       ← contextBridge: the window.worldtv API (the only renderer<->main surface)
src/renderer/
  index.html       ← layout (sidebar, grid, guide, settings, docked player pane)
  styles.css       ← dark theme
  renderer.js      ← all UI logic (filters, grid windowing, player, EPG, settings)
  vendor/hls.min.js← copied from node_modules at build time (gitignored)
scripts/
  copy-vendor.js   ← copies hls.min.js into renderer/vendor (postinstall + pre-dev/build)
  make-icon.js     ← generates build/icon.png + build/icon.ico from scratch
build/icon.{png,ico} ← app icons
```

## How to Run / Build / Test
```bash
npm install        # deps + postinstall copies hls.js into renderer/vendor
npm run dev        # launch (set WORLDTV_DEVTOOLS=1 to auto-open devtools)
npm run dist       # NSIS installer + portable .exe -> release/
npm run dist:dir   # unpacked build (fast packaging smoke test)
```

## Env Vars
None required. `WORLDTV_DEVTOOLS=1` optionally opens devtools in dev.

## Agent-Specific Notes

### Data model / joins (catalog.js)
- `channel.id` is the join key: `streams[].channel`, `feeds[].channel`,
  `logos[].channel` all reference it. A channel is "watchable" only if it has ≥1
  stream. Languages come from the channel's **feeds** (channels.json has none).
- `computeFacets(channels, lookups)` is reused twice: at base-catalog build time
  and again after custom playlists are merged, so sidebar counts always match the
  visible set. Bump `CATALOG_VERSION` when the entry shape changes (invalidates
  the on-disk catalog cache).
- Renderer gets **lite** channels (`liteChannel()` in main.js) — no full stream
  arrays, just `playUrl` + `streamCount`. Full stream list is fetched on demand
  via `catalog:streams`.

### IPC surface
All renderer↔main traffic goes through `preload.js` → `window.worldtv`. Add new
capabilities by (1) `ipcMain.handle` in main.js, (2) a method in preload.js.
Events main→renderer: `sync:progress`, `catalog:ready`, `health:result`,
`epg:loaded`.

### EPG reality check
iptv-org hosts **no** prebuilt EPG. EPG is XMLTV the user configures in Settings.
Matching is by XMLTV `channel` id vs catalog channel id (with `id@feed` →
base-id fallback). Many channels won't match any given feed — the UI degrades to
"no guide" gracefully. Don't promise global EPG.

### Why channels fail to play (measured, important)
"Many channels won't open" is mostly the feeds themselves: a representative
sample probes at ~75% reachable / ~25% dead, plus a few non-HLS or geo-blocked.
CORS is a *minor* factor — most servers send `*` or reflect the Origin. So:
- `main.js setupStreamNetworking()` only (a) sends a browser User-Agent (Electron's
  default UA is rejected by some CDNs) and (b) ADDS `Access-Control-Allow-Origin: *`
  **only when the response has none**. It must NOT delete the `Origin` request
  header or existing ACAO — many servers reflect Origin, and stripping it makes
  them stop sending ACAO → blocked. (An earlier "delete Origin + force ACAO"
  version regressed working streams; don't reintroduce it.)
- The renderer fetches all of a channel's streams on play and falls back to the
  next on a fatal hls.js error (`tryNextStream`), then marks/hides the channel dead.
- The health-checker (main-side, no CORS) uses the same browser UA so its verdicts
  match real playability.

### Packaging gotcha (winCodeSign symlinks)
`npm run dist` failed on this non-admin Windows box because electron-builder
downloads `winCodeSign` for the exe resource-edit (rcedit) step, and its archive
contains macOS symlinks that 7-Zip can't extract without the "Create symbolic
links" privilege (`A required privilege is not held by the client`). Fixed with
`build.win.signAndEditExecutable: false` (skips rcedit + signing; installer icon
still comes from `build/icon.ico`). Build with `CSC_IDENTITY_AUTO_DISCOVERY=false`.
Enable Windows Developer Mode / run as admin to restore exe icon embedding.

### Gotchas
- `vendor/hls.min.js` is **gitignored** and copied from node_modules; nothing runs
  until `npm install` (postinstall) or `npm run vendor`. If the player is blank,
  check that file exists.
- CSP in index.html allows `media-src`/`connect-src` over http(s) for arbitrary
  stream hosts but `script-src 'self'` — keep all scripts local.
- Health probing reads a 2KB slice and sniffs for manifest markers; some valid
  CDNs serve odd first responses, so the heuristic is permissive (only clear
  HTML/error pages are marked dead).
- Windows Chromium has no native HLS — hls.js is required; the native `<video>`
  path is only a fallback for progressive (mp4) URLs.
- Don't set custom User-Agent/Referer from the renderer (browser-blocked). Streams
  that require them may fail; acceptable for v1.

### Project doc spine
Follows the workspace convention: `README.md` + `AGENTS.md` + `CLAUDE.md`
(one-line `@AGENTS.md`) + `PROJECTLOG.md`. MIT licensed.
