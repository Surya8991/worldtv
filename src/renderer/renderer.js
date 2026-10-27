/* renderer.js — WorldTV UI. Talks to the main process only through the
 * window.worldtv bridge exposed by preload.js. */
'use strict';

const api = window.worldtv;
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const PAGE_SIZE = 60;

// One-click public IPTV playlist presets. All from the Free-TV project — a
// curated, free-to-air list whose channels aren't already in the iptv-org
// catalog (~1,200 new). "Global" is everything; the others are subsets of it
// (add Global, or pick the ones you want). Duplicates are skipped automatically.
const FREETV = 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlists/';
const IPTV_PRESETS = [
  { name: 'Free-TV — Global (FTA)', url: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8', note: '~2,000 free-to-air channels worldwide (adds ~1,200 new)' },
  { name: 'Free-TV — USA', url: `${FREETV}playlist_usa.m3u8`, note: 'United States channels' },
  { name: 'Free-TV — UK', url: `${FREETV}playlist_uk.m3u8`, note: 'United Kingdom channels' },
  { name: 'Free-TV — India', url: `${FREETV}playlist_india.m3u8`, note: 'India channels' },
  { name: 'Free-TV — News (English)', url: `${FREETV}playlist_zz_news_en.m3u8`, note: 'English-language news' },
  { name: 'Free-TV — Movies', url: `${FREETV}playlist_zz_movies.m3u8`, note: 'Movie channels' },
];
// Matches Free-TV's tvg-ids, so enabling it gives real guide data for them.
const EPG_PRESET = { name: 'epgshare01 — All sources', url: 'https://epgshare01.online/epgshare01/epg_ripper_ALL_SOURCES1.xml.gz' };

const state = {
  channels: [],            // lite channel list
  byId: new Map(),
  facets: { countries: [], categories: [], languages: [], services: [] },
  favorites: new Set(),
  recent: [],
  settings: {},
  view: 'all',
  filters: { service: null, country: null, category: null, language: null },
  search: '',
  hideDead: false,
  health: new Map(),       // id -> 'ok'|'dead'|'unknown'
  filtered: [],
  rendered: 0,
  current: null,           // currently playing channel id
  playStreams: [],         // all streams for the current channel (for fallback)
  playIdx: 0,
  hls: null,
};

/* ---------- init ---------- */
async function init() {
  wireStaticEvents();
  const data = await api.getCatalog();
  applyCatalog(data);

  const info = await api.getAppInfo();
  $('#about-text').textContent =
    `WorldTV v${info.version} · Electron ${info.electron}. Data cached in your local app folder.`;

  api.onCatalogReady((payload) => { if (!payload || !payload.about) applyCatalog(payload); });
  api.onSyncProgress(onSyncProgress);
  api.onHealthResult(({ id, status }) => {
    state.health.set(id, status);
    updateCardHealth(id, status);
  });
  api.onEpgLoaded((s) => {
    toast(`EPG loaded: ${s.programmeCount.toLocaleString()} programs across ${s.channels} channels`);
    if (state.view === 'guide') renderGuide();
    if (state.current) refreshNowNext(state.current);
  });

  refreshDataMeta();
  // Preload EPG if the user has sources configured.
  if ((state.settings.epgUrls || []).length) api.loadEpg();
}

function applyCatalog(data) {
  if (!data) return;
  if (data.channels) {
    state.channels = data.channels;
    state.byId = new Map(data.channels.map((c) => [c.id, c]));
  }
  if (data.facets) state.facets = data.facets;
  if (data.favorites) state.favorites = new Set(data.favorites);
  if (data.recent) state.recent = data.recent;
  if (data.settings) state.settings = data.settings;

  $('#hide-dead').checked = !!state.settings.autoHideDead;
  state.hideDead = !!state.settings.autoHideDead;

  renderFacets();
  renderSettings();
  applyFiltersAndRender();
}

/* ---------- facets / sidebar ---------- */
function renderFacets() {
  renderServiceFilter();
  renderCountryFilter();
  renderList('#filter-categories', state.facets.categories, 'category', (c) => ({
    key: c.id, name: c.name, count: c.count,
  }));
  renderList('#filter-languages', state.facets.languages.slice(0, 60), 'language', (l) => ({
    key: l.code, name: l.name, count: l.count,
  }));
}

function renderServiceFilter() {
  const box = $('#filter-services');
  box.innerHTML = '';
  if (!state.facets.services.length) {
    box.innerHTML = '<div class="muted" style="padding:4px 7px;font-size:12px">None detected</div>';
    return;
  }
  for (const s of state.facets.services) {
    box.appendChild(filterItem({
      key: s.id, name: s.name, count: s.count,
      active: state.filters.service === s.id,
      onClick: () => toggleFilter('service', s.id),
    }));
  }
}

function renderCountryFilter() {
  const term = ($('#country-search').value || '').toLowerCase();
  const list = state.facets.countries.filter((c) => !term || c.name.toLowerCase().includes(term));
  const box = $('#filter-countries');
  box.innerHTML = '';
  for (const c of list) {
    box.appendChild(filterItem({
      key: c.code, name: c.name, count: c.count, flag: c.flag,
      active: state.filters.country === c.code,
      onClick: () => toggleFilter('country', c.code),
    }));
  }
}

function renderList(sel, items, dim, map) {
  const box = $(sel);
  box.innerHTML = '';
  for (const it of items) {
    const m = map(it);
    box.appendChild(filterItem({
      key: m.key, name: m.name, count: m.count,
      active: state.filters[dim] === m.key,
      onClick: () => toggleFilter(dim, m.key),
    }));
  }
}

function filterItem({ key, name, count, flag, active, onClick }) {
  const el = document.createElement('div');
  el.className = 'filter-item' + (active ? ' active' : '');
  el.innerHTML =
    (flag ? `<span class="fi-flag">${flag}</span>` : '') +
    `<span class="fi-name">${escapeHtml(name)}</span>` +
    `<span class="fi-count">${count ?? ''}</span>`;
  el.onclick = onClick;
  return el;
}

function toggleFilter(dim, key) {
  state.filters[dim] = state.filters[dim] === key ? null : key;
  if (state.view !== 'all' && state.view !== 'guide') setView('all');
  renderFacets();
  renderActiveFilters();
  applyFiltersAndRender();
}

function renderActiveFilters() {
  const box = $('#active-filters');
  box.innerHTML = '';
  const add = (label, clear) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `${escapeHtml(label)} <button>✕</button>`;
    chip.querySelector('button').onclick = clear;
    box.appendChild(chip);
  };
  const f = state.filters;
  if (f.service) add(`Service: ${nameOf('services', f.service, 'id')}`, () => toggleFilter('service', f.service));
  if (f.country) add(`${nameOf('countries', f.country, 'code')}`, () => toggleFilter('country', f.country));
  if (f.category) add(`${nameOf('categories', f.category, 'id')}`, () => toggleFilter('category', f.category));
  if (f.language) add(`${nameOf('languages', f.language, 'code')}`, () => toggleFilter('language', f.language));
}

