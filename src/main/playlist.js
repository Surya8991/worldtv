// playlist.js — fetches and parses custom M3U/M3U8 playlists that the user adds
// in Settings, turning them into channel entries compatible with the catalog
// shape so they appear in the grid alongside the iptv-org channels.

const { detectProvider } = require('./providers');
const { detectPaywall } = require('./paywall');

const FETCH_TIMEOUT_MS = 30 * 1000;

// Parse a #EXTM3U playlist body into catalog-style channel entries.
function parseM3U(text, sourceName = 'Custom') {
  const lines = text.split(/\r?\n/);
  const out = [];
  let pending = null;

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF')) {
      pending = parseExtInf(line);
    } else if (line.startsWith('#EXTVLCOPT')) {
      if (pending) applyVlcOpt(pending, line);
    } else if (line.startsWith('#')) {
      // ignore other directives
    } else if (pending) {
      const url = line;
      const id = pending.tvgId || `custom:${sourceName}:${slug(pending.name)}:${out.length}`;
      const provider = detectProvider(url);
      const pay = detectPaywall(pending.name);
      out.push({
        id,
        name: pending.name || 'Unknown',
        altNames: [],
        website: null,
        isNsfw: false,
        paywalled: !!pay,
        paywallService: pay ? pay.service : null,
        countryCode: pending.tvgCountry || null,
        countryName: pending.tvgCountry || sourceName,
        countryFlag: '',
        categories: pending.group ? [{ id: slug(pending.group), name: pending.group }] : [],
        languages: pending.tvgLanguage
          ? [{ code: pending.tvgLanguage, name: pending.tvgLanguage }]
          : [],
        providerId: provider ? provider.id : null,
        providerName: provider ? provider.name : null,
        logo: pending.tvgLogo || null,
        streams: [{
          url,
          quality: null,
          feed: null,
          userAgent: pending.userAgent || null,
          referrer: pending.referrer || null,
        }],
        streamCount: 1,
        custom: true,
        source: sourceName,
      });
      pending = null;
    }
  }
  return out;
}

function parseExtInf(line) {
  const info = {};
  const attrMatches = line.matchAll(/([a-zA-Z0-9-]+)="([^"]*)"/g);
  for (const m of attrMatches) {
    const key = m[1].toLowerCase();
    const val = m[2];
    if (key === 'tvg-id') info.tvgId = val;
    else if (key === 'tvg-logo') info.tvgLogo = val;
    else if (key === 'tvg-language') info.tvgLanguage = val;
    else if (key === 'tvg-country') info.tvgCountry = val;
    else if (key === 'group-title') info.group = val;
  }
  // Channel name is whatever follows the last comma.
  const comma = line.indexOf(',');
  info.name = comma >= 0 ? line.slice(comma + 1).trim() : 'Unknown';
  return info;
}

function applyVlcOpt(pending, line) {
  const v = line.slice(line.indexOf(':') + 1);
  if (/http-user-agent=/i.test(v)) pending.userAgent = v.split('=').slice(1).join('=');
  else if (/http-referrer=/i.test(v)) pending.referrer = v.split('=').slice(1).join('=');
}

function slug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function fetchPlaylist({ name, url }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'WorldTV/0.1' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    return { ok: true, channels: parseM3U(text, name || 'Custom') };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err), channels: [] };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { parseM3U, fetchPlaylist };
