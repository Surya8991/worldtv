// main.js — Electron main process. Owns the data layer (datasets, catalog,
// custom playlists, EPG, health) and brokers everything to the renderer over IPC.
//
// WorldTV streams strictly free-to-air / publicly available channels from the
// open iptv-org project. No paywalled or DRM services.

const { app, BrowserWindow, ipcMain, shell, Menu, session, dialog } = require('electron');
const path = require('path');
const fsp = require('fs/promises');

const { DataStore } = require('./dataStore');
const {
  buildCatalog, computeFacets, saveCatalog, loadCatalog,
} = require('./catalog');
const { Persistence } = require('./persistence');
const { fetchPlaylist } = require('./playlist');
const { HealthChecker } = require('./health');
const { loadEpg } = require('./epg');

let win = null;
let store;        // DataStore
let persist;      // Persistence
let health;       // HealthChecker
let rawDatasets;  // cached raw datasets (for facet lookups)
let baseCatalog;  // catalog built from iptv-org only
let channels;     // merged channels (iptv-org + custom playlists)
let byId;         // Map id -> full channel (with streams)
let facets;       // merged facets
let epg = null;   // { index, ... }
let epgLoading = null;

const isDev = !app.isPackaged;

// A normal desktop-browser UA; many stream CDNs reject Electron's default UA.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// Network tuning so the renderer can load as many public streams as possible.
// Two safe adjustments (measured against real iptv-org streams):
//   1. Present a normal browser User-Agent — Electron's default UA contains
//      "Electron", which some stream CDNs reject.
//   2. Only ADD a permissive Access-Control-Allow-Origin when the response has
//      none. We never delete the Origin request header or an existing ACAO:
//      many servers *reflect* the Origin back as their ACAO, and stripping
//      Origin would make those stop sending it and get blocked.
// (Main-process dataset downloads use Node fetch and are unaffected by this.)
function setupStreamNetworking() {
  const ses = session.defaultSession;
  const filter = { urls: ['http://*/*', 'https://*/*'] };

  ses.webRequest.onBeforeSendHeaders(filter, (details, cb) => {
    const h = details.requestHeaders || {};
    h['User-Agent'] = BROWSER_UA;
    cb({ requestHeaders: h });
  });

  ses.webRequest.onHeadersReceived(filter, (details, cb) => {
    const rh = details.responseHeaders || {};
    const hasAcao = Object.keys(rh).some((k) => /^access-control-allow-origin$/i.test(k));
    if (!hasAcao) rh['Access-Control-Allow-Origin'] = ['*'];
    cb({ responseHeaders: rh });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0e0f13',
    title: 'WorldTV',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require(); renderer stays isolated
    },
  });

  Menu.setApplicationMenu(buildMenu());
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  if (isDev && process.env.WORLDTV_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });

  win.webContents.on('did-finish-load', () => console.log('[worldtv] renderer loaded'));
  win.webContents.on('render-process-gone', (_e, d) => console.error('[worldtv] renderer gone:', d));
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log('[renderer]', message); // 2=warning, 3=error
  });
}

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Refresh channel data', click: () => triggerRefresh(true) },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'iptv-org project',
          click: () => shell.openExternal('https://github.com/iptv-org/iptv'),
        },
        {
          label: 'About WorldTV',
          click: () => win && win.webContents.send('catalog:ready', { about: true }),
        },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---- Catalog assembly -----------------------------------------------------

function liteChannel(ch) {
  return {
    id: ch.id,
    name: ch.name,
    logo: ch.logo || null,
    countryCode: ch.countryCode || null,
    countryName: ch.countryName || 'Unknown',
    countryFlag: ch.countryFlag || '',
    catIds: (ch.categories || []).map((c) => c.id),
    langCodes: (ch.languages || []).map((l) => l.code),
    providerId: ch.providerId || null,
    providerName: ch.providerName || null,
    paywalled: !!ch.paywalled,
    paywallService: ch.paywallService || null,
    playUrl: ch.streams && ch.streams.length ? ch.streams[0].url : null,
    streamCount: ch.streamCount || (ch.streams ? ch.streams.length : 0),
    isNsfw: !!ch.isNsfw,
    custom: !!ch.custom,
  };
}

async function fetchCustomChannels() {
  const settings = persist.getSettings();
  const lists = settings.customPlaylists || [];
  const all = [];
  for (const entry of lists) {
    if (!entry || !entry.url) continue;
    const res = await fetchPlaylist(entry);
    if (res.ok) all.push(...res.channels);
    else console.warn(`[playlist] failed ${entry.url}: ${res.error}`);
  }
  return all;
}