function nameOf(facet, key, idField) {
  const item = state.facets[facet].find((x) => x[idField] === key);
  return item ? item.name : key;
}

/* ---------- filtering + grid ---------- */
function applyFiltersAndRender() {
  const f = state.filters;
  const term = state.search.trim().toLowerCase();
  let base = state.channels;

  if (state.view === 'favorites') base = base.filter((c) => state.favorites.has(c.id));
  else if (state.view === 'recent') {
    const order = new Map(state.recent.map((r, i) => [r.id, i]));
    base = base.filter((c) => order.has(c.id)).sort((a, b) => order.get(a.id) - order.get(b.id));
  }

  state.filtered = base.filter((c) => {
    if (f.service && c.providerId !== f.service) return false;
    if (f.country && c.countryCode !== f.country) return false;
    if (f.category && !c.catIds.includes(f.category)) return false;
    if (f.language && !c.langCodes.includes(f.language)) return false;
    if (term && !c.name.toLowerCase().includes(term)) return false;
    if (state.hideDead && state.health.get(c.id) === 'dead') return false;
    return true;
  });

  $('#result-count').textContent = `${state.filtered.length.toLocaleString()} channels`;
  renderRecentRow();
  resetGrid();
}

function resetGrid() {
  const grid = $('#grid');
  grid.innerHTML = '';
  state.rendered = 0;
  $('#empty').classList.toggle('hidden', state.filtered.length > 0);
  renderMore();
}

