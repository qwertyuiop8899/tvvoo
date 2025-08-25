"use strict";
// Lightweight name -> tvg-id mappings and normalizer
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeChannelName = normalizeChannelName;
exports.buildNameToIdMap = buildNameToIdMap;
function normalizeChannelName(raw) {
    if (!raw)
        return '';
    return raw
        .toLowerCase()
        // drop trailing .c/.s/.b etc
        .replace(/\s*(\.[a-z0-9]{1,3})+$/i, '')
        // unify separators
        .replace(/[^a-z0-9]+/g, ' ')
        // remove generic suffixes
        .replace(/\b(hd|uhd|4k|tv|channel|plus)\b/g, ' ')
        .replace(/\bsports\b/g, 'sport')
        .replace(/\s+/g, ' ')
        .trim();
}
// Base map: put hand-curated tricky cases here (can be extended at runtime)
const STATIC_MAP = {
    // Examples for SKY ARTE (1)/(2) mapping to the same tvg-id or distinct if known
    'sky arte 1': 'SkyArte.it',
    'sky arte 2': 'SkyArte.it',
    'real time 1': 'RealTime.it',
    'real time 2': 'RealTime.it',
};
function buildNameToIdMap(ext) {
    return { ...STATIC_MAP, ...(ext || {}) };
}
