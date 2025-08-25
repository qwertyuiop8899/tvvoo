/*
Build a local logos map from https://github.com/tv-logo/tv-logos
- Clones or updates the repo into .cache/tv-logos
- Walks countries/<country>/*.png
- Produces dist/logos-map.json with keys `${countryId}:${cleanName}` -> raw.githubusercontent URL

Usage:
  ts-node scripts/build-logos-map.ts
or
  npx ts-node scripts/build-logos-map.ts
*/

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache');
const REPO_DIR = path.join(CACHE_DIR, 'tv-logos');
const OUT_DIR = path.join(ROOT, 'dist');
const OUT_FILE = path.join(OUT_DIR, 'logos-map.json');

function vdbg(...args: any[]) { try { console.log('[logos]', ...args); } catch {} }

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

function cleanupNameFromFilename(fname: string): string {
  // examples: real-time-it.png -> real time ; sky-cinema-uno-it.png -> sky cinema uno
  return fname
    .replace(/\.png$/i, '')
    .replace(/-[a-z]{2}$/i, '') // trailing -it/-uk country code
    .replace(/[^a-z0-9]+/gi, ' ')
    .trim()
    .toLowerCase();
}

function main() {
  try {
    ensureRepo();
  } catch (e: any) {
    vdbg('Skipping logos build (git not available or repo fetch failed). A minimal empty logos-map will be written and updated at runtime.');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify({}, null, 2));
    vdbg('Wrote', OUT_FILE, 0, 'entries (empty)');
    return;
  }
  const countriesDir = path.join(REPO_DIR, 'countries');
  const out: Record<string, string> = {};
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

function countryAlias(dirName: string): string {
  // Map directory names to our SUPPORTED_COUNTRIES ids
  const map: Record<string, string> = {
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
  return map[dirName.toLowerCase()] || dirName.toLowerCase();
}

main();
