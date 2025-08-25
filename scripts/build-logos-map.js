/*
Plain JS build of logos map to avoid ts-node/git's presence during build.
- If git is unavailable, writes an empty dist/logos-map.json and exits gracefully.
*/

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const REPO_DIR = path.join(CACHE_DIR, 'tv-logos');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'logos-map.json');

function vdbg() { try { console.log('[logos]', ...arguments); } catch (_) {} }

function ensureRepo() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!fs.existsSync(REPO_DIR)) {
    vdbg('Cloning tv-logos…');
    execSync('git clone --depth=1 https://github.com/tv-logo/tv-logos.git', { cwd: CACHE_DIR, stdio: 'inherit' });
  } else {
    vdbg('Updating tv-logos…');
    execSync('git fetch --depth=1 origin', { cwd: REPO_DIR, stdio: 'inherit' });
    execSync('git reset --hard origin/main', { cwd: REPO_DIR, stdio: 'inherit' });
  }
}

function cleanupNameFromFilename(fname) {
  return fname
    .replace(/\.png$/i, '')
    .replace(/-[a-z]{2}$/i, '')
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function countryAlias(dirName) {
  const map = {
    italy: 'it',
    france: 'fr',
    germany: 'de',
    spain: 'es',
    portugal: 'pt',
    netherlands: 'nl',
    albania: 'al',
    turkey: 'tr',
    'united-kingdom': 'uk',
    arabic: 'ar',
    balkans: 'bk',
    russia: 'ru',
    romania: 'ro',
    poland: 'pl',
    bulgaria: 'bg',
  };
  return (map[dirName.toLowerCase()] || dirName.toLowerCase());
}

function main() {
  try {
    ensureRepo();
  } catch (e) {
    vdbg('Skipping logos build (git not available). Writing empty map.');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify({}, null, 2));
    vdbg('Wrote', OUT_FILE, 0, 'entries (empty)');
    return;
  }
  const countriesDir = path.join(REPO_DIR, 'countries');
  const out = {};
  const countries = fs.readdirSync(countriesDir).filter(f => fs.statSync(path.join(countriesDir, f)).isDirectory());
  for (const c of countries) {
    const dir = path.join(countriesDir, c);
    const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.png'));
    for (const f of files) {
      const cleanName = cleanupNameFromFilename(f);
      const key = `${countryAlias(c)}:${cleanName}`;
      const rawUrl = `https://raw.githubusercontent.com/tv-logo/tv-logos/main/countries/${encodeURIComponent(c)}/${encodeURIComponent(f)}`;
      out[key] = rawUrl;
    }
    vdbg('processed', c, files.length);
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  vdbg('Wrote', OUT_FILE, Object.keys(out).length, 'entries');
}

main();