// Build or load base catalog, merge custom playlists, recompute facets.
async function ensureCatalog({ rebuild = false } = {}) {
  if (!rawDatasets) rawDatasets = await store.getRaw();

  if (!baseCatalog || rebuild) {
    baseCatalog = rebuild ? null : await loadCatalog(app.getPath('userData'));
    if (!baseCatalog) {
      const settings = persist.getSettings();
      baseCatalog = buildCatalog(rawDatasets, { includeNsfw: settings.includeNsfw });
      await saveCatalog(app.getPath('userData'), baseCatalog);
    }
  }

  const custom = await fetchCustomChannels();
  // Dedupe on the base channel id (strip any "@feed" suffix) so that iptv-org
  // style playlists ("BBCNews.uk@SD") don't duplicate catalog channels
  // ("BBCNews.uk"). Channels without a tvg-id get a unique custom: id and pass.
  const baseId = (id) => String(id).split('@')[0];
  const merged = [...baseCatalog.channels];
  const seen = new Set(merged.map((c) => baseId(c.id)));
  for (const c of custom) {
    const b = baseId(c.id);
    if (seen.has(b)) continue;
    seen.add(b);
    merged.push(c);
  }
  merged.sort((a, b) => a.name.localeCompare(b.name));

  channels = merged;
  byId = new Map(merged.map((c) => [c.id, c]));
  facets = computeFacets(merged, {
    countries: rawDatasets.countries,
    categories: rawDatasets.categories,
    languages: rawDatasets.languages,
  });
  return { count: merged.length, customCount: custom.length };
}

function catalogPayload() {
  return {
    channels: channels.map(liteChannel),
    facets,
    favorites: persist.getFavorites(),
    recent: persist.getRecent(),
    settings: persist.getSettings(),
  };
}

async function triggerRefresh(force) {
  send('sync:progress', { phase: 'start', message: 'Refreshing channel data…' });
  const result = await store.sync({
    force,
    onProgress: ({ name, index, total }) =>
      send('sync:progress', { phase: 'download', name, index, total }),
  });
  rawDatasets = null; // force reload from freshly written cache
  send('sync:progress', { phase: 'build', message: 'Rebuilding catalog…' });
  await ensureCatalog({ rebuild: true });
  send('catalog:ready', catalogPayload());
  send('sync:progress', { phase: 'done', meta: await store.getMeta() });
  return result;
}

// ---- EPG ------------------------------------------------------------------

async function ensureEpg(forceReload = false) {
  if (epg && !forceReload) return epg;
  if (epgLoading) return epgLoading;
  const settings = persist.getSettings();
  const urls = settings.epgUrls || [];
  if (urls.length === 0) {
    epg = { index: null, results: [], programmeCount: 0, channels: 0 };
    return epg;
  }
  epgLoading = loadEpg(urls).then((res) => {
    epg = res;
    epgLoading = null;
    send('epg:loaded', {
      programmeCount: res.programmeCount,
      channels: res.channels,
      results: res.results,
    });
    return res;
  }).catch((err) => {
    epgLoading = null;
    epg = { index: null, results: [{ ok: false, error: String(err) }], programmeCount: 0, channels: 0 };
    return epg;
  });
  return epgLoading;
}

// ---- IPC handlers ---------------------------------------------------------

