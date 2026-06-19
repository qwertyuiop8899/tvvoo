const fetch = require('node-fetch');
const fs = require('fs');

async function prebuild() {
  console.log('Prebuild: fetching M3U...');
  const resp = await fetch('https://raw.githubusercontent.com/piholo/logo/main/lista.m3u', { timeout: 15000 });
  if (!resp.ok) throw new Error('M3U fetch failed: ' + resp.status);
  const text = await resp.text();
  const lines = text.split(/\r?\n/);
  const logos = {}, cats = {}, portrait = {}, landscape = {};

  const cleanup = n => n
    .replace(/\s*(\.[a-z0-9]{1,3})+$/i, '')
    .replace(/\s*\((?:\d+|[A-Za-z]{1,3})\)\s*$/i, '')
    .trim();

  for (const line of lines) {
    if (!line.startsWith('#EXTINF')) continue;
    const logo  = (line.match(/tvg-logo="([^"]+)"/) || [])[1];
    const cp    = (line.match(/tvg-cover-portrait="([^"]+)"/) || [])[1];
    const cl    = (line.match(/tvg-cover-landscape="([^"]+)"/) || [])[1];
    const group = (line.match(/group-title="([^"]+)"/) || [])[1];
    const comma = line.indexOf(',');
    const raw   = comma >= 0 ? line.slice(comma + 1).trim() : '';
    const clean = cleanup(raw).toLowerCase();
    if (!clean) continue;
    const k = 'it:' + clean;
    if (logo  && !logos[k])     logos[k]     = logo;
    if (cp    && !portrait[k])  portrait[k]  = cp;
    if (cl    && !landscape[k]) landscape[k] = cl;
    if (group && !cats[k])      cats[k]      = group;
  }

  fs.writeFileSync('dist/logos-map.json',           JSON.stringify(logos,    null, 2));
  fs.writeFileSync('dist/categories-map.json',      JSON.stringify(cats,     null, 2));
  fs.writeFileSync('dist/cover-portrait-map.json',  JSON.stringify(portrait, null, 2));
  fs.writeFileSync('dist/cover-landscape-map.json', JSON.stringify(landscape,null, 2));

  console.log('Prebuild done — logos=' + Object.keys(logos).length + ' cats=' + Object.keys(cats).length);
}

prebuild().catch(e => { console.error('Prebuild FAILED:', e.message); process.exit(1); });
