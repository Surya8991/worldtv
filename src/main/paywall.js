// paywall.js — flags channels that are really paid / subscription (pay-TV)
// services. These sometimes appear in community IPTV playlists as unauthorized
// restreams; WorldTV does NOT try to play around their paywall — it just labels
// them clearly so the user knows a subscription is required and the free stream
// is unlikely to work. Detection is name-based (best-effort), grouped by the
// official service so the UI can tell the user where to watch legally.

const GROUPS = [
  {
    service: 'SonyLIV',
    re: /\bsony\b|sonyliv|\bsony\s?(liv|max|pix|sab|ten|sports|yay|aath|wah|bbc|marathi)\b|\bset\s?hd\b/i,
  },
  {
    service: 'Disney+ Hotstar',
    re: /\bstar\s?(plus|bharat|gold|sports|world|movies|jalsha|vijay|maa|pravah|utsav)\b|hotstar|disney\+?\s?hotstar|\bhungama\b|\banimax\b/i,
  },
  {
    service: 'ZEE5',
    re: /\bzee\b|zee5|&\s?tv|&\s?pictures|&\s?flix|&\s?prive|\bziving\b/i,
  },
  {
    service: 'JioCinema / Voot',
    re: /\bcolors\b|\bvoot\b|jiocinema|\bnick(elodeon)?\b|comedy central|\bmtv\b/i,
  },
  {
    service: 'their official app',
    re: /\bhbo\b|hbo\s?max|\bmax\b(?!\s?tv)|showtime|\bstarz\b|cinemax|netflix|disney\+|prime video|\bhulu\b|peacock|paramount\+|apple tv\+|discovery\+/i,
  },
  {
    service: 'a sports subscription',
    re: /sky\s?sports|bt\s?sport|bein\s?sports?|\bdazn\b|espn\+|\bwillow\b|\bfancode\b|\btten\s?\d|premier sports|optus sport/i,
  },
];

// Returns { service } if the channel name looks like a paid service, else null.
function detectPaywall(name) {
  if (!name) return null;
  for (const g of GROUPS) {
    if (g.re.test(name)) return { service: g.service };
  }
  return null;
}

module.exports = { detectPaywall, GROUPS };
