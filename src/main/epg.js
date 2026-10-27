// epg.js — Electronic Program Guide support via standard XMLTV.
//
// iptv-org does not host a prebuilt EPG feed; instead the user supplies one or
// more XMLTV URLs in Settings (for example output from the iptv-org/epg grabber,
// or any public `url-tvg` XMLTV source). We stream-parse the XMLTV (gzip aware)
// so even large guides don't blow up memory, index programmes by channel id, and
// expose now/next + a day's schedule. Channels with no matching guide data simply
// show "no guide" — the UI degrades gracefully.

const zlib = require('zlib');
const sax = require('sax');
const { Readable } = require('stream');

const FETCH_TIMEOUT_MS = 60 * 1000;

// Parse an XMLTV timestamp like "20260127140000 +0000" (offset optional).
function parseXmltvTime(s) {
  if (!s) return null;
  const m = String(s).trim().match(
    /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/
  );
  if (!m) return null;
  const [, y, mo, d, h, mi, se, tz] = m;
  const base = `${y}-${mo}-${d}T${h}:${mi}:${se || '00'}`;
  const offset = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : 'Z';
  const t = Date.parse(`${base}${offset}`);
  return Number.isNaN(t) ? null : t;
}

class EpgIndex {
  constructor() {
    this.byChannel = new Map(); // xmltv channel id -> [{ start, stop, title, desc }]
    this.loadedAt = null;
    this.sources = [];
    this.programmeCount = 0;
  }

  _add(channelId, prog) {
    if (!channelId || prog.start == null) return;
    let arr = this.byChannel.get(channelId);
    if (!arr) { arr = []; this.byChannel.set(channelId, arr); }
    arr.push(prog);
    this.programmeCount += 1;
  }

  finalize() {
    for (const arr of this.byChannel.values()) arr.sort((a, b) => a.start - b.start);
    this.loadedAt = Date.now();
  }

  // Resolve a catalog channel id (possibly "id@feed") against the index.
  _resolve(channelId) {
    if (!channelId) return null;
    if (this.byChannel.has(channelId)) return this.byChannel.get(channelId);
    const base = channelId.split('@')[0];
    if (this.byChannel.has(base)) return this.byChannel.get(base);
    return null;
  }

  hasChannel(channelId) {
    return this._resolve(channelId) != null;
  }

  nowNext(channelId, at = Date.now()) {
    const arr = this._resolve(channelId);
    if (!arr || arr.length === 0) return { now: null, next: null };
    let now = null;
    let next = null;
    for (let i = 0; i < arr.length; i += 1) {
      const p = arr[i];
      const stop = p.stop || (arr[i + 1] ? arr[i + 1].start : p.start + 3600000);
      if (p.start <= at && at < stop) {
        now = { ...p, stop };
        next = arr[i + 1] ? { ...arr[i + 1] } : null;
        break;
      }
      if (p.start > at) { next = { ...p }; break; }
    }
    return { now, next };
  }

  // Programmes overlapping [from, to].
  range(channelId, from, to) {
    const arr = this._resolve(channelId);
    if (!arr) return [];
    return arr
      .map((p, i) => ({
        ...p,
        stop: p.stop || (arr[i + 1] ? arr[i + 1].start : p.start + 3600000),
      }))
      .filter((p) => p.stop > from && p.start < to);
  }
}

// Stream-parse one XMLTV document into the given index.
function parseXmltvStream(nodeStream, index, sourceLabel) {
  return new Promise((resolve, reject) => {
    const parser = sax.createStream(true, { trim: true, lowercase: true });
    let cur = null;      // current <programme> being built
    let textTarget = null; // 'title' | 'desc' | null

    parser.on('opentag', (node) => {
      if (node.name === 'programme') {
        cur = {
          channel: node.attributes.channel,
          start: parseXmltvTime(node.attributes.start),
          stop: parseXmltvTime(node.attributes.stop),
          title: '',
          desc: '',
        };
      } else if (cur && node.name === 'title') {
        textTarget = 'title';
      } else if (cur && node.name === 'desc') {
        textTarget = 'desc';
      }
    });

    parser.on('text', (t) => {
      if (cur && textTarget && t) {
        if (!cur[textTarget]) cur[textTarget] = t;
      }
    });

    parser.on('closetag', (name) => {
      if (name === 'title' || name === 'desc') {
        textTarget = null;
      } else if (name === 'programme' && cur) {
        index._add(cur.channel, {
          start: cur.start,
          stop: cur.stop,
          title: cur.title || 'Program',
          desc: cur.desc || '',
        });
        cur = null;
      }
    });

    parser.on('error', (err) => reject(err));
    parser.on('end', () => resolve());

    nodeStream.on('error', reject);
    nodeStream.pipe(parser);
  });
}

async function fetchXmltv({ name, url }, index) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'WorldTV/0.1' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    let nodeStream = Readable.fromWeb(res.body);
    const gz = url.endsWith('.gz') || (res.headers.get('content-type') || '').includes('gzip');
    if (gz) nodeStream = nodeStream.pipe(zlib.createGunzip());

    await parseXmltvStream(nodeStream, index, name || url);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

// Load every configured EPG URL into a fresh index.
async function loadEpg(epgUrls = []) {
  const index = new EpgIndex();
  const results = [];
  for (const src of epgUrls) {
    if (!src || !src.url) continue;
    const r = await fetchXmltv(src, index);
    results.push({ name: src.name || src.url, url: src.url, ...r });
  }
  index.finalize();
  index.sources = results;
  return { index, results, programmeCount: index.programmeCount, channels: index.byChannel.size };
}

module.exports = { EpgIndex, loadEpg, parseXmltvTime };