function renderMore() {
  const grid = $('#grid');
  const slice = state.filtered.slice(state.rendered, state.rendered + PAGE_SIZE);
  const frag = document.createDocumentFragment();
  for (const c of slice) frag.appendChild(channelCard(c));
  grid.appendChild(frag);
  state.rendered += slice.length;
  // Probe health for the newly shown channels.
  if (state.settings.healthCheck && slice.length) {
    api.requestHealth(slice.map((c) => c.id));
  }
}

function channelCard(c) {
  const el = document.createElement('div');
  el.className = 'card-ch';
  el.dataset.id = c.id;
  const health = state.health.get(c.id);
  if (state.hideDead && health === 'dead') el.classList.add('dead');

  const fav = state.favorites.has(c.id);
  const topBadge = c.paywalled
    ? '<span class="badge-paywall" title="Paid / subscription channel">🔒 PAID</span>'
    : (c.providerName ? `<span class="badge-provider">${escapeHtml(c.providerName)}</span>` : '');
  el.innerHTML =
    topBadge +
    `<button class="fav-star ${fav ? 'on' : ''}" title="Favorite">${fav ? '★' : '☆'}</button>` +
    `<div class="logo-wrap"></div>` +
    `<div class="ch-name">${escapeHtml(c.name)}</div>` +
    `<div class="ch-sub"><span class="health-dot ${health || ''}"></span>${c.countryFlag || ''} ${escapeHtml(c.countryName || '')}</div>`;

  el.querySelector('.logo-wrap').appendChild(logoEl(c, 84));
  el.querySelector('.fav-star').onclick = (e) => { e.stopPropagation(); toggleFav(c.id); };
  el.onclick = () => playChannel(c.id);
  return el;
}

// Build a logo <img> (with graceful fallback) or an initials tile. onerror is
// wired in JS so channel names never get interpolated into inline handlers.
function logoEl(c, max) {
  if (c.logo) {
    const img = document.createElement('img');
    img.src = c.logo;
    img.loading = 'lazy';
    img.alt = '';
    if (max) { img.style.maxWidth = `${max}px`; img.style.maxHeight = `${max}px`; }
    img.onerror = () => { try { img.replaceWith(fallbackEl(c.name)); } catch {} };
    return img;
  }
  return fallbackEl(c.name);
}
function fallbackEl(name) {
  const d = document.createElement('div');
  d.className = 'logo-fallback';
  d.textContent = initials(name);
  return d;
}

function updateCardHealth(id, status) {
  const card = $(`.card-ch[data-id="${cssEscape(id)}"]`);
  if (card) {
    const dot = card.querySelector('.health-dot');
    if (dot) dot.className = `health-dot ${status}`;
    if (state.hideDead && status === 'dead') card.remove();
  }
}

/* ---------- recently watched row ---------- */
function renderRecentRow() {
  const row = $('#recent-row');
  if (state.view !== 'all' || !state.recent.length) { row.classList.add('hidden'); return; }
  row.classList.remove('hidden');
  const box = $('#recent-items');
  box.innerHTML = '';
  for (const r of state.recent.slice(0, 12)) {
    const c = state.byId.get(r.id);
    if (!c) continue;
    const el = document.createElement('div');
    el.className = 'recent-card';
    el.innerHTML = `<div class="rc-logo"></div><div class="rc-name">${escapeHtml(c.name)}</div>`;
    const lg = logoEl(c, 64);
    if (lg.classList.contains('logo-fallback')) lg.style.margin = '0 auto';
    el.querySelector('.rc-logo').appendChild(lg);
    el.onclick = () => playChannel(c.id);
    box.appendChild(el);
  }
}

