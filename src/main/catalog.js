// catalog.js — joins the raw iptv-org datasets into a single normalized list of
// *watchable* channels (channels that have at least one stream). Each entry is
// denormalized with everything the UI needs: display name, logo, country (name +
// flag), category names, languages, and the list of stream URLs with quality.
//
// The join is done once per sync and the result is cached to disk so subsequent
// launches are instant.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { detectProvider } = require('./providers');
const { detectPaywall } = require('./paywall');

const CATALOG_VERSION = 5;

function indexBy(arr, key) {
  const m = new Map();
  for (const item of arr) {
    const k = item[key];
    if (k != null) m.set(k, item);
  }
  return m;
}

function groupBy(arr, key) {
  const m = new Map();
  for (const item of arr) {
    const k = item[key];
    if (k == null) continue;
    let bucket = m.get(k);
    if (!bucket) { bucket = []; m.set(k, bucket); }
    bucket.push(item);
  }
  return m;
}

// Build the normalized catalog. `datasets` is the object returned by DataStore.getRaw().
function buildCatalog(datasets, { includeNsfw = false } = {}) {
  const {
    channels = [],
    streams = [],
    feeds = [],
    countries = [],
    categories = [],
    languages = [],
    logos = [],
  } = datasets;

  const countryByCode = indexBy(countries, 'code');
  const categoryById = indexBy(categories, 'id');
  const languageByCode = indexBy(languages, 'code');

  const streamsByChannel = groupBy(streams.filter((s) => s.channel && s.url), 'channel');
  const feedsByChannel = groupBy(feeds, 'channel');

  // Prefer an in-use logo; fall back to the first available one for the channel.
  const logoByChannel = new Map();
  for (const l of logos) {
    if (!l.channel || !l.url) continue;
    const existing = logoByChannel.get(l.channel);
    if (!existing || (l.in_use && !existing.in_use)) logoByChannel.set(l.channel, l);
  }

  const out = [];

  for (const ch of channels) {
    const chStreams = streamsByChannel.get(ch.id);
    if (!chStreams || chStreams.length === 0) continue; // not watchable
    if (ch.is_nsfw && !includeNsfw) continue;

    const country = countryByCode.get(ch.country) || null;

    const catNames = (ch.categories || []).map((id) => {
      const c = categoryById.get(id);
      return c ? { id, name: c.name } : { id, name: id };
    });

    // Languages come from the channel's feeds (deduped).
    const langCodes = new Set();
    for (const f of feedsByChannel.get(ch.id) || []) {
      for (const code of f.languages || []) langCodes.add(code);
    }
    const langs = [...langCodes].map((code) => {
      const l = languageByCode.get(code);
      return { code, name: l ? l.name : code };
    });

    const logo = logoByChannel.get(ch.id);

    // Dedupe + sort streams: prefer higher quality, keep the url list.
    const seen = new Set();
    const streamList = [];
    for (const s of chStreams) {
      if (seen.has(s.url)) continue;
      seen.add(s.url);
      streamList.push({
        url: s.url,
        quality: s.quality || null,
        feed: s.feed || null,
        userAgent: s.user_agent || null,
        referrer: s.referrer || null,
      });
    }
    streamList.sort((a, b) => qualityRank(b.quality) - qualityRank(a.quality));

    const provider = streamList.length ? detectProvider(streamList[0].url) : null;
    const pay = detectPaywall(ch.name);

    const entry = {
      id: ch.id,
      name: ch.name,
      paywalled: !!pay,
      paywallService: pay ? pay.service : null,
      altNames: ch.alt_names || [],
      website: ch.website || null,
      isNsfw: !!ch.is_nsfw,
      countryCode: ch.country || null,
      countryName: country ? country.name : (ch.country || 'Unknown'),
      countryFlag: country ? country.flag : '',
      categories: catNames,
      languages: langs,
      providerId: provider ? provider.id : null,
      providerName: provider ? provider.name : null,
      logo: logo ? logo.url : null,
      streams: streamList,
      streamCount: streamList.length,
    };
    out.push(entry);
  }

  out.sort((a, b) => a.name.localeCompare(b.name));

  const facets = computeFacets(out, { countries, categories, languages });
  return { version: CATALOG_VERSION, builtAt: Date.now(), channels: out, facets };
}

