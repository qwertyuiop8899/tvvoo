/*
  Split src/channels/lists.json into dist/channels/by-country/<cid>.json
  Keeps only non-Italy entries. Designed to reduce runtime memory/IO.
*/
const fs = require('fs');
const path = require('path');

function countryNameToId(n) {
  const map = {
    italy: 'it', italia: 'it', it: 'it',
    france: 'fr', fr: 'fr',
    germany: 'de', de: 'de',
    spain: 'es', es: 'es',
    portugal: 'pt', pt: 'pt',
    netherlands: 'nl', nederland: 'nl', nl: 'nl',
    albania: 'al', al: 'al',
    turkey: 'tr', türkiye: 'tr', tr: 'tr',
    'united kingdom': 'uk', uk: 'uk', england: 'uk', 'great britain': 'uk',
    arabia: 'ar', arabic: 'ar', 'saudi arabia': 'ar',
    balkans: 'bk',
    russia: 'ru', ru: 'ru',
    romania: 'ro', ro: 'ro',
    poland: 'pl', pl: 'pl',
    bulgaria: 'bg', bg: 'bg',
  };
  const key = (n || '').trim().toLowerCase();
  return map[key] || null;
}

function main() {
  const src = path.resolve(__dirname, '..', 'src', 'channels', 'lists.json');
  if (!fs.existsSync(src)) {
    console.warn('[split-lists] No src/channels/lists.json found, skipping.');
    return;
  }
  const outDir = path.resolve(__dirname, '..', 'dist', 'channels', 'by-country');
  fs.mkdirSync(outDir, { recursive: true });
  const raw = fs.readFileSync(src, 'utf8');
  let arr;
  try {
    arr = JSON.parse(raw);
  } catch (e) {
    console.error('[split-lists] Failed to parse lists.json:', e && e.message ? e.message : e);
    process.exitCode = 1;
    return;
  }
  if (!Array.isArray(arr)) {
    console.error('[split-lists] lists.json is not an array.');
    process.exitCode = 1;
    return;
  }
  const buckets = {};
  for (const e of arr) {
    const cid = countryNameToId(e && e.country);
    if (!cid || cid === 'it') continue; // skip Italy here
    (buckets[cid] ||= []).push({
      name: e && e.name || 'Unknown',
      country: e && e.country || '',
      logo: e && Object.prototype.hasOwnProperty.call(e, 'logo') ? e.logo : null,
      category: e && Object.prototype.hasOwnProperty.call(e, 'category') ? e.category : null,
    });
  }
  const ids = Object.keys(buckets).sort();
  for (const id of ids) {
    const file = path.join(outDir, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(buckets[id], null, 0), 'utf8');
    console.log('[split-lists] wrote', file, buckets[id].length);
  }
}

main();