/* ---------- player ---------- */
async function playChannel(id) {
  const c = state.byId.get(id);
  if (!c || !c.playUrl) { toast('No stream for this channel'); return; }
  state.current = id;

  $('#player-pane').classList.remove('hidden');
  $('#pp-name').textContent = c.name;
  $('#pp-meta').textContent = [c.countryName, c.providerName].filter(Boolean).join(' · ');
  const ppLogo = $('#pp-logo');
  if (c.logo) { ppLogo.src = c.logo; ppLogo.style.visibility = 'visible'; } else ppLogo.style.visibility = 'hidden';
  $('#pp-fav').classList.toggle('on', state.favorites.has(id));
  $('#pp-fav').textContent = state.favorites.has(id) ? '★' : '☆';

  // Paywall notice: label paid channels; we don't bypass their paywall.
  const banner = $('#paywall-banner');
  if (c.paywalled) {
    banner.innerHTML = `🔒 <b>${escapeHtml(c.name)}</b> is a paid / subscription channel. `
      + `Any free stream here is an unauthorized restream and usually won't play — `
      + `watch it legally via <b>${escapeHtml(c.paywallService || 'its official service')}</b>.`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }

  state.recent = await api.pushRecent(id);
  refreshNowNext(id);

  // Fetch all streams so we can fall back if the first one fails.
  let streams = [];
  try { streams = await api.getStreams(id); } catch {}
  if (!streams.length) streams = [{ url: c.playUrl }];
  // Only replay if this is still the active channel (user may have clicked away).
  if (state.current !== id) return;
  state.playStreams = streams;
  state.playIdx = 0;
  playCurrentStream();
}

function playCurrentStream() {
  const s = state.playStreams[state.playIdx];
  if (!s) return;
  loadStream(s.url);
}

function tryNextStream(reason) {
  if (state.playIdx + 1 < state.playStreams.length) {
    state.playIdx += 1;
    showPlayerMsg(`Stream unavailable — trying alternate ${state.playIdx + 1}/${state.playStreams.length}…`);
    setTimeout(() => { if (state.current) playCurrentStream(); }, 600);
    return true;
  }
  showPlayerMsg(reason || 'This channel could not be played — it looks offline right now. Try another channel.');
  if (state.current) {
    state.health.set(state.current, 'dead');
    updateCardHealth(state.current, 'dead');
  }
  teardownHls();
  return false;
}

function loadStream(url) {
  const video = $('#video');
  const msg = $('#player-msg');
  msg.classList.add('hidden');
  teardownHls();

  const isHls = /\.m3u8(\?|$)/i.test(url) || url.includes('m3u8');
  if (isHls && window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 20, manifestLoadingMaxRetry: 2, levelLoadingMaxRetry: 2 });
    state.hls = hls;
    let recovered = 0;
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => { msg.classList.add('hidden'); video.play().catch(() => {}); });
    hls.on(window.Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      switch (data.type) {
        case window.Hls.ErrorTypes.NETWORK_ERROR:
          // Manifest/segment load failed → the stream is unreachable; fall back.
          if (data.details && /manifestLoadError|manifestLoadTimeOut|levelLoadError/i.test(data.details)) {
            teardownHls();
            tryNextStream();
          } else if (recovered < 2) { recovered += 1; hls.startLoad(); }
          else { teardownHls(); tryNextStream(); }
          break;
        case window.Hls.ErrorTypes.MEDIA_ERROR:
          if (recovered < 2) { recovered += 1; hls.recoverMediaError(); }
          else { teardownHls(); tryNextStream('This stream uses a media format the player can\'t decode.'); }
          break;
        default:
          teardownHls();
          tryNextStream();
      }
    });
  } else {
    // Native / progressive fallback (mp4, native-HLS on some platforms).
    video.src = url;
    video.play().catch(() => {});
    video.onerror = () => tryNextStream('This stream uses a format the player can\'t handle.');
  }
}

function showPlayerMsg(text) {
  const msg = $('#player-msg');
  msg.textContent = text;
  msg.classList.remove('hidden');
}

