// health.js — background stream health checker. These free community streams
// break often, so we probe them (from the main process, where there's no CORS)
// and flag dead ones so the UI can hide them. Results are cached to disk with a
// TTL so we don't re-probe constantly.
//
// Probing an HLS stream = GET the .m3u8 with a short timeout and confirm it
// returns 2xx and looks like a playlist (or any readable media manifest).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const TTL_MS = 6 * 60 * 60 * 1000;      // re-check a stream at most every 6h
const PROBE_TIMEOUT_MS = 6500;
const DEFAULT_CONCURRENCY = 10;

// Match the UA the renderer uses so probe verdicts reflect real playability.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

class HealthChecker {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'cache', 'health.json');
    this.map = new Map();  // url -> { status, at, code }
    this._loaded = false;
    this._saveTimer = null;
  }

  async load() {
    if (this._loaded) return;
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      const obj = JSON.parse(raw);
      for (const [k, v] of Object.entries(obj)) this.map.set(k, v);
    } catch { /* no cache yet */ }
    this._loaded = true;
  }

  _scheduleSave() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      const obj = Object.fromEntries(this.map);
      fs.promises
        .mkdir(path.dirname(this.file), { recursive: true })
        .then(() => fsp.writeFile(this.file, JSON.stringify(obj), 'utf8'))
        .catch(() => {});
    }, 1500);
  }

  getStatus(url) {
    const rec = this.map.get(url);
    if (!rec) return { status: 'unknown', at: null };
    if (Date.now() - rec.at > TTL_MS) return { status: rec.status, at: rec.at, stale: true };
    return rec;
  }

  // Probe a single stream URL. Returns { status: 'ok'|'dead', code }.
  async probe(url, { headers = {} } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': BROWSER_UA, ...headers },
      });
      if (!res.ok) {
        return this._record(url, 'dead', res.status);
      }
      // Read a small slice to confirm it's a real manifest, not an error page.
      const text = (await res.text()).slice(0, 2048);
      const looksLikeManifest = /#EXTM3U|#EXT-X-|\.ts|\.m3u8|#EXTINF/i.test(text);
      // Some CDNs return the manifest without the tags on first segment list;
      // treat any 2xx non-HTML body as playable-ish.
      const looksLikeHtml = /<html|<!doctype html/i.test(text);
      const status = looksLikeManifest || !looksLikeHtml ? 'ok' : 'dead';
      return this._record(url, status, res.status);
    } catch (err) {
      return this._record(url, 'dead', 0, String(err && err.name));
    } finally {
      clearTimeout(timer);
    }
  }

  _record(url, status, code, note) {
    const rec = { status, at: Date.now(), code: code || 0 };
    if (note) rec.note = note;
    this.map.set(url, rec);
    this._scheduleSave();
    return rec;
  }

  // Probe many channels (uses each channel's primary stream). Skips ones with a
  // fresh cached result. Returns a map of channelId -> status. `onResult` fires
  // per channel for incremental UI updates.
  async checkChannels(channels, { concurrency = DEFAULT_CONCURRENCY, onResult, force = false } = {}) {
    await this.load();
    const queue = channels.filter((ch) => ch.streams && ch.streams.length);
    const out = {};
    let i = 0;

    const worker = async () => {
      while (i < queue.length) {
        const ch = queue[i++];
        const url = ch.streams[0].url;
        const cached = this.getStatus(url);
        let rec;
        if (!force && cached.status !== 'unknown' && !cached.stale) {
          rec = cached;
        } else {
          const headers = {};
          if (ch.streams[0].userAgent) headers['User-Agent'] = ch.streams[0].userAgent;
          if (ch.streams[0].referrer) headers.Referer = ch.streams[0].referrer;
          rec = await this.probe(url, { headers });
        }
        out[ch.id] = rec.status;
        if (onResult) onResult(ch.id, rec.status);
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, () => worker());
    await Promise.all(workers);
    return out;
  }
}

module.exports = { HealthChecker, TTL_MS };