function registerIpc() {
  ipcMain.handle('catalog:get', async () => {
    if (!channels) await ensureCatalog();
    // Proactively probe favorites + recently-watched so dead ones are flagged
    // before the user clicks them.
    const settings = persist.getSettings();
    if (settings.healthCheck) {
      const ids = new Set([...persist.getFavorites(), ...persist.getRecent().map((r) => r.id)]);
      const list = [...ids].map((id) => byId.get(id)).filter(Boolean);
      if (list.length) {
        health.checkChannels(list, { onResult: (id, status) => send('health:result', { id, status }) });
      }
    }
    return catalogPayload();
  });

  ipcMain.handle('catalog:refresh', async (_e, { force } = {}) => triggerRefresh(force));

  ipcMain.handle('catalog:streams', async (_e, id) => {
    const ch = byId && byId.get(id);
    return ch ? ch.streams : [];
  });

  ipcMain.handle('data:meta', async () => store.getMeta());

  ipcMain.handle('fav:get', async () => persist.getFavorites());
  ipcMain.handle('fav:toggle', async (_e, id) => persist.toggleFavorite(id));
  ipcMain.handle('recent:get', async () => persist.getRecent());
  ipcMain.handle('recent:push', async (_e, id) => persist.pushRecent(id));
  ipcMain.handle('recent:clear', async () => persist.clearRecent());

  ipcMain.handle('settings:get', async () => persist.getSettings());
  ipcMain.handle('settings:update', async (_e, patch) => {
    const next = persist.updateSettings(patch || {});
    // NSFW toggle changes which channels are watchable -> rebuild base catalog.
    if (patch && Object.prototype.hasOwnProperty.call(patch, 'includeNsfw')) {
      await ensureCatalog({ rebuild: true });
      send('catalog:ready', catalogPayload());
    }
    return next;
  });

  ipcMain.handle('playlist:add', async (_e, entry) => {
    const settings = persist.getSettings();
    const lists = (settings.customPlaylists || []).filter((p) => p.url !== entry.url);
    lists.push({ name: entry.name || entry.url, url: entry.url });
    persist.updateSettings({ customPlaylists: lists });
    await ensureCatalog();
    send('catalog:ready', catalogPayload());
    return catalogPayload();
  });

  ipcMain.handle('playlist:remove', async (_e, url) => {
    const settings = persist.getSettings();
    const lists = (settings.customPlaylists || []).filter((p) => p.url !== url);
    persist.updateSettings({ customPlaylists: lists });
    await ensureCatalog();
    send('catalog:ready', catalogPayload());
    return catalogPayload();
  });

  ipcMain.handle('epg:add', async (_e, entry) => {
    const settings = persist.getSettings();
    const urls = (settings.epgUrls || []).filter((p) => p.url !== entry.url);
    urls.push({ name: entry.name || entry.url, url: entry.url });
    const next = persist.updateSettings({ epgUrls: urls });
    ensureEpg(true);
    return next;
  });

  ipcMain.handle('epg:remove', async (_e, url) => {
    const settings = persist.getSettings();
    const urls = (settings.epgUrls || []).filter((p) => p.url !== url);
    const next = persist.updateSettings({ epgUrls: urls });
    ensureEpg(true);
    return next;
  });

  ipcMain.handle('health:check', async (_e, ids) => {
    const settings = persist.getSettings();
    if (!settings.healthCheck) return { skipped: true };
    const list = (ids || []).map((id) => byId.get(id)).filter(Boolean);
    health.checkChannels(list, {
      onResult: (id, status) => send('health:result', { id, status }),
    });
    return { started: list.length };
  });

  ipcMain.handle('health:get', async (_e, ids) => {
    await health.load();
    const out = {};
    for (const id of ids || []) {
      const ch = byId.get(id);
      if (ch && ch.streams[0]) out[id] = health.getStatus(ch.streams[0].url).status;
    }
    return out;
  });

  ipcMain.handle('epg:load', async () => {
    const res = await ensureEpg(true);
    return { programmeCount: res.programmeCount, channels: res.channels, results: res.results };
  });

  ipcMain.handle('epg:status', async () => {
    if (!epg) return { loaded: false, programmeCount: 0, channels: 0, results: [] };
    return {
      loaded: !!epg.index,
      programmeCount: epg.programmeCount,
      channels: epg.channels,
      results: epg.results,
    };
  });

  ipcMain.handle('epg:nownext', async (_e, id) => {
    const res = await ensureEpg();
    if (!res.index) return { now: null, next: null };
    const ch = byId && byId.get(id);
    return res.index.nowNext(id, Date.now(), ch ? ch.name : null);
  });

  ipcMain.handle('epg:guide', async (_e, { id, from, to }) => {
    const res = await ensureEpg();
    if (!res.index) return [];
    const ch = byId && byId.get(id);
    return res.index.range(id, from, to, ch ? ch.name : null);
  });

  ipcMain.handle('data:export', async () => {
    const payload = {
      app: 'WorldTV', version: app.getVersion(), exportedAt: Date.now(),
      favorites: persist.getFavorites(),
      recent: persist.getRecent(),
      settings: persist.getSettings(),
    };
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Export WorldTV data',
      defaultPath: 'worldtv-backup.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    await fsp.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
    return { ok: true, path: filePath };
  });

  ipcMain.handle('data:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Import WorldTV data',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, canceled: true };
    try {
      const parsed = JSON.parse(await fsp.readFile(filePaths[0], 'utf8'));
      if (Array.isArray(parsed.favorites)) persist.store.set('favorites', parsed.favorites);
      if (Array.isArray(parsed.recent)) persist.store.set('recent', parsed.recent);
      if (parsed.settings && typeof parsed.settings === 'object') persist.updateSettings(parsed.settings);
      await ensureCatalog({ rebuild: true });
      send('catalog:ready', catalogPayload());
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message ? err.message : err) };
    }
  });

  ipcMain.handle('app:openExternal', async (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    userData: app.getPath('userData'),
  }));
}

// ---- Lifecycle ------------------------------------------------------------

app.whenReady().then(async () => {
  store = new DataStore(app.getPath('userData'));
  persist = new Persistence();
  health = new HealthChecker(app.getPath('userData'));
  setupStreamNetworking();
  registerIpc();
  createWindow();

  // First run (or stale) background sync so the catalog stays current without
  // blocking startup when a cache already exists.
  const meta = await store.getMeta();
  if (!meta.hasLocal) {
    triggerRefresh(true);
  } else if (meta.stale) {
    triggerRefresh(false);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