function teardownHls() {
  if (state.hls) { try { state.hls.destroy(); } catch {} state.hls = null; }
  const video = $('#video');
  video.removeAttribute('src');
  video.onerror = null;
}

function closePlayer() {
  teardownHls();
  $('#video').pause();
  $('#player-pane').classList.add('hidden');
  $('#paywall-banner').classList.add('hidden');
  state.current = null;
}

/* ---------- EPG now/next ---------- */
async function refreshNowNext(id) {
  const { now, next } = await api.nowNext(id);
  $('#epg-now-title').textContent = now ? now.title : '—';
  $('#epg-now-time').textContent = now ? timeRange(now.start, now.stop) : '';
  $('#epg-next-title').textContent = next ? next.title : '—';
  $('#epg-next-time').textContent = next ? fmtTime(next.start) : '';
}

/* ---------- guide view ---------- */
async function renderGuide() {
  const status = $('#guide-status');
  const body = $('#guide-body');
  const epgStat = await api.epgStatus();
  if (!epgStat.loaded || epgStat.channels === 0) {
    status.innerHTML = 'No EPG data loaded. Add an XMLTV source in <b>Settings → EPG sources</b>, then reload.';
    body.innerHTML = '';
    return;
  }
  status.textContent = `${epgStat.programmeCount.toLocaleString()} programs loaded. Showing the next few hours.`;

  // Show guide for the current filtered set (cap for performance), preferring favorites.
  let list = state.filtered.length ? state.filtered : state.channels;
  if (state.favorites.size) {
    const favs = list.filter((c) => state.favorites.has(c.id));
    if (favs.length) list = favs;
  }
  list = list.slice(0, 40);

  const from = Date.now();
  const to = from + 4 * 3600 * 1000;
  body.innerHTML = '<div class="muted">Loading guide…</div>';
  const rows = [];
  for (const c of list) {
    const progs = await api.guide(c.id, from, to);
    if (!progs.length) continue;
    rows.push(renderGuideRow(c, progs, from));
  }
  body.innerHTML = '';
  if (!rows.length) {
    body.innerHTML = '<div class="muted">None of these channels have matching guide data.</div>';
    return;
  }
  rows.forEach((r) => body.appendChild(r));
}

function renderGuideRow(c, progs, now) {
  const el = document.createElement('div');
  el.className = 'guide-row';
  const chCell = document.createElement('div');
  chCell.className = 'guide-ch';
  if (c.logo) {
    const img = document.createElement('img');
    img.src = c.logo; img.loading = 'lazy'; img.alt = '';
    img.onerror = () => { img.style.display = 'none'; };
    chCell.appendChild(img);
  }
  const span = document.createElement('span');
  span.textContent = c.name;
  chCell.appendChild(span);
  chCell.onclick = () => playChannel(c.id);

  const progCell = document.createElement('div');
  progCell.className = 'guide-progs';
  for (const p of progs.slice(0, 8)) {
    const pe = document.createElement('div');
    pe.className = 'guide-prog' + (p.start <= now && now < p.stop ? ' on-now' : '');
    pe.innerHTML = `<div class="gp-time">${fmtTime(p.start)}</div><div>${escapeHtml(p.title)}</div>`;
    progCell.appendChild(pe);
  }
  el.appendChild(chCell);
  el.appendChild(progCell);
  return el;
}

/* ---------- favorites ---------- */
async function toggleFav(id) {
  const favs = await api.toggleFavorite(id);
  state.favorites = new Set(favs);
  // Update any visible star for this id.
  $$(`.card-ch[data-id="${cssEscape(id)}"] .fav-star`).forEach((b) => {
    const on = state.favorites.has(id);
    b.classList.toggle('on', on);
    b.textContent = on ? '★' : '☆';
  });
  if (state.current === id) {
    const on = state.favorites.has(id);
    $('#pp-fav').classList.toggle('on', on);
    $('#pp-fav').textContent = on ? '★' : '☆';
  }
  if (state.view === 'favorites') applyFiltersAndRender();
}

