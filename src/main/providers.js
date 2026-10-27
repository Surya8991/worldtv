// providers.js — detects which free, ad-supported streaming service (FAST
// platform) a stream belongs to, based on the public iptv-org stream URL.
//
// These are all free-to-air / publicly available services (no login, no DRM,
// no paywall). Paywalled/DRM services (Netflix, Disney+, Prime Video, Hulu,
// SonyLIV, etc.) are deliberately NOT here and are out of scope for this app —
// there is no lawful free feed for them.

const PROVIDERS = [
  { id: 'pluto',    name: 'Pluto TV',         re: /pluto\.tv|jmp2\.uk\/plu-|\bplutotv\b/i },
  { id: 'samsung',  name: 'Samsung TV Plus',  re: /samsung(cloud)?|jmp2\.uk\/stvp?-|\bsamsungtvplus\b/i },
  { id: 'plex',     name: 'Plex',             re: /\bplex\.tv\b|jmp2\.uk\/plex-|provider-static\.plex/i },
  { id: 'rakuten',  name: 'Rakuten TV',       re: /rakuten/i },
  { id: 'xumo',     name: 'Xumo',             re: /xumo/i },
  { id: 'tubi',     name: 'Tubi',             re: /tubi/i },
  { id: 'stirr',    name: 'Stirr',            re: /stirr|jmp2\.uk\/sti-/i },
  { id: 'roku',     name: 'The Roku Channel', re: /roku|jmp2\.uk\/rok-/i },
  { id: 'lg',       name: 'LG Channels',      re: /lgchannel|lgtvcommon|jmp2\.uk\/lg-/i },
];

// Returns { id, name } of the first matching provider, or null.
function detectProvider(url) {
  if (!url) return null;
  for (const p of PROVIDERS) {
    if (p.re.test(url)) return { id: p.id, name: p.name };
  }
  return null;
}

module.exports = { PROVIDERS, detectProvider };
