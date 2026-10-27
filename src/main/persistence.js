// persistence.js — local, durable storage for user state: favorites,
// recently-watched, custom playlist URLs, EPG URLs, and app settings.
// Backed by electron-store (a small JSON file in userData). Nothing here leaves
// the machine.

const Store = require('electron-store');

const RECENT_LIMIT = 24;

const schema = {
  favorites: { type: 'array', default: [] },        // array of channel ids
  recent: { type: 'array', default: [] },           // array of { id, at }
  settings: {
    type: 'object',
    default: {
      includeNsfw: false,
      autoHideDead: true,
      healthCheck: true,
      customPlaylists: [],   // array of { name, url }
      epgUrls: [],           // array of { name, url }
    },
  },
};

class Persistence {
  constructor() {
    this.store = new Store({ name: 'worldtv-user', schema, clearInvalidConfig: true });
  }

  getFavorites() {
    return this.store.get('favorites', []);
  }

  toggleFavorite(id) {
    const favs = new Set(this.store.get('favorites', []));
    if (favs.has(id)) favs.delete(id);
    else favs.add(id);
    const arr = [...favs];
    this.store.set('favorites', arr);
    return arr;
  }

  isFavorite(id) {
    return this.getFavorites().includes(id);
  }

  getRecent() {
    return this.store.get('recent', []);
  }

  pushRecent(id) {
    let recent = this.store.get('recent', []).filter((r) => r.id !== id);
    recent.unshift({ id, at: Date.now() });
    if (recent.length > RECENT_LIMIT) recent = recent.slice(0, RECENT_LIMIT);
    this.store.set('recent', recent);
    return recent;
  }

  clearRecent() {
    this.store.set('recent', []);
    return [];
  }

  getSettings() {
    return this.store.get('settings');
  }

  updateSettings(patch) {
    const current = this.store.get('settings');
    const next = { ...current, ...patch };
    this.store.set('settings', next);
    return next;
  }
}

module.exports = { Persistence, RECENT_LIMIT };