/* ---------- settings ---------- */
function renderSettings() {
  const s = state.settings;
  $('#set-healthcheck').checked = !!s.healthCheck;
  $('#set-autohide').checked = !!s.autoHideDead;
  $('#set-nsfw').checked = !!s.includeNsfw;

  renderPresets();

  const plList = $('#pl-list');
  plList.innerHTML = '';
  for (const p of s.customPlaylists || []) {
    plList.appendChild(srcRow(p.name, p.url, () => removePlaylist(p.url)));
  }
  if (!(s.customPlaylists || []).length) plList.innerHTML = '<li class="muted">No custom playlists.</li>';

  const epgList = $('#epg-list');
  epgList.innerHTML = '';
  for (const e of s.epgUrls || []) {
    epgList.appendChild(srcRow(e.name, e.url, () => removeEpg(e.url)));
  }
  if (!(s.epgUrls || []).length) epgList.innerHTML = '<li class="muted">No EPG sources.</li>';
}

function renderPresets() {
  const box = $('#preset-list');
  if (!box) return;
  const added = new Set((state.settings.customPlaylists || []).map((p) => p.url));
  box.innerHTML = '';
  for (const p of IPTV_PRESETS) {
    const on = added.has(p.url);
    const li = document.createElement('div');
    li.className = 'src-list';
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:10px;padding:7px 0;border-top:1px solid var(--line)';
    row.innerHTML = `<span><b>${escapeHtml(p.name)}</b><br><span class="src-meta">${escapeHtml(p.note)}</span></span>`;
    const btn = document.createElement('button');
    btn.textContent = on ? 'Remove' : 'Add';
    btn.onclick = async () => {
      btn.disabled = true;
      toast(on ? `Removing ${p.name}…` : `Fetching ${p.name}…`);
      const data = on ? await api.removePlaylist(p.url) : await api.addPlaylist({ name: p.name, url: p.url });
      applyCatalog(data);
      toast(on ? 'Removed' : `Added ${p.name}`);
    };
    row.appendChild(btn);
    box.appendChild(row);
  }
}

function srcRow(name, url, onRemove) {
  const li = document.createElement('li');
  li.innerHTML = `<span><b>${escapeHtml(name || 'Source')}</b><br><span class="src-meta">${escapeHtml(url)}</span></span>`;
  const btn = document.createElement('button');
  btn.textContent = 'Remove';
  btn.onclick = onRemove;
  li.appendChild(btn);
  return li;
}

async function removePlaylist(url) {
  toast('Removing playlist…');
  const data = await api.removePlaylist(url);
  applyCatalog(data);
}
async function removeEpg(url) {
  state.settings = await api.removeEpgUrl(url);
  renderSettings();
  toast('EPG source removed');
}

