// dataStore.js — downloads and caches the open iptv-org datasets into the app's
// userData directory. The app reads from the local cache first so it opens fast
// and keeps working offline after the first sync; a background refresh runs when
// the cache is stale (older than REFRESH_INTERVAL) or when the user asks for it.
//
// All stream data comes strictly from the publicly available iptv-org project
// (free-to-air / publicly reachable streams only). No paywalled or DRM services.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const API_BASE = 'https://iptv-org.github.io/api';

// Datasets we mirror locally. Keys match the file names used on disk.
const DATASETS = {
  channels: `${API_BASE}/channels.json`,
  streams: `${API_BASE}/streams.json`,
  feeds: `${API_BASE}/feeds.json`,
  countries: `${API_BASE}/countries.json`,
  categories: `${API_BASE}/categories.json`,
  languages: `${API_BASE}/languages.json`,
  logos: `${API_BASE}/logos.json`,
};

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // nightly
const FETCH_TIMEOUT_MS = 45 * 1000;

class DataStore {
  constructor(userDataDir) {
    this.cacheDir = path.join(userDataDir, 'cache');
    this.metaPath = path.join(this.cacheDir, 'meta.json');
    fs.mkdirSync(this.cacheDir, { recursive: true });
  }

  _filePath(name) {
    return path.join(this.cacheDir, `${name}.json`);
  }

  async _readMeta() {
    try {
      return JSON.parse(await fsp.readFile(this.metaPath, 'utf8'));
    } catch {
      return { datasets: {} };
    }
  }

  async _writeMeta(meta) {
    await fsp.writeFile(this.metaPath, JSON.stringify(meta, null, 2), 'utf8');
  }

  // Returns parsed dataset from local cache, or null if not present/corrupt.
  async loadLocal(name) {
    try {
      const raw = await fsp.readFile(this._filePath(name), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async hasAllLocal() {
    const names = Object.keys(DATASETS);
    const checks = await Promise.all(
      names.map((n) => fsp.access(this._filePath(n)).then(() => true).catch(() => false))
    );
    return checks.every(Boolean);
  }

  async isStale() {
    const meta = await this._readMeta();
    const last = meta.lastSync || 0;
    return Date.now() - last > REFRESH_INTERVAL_MS;
  }

  async getMeta() {
    const meta = await this._readMeta();
    return {
      lastSync: meta.lastSync || null,
      datasets: meta.datasets || {},
      hasLocal: await this.hasAllLocal(),
      stale: await this.isStale(),
    };
  }

  async _fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'WorldTV/0.1 (+https://github.com/Surya8991/worldtv)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Downloads every dataset. If force is false and fresh local copies exist,
  // it is a no-op. Returns a per-dataset result summary.
  async sync({ force = false, onProgress } = {}) {
    if (!force && (await this.hasAllLocal()) && !(await this.isStale())) {
      return { skipped: true, reason: 'cache-fresh', ...(await this.getMeta()) };
    }

    const meta = await this._readMeta();
    meta.datasets = meta.datasets || {};
    const results = {};
    const names = Object.keys(DATASETS);

    for (let i = 0; i < names.length; i += 1) {
      const name = names[i];
      if (onProgress) onProgress({ name, index: i, total: names.length });
      try {
        const data = await this._fetchJson(DATASETS[name]);
        await fsp.writeFile(this._filePath(name), JSON.stringify(data), 'utf8');
        meta.datasets[name] = { count: Array.isArray(data) ? data.length : null, at: Date.now() };
        results[name] = { ok: true, count: meta.datasets[name].count };
      } catch (err) {
        // Keep any previously cached copy; just record the failure.
        results[name] = { ok: false, error: String(err && err.message ? err.message : err) };
      }
    }

    const anyOk = Object.values(results).some((r) => r.ok);
    if (anyOk) meta.lastSync = Date.now();
    await this._writeMeta(meta);

    return { skipped: false, results, ...(await this.getMeta()) };
  }

  // Returns all raw datasets, triggering a blocking sync only if nothing is cached.
  async getRaw() {
    if (!(await this.hasAllLocal())) {
      await this.sync({ force: true });
    }
    const names = Object.keys(DATASETS);
    const loaded = await Promise.all(names.map((n) => this.loadLocal(n)));
    const out = {};
    names.forEach((n, i) => { out[n] = loaded[i] || []; });
    return out;
  }
}

module.exports = { DataStore, DATASETS, REFRESH_INTERVAL_MS };