function bump(map, key) {
  if (key == null) return;
  map.set(key, (map.get(key) || 0) + 1);
}

// Compute sidebar filter facets (countries, categories, languages, services)
// over an arbitrary channel list. Used at build time and again after custom
// playlists are merged in, so counts always reflect what's actually shown.
function computeFacets(channelList, lookups = {}) {
  const { countries = [], categories = [], languages = [] } = lookups;
  const countryByCode = indexBy(countries, 'code');
  const categoryById = indexBy(categories, 'id');
  const languageByCode = indexBy(languages, 'code');

  const countryCounts = new Map();
  const countryMeta = new Map();
  const categoryCounts = new Map();
  const categoryMeta = new Map();
  const languageCounts = new Map();
  const languageMeta = new Map();
  const providerCounts = new Map();
  const providerMeta = new Map();

  for (const ch of channelList) {
    bump(countryCounts, ch.countryCode);
    if (ch.countryCode && !countryMeta.has(ch.countryCode)) {
      const c = countryByCode.get(ch.countryCode);
      countryMeta.set(ch.countryCode, {
        code: ch.countryCode,
        name: c ? c.name : (ch.countryName || ch.countryCode),
        flag: c ? c.flag : (ch.countryFlag || ''),
      });
    }
    for (const cat of ch.categories || []) {
      bump(categoryCounts, cat.id);
      if (!categoryMeta.has(cat.id)) {
        const c = categoryById.get(cat.id);
        categoryMeta.set(cat.id, { id: cat.id, name: c ? c.name : cat.name });
      }
    }
    for (const l of ch.languages || []) {
      bump(languageCounts, l.code);
      if (!languageMeta.has(l.code)) {
        const lang = languageByCode.get(l.code);
        languageMeta.set(l.code, { code: l.code, name: lang ? lang.name : l.name });
      }
    }
    if (ch.providerId) {
      bump(providerCounts, ch.providerId);
      if (!providerMeta.has(ch.providerId)) {
        providerMeta.set(ch.providerId, { id: ch.providerId, name: ch.providerName });
      }
    }
  }

  return {
    countries: [...countryMeta.values()]
      .map((c) => ({ ...c, count: countryCounts.get(c.code) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    categories: [...categoryMeta.values()]
      .map((c) => ({ ...c, count: categoryCounts.get(c.id) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    languages: [...languageMeta.values()]
      .map((l) => ({ ...l, count: languageCounts.get(l.code) }))
      .sort((a, b) => b.count - a.count),
    services: [...providerMeta.values()]
      .map((p) => ({ ...p, count: providerCounts.get(p.id) }))
      .sort((a, b) => b.count - a.count),
  };
}

function qualityRank(q) {
  if (!q) return 0;
  const m = String(q).match(/(\d{3,4})/);
  return m ? parseInt(m[1], 10) : 0;
}

// Persisted catalog helpers.
function catalogPath(userDataDir) {
  return path.join(userDataDir, 'cache', 'catalog.json');
}

async function saveCatalog(userDataDir, catalog) {
  const p = catalogPath(userDataDir);
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, JSON.stringify(catalog), 'utf8');
}

async function loadCatalog(userDataDir) {
  try {
    const raw = await fsp.readFile(catalogPath(userDataDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.version !== CATALOG_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function hasCatalog(userDataDir) {
  return fs.existsSync(catalogPath(userDataDir));
}

module.exports = {
  buildCatalog,
  computeFacets,
  saveCatalog,
  loadCatalog,
  hasCatalog,
  CATALOG_VERSION,
};