/* ---------- sync / meta ---------- */
async function refreshDataMeta() {
  const meta = await api.getDataMeta();
  const el = $('#data-meta');
  if (meta.lastSync) {
    const d = new Date(meta.lastSync);
    el.textContent = `Synced ${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  } else el.textContent = 'Not synced yet';
}

function onSyncProgress(p) {
  if (p.phase === 'download') toast(`Downloading ${p.name}… (${p.index + 1}/${p.total})`);
  else if (p.phase === 'build') toast('Rebuilding catalog…');
  else if (p.phase === 'start') toast(p.message);
  else if (p.phase === 'done') { toast('Channel data updated'); refreshDataMeta(); }
}

/* ---------- views ---------- */
function setView(view) {
  state.view = view;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#view-browse').classList.toggle('hidden', !(view === 'all' || view === 'favorites' || view === 'recent'));
  $('#view-guide').classList.toggle('hidden', view !== 'guide');
  $('#view-settings').classList.toggle('hidden', view !== 'settings');

  if (view === 'guide') renderGuide();
  else if (view === 'settings') renderSettings();
  else applyFiltersAndRender();
}

/* ---------- static events ---------- */
function wireStaticEvents() {
  $$('.nav-item').forEach((b) => { b.onclick = () => setView(b.dataset.view); });

  let searchTimer = null;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => { state.search = v; applyFiltersAndRender(); }, 180);
  });

  $('#country-search').addEventListener('input', () => renderCountryFilter());

  $('#hide-dead').addEventListener('change', (e) => {
    state.hideDead = e.target.checked;
    api.updateSettings({ autoHideDead: e.target.checked });
    applyFiltersAndRender();
  });

  $('#refresh-btn').onclick = () => api.refresh(true);

  // Infinite scroll
  const sentinel = $('#grid-sentinel');
  const io = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && state.rendered < state.filtered.length) renderMore();
  }, { root: $('#content'), rootMargin: '400px' });
  io.observe(sentinel);

  // Player buttons
  $('#pp-close').onclick = closePlayer;
  $('#pp-fav').onclick = () => state.current && toggleFav(state.current);
  $('#pp-full').onclick = () => {
    const v = $('#video');
    if (document.fullscreenElement) document.exitFullscreen();
    else v.requestFullscreen().catch(() => {});
  };
  $('#pp-pip').onclick = async () => {
    const v = $('#video');
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch { toast('Picture-in-picture not available for this stream'); }
  };

  // Settings toggles
  $('#set-healthcheck').onchange = (e) => { state.settings.healthCheck = e.target.checked; api.updateSettings({ healthCheck: e.target.checked }); };
  $('#set-autohide').onchange = (e) => { state.settings.autoHideDead = e.target.checked; $('#hide-dead').checked = e.target.checked; state.hideDead = e.target.checked; api.updateSettings({ autoHideDead: e.target.checked }); };
  $('#set-nsfw').onchange = async (e) => { toast('Rebuilding catalog…'); await api.updateSettings({ includeNsfw: e.target.checked }); };

  $('#pl-add').onclick = async () => {
    const url = $('#pl-url').value.trim();
    if (!/^https?:\/\//i.test(url)) { toast('Enter a valid http(s) URL'); return; }
    const name = $('#pl-name').value.trim();
    toast('Fetching playlist…');
    const data = await api.addPlaylist({ name, url });
    $('#pl-url').value = ''; $('#pl-name').value = '';
    applyCatalog(data);
    toast('Playlist added');
  };

  $('#epg-add').onclick = async () => {
    const url = $('#epg-url').value.trim();
    if (!/^https?:\/\//i.test(url)) { toast('Enter a valid http(s) URL'); return; }
    const name = $('#epg-name').value.trim();
    state.settings = await api.addEpgUrl({ name, url });
    $('#epg-url').value = ''; $('#epg-name').value = '';
    renderSettings();
    toast('EPG source added — loading…');
    const r = await api.loadEpg();
    $('#epg-status').textContent = `${r.programmeCount.toLocaleString()} programs, ${r.channels} channels`;
  };

  $('#epg-reload').onclick = async () => {
    toast('Reloading EPG…');
    const r = await api.loadEpg();
    $('#epg-status').textContent = `${r.programmeCount.toLocaleString()} programs, ${r.channels} channels`;
  };

  $('#epg-preset').onclick = async () => {
    toast('Adding recommended EPG — this is a large file, give it a minute…');
    state.settings = await api.addEpgUrl(EPG_PRESET);
    renderSettings();
    const r = await api.loadEpg();
    $('#epg-status').textContent = `${r.programmeCount.toLocaleString()} programs, ${r.channels} channels`;
    toast('EPG loaded');
  };

  document.addEventListener('click', (e) => {
    const ext = e.target.closest('[data-ext]');
    if (ext) { e.preventDefault(); api.openExternal(ext.dataset.ext); }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#player-pane').classList.contains('hidden') && !document.fullscreenElement) closePlayer();
  });
}

/* ---------- helpers ---------- */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2600);
}
function initials(name) {
  return (name || '?').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase() || '?';
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s).replace(/`/g, '&#96;'); }
function cssEscape(s) { return String(s).replace(/["\\]/g, '\\$&'); }
function fmtTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function timeRange(a, b) {
  return b ? `${fmtTime(a)} – ${fmtTime(b)}` : fmtTime(a);
}

init();
