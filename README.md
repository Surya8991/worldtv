# WorldTV

A Windows desktop app (Electron) for browsing and watching **freely available /
free-to-air live TV channels** from around the world, powered by the open
[iptv-org](https://github.com/iptv-org/iptv) datasets.

> **Legal / scope note.** WorldTV plays **only publicly available, free-to-air
> streams** sourced from the open iptv-org project. It does **not** support, and
> will never add, paywalled or DRM-protected services (Netflix, Disney+, Prime
> Video, Hulu, SonyLIV, etc.) — there is no lawful free feed for those. "Popular
> streaming services" here means the **free, ad-supported (FAST) platforms**
> (Pluto TV, Samsung TV Plus, Plex, Tubi, Stirr, Xumo, Rakuten TV, The Roku
> Channel, LG Channels), whose channels are already part of the open data and are
> grouped under the **Service** filter.

![status](https://img.shields.io/badge/platform-Windows-blue) ![license](https://img.shields.io/badge/license-MIT-green)

## Features

- **Browse by Country, Category, Language, and Service** (free FAST platform), plus Favorites and Recently-watched.
- **Searchable channel grid** with channel logos and names (~13k watchable channels).
- **HLS player** (hls.js in a Chromium `<video>`) with **fullscreen** and **picture-in-picture**.
- **EPG**: now/next strip on the player and a full **program-guide** view, wherever XMLTV guide data matches a channel.
- **Favorites** and a **Recently-watched** row, persisted locally.
- **One-click public IPTV presets**: enable curated free-to-air playlists (Free-TV — Global/USA/UK/India/News/Movies, ~1,200 extra channels) from Settings; duplicates already in the catalog are skipped automatically.
- **Paywall labeling**: channels that are really paid/subscription services (Sony, Star/Hotstar, Zee, Colors, HBO, beIN, etc.) are flagged with a 🔒 PAID badge and an in-player notice pointing to the official service. WorldTV never tries to bypass a paywall or DRM — it just tells you a stream needs a subscription.
- **Custom playlists**: add your own publicly available M3U/M3U8 URLs in Settings.
- **Background health-checker** that probes streams and flags/hides dead channels (these feeds break often), with automatic fallback to a channel's alternate streams when one fails.
- **Offline-tolerant**: datasets are cached in your local app-data folder; the app opens fast and keeps working after the first sync, refreshing nightly or on demand.

### Player & navigation
- **Keyboard / TV zapping**: ↑/↓ previous/next channel, Space play-pause, ←/→ volume, `F` fullscreen, `M` mute, `P` picture-in-picture, Esc close.
- **Quality selector** (choose resolution or Auto) and **subtitles/CC** toggle where the stream provides them.
- **Remembers** your volume and last channel; optional **resume last channel on launch**.
- **Sleep timer** (15 / 30 / 60 / 90 min) that stops playback.

### Organizing & filtering
- **Sort** by name, country, or working-first; **Working only** and **Hide paid** / **Hide dead** quick toggles.
- **Export / import** your favorites, recently-watched, playlists and settings as a JSON backup.

### Guide
- **EPG matches by channel id and by name** — adding a standard XMLTV source lights up now/next and the guide for far more channels, even when ids differ.

## Data sources

All channel metadata and streams come from the public iptv-org API:
`channels.json`, `streams.json`, `feeds.json`, `countries.json`,
`categories.json`, `languages.json`, `logos.json`
(<https://iptv-org.github.io/api/>).

**EPG**: iptv-org does not host a prebuilt guide feed, so WorldTV consumes
standard **XMLTV**. Add one or more XMLTV URLs in **Settings → EPG sources**
(for example output from [iptv-org/epg](https://github.com/iptv-org/epg), or any
public `url-tvg` feed; `.gz` is supported). Guide data appears for channels whose
id matches the XMLTV `channel` id.

## Getting started

```bash
npm install        # installs deps + copies hls.js into the renderer
npm run dev        # launch the app
```

## Build a Windows installer

```bash
npm run dist       # NSIS installer (.exe) + a portable .exe, in release/
npm run dist:dir   # unpacked build only (fast, for smoke-testing packaging)
```

Output lands in `release/`.

## How it works

- **Main process** (`src/main/`) owns the data layer: downloading & caching the
  iptv-org datasets (`dataStore.js`), joining them into a denormalized channel
  catalog (`catalog.js`), detecting free streaming services from stream URLs
  (`providers.js`), parsing custom M3U playlists (`playlist.js`), XMLTV EPG
  (`epg.js`), stream health probing (`health.js`), and local persistence of
  favorites / recents / settings (`persistence.js`). It exposes everything over
  IPC via `preload.js`.
- **Renderer** (`src/renderer/`) is a sandboxed UI (contextIsolation on,
  nodeIntegration off) that talks to main only through `window.worldtv`.

## Why some channels don't play

These are free, community-maintained streams, so a meaningful share are down at
any moment. In a representative sample (measured): ~75% play, ~25% are
dead/unreachable, and a few use non-HLS formats or are geo-blocked in your
region. There is no fix for a dead upstream — WorldTV's job is to **detect and
hide** them:

- The **health-checker** probes streams in the background and hides dead ones
  (keep "Hide dead" on).
- If a stream fails when you click it, the player **automatically tries the
  channel's other streams** and, if all fail, shows a clear message and marks the
  channel dead.
- CORS is handled at the network layer, and a normal browser User-Agent is sent,
  so streams aren't blocked for those reasons.

hls.js plays HLS (`.m3u8`); a small minority use formats it can't decode (e.g.
raw MPEG-TS) or are geo-restricted — expected for a v1.

## Building on a non-admin Windows account

The Windows build config sets `signAndEditExecutable: false`. This avoids the
`winCodeSign` package, which contains macOS symlinks that fail to extract without
the "Create symbolic links" privilege (admin or Windows **Developer Mode**). The
installer still gets its icon from `build/icon.ico`. To embed the icon/version
metadata into the app `.exe` as well, enable Developer Mode (Settings → Privacy &
security → For developers) or run the build as administrator, then remove that
flag.

## License

MIT — see [LICENSE](LICENSE). WorldTV is an independent project and is not
affiliated with iptv-org or any streaming service.
