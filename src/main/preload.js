// preload.js — the only bridge between the sandboxed renderer and the main
// process. contextIsolation is ON and nodeIntegration is OFF, so the renderer
// can only touch what we expose here on window.worldtv.

const { contextBridge, ipcRenderer } = require('electron');

function sub(channel) {
  return (cb) => {
    const listener = (_evt, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('worldtv', {
  // Catalog / data
  getCatalog: () => ipcRenderer.invoke('catalog:get'),
  refresh: (force) => ipcRenderer.invoke('catalog:refresh', { force: !!force }),
  getStreams: (id) => ipcRenderer.invoke('catalog:streams', id),
  getDataMeta: () => ipcRenderer.invoke('data:meta'),

  // User state
  getFavorites: () => ipcRenderer.invoke('fav:get'),
  toggleFavorite: (id) => ipcRenderer.invoke('fav:toggle', id),
  getRecent: () => ipcRenderer.invoke('recent:get'),
  pushRecent: (id) => ipcRenderer.invoke('recent:push', id),
  clearRecent: () => ipcRenderer.invoke('recent:clear'),

  // Settings + custom playlists
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  addPlaylist: (entry) => ipcRenderer.invoke('playlist:add', entry),
  removePlaylist: (url) => ipcRenderer.invoke('playlist:remove', url),
  addEpgUrl: (entry) => ipcRenderer.invoke('epg:add', entry),
  removeEpgUrl: (url) => ipcRenderer.invoke('epg:remove', url),

  // Health
  requestHealth: (ids) => ipcRenderer.invoke('health:check', ids),
  getHealth: (ids) => ipcRenderer.invoke('health:get', ids),

  // EPG
  loadEpg: () => ipcRenderer.invoke('epg:load'),
  epgStatus: () => ipcRenderer.invoke('epg:status'),
  nowNext: (id) => ipcRenderer.invoke('epg:nownext', id),
  guide: (id, from, to) => ipcRenderer.invoke('epg:guide', { id, from, to }),

  // Backup
  exportData: () => ipcRenderer.invoke('data:export'),
  importData: () => ipcRenderer.invoke('data:import'),

  // Misc
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  // Events (main -> renderer)
  onSyncProgress: sub('sync:progress'),
  onCatalogReady: sub('catalog:ready'),
  onHealthResult: sub('health:result'),
  onEpgLoaded: sub('epg:loaded'),
});
