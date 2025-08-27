// TypeScript may not have types for stremio-addon-sdk in this workspace; use minimal typing.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { addonBuilder, Manifest, Stream, getRouter } from 'stremio-addon-sdk';
/// <reference types="node" />
import express, { Request, Response, NextFunction } from 'express';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import cron from 'node-cron';
// EPG support (can be disabled via env)
import { EPGService } from './epg/service';
import { normalizeChannelName } from './epg/nameMap';

// Hardening: log and survive unexpected errors
process.on('uncaughtException', (err: unknown) => { try { console.error('[VAVOO] uncaughtException', err); } catch {} });
process.on('unhandledRejection', (reason: unknown) => { try { console.error('[VAVOO] unhandledRejection', reason); } catch {} });

// Minimal config: countries supported and mapping to Vavoo group filters
const SUPPORTED_COUNTRIES = [
  { id: 'it', name: 'Italia', group: 'Italy' },
  { id: 'uk', name: 'United Kingdom', group: 'United Kingdom' },
  { id: 'fr', name: 'France', group: 'France' },
  { id: 'de', name: 'Germany', group: 'Germany' },
  { id: 'pt', name: 'Portugal', group: 'Portugal' },
  { id: 'es', name: 'Spain', group: 'Spain' },
  { id: 'al', name: 'Albania', group: 'Albania' },
  { id: 'tr', name: 'Turkey', group: 'Turkey' },
  { id: 'nl', name: 'Nederland', group: 'Nederland' },
  { id: 'ar', name: 'Arabia', group: 'Arabia' },
  { id: 'bk', name: 'Balkans', group: 'Balkans' },
  { id: 'ru', name: 'Russia', group: 'Russia' },
  { id: 'ro', name: 'Romania', group: 'Romania' },
  { id: 'pl', name: 'Poland', group: 'Poland' },
  { id: 'bg', name: 'Bulgaria', group: 'Bulgaria' },
];

const DEFAULT_VAVOO_UA = 'Mozilla/5.0 (Linux; Android 13; Pixel Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36';
// Absolute fallback artwork used across poster/logo/background to avoid relative paths not supported by clients
const TVVOO_FALLBACK_ABS = 'https://raw.githubusercontent.com/qwertyuiop8899/tvvoo/refs/heads/main/public/tvvoo.png';

// Behavior flags (config via env)
const VAVOO_SET_IPLOCATION_ONLY = (process.env.VAVOO_SET_IPLOCATION_ONLY || '').toLowerCase() === 'true' || process.env.VAVOO_SET_IPLOCATION_ONLY === '1';
const VAVOO_LOG_SIG_FULL = (process.env.VAVOO_LOG_SIG_FULL || '').toLowerCase() === 'true' || process.env.VAVOO_LOG_SIG_FULL === '1';
const VAVOO_DISABLE_EPG = (process.env.VAVOO_DISABLE_EPG || process.env.EPG_DISABLED || '').toLowerCase() === 'true' || process.env.VAVOO_DISABLE_EPG === '1' || process.env.EPG_DISABLED === '1';
const VAVOO_REFRESH_WHITELIST: Set<string> | null = (() => {
  const raw = process.env.VAVOO_REFRESH_COUNTRIES || '';
  if (!raw.trim()) return null;
  const ids = raw.split(',').map((s: string) => s.trim()).filter(Boolean);
  if (!ids.length) return null;
  return new Set(ids);
})();
// Default OFF to avoid memory spikes; can be enabled via env when desired
const DO_BOOT_REFRESH = (process.env.VAVOO_BOOT_REFRESH || '0') !== '0';
const DO_SCHEDULE_REFRESH = (process.env.VAVOO_SCHEDULE_REFRESH || '0') !== '0';

function vdbg(...args: any[]) { if (process.env.VAVOO_DEBUG !== '0') { try { console.log('[VAVOO]', ...args); } catch {} } }

// Optional logos map loaded from disk: key `${countryId}:${cleanName.toLowerCase()}` -> logo URL
const LOGOS_FILE = path.join(__dirname, 'logos-map.json');
let logosMap: Record<string, string> = {};
function readLogosFromDisk(): Record<string, string> {
  try {
    const raw = fs.readFileSync(LOGOS_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return j as Record<string, string>;
  } catch {}
  return {};
}

// Optional categories map persisted on disk: key `${countryId}:${cleanName.toLowerCase()}` -> category from M3U group-title
const CATEGORIES_FILE = path.join(__dirname, 'categories-map.json');
let categoriesMap: Record<string, string> = {};
function readCategoriesFromDisk(): Record<string, string> {
  try {
    const raw = fs.readFileSync(CATEGORIES_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return j as Record<string, string>;
  } catch {}
  return {};
}

function cleanupChannelName(name: string): string {
  if (!name) return 'Unknown';
  // Remove one or more trailing dot-codes like ".c", ".s", ".b", optionally stacked (e.g., " .c .s") and trim
  // Examples: "Channel .c" -> "Channel", "Channel .s .b" -> "Channel", "Channel.s" -> "Channel"
  return name.replace(/\s*(\.[a-z0-9]{1,3})+$/i, '').trim();
}

function normalizeName(s: string): string {
  return (s || '')
    .toLowerCase()
  .replace(/\bhd\b|\buhd\b|\b4k\b|\btv\b|\bchannel\b|\bplus\b/g, ' ')
  .replace(/\bsports\b/g, 'sport')
  .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function bigrams(s: string): string[] {
  const t = normalizeName(s);
  if (t.length < 2) return [t];
  const grams: string[] = [];
  for (let i = 0; i < t.length - 1; i++) grams.push(t.slice(i, i + 2));
  return grams;
}

function diceSimilarity(a: string, b: string): number {
  const A = bigrams(a), B = bigrams(b);
  if (!A.length && !B.length) return 1;
  if (!A.length || !B.length) return 0;
  const setB = new Map<string, number>();
  for (const g of B) setB.set(g, (setB.get(g) || 0) + 1);
  let inter = 0;
  for (const g of A) {
    const c = setB.get(g) || 0;
    if (c > 0) { inter++; setB.set(g, c - 1); }
  }
  return (2 * inter) / (A.length + B.length);
}

function findBestLogo(countryId: string, baseName: string): string | undefined {
  const exact = logosMap[`${countryId}:${baseName.toLowerCase()}`];
  if (exact) return exact;
  const target = baseName;
  let bestUrl: string | undefined;
  let best = 0;
  const prefix = `${countryId}:`;
  for (const key of Object.keys(logosMap)) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    const score = diceSimilarity(target, name);
    if (score > best) { best = score; bestUrl = logosMap[key]; }
  }
  return best >= 0.85 ? bestUrl : undefined;
}

function findBestLogoAny(baseName: string): string | undefined {
  const target = baseName;
  let bestUrl: string | undefined;
  let best = 0;
  for (const [key, url] of Object.entries(logosMap)) {
    const name = key.split(':')[1] || '';
    const score = diceSimilarity(target, name);
    if (score > best) { best = score; bestUrl = url; }
  }
  return best >= 0.85 ? bestUrl : undefined;
}

function categoriesOptionsForCountry(countryId: string): string[] {
  // Italy uses categoriesMap (from M3U), others will use static list (loaded later)
  try {
    if (countryId === 'it') {
      const prefix = `${countryId}:`;
      const set = new Set<string>();
      for (const [key, val] of Object.entries(categoriesMap)) {
        if (!key.startsWith(prefix)) continue;
        if (typeof val === 'string' && val.trim()) set.add(val.trim());
      }
      const list = Array.from(set).filter(v => !isBannedCategory(v));
      const sorted = list.sort((a, b) => a.localeCompare(b, 'it', { sensitivity: 'base' }));
      return ['Tutti', ...sorted];
    }
  // Non-Italy: build from static list
  const opts = categoriesOptionsFromStatic(countryId);
  if (opts && opts.length) return opts;
  } catch {}
  // For non-Italy we'll compute from static list at request time in manifest handlers
  return ['Tutti'];
}

function normCatStr(s?: string): string {
  return (s || '').trim().toLowerCase();
}

// Categories to always hide from filters and meta genres
const BANNED_CATEGORIES = new Set(['pluto tv italia', 'eventi live']);
function isBannedCategory(s?: string): boolean {
  return BANNED_CATEGORIES.has(normCatStr(s));
}

// Static channels list for non-Italy (logos & categories)
type StaticEntry = { name: string; country: string; logo?: string | null; category?: string | null };
let staticByCountry: Record<string, StaticEntry[]> = {};
// Lazy shard path helpers for dist builds
function shardPathCandidates(cid: string): string[] {
  return [
    // Runtime dist path
    path.join(__dirname, 'channels', 'by-country', `${cid}.json`),
    // Fallbacks that may help in dev
    path.resolve(__dirname, '../channels/by-country', `${cid}.json`),
    path.resolve(__dirname, '../src/channels/by-country', `${cid}.json`),
  ];
}

// Cache resolved hints per country and baseName to avoid repeated fuzzy matching
type ResolvedHint = { logo?: string; cat?: string };
const resolvedHints: Record<string, Record<string, ResolvedHint>> = {};
function getResolvedHint(countryId: string, baseName: string): ResolvedHint {
  const key = baseName.toLowerCase();
  let bucket = resolvedHints[countryId];
  if (!bucket) {
    bucket = readHints(countryId);
    resolvedHints[countryId] = bucket;
  }
  if (bucket[key]) return bucket[key];
  let logo: string | undefined;
  let cat: string | undefined;
  if (countryId === 'it') {
    logo = findBestLogo(countryId, baseName);
    cat = findBestCategory(countryId, baseName);
  } else {
    logo = findStaticLogo(countryId, baseName);
    cat = findStaticCategory(countryId, baseName);
  }
  const h = { logo, cat } as ResolvedHint;
  bucket[key] = h;
  // write-through persist (best-effort)
  try { writeHints(countryId, bucket); } catch {}
  return h;
}
function loadShardForCountry(cid: string): void {
  try {
    if (!cid || cid === 'it') return;
    if (staticByCountry[cid] && staticByCountry[cid].length) return;
    for (const p of shardPathCandidates(cid)) {
      try {
        if (fs.existsSync(p)) {
          const raw = fs.readFileSync(p, 'utf8');
          const arr = JSON.parse(raw);
          if (Array.isArray(arr)) {
            staticByCountry[cid] = arr as StaticEntry[];
            vdbg('Shard loaded', { cid, path: p, count: (arr as any[]).length });
            return;
          }
        }
      } catch {}
    }
  } catch {}
}
function countryNameToId(n: string): string | null {
  const map: Record<string, string> = {
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
function loadStaticChannels() {
  try {
    const candidates = [
      path.join(__dirname, 'channels', 'lists.json'),
      path.resolve(__dirname, '../src/channels/lists.json'),
    ];
    let raw: string | null = null;
    for (const p of candidates) { try { if (fs.existsSync(p)) { raw = fs.readFileSync(p, 'utf8'); break; } } catch {} }
    if (!raw) { staticByCountry = {}; return; }
    const arr = JSON.parse(raw) as StaticEntry[];
    const by: Record<string, StaticEntry[]> = {};
    for (const e of arr) {
      const cid = countryNameToId(e.country);
      if (!cid || cid === 'it') continue;
      (by[cid] ||= []).push(e);
    }
    staticByCountry = by;
    vdbg('Static channels loaded:', Object.keys(staticByCountry));
  } catch { staticByCountry = {}; }
}
function findStaticBest(countryId: string, baseName: string): StaticEntry | null {
  if (!staticByCountry[countryId] || !staticByCountry[countryId].length) loadShardForCountry(countryId);
  const list = staticByCountry[countryId] || [];
  if (!list.length) return null;
  let best = 0; let bestIdx = -1;
  for (let i = 0; i < list.length; i++) {
    const score = diceSimilarity(baseName, list[i].name || '');
    if (score > best) { best = score; bestIdx = i; }
  }
  return best >= 0.85 && bestIdx >= 0 ? list[bestIdx] : null;
}
function findStaticLogo(countryId: string, baseName: string): string | undefined {
  const e = findStaticBest(countryId, baseName);
  return (e?.logo || undefined) || undefined;
}
function findStaticCategory(countryId: string, baseName: string): string | undefined {
  const e = findStaticBest(countryId, baseName);
  const cat = (e?.category || undefined) || undefined;
  return cat ? cat : undefined;
}

function categoriesOptionsFromStatic(countryId: string): string[] {
  try {
  if (!staticByCountry[countryId] || !staticByCountry[countryId].length) loadShardForCountry(countryId);
  const arr = staticByCountry[countryId] || [];
    if (!arr.length) return ['Tutti'];
    const set = new Set<string>();
    for (const e of arr) {
      const c = (e?.category || '').toString().trim();
      if (!c) continue;
      if (isBannedCategory(c)) continue;
      set.add(c);
    }
    const list = Array.from(set);
    const sorted = list.sort((a, b) => a.localeCompare(b, 'it', { sensitivity: 'base' }));
    return ['Tutti', ...sorted];
  } catch {
    return ['Tutti'];
  }
}

function findBestCategory(countryId: string, baseName: string): string | undefined {
  const exact = categoriesMap[`${countryId}:${baseName.toLowerCase()}`];
  if (exact) return exact;
  const target = baseName;
  let bestCat: string | undefined;
  let best = 0;
  const prefix = `${countryId}:`;
  for (const key of Object.keys(categoriesMap)) {
    if (!key.startsWith(prefix)) continue;
    const name = key.slice(prefix.length);
    const score = diceSimilarity(target, name);
    if (score > best) { best = score; bestCat = categoriesMap[key]; }
  }
  return best >= 0.85 ? bestCat : undefined;
}

function maskSig(s: string): string {
  if (!s) return '';
  if (s.length <= 16) return s.replace(/.(?=.{4}$)/g, '*');
  return `${s.slice(0, 8)}${'*'.repeat(Math.max(0, s.length - 16))}${s.slice(-8)}`;
}

// Toggle to include stream headers: default OFF
function shouldIncludeStreamHeaders(req: any): boolean {
  try {
    // Query override: ?hdr=1 to enable, ?hdr=0 to disable
    const q = (req?.query || {}) as Record<string, any>;
    const qv = typeof q.hdr === 'string' ? q.hdr.toLowerCase() : undefined;
    if (qv === '1' || qv === 'true') return true;
    if (qv === '0' || qv === 'false') return false;
    // Path-based config: /cfg-...-hdr1/... enables headers
    const url = String(req?.originalUrl || req?.url || '');
    const m = url.match(/\/cfg-([^/]+)/i);
    const cfg = m?.[1] || '';
    if (cfg.toLowerCase().split('-').includes('hdr1')) return true;
  } catch {}
  return false; // default OFF
}

// Simple on-disk cache for daily catalogs (persist across restarts while container is alive)
type CatalogCache = { updatedAt: number; countries: Record<string, any[]> };
const CACHE_FILE = path.join(__dirname, 'vavoo_catalog_cache.json');
let currentCache: CatalogCache = { updatedAt: 0, countries: {} };

function readCacheFromDisk(): CatalogCache {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && j.countries) return j as CatalogCache;
  } catch {}
  return { updatedAt: 0, countries: {} };
}

function writeCacheToDisk(cache: CatalogCache) {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8'); } catch (e) { console.error('Cache write error:', e); }
}

// On-demand per-country disk cache (keeps memory small and avoids loading all countries)
const CAT_CACHE_DIR = path.join(__dirname, 'cache', 'catalog');
type CountryCatalogFile = { updatedAt: number; items: any[] };
function ensureDir(p: string) {
  try { fs.mkdirSync(p, { recursive: true }); } catch {}
}
function readCountryCatalogFromDisk(cid: string): CountryCatalogFile | null {
  try {
    const file = path.join(CAT_CACHE_DIR, `${cid}.json`);
    if (!fs.existsSync(file)) return null;
    const raw = fs.readFileSync(file, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && Array.isArray(j.items)) return j as CountryCatalogFile;
  } catch {}
  return null;
}
function writeCountryCatalogToDisk(cid: string, data: CountryCatalogFile) {
  try {
    ensureDir(CAT_CACHE_DIR);
    const file = path.join(CAT_CACHE_DIR, `${cid}.json`);
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) { console.error('Country cache write error:', cid, e); }
}

// Persisted resolved hints (logos/categories) per country
const HINTS_DIR = path.join(__dirname, 'cache', 'hints');
function readHints(cid: string): Record<string, ResolvedHint> {
  try {
    const f = path.join(HINTS_DIR, `${cid}.json`);
    if (!fs.existsSync(f)) return {};
    const raw = fs.readFileSync(f, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object') return j as Record<string, ResolvedHint>;
  } catch {}
  return {};
}
function writeHints(cid: string, data: Record<string, ResolvedHint>) {
  try { ensureDir(HINTS_DIR); fs.writeFileSync(path.join(HINTS_DIR, `${cid}.json`), JSON.stringify(data), 'utf8'); } catch {}
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000; // reserved (no TTL enforced for disk cache now)
let lastM3UUpdate = 0;
// Deduplicate concurrent fetches for the same country
const inflightCatalogFetch: Record<string, Promise<any[]>> = {};
// Global concurrency guard to avoid spikes if many different countries are requested at once
const MAX_CATALOG_FETCHES = Math.max(1, Number(process.env.VAVOO_MAX_FETCH || 3) || 3);
let activeCatalogFetches = 0;
const fetchWaiters: Array<() => void> = [];
async function withCatalogFetchSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeCatalogFetches >= MAX_CATALOG_FETCHES) {
    await new Promise<void>(resolve => fetchWaiters.push(resolve));
  }
  activeCatalogFetches++;
  try {
    return await fn();
  } finally {
    activeCatalogFetches--;
    const next = fetchWaiters.shift();
    if (next) { try { next(); } catch {} }
  }
}
async function getOrFetchCountryCatalog(cid: string): Promise<any[]> {
  try {
    // 1) In-memory
    const mem = currentCache.countries[cid];
    if (mem && mem.length) return mem;
    // 2) Disk cache (permanent until restart; no TTL)
    const disk = readCountryCatalogFromDisk(cid);
    if (disk && Array.isArray(disk.items)) {
      currentCache.countries[cid] = disk.items;
      return disk.items;
    }
    // 2.5) If a fetch is already in-flight, await it
  if (Object.prototype.hasOwnProperty.call(inflightCatalogFetch, cid)) {
      try { return await inflightCatalogFetch[cid]; } catch { /* fall-through */ }
    }
    // 3) Fetch on demand
    const c = SUPPORTED_COUNTRIES.find(x => x.id === cid);
    if (!c) return [];
    const sig = await getVavooSignature(null);
    if (!sig) return [];
    vdbg('CATALOG FETCH start', { cid });
    inflightCatalogFetch[cid] = withCatalogFetchSlot(async () => {
      const groupCandidates = [c.group, ...(c.id === 'nl' ? ['Netherlands', 'Holland'] : [])];
      let items: any[] = [];
      for (const g of groupCandidates) {
        try {
          items = await vavooCatalog(g, sig);
          if (items && items.length) break;
        } catch {}
      }
      if (!items || !items.length) {
        try { items = await vavooCatalog(c.group, sig); } catch {}
      }
      const slim = (items || []).map((it: any) => ({
        name: cleanupChannelName(String(it?.name || 'Unknown')),
        url: String((it && (it.url || it.play || it.href || it.link)) || ''),
        poster: it?.poster || it?.image || undefined,
        description: undefined,
      }));
      currentCache.countries[cid] = slim;
      writeCountryCatalogToDisk(cid, { updatedAt: Date.now(), items: slim });
      // Italy: refresh logos/categories from M3U occasionally
      if (cid === 'it' && Date.now() - lastM3UUpdate > 6 * 60 * 60 * 1000) {
        try { await updateLogosFromM3U(); lastM3UUpdate = Date.now(); } catch {}
      }
      vdbg('CATALOG FETCH done', { cid, count: slim.length });
      return slim;
  });
    try {
      return await inflightCatalogFetch[cid];
    } finally {
      delete inflightCatalogFetch[cid];
    }
  } catch {
    return [];
  }
}

function getClientIpFromReq(req: any): string | null {
  try {
    const headers = (req?.headers || {}) as Record<string, string | string[]>;
    const asStr = (v?: string | string[]) => Array.isArray(v) ? v[0] : (v || '');
    const normalize = (raw: string) => {
      if (!raw) return '';
      let ip = raw.trim();
      // Remove surrounding brackets for IPv6 [::1]
      if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
      // Strip port (both IPv4:port and [IPv6]:port and IPv6:port without brackets)
      if (/^\[.*\]:\d+$/.test(raw)) {
        ip = raw.replace(/^\[(.*)\]:\d+$/, '$1');
      } else if (/^.*:\d+$/.test(raw) && ip.indexOf(':') === ip.lastIndexOf(':')) {
        // Only one colon -> IPv4:port
        ip = ip.replace(/:(\d+)$/, '');
      }
      // IPv4-mapped IPv6 ::ffff:1.2.3.4
      const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)/i);
      if (mapped) ip = mapped[1];
      return ip;
    };
    const isPrivateV4 = (ip: string) => {
      const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
      if (!m) return false;
      const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
      if (a === 10 || a === 127) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      return false;
    };
    const isPrivate = (ip: string) => {
      if (!ip) return true;
      if (ip.includes('.')) return isPrivateV4(ip);
      // IPv6 private ranges: ::1/128, fc00::/7 (unique local), fe80::/10 (link-local)
      const low = ip.toLowerCase();
      if (low === '::1') return true;
      if (low.startsWith('fc') || low.startsWith('fd')) return true; // fc00::/7
      if (low.startsWith('fe80:')) return true; // link-local
      return false;
    };
    const pickFirstPublic = (candidates: string[]): string | null => {
      for (const raw of candidates) {
        const ip = normalize(raw);
        if (ip && !isPrivate(ip)) return ip;
      }
      // fallback to first non-empty normalized
      for (const raw of candidates) {
        const ip = normalize(raw);
        if (ip) return ip;
      }
      return null;
    };

    // 1) Proxy headers (prefer original client)
    const xff = asStr(headers['x-forwarded-for']);
    if (xff) {
      const list = xff.split(',').map(s => s.trim()).filter(Boolean);
      const got = pickFirstPublic(list);
      if (got) return got;
    }
    const directHeaders = [
      'cf-connecting-ip',
      'true-client-ip',
      'x-real-ip',
      'x-client-ip',
      'fly-client-ip',
      'fastly-client-ip',
      'x-forwarded',
      'forwarded'
    ];
    for (const h of directHeaders) {
      const val = asStr((headers as any)[h]);
      if (val) {
        const ip = normalize(val);
        if (ip) return ip;
      }
    }

    // 2) Express-provided ip when trust proxy is enabled
    const expIp = normalize(String((req as any)?.ip || ''));
    if (expIp) return expIp;

    // 3) Socket addresses
    const ra = normalize(String((req?.socket as any)?.remoteAddress || (req?.connection as any)?.remoteAddress || ''));
    if (ra) return ra;

    return null;
  } catch {
    return null;
  }
}

async function getVavooSignature(clientIp: string | null) {
  const body: any = {
    token: 'tosFwQCJMS8qrW_AjLoHPQ41646J5dRNha6ZWHnijoYQQQoADQoXYSo7ki7O5-CsgN4CH0uRk6EEoJ0728ar9scCRQW3ZkbfrPfeCXW2VgopSW2FWDqPOoVYIuVPAOnXCZ5g',
    reason: 'app-blur', locale: 'de', theme: 'dark',
    metadata: { device: { type: 'Handset', brand: 'google', model: 'Pixel', name: 'sdk_gphone64_arm64', uniqueId: 'd10e5d99ab665233' }, os: { name: 'android', version: '13', abis: ['arm64-v8a','armeabi-v7a','armeabi'], host: 'android' }, app: { platform: 'android', version: '3.1.21', buildId: '289515000', engine: 'hbc85', signatures: ['6e8a975e3cbf07d5de823a760d4c2547f86c1403105020adee5de67ac510999e'], installer: 'app.revanced.manager.flutter' }, version: { package: 'tv.vavoo.app', binary: '3.1.21', js: '3.1.21' } },
    appFocusTime: 0, playerActive: false, playDuration: 0, devMode: false, hasAddon: true, castConnected: false,
    package: 'tv.vavoo.app', version: '3.1.21', process: 'app', firstAppStart: Date.now(), lastAppStart: Date.now(),
    ipLocation: clientIp || '', adblockEnabled: true, proxy: { supported: ['ss','openvpn'], engine: 'ss', ssVersion: 1, enabled: true, autoServer: true, id: 'de-fra' }, iap: { supported: false }
  };
  const headers: any = { 'user-agent': 'okhttp/4.11.0', 'accept': 'application/json', 'content-type': 'application/json; charset=utf-8', 'accept-encoding': 'gzip' };
  vdbg('PING ipLocation', clientIp);
  const res = await fetch('https://www.vavoo.tv/api/app/ping', { method: 'POST', headers, body: JSON.stringify(body), timeout: 8000 } as any);
  if (!res.ok) return null;
  const json: any = await res.json();
  return json?.addonSig || null;
}

async function vavooCatalog(group: string, signature: string) {
  const headers: any = { 'user-agent': 'okhttp/4.11.0', 'accept': 'application/json', 'content-type': 'application/json; charset=utf-8', 'accept-encoding': 'gzip', 'mediahubmx-signature': signature };
  const out: any[] = [];
  let cursor: any = 0;
  do {
    const body = { language: 'de', region: 'AT', catalogId: 'iptv', id: 'iptv', adult: false, search: '', sort: 'name', filter: { group }, cursor, clientVersion: '3.1.21' };
    const res = await fetch('https://vavoo.to/mediahubmx-catalog.json', { method: 'POST', headers, body: JSON.stringify(body), timeout: 10000 } as any);
    if (!res.ok) break;
    const j: any = await res.json();
    out.push(...(j?.items || []));
    cursor = j?.nextCursor;
  } while (cursor);
  return out;
}

async function resolveVavooPlay(url: string, signature: string): Promise<string | null> {
  const headers: any = { 'user-agent': 'MediaHubMX/2', 'accept': 'application/json', 'content-type': 'application/json; charset=utf-8', 'accept-encoding': 'gzip', 'mediahubmx-signature': signature };
  const res = await fetch('https://vavoo.to/mediahubmx-resolve.json', { method: 'POST', headers, body: JSON.stringify({ language: 'de', region: 'AT', url, clientVersion: '3.1.21' }), timeout: 8000 } as any);
  if (!res.ok) return null;
  const j: any = await res.json();
  if (Array.isArray(j) && j[0]?.url) return String(j[0].url);
  if (j?.url) return String(j.url);
  return null;
}

// Combined resolve that forwards client IP and rewrites addonSig to prioritize the observed client IP
async function resolveVavooCleanUrl(vavooPlayUrl: string, clientIp: string | null): Promise<{ url: string; headers: Record<string, string> } | null> {
  try {
    if (!vavooPlayUrl || !vavooPlayUrl.includes('vavoo.to')) return null;
    const startedAt = Date.now();
    vdbg('Clean resolve START', { url: vavooPlayUrl.substring(0, 120), ip: clientIp || '(none)' });

    // Prepare ping payload; optionally set ipLocation
    const pingBody: any = {
      token: 'tosFwQCJMS8qrW_AjLoHPQ41646J5dRNha6ZWHnijoYQQQoADQoXYSo7ki7O5-CsgN4CH0uRk6EEoJ0728ar9scCRQW3ZkbfrPfeCXW2VgopSW2FWDqPOoVYIuVPAOnXCZ5g',
      reason: 'app-blur',
      locale: 'de',
      theme: 'dark',
      metadata: {
        device: { type: 'Handset', brand: 'google', model: 'Pixel', name: 'sdk_gphone64_arm64', uniqueId: 'd10e5d99ab665233' },
        os: { name: 'android', version: '13', abis: ['arm64-v8a', 'armeabi-v7a', 'armeabi'], host: 'android' },
        app: { platform: 'android', version: '3.1.21', buildId: '289515000', engine: 'hbc85', signatures: ['6e8a975e3cbf07d5de823a760d4c2547f86c1403105020adee5de67ac510999e'], installer: 'app.revanced.manager.flutter' },
        version: { package: 'tv.vavoo.app', binary: '3.1.21', js: '3.1.21' }
      },
      appFocusTime: 0,
      playerActive: false,
      playDuration: 0,
      devMode: false,
      hasAddon: true,
      castConnected: false,
      package: 'tv.vavoo.app',
      version: '3.1.21',
      process: 'app',
      firstAppStart: Date.now(),
      lastAppStart: Date.now(),
  ipLocation: clientIp ? clientIp : '',
      adblockEnabled: true,
      proxy: { supported: ['ss', 'openvpn'], engine: 'ss', ssVersion: 1, enabled: true, autoServer: true, id: 'de-fra' },
      iap: { supported: false }
    };
    const pingHeaders: Record<string, string> = { 'user-agent': 'okhttp/4.11.0', 'accept': 'application/json', 'content-type': 'application/json; charset=utf-8', 'accept-encoding': 'gzip' };
    if (clientIp) {
      // Minimal forwarding to avoid WAF blocks
      pingHeaders['x-forwarded-for'] = clientIp;
      pingHeaders['x-real-ip'] = clientIp;
      vdbg('Ping will forward client IP (minimal headers)', { xff: clientIp, ipLocation: pingBody.ipLocation });
    } else {
      vdbg('Ping will use SERVER IP (no client IP observed)');
    }
    vdbg('Ping POST https://www.vavoo.tv/api/app/ping', { ipLocation: pingBody.ipLocation });
    const pingRes = await fetch('https://www.vavoo.tv/api/app/ping', { method: 'POST', headers: pingHeaders, body: JSON.stringify(pingBody), timeout: 12000 } as any);
    vdbg('Ping response', { status: (pingRes as any).status, ok: (pingRes as any).ok, tookMs: Date.now() - startedAt });
    let addonSig: string | null = null;
    if (!pingRes.ok) {
      let text = '';
      try { text = await pingRes.text(); } catch {}
      vdbg('Ping NOT OK, body snippet:', text.substring(0, 300));
      // Fallback: retry without forwarding headers and with empty ipLocation
      const fallbackBody = { ...pingBody, ipLocation: '' };
      const fallbackHeaders: Record<string, string> = { 'user-agent': 'okhttp/4.11.0', 'accept': 'application/json', 'content-type': 'application/json; charset=utf-8', 'accept-encoding': 'gzip' };
      vdbg('Ping FALLBACK without client headers/ipLocation');
      const pingRes2 = await fetch('https://www.vavoo.tv/api/app/ping', { method: 'POST', headers: fallbackHeaders, body: JSON.stringify(fallbackBody), timeout: 12000 } as any);
      vdbg('Ping fallback response', { status: (pingRes2 as any).status, ok: (pingRes2 as any).ok });
      if (!pingRes2.ok) return null;
      const pj2: any = await pingRes2.json();
      addonSig = pj2?.addonSig || null;
      if (!addonSig) return null;
    } else {
      const pingJson: any = await pingRes.json();
      addonSig = pingJson?.addonSig || null;
      if (!addonSig) {
        vdbg('Ping OK but addonSig missing.');
        return null;
      }
    }
    if (!addonSig) {
      vdbg('Ping OK but addonSig missing.');
      return null;
    }
    const sigPreview = VAVOO_LOG_SIG_FULL ? String(addonSig) : maskSig(String(addonSig));
    vdbg('Ping OK, addonSig preview:', sigPreview);

    // Try to decode and rewrite signature to prioritize the observed client IP
    try {
      const decoded = Buffer.from(String(addonSig), 'base64').toString('utf8');
      let sigObj: any = null;
      try { sigObj = JSON.parse(decoded); } catch {}
      if (sigObj) {
        let dataObj: any = {};
        try { dataObj = JSON.parse(sigObj?.data || '{}'); } catch {}
        const currentIps = Array.isArray(dataObj.ips) ? dataObj.ips : [];
        vdbg('addonSig.data ips (before):', currentIps);
        if (clientIp) {
          const newIps = [clientIp, ...currentIps.filter((x: any) => x && x !== clientIp)];
          dataObj.ips = newIps;
          if (typeof dataObj.ip === 'string') dataObj.ip = clientIp;
          sigObj.data = JSON.stringify(dataObj);
          const reencoded = Buffer.from(JSON.stringify(sigObj), 'utf8').toString('base64');
          vdbg('addonSig REWRITTEN with client IP', { oldLen: String(addonSig).length, newLen: String(reencoded).length });
          vdbg('addonSig.data ips (after):', newIps);
          addonSig = reencoded;
        } else {
          vdbg('No client IP observed, addonSig not rewritten');
        }
      }
    } catch {}

    // Resolve
  const resolveHeaders: Record<string, string> = { 'user-agent': 'MediaHubMX/2', 'accept': 'application/json', 'content-type': 'application/json; charset=utf-8', 'accept-encoding': 'gzip', 'mediahubmx-signature': addonSig as string };
    if (clientIp) {
      // Minimal forwarding
      resolveHeaders['x-forwarded-for'] = clientIp;
      resolveHeaders['x-real-ip'] = clientIp;
      vdbg('Resolve will forward client IP (minimal headers)', { xff: clientIp });
    } else {
      vdbg('Resolve will use SERVER IP (no client IP observed)');
    }
    vdbg('Resolve using signature:', VAVOO_LOG_SIG_FULL ? String(addonSig) : maskSig(String(addonSig)));
    vdbg('Resolve POST https://vavoo.to/mediahubmx-resolve.json', { url: vavooPlayUrl.substring(0, 120), headers: Object.keys(resolveHeaders) });
    const resolveRes = await fetch('https://vavoo.to/mediahubmx-resolve.json', { method: 'POST', headers: resolveHeaders, body: JSON.stringify({ language: 'de', region: 'AT', url: vavooPlayUrl, clientVersion: '3.1.21' }), timeout: 12000 } as any);
    vdbg('Resolve response', { status: (resolveRes as any).status, ok: (resolveRes as any).ok, tookMs: Date.now() - startedAt });
    if (!resolveRes.ok) {
      let text = '';
      try { text = await resolveRes.text(); } catch {}
      vdbg('Resolve NOT OK, body snippet:', text.substring(0, 300));
      return null;
    }
    const resolveJson: any = await resolveRes.json();
    let resolved: string | null = null;
    if (Array.isArray(resolveJson) && resolveJson.length && resolveJson[0]?.url) resolved = String(resolveJson[0].url);
    else if (resolveJson && typeof resolveJson === 'object' && resolveJson.url) resolved = String(resolveJson.url);
    if (!resolved) {
      vdbg('Resolve OK but no url field in JSON.');
      return null;
    }
    vdbg('Clean resolve SUCCESS', { url: resolved.substring(0, 200) });
    return { url: resolved, headers: { 'User-Agent': DEFAULT_VAVOO_UA, 'Referer': 'https://vavoo.to/' } };
  } catch (e) {
    const msg = (e as any)?.message || String(e);
    vdbg('Clean resolve ERROR:', msg);
    console.error('[VAVOO] Clean resolve failed:', msg);
    return null;
  }
}

const manifest: Manifest = {
  id: 'org.stremio.vavoo.clean',
  version: '1.2.23',
  name: 'TvVoo',
  description: "Stremio addon that lists VAVOO TV channels and resolves clean HLS using the viewer's IP.",
  background: 'https://raw.githubusercontent.com/qwertyuiop8899/StreamViX/refs/heads/main/public/backround.png',
  logo: 'https://raw.githubusercontent.com/qwertyuiop8899/StreamViX/refs/heads/main/public/icon.png',
  types: ['tv'],
  // Explicitly include both 'vavoo' and 'vavoo_' so clients that match prefixes strictly will route streams here
  idPrefixes: ['vavoo', 'vavoo_'],
  catalogs: SUPPORTED_COUNTRIES.map(c => ({ id: `vavoo_tv_${c.id}`, type: 'tv', name: `Vavoo TV • ${c.name}`, extra: [] })),
  resources: ['catalog', 'meta', 'stream'],
  behaviorHints: { configurable: true, configurationRequired: false } as any
};

const builder = new addonBuilder(manifest);
// Initialize EPG service (can be disabled to reduce memory)
let epg: any;
if (VAVOO_DISABLE_EPG) {
  vdbg('EPG disabled via env');
  epg = { refresh: async () => {}, getIndex: () => ({ updatedAt: 0, byChannel: {}, nameToIds: {}, nowNext: {} }) };
} else {
  const epgUrl = process.env.EPG_URL || 'https://raw.githubusercontent.com/qwertyuiop8899/TV/refs/heads/main/epg.xml';
  epg = new EPGService({ url: epgUrl, refreshCron: '0 */3 * * *' });
  // Kick off initial fetch in background (don’t block server startup)
  epg.refresh().catch(() => {});
}

// Catalog handler: list Vavoo channels for the selected country
builder.defineCatalogHandler(async ({ id, type, extra }: { id: string; type: string; extra?: any }) => {
  try {
    if (type !== 'tv') return { metas: [] };
    const country = SUPPORTED_COUNTRIES.find(c => id === `vavoo_tv_${c.id}`);
    if (!country) return { metas: [] };
    // On-demand: fetch catalog for this country if not cached yet
    const items: any[] = await getOrFetchCountryCatalog(country.id);
    const selectedGenre = extra && typeof (extra as any).genre === 'string' ? String((extra as any).genre) : undefined;
    // Use metas cache when possible
    const countryKey = country.id;
    type MetasCacheEntry = { updatedAt: number; metas: any[] };
    (global as any).__vavooMetasCache = (global as any).__vavooMetasCache || {};
    const metasCache: Record<string, MetasCacheEntry> = (global as any).__vavooMetasCache;
    const useCache = !selectedGenre; // cache only the unfiltered full catalog to keep it simple and light
    if (!selectedGenre && metasCache[countryKey] && Array.isArray(metasCache[countryKey].metas)) {
      return { metas: metasCache[countryKey].metas };
    }
  // Grab EPG index once for this request
  const epgIdx = epg.getIndex();
  // First pass: compute cleaned names and counts
  const cleaned = items.map((it: any) => cleanupChannelName(it?.name || 'Unknown'));
  const totals: Record<string, number> = {};
  for (const n of cleaned) totals[n] = (totals[n] || 0) + 1;
  // Prepare array and sort with priority: SKY -> EUROSPORT -> DAZN -> A-Z
  let rows = items.map((it: any, idx: number) => ({ it, baseName: cleaned[idx] || 'Unknown' }));
  if (selectedGenre && normCatStr(selectedGenre) !== 'tutti') {
    rows = rows.filter(r => {
      const hint = getResolvedHint(country.id, r.baseName);
      const cat = hint.cat;
      return cat && normCatStr(cat) === normCatStr(selectedGenre);
    });
  }
  const priorityOf = (name: string): number => {
    const n = name.toLowerCase();
    if (/\bsky\b/.test(n)) return 0;
    if (/\beurosport\b/.test(n)) return 1;
    if (/\bdazn\b/.test(n)) return 2;
    return 3;
  };
  rows.sort((a, b) => {
    const pa = priorityOf(a.baseName);
    const pb = priorityOf(b.baseName);
    if (pa !== pb) return pa - pb;
    return a.baseName.localeCompare(b.baseName, 'it', { sensitivity: 'base' });
  });
  const usedIndex: Record<string, number> = {};
  // Second pass: build metas with numbering for duplicates and optional logos
  const metas = rows.map(({ it, baseName }) => {
    const total = totals[baseName] || 1;
    let displayName = baseName;
    if (total > 1) {
      const cur = (usedIndex[baseName] = (usedIndex[baseName] || 0) + 1);
      displayName = `${baseName} (${cur})`; // e.g., "REAL TIME (1)", "REAL TIME (2)"
    }
  const fallback = fallbackPosterAbsUrl || TVVOO_FALLBACK_ABS;
  const hint = getResolvedHint(country.id, baseName);
  const fromLogos = hint.logo || fallback || undefined;
  const cat = hint.cat;
    // EPG: map normalized baseName -> tvg-id candidates, build description with icons
    let description: string | undefined = undefined;
    try {
      const key = normalizeChannelName(baseName);
      const candidates = epgIdx.nameToIds?.[key] || [];
      let nowTitle: string | undefined;
      let nowDesc: string | undefined;
      let nextTitle: string | undefined;
      let nextDesc: string | undefined;
      const short = (s?: string) => {
        if (!s) return '';
        const t = s.trim();
        const MAX = 280; // doubled from 140
        return t.length > MAX ? t.slice(0, MAX) : t;
      };
      for (const chId of candidates) {
        const nn = epgIdx.nowNext?.[chId];
        if (nn?.now && !nowTitle) { nowTitle = nn.now.title; nowDesc = nn.now.desc; }
        if (nn?.next && !nextTitle) { nextTitle = nn.next.title; nextDesc = nn.next.desc; }
        if (nowTitle && nextTitle) break;
      }
      if (nowTitle || nowDesc || nextTitle || nextDesc) {
        const parts = [] as string[];
        if (nowTitle || nowDesc) parts.push(`🔴 ${[nowTitle, short(nowDesc)].filter(Boolean).join(' — ')}`);
        if (nextTitle || nextDesc) parts.push(`➡️ ${[nextTitle, short(nextDesc)].filter(Boolean).join(' — ')}`);
        description = parts.join('  •  ');
      }
    } catch {}
    return {
      // Use 'vavoo_' prefix (no colon) so Stremio matches idPrefixes correctly
      id: `vavoo_${encodeURIComponent(displayName)}|${encodeURIComponent(it?.url || '')}`,
      type: 'tv',
      name: displayName,
  poster: fromLogos || it?.poster || it?.image || fallback || undefined,
  posterShape: 'landscape' as any,
  logo: fromLogos || fallback || undefined,
  background: fromLogos || fallback || undefined,
  description: description || it?.description || undefined,
  genres: (cat && !isBannedCategory(cat)) ? [cat] : undefined
    };
  });
    if (useCache) {
      metasCache[countryKey] = { updatedAt: Date.now(), metas };
    }
    return { metas };
  } catch (e) {
    console.error('Catalog error:', e);
    return { metas: [] };
  }
});

// Optional Meta handler: provide basic meta for a given id (some clients request meta before streams)
builder.defineMetaHandler(async ({ type, id }: { type: string; id: string }) => {
  if (type !== 'tv') return { meta: null as any };
  try {
    // Parse id just like in stream handler
    let rest = '';
    if (id.startsWith('vavoo:')) rest = id.slice('vavoo:'.length);
    else if (id.startsWith('vavoo_')) rest = id.slice('vavoo_'.length);
    else if (id.startsWith('vavoo')) rest = id.slice('vavoo'.length);
    const [nameEnc, urlEnc] = (rest || '').split('|');
    const name = decodeURIComponent(nameEnc || 'Unknown');
    const vavooUrl = decodeURIComponent(urlEnc || '');
    // Try to infer a country by URL from cache
    const guessCountryIdByUrl = (u: string): string | null => {
      for (const [cid, arr] of Object.entries(currentCache.countries)) {
        if ((arr as any[]).some(it => (it?.url || '') === u)) return cid;
      }
      return null;
    };
    // Remove duplicate suffix we add in catalog (e.g., " (1)", " (2)" or legacy " 1") for better matching
    const baseName = cleanupChannelName(name)
      .replace(/\s\(\d+\)$/, '')
      .replace(/\s\d+$/, '');
    const cid = vavooUrl ? guessCountryIdByUrl(vavooUrl) : null;
    const fallback = fallbackPosterAbsUrl || TVVOO_FALLBACK_ABS;
    let poster: string | undefined;
    if (cid) {
      poster = (cid === 'it' ? findBestLogo(cid, baseName) : findStaticLogo(cid, baseName)) || fallback || undefined;
    } else {
      poster = findBestLogoAny(baseName) || fallback || undefined;
    }
    // Try to enrich with EPG now/next by mapping name -> tvg-id candidates
    const idx = epg.getIndex();
    const key = normalizeChannelName(baseName);
    const candidates = idx.nameToIds?.[key] || [];
    let nowTitle: string | undefined;
    let nowDesc: string | undefined;
    let nextTitle: string | undefined;
    let nextDesc: string | undefined;
    const short = (s?: string) => {
      if (!s) return '';
      const t = s.trim();
      const MAX = 400; // doubled from 200
      return t.length > MAX ? t.slice(0, MAX) : t;
    };
    for (const chId of candidates) {
      const nn = idx.nowNext?.[chId];
      if (nn?.now && !nowTitle) { nowTitle = nn.now.title; nowDesc = nn.now.desc; }
      if (nn?.next && !nextTitle) { nextTitle = nn.next.title; nextDesc = nn.next.desc; }
      if (nowTitle && nextTitle) break;
    }
    vdbg('META', { id, name, vavooUrl });
    const metaOut: any = { id, type: 'tv', name, poster, posterShape: 'landscape' as any, logo: poster, background: poster };
    if (cid) {
      const cat = cid === 'it' ? findBestCategory(cid, baseName) : findStaticCategory(cid, baseName);
      if (cat && !isBannedCategory(cat)) metaOut.genres = [cat];
    }
    if (nowTitle || nowDesc || nextTitle || nextDesc) {
      const parts = [] as string[];
      if (nowTitle || nowDesc) parts.push(`🔴 ${[nowTitle, short(nowDesc)].filter(Boolean).join(' — ')}`);
      if (nextTitle || nextDesc) parts.push(`➡️ ${[nextTitle, short(nextDesc)].filter(Boolean).join(' — ')}`);
      metaOut.description = parts.join(' • ');
    }
  return { meta: metaOut as any };
  } catch (e) {
    return { meta: null as any };
  }
});

// Stream handler: resolve using viewer IP via ipLocation in ping signature
// Keep a short-lived map from stream id -> last seen client IP (filled by Express middleware below)
const lastIpByStreamId = new Map<string, { ip: string; ts: number }>();

builder.defineStreamHandler(async ({ id }: { id: string }, req: any) => {
  try {
  // Accept both 'vavoo:<...>' (legacy) and 'vavoo_<...>' (current)
  let rest = '';
  if (id.startsWith('vavoo:')) rest = id.slice('vavoo:'.length);
  else if (id.startsWith('vavoo_')) rest = id.slice('vavoo_'.length);
  else return { streams: [] };
  const [nameEnc, urlEnc] = (rest || '').split('|');
    const name = decodeURIComponent(nameEnc || '');
    const vavooUrl = decodeURIComponent(urlEnc || '');
    // Prefer IP from incoming request; fallback to the one captured by Express middleware
    let clientIp = getClientIpFromReq(req as any);
    if (!clientIp) clientIp = lastIpByStreamId.get(id)?.ip || null;
    // Cleanup entries older than 2 minutes
    const now = Date.now();
    for (const [k, v] of Array.from(lastIpByStreamId.entries())) {
      if (now - v.ts > 120000) lastIpByStreamId.delete(k);
    }
    vdbg('STREAM', { name, vavooUrl, clientIp });
    const resolved = await resolveVavooCleanUrl(vavooUrl, clientIp);
    if (!resolved) return { streams: [] };
    const includeHdrs = shouldIncludeStreamHeaders(req);
    const defaultHdrs = { 'User-Agent': DEFAULT_VAVOO_UA, 'Referer': 'https://vavoo.to/' } as Record<string, string>;
    const hdrs = includeHdrs ? (resolved.headers || defaultHdrs) : undefined;
    const streams: Stream[] = [
      includeHdrs
        ? { name: 'Vavoo', title: `[🏠] ${name}`, url: resolved.url, behaviorHints: { notWebReady: true, headers: hdrs, proxyHeaders: hdrs, proxyUseFallback: true } as any }
        : { name: 'Vavoo', title: `[🏠] ${name}`, url: resolved.url, behaviorHints: { notWebReady: true } as any }
    ];
    return { streams };
  } catch (e) {
    console.error('Stream error:', e);
    return { streams: [] };
  }
});

// Minimal install/landing page
const router = getRouter(builder.getInterface());
const app = express();
app.set('trust proxy', true);
// Global CORS for Stremio Web and clients that require it
app.use((req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Serve static assets from dist (landing.html, tvvoo.png)
app.use(express.static(__dirname, { etag: false, maxAge: 0 }));
// Compute absolute URL for fallback poster/logo on each request
const FALLBACK_POSTER_FILE = path.join(__dirname, 'tvvoo.png');
// Always use absolute raw GitHub URL for fallback artwork
let fallbackPosterAbsUrl = TVVOO_FALLBACK_ABS;
// Force fresh fetches from Stremio clients and support both query-based and path-based entry config
// Path-based: /key1=val1&key2=val2/manifest.json
// Safe Path-based (recommended): /cfg-it-uk-fr/manifest.json or /cfg-it-uk-fr-ex-de-pt/manifest.json
app.get('/cfg-:cfg/manifest.json', (req: Request, res: Response) => {
  try {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const raw = String(req.params.cfg || '').toLowerCase();
    // Split include/exclude by "-ex-" delimiter
    const [incPart, excPart] = raw.split('-ex-');
    const incList = (incPart || '').split('-').map(s => s.trim()).filter(Boolean);
    const excList = (excPart || '').split('-').map(s => s.trim()).filter(Boolean);
    // Validate against supported country ids
    const validIds = new Set(SUPPORTED_COUNTRIES.map(c => c.id));
    const include = incList.filter(id => validIds.has(id));
    const exclude = excList.filter(id => validIds.has(id));
    const countries = SUPPORTED_COUNTRIES.filter(c => (include.length ? include.includes(c.id) : true) && !exclude.includes(c.id));
    const dyn = {
      ...manifest,
      catalogs: countries.map(c => {
        const opts = categoriesOptionsForCountry(c.id);
        const extra = opts.length ? [{ name: 'genre', options: opts, isRequired: false } as any] : [];
        return { id: `vavoo_tv_${c.id}`, type: 'tv', name: `Vavoo TV • ${c.name}`, extra };
      }),
    } as Manifest;
    res.end(JSON.stringify(dyn));
  } catch (e) {
    res.status(500).json({ err: 'bad-config' });
  }
});

// Also support '/configure/:cfg/manifest.json' by delegating to the same logic
app.get('/configure/:cfg/manifest.json', (req: Request, res: Response, next: NextFunction) => {
  // Re-route to '/:cfg/manifest.json'
  (req as any).url = `/${encodeURIComponent(String(req.params.cfg || ''))}/manifest.json`;
  next();
});
app.get('/:cfg/manifest.json', (req: Request, res: Response) => {
  try {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    const raw = String(req.params.cfg || '');
    const parts = raw.split('&').filter(Boolean);
    const cfg: Record<string, string> = {};
    for (const p of parts) {
      const [k, v] = p.split('=');
      if (!k) continue;
      cfg[decodeURIComponent(k)] = decodeURIComponent(v || '');
    }
    const include = cfg.include ? cfg.include.split(',').map(s => s.trim()) : null;
    const exclude = cfg.exclude ? cfg.exclude.split(',').map(s => s.trim()) : [];
    const countries = SUPPORTED_COUNTRIES.filter(c => (include ? include.includes(c.id) : true) && !exclude.includes(c.id));
    const dyn = {
      ...manifest,
      catalogs: countries.map(c => {
        const opts = categoriesOptionsForCountry(c.id);
        const extra = opts.length ? [{ name: 'genre', options: opts, isRequired: false } as any] : [];
        return { id: `vavoo_tv_${c.id}`, type: 'tv', name: `Vavoo TV • ${c.name}`, extra };
      }),
    } as Manifest;
    res.end(JSON.stringify(dyn));
  } catch (e) {
    res.status(500).json({ err: 'bad-config' });
  }
});
// Query-based: /manifest.json?include=it,uk&exclude=de
app.get('/manifest.json', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  // include=it,uk or exclude=de,fr
  const include = typeof req.query.include === 'string' ? String(req.query.include).split(',').map(s => s.trim()) : null;
  const exclude = typeof req.query.exclude === 'string' ? String(req.query.exclude).split(',').map(s => s.trim()) : [];
  const countries = SUPPORTED_COUNTRIES.filter(c => (include ? include.includes(c.id) : true) && !exclude.includes(c.id));
  const dyn = {
    ...manifest,
    catalogs: countries.map(c => {
      const opts = categoriesOptionsForCountry(c.id);
      const extra = opts.length ? [{ name: 'genre', options: opts, isRequired: false } as any] : [];
      return { id: `vavoo_tv_${c.id}`, type: 'tv', name: `Vavoo TV • ${c.name}`, extra };
    }),
  } as Manifest;
  res.end(JSON.stringify(dyn));
});
app.use('/catalog', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/stream', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
// Prefixed routes (path-based config)
app.use('/:cfg/catalog', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/:cfg/stream', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/cfg-:cfg/catalog', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/cfg-:cfg/stream', (_req: Request, res: Response, next: NextFunction) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
// Capture client IP for subsequent SDK stream handler (helps when req passed to handler lacks proxy info)
app.use((req: Request, _res: Response, next: NextFunction) => {
  try {
    if (req.method === 'GET' && /\/stream\//.test(req.url)) {
      const ip = getClientIpFromReq(req as any);
      // Extract id tail from URL, e.g., /stream/tv/<id>.json or /cfg-xxx/stream/tv/<id>.json
      const m = req.url.match(/\/stream\/tv\/([^/?#]+)\.json/i);
      const rawId = m ? decodeURIComponent(m[1]) : null;
      if (ip && rawId) {
        lastIpByStreamId.set(rawId, { ip, ts: Date.now() });
      }
    }
  } catch {}
  next();
});
app.get('/', (_req: Request, res: Response) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  try {
    const filePath = path.join(__dirname, 'landing.html');
  const html = fs.readFileSync(filePath, 'utf8');
  res.send(html);
  } catch {
    res.send('<h1>VAVOO Clean</h1><p>Manifest: /manifest.json</p>');
  }
});
// Stremio configuration gear should open a configure page; serve the same landing UI
app.get('/configure', (req: Request, res: Response) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  try {
    const filePath = path.join(__dirname, 'landing.html');
  const html = fs.readFileSync(filePath, 'utf8');
  res.send(html);
  } catch {
    res.send('<h1>VAVOO Clean</h1><p>Manifest: /manifest.json</p>');
  }
});
// Compatibility: support '/configure/:cfg' and '/:cfg/configure' styles by redirecting to query-based configure
app.get('/configure/:cfg', (req: Request, res: Response) => {
  try {
    const cfg = String(req.params.cfg || '');
    // Pass through as '?cfg=...'
    return res.redirect(`/configure?cfg=${encodeURIComponent(cfg)}`);
  } catch {
    return res.redirect('/configure');
  }
});
app.get('/:cfg/configure', (req: Request, res: Response) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  try {
    const cfg = String(req.params.cfg || '');
    // Redirect to the canonical configure with query so landing can read it (future use)
    return res.redirect(`/configure?cfg=${encodeURIComponent(cfg)}`);
  } catch {
    res.redirect('/configure');
  }
});
app.get('/cfg-:cfg/configure', (_req: Request, res: Response) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  try {
    const filePath = path.join(__dirname, 'landing.html');
    const html = fs.readFileSync(filePath, 'utf8');
    res.send(html);
  } catch {
    res.send('<h1>VAVOO Clean</h1><p>Manifest: /manifest.json</p>');
  }
});
// Serve fallback poster/logo if present in dist
app.get('/tvvoo.png', (_req: Request, res: Response) => {
  const candidates = [
    path.join(__dirname, 'tvvoo.png'),
    path.resolve(__dirname, '../public/tvvoo.png'),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        const bin = fs.readFileSync(p);
        res.setHeader('Content-Type', 'image/png');
        return res.send(bin);
      }
    } catch {}
  }
  res.status(404).end();
});
// Simple health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.status(200).send('ok');
});
// Debug endpoint to inspect detected client IP and proxy headers
app.get('/debug/ip', (req: Request, res: Response) => {
  const ip = getClientIpFromReq(req as any);
  res.json({
    detectedIp: ip,
    trustProxy: (app.get('trust proxy') ? true : false),
    headers: {
      'x-forwarded-for': req.headers['x-forwarded-for'],
      'x-real-ip': req.headers['x-real-ip'],
      'cf-connecting-ip': (req.headers as any)['cf-connecting-ip'],
      'true-client-ip': (req.headers as any)['true-client-ip'],
      'fly-client-ip': (req.headers as any)['fly-client-ip'],
      'fastly-client-ip': (req.headers as any)['fastly-client-ip'],
      'x-forwarded': req.headers['x-forwarded'],
      forwarded: req.headers['forwarded']
    },
    reqIp: (req as any).ip,
    remoteAddress: (req.socket as any)?.remoteAddress
  });
});
// Debug endpoint to manually test resolve without Stremio
app.get('/debug/resolve', async (req: Request, res: Response) => {
  try {
    const name = String(req.query.name || '');
    const url = String(req.query.url || '');
    const ipOverride = req.query.ip ? String(req.query.ip) : null;
    const clientIp = ipOverride || getClientIpFromReq(req);
    vdbg('DEBUG RESOLVE', { name, url, clientIp });
    const sig = await getVavooSignature(clientIp);
    if (!sig) return res.status(502).json({ error: 'no-signature' });
    const resolved = await resolveVavooPlay(url, sig);
    if (!resolved) return res.status(404).json({ error: 'not-resolved' });
    const hdrs = { 'User-Agent': DEFAULT_VAVOO_UA, 'Referer': 'https://vavoo.to/' } as Record<string, string>;
    return res.json({ name, url, clientIp, resolved, headers: hdrs });
  } catch (e: any) {
    console.error('DEBUG RESOLVE error:', e?.message || e);
    return res.status(500).json({ error: 'debug-failed' });
  }
});
// Cache status endpoint (not listing full data)
app.get('/cache/status', (_req: Request, res: Response) => {
  res.json({ updatedAt: currentCache.updatedAt, countries: Object.keys(currentCache.countries) });
});
// EPG status and lookup endpoints
app.get('/epg/status', (_req: Request, res: Response) => {
  try {
    const idx = epg.getIndex();
    res.json({ updatedAt: idx.updatedAt, channels: Object.keys(idx.byChannel).length });
  } catch {
    res.json({ updatedAt: 0, channels: 0 });
  }
});
app.get('/epg/lookup', (req: Request, res: Response) => {
  try {
    const name = String(req.query.name || '');
    const idx = epg.getIndex();
    const key = normalizeChannelName(name);
    const candidates = idx.nameToIds?.[key] || [];
  const result = candidates.map((id: string) => ({ id, now: idx.nowNext?.[id]?.now || null, next: idx.nowNext?.[id]?.next || null }));
    res.json({ name, key, candidates: result });
  } catch (e) {
    res.status(500).json({ error: 'lookup-failed' });
  }
});
// Debug HTTP request logger (helps confirm if Stremio is hitting /stream)
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (process.env.VAVOO_DEBUG !== '0') {
    try { console.log('[VAVOO] HTTP', req.method, req.url); } catch {}
  }
  next();
});
// Mount router at root and under the path-based config prefix so Stremio follows the same base
app.use(router);
app.use('/:cfg', router);
app.use('/cfg-:cfg', router);

const port = Number(process.env.PORT || 7019);
// Initialize cache from disk, then schedule a daily refresh at 02:00 Europe/Rome
currentCache = readCacheFromDisk();
if (currentCache.updatedAt) {
  vdbg('Cache loaded from disk at', new Date(currentCache.updatedAt).toISOString());
}
logosMap = readLogosFromDisk();
if (Object.keys(logosMap).length) {
  vdbg('Logos map loaded with', Object.keys(logosMap).length, 'entries');
}
categoriesMap = readCategoriesFromDisk();
if (Object.keys(categoriesMap).length) {
  vdbg('Categories map loaded with', Object.keys(categoriesMap).length, 'entries');
}
// Load static non-Italy channels list (logos & categories)
loadStaticChannels();
let refreshing = false;
async function updateLogosFromM3U(): Promise<number> {
  try {
    const url = 'https://raw.githubusercontent.com/nzo66/TV/main/lista.m3u';
    const resp = await fetch(url, { timeout: 8000 } as any);
    if (!resp.ok) return 0;
    const text = await resp.text();
    const lines = text.split(/\r?\n/);
    let added = 0;
    let catsAdded = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.startsWith('#EXTINF')) continue;
      // Extract tvg-logo and channel name after comma
      const logoMatch = line.match(/tvg-logo=\"([^\"]+)\"/);
      const groupMatch = line.match(/group-title=\"([^\"]+)\"/);
      const commaIdx = line.indexOf(',');
      const chName = commaIdx >= 0 ? line.slice(commaIdx + 1).trim() : '';
      const clean = cleanupChannelName(chName).toLowerCase();
      const logoUrl = logoMatch?.[1];
      if (clean && logoUrl) {
        const key = `it:${clean}`; // this list targets Italy
        if (!logosMap[key]) {
          logosMap[key] = logoUrl;
          added++;
        }
      }
      const group = groupMatch?.[1]?.trim();
      if (clean && group) {
        const k2 = `it:${clean}`;
        if (!categoriesMap[k2]) { categoriesMap[k2] = group; catsAdded++; }
      }
    }
    if (added > 0) {
      try { fs.writeFileSync(LOGOS_FILE, JSON.stringify(logosMap, null, 2), 'utf8'); } catch {}
      vdbg('Logos map updated from M3U with', added, 'entries');
    }
    if (catsAdded > 0) {
      try { fs.writeFileSync(CATEGORIES_FILE, JSON.stringify(categoriesMap, null, 2), 'utf8'); } catch {}
      vdbg('Categories map updated from M3U with', catsAdded, 'entries');
    }
    return added;
  } catch (e) {
    console.error('Logos M3U update failed:', e);
    return 0;
  }
}

async function refreshDailyCache() {
  if (refreshing) return; // prevent overlap
  refreshing = true;
  try {
    vdbg('Refreshing daily Vavoo catalog cache…');
    const sig = await getVavooSignature(null);
    if (!sig) throw new Error('No signature');
    const countries: Record<string, any[]> = {};
    for (const c of SUPPORTED_COUNTRIES) {
      if (VAVOO_REFRESH_WHITELIST && !VAVOO_REFRESH_WHITELIST.has(c.id)) {
        countries[c.id] = [];
        continue;
      }
      try {
        // Try primary group, then a few fallbacks for regions that might have alternate group names
        const groupCandidates = [c.group, ...(c.id === 'nl' ? ['Netherlands', 'Holland'] : [])];
        let items: any[] = [];
        for (const g of groupCandidates) {
          items = await vavooCatalog(g, sig);
          if (items && items.length) break;
        }
        // lightweight retry if first attempt returns empty (transient upstream timeouts)
        if (!items || items.length === 0) {
          try { items = await vavooCatalog(c.group, sig); } catch {}
        }
        const slim = (items || []).map((it: any) => ({
          name: cleanupChannelName(String(it?.name || 'Unknown')),
          url: String((it && (it.url || it.play || it.href || it.link)) || ''),
          // retain tiny fields if present (poster/image used as fallback only)
          poster: it?.poster || it?.image || undefined,
          description: undefined,
        }));
        countries[c.id] = slim;
        vdbg('Fetched', c.id, slim.length, 'items');
      } catch (e) {
        console.error('Fetch error for', c.id, e);
        countries[c.id] = [];
      }
    }
    currentCache = { updatedAt: Date.now(), countries };
    writeCacheToDisk(currentCache);
    vdbg('Cache refresh complete at', new Date(currentCache.updatedAt).toISOString());
  // After refreshing catalogs, enrich Italy logos/categories from M3U only (non-Italy uses static lists)
  await updateLogosFromM3U();
  } catch (e) {
    console.error('Cache refresh failed:', e);
  } finally {
    refreshing = false;
  }
}

// Refresh on startup unless explicitly disabled; keeps serving cached while updating
if (DO_BOOT_REFRESH) {
  refreshDailyCache().catch(() => {});
} else {
  vdbg('Boot refresh disabled via env (VAVOO_BOOT_REFRESH=0)');
}

// Schedule at 02:00 Europe/Rome daily (can be disabled)
if (DO_SCHEDULE_REFRESH) {
  cron.schedule('0 2 * * *', () => { refreshDailyCache().catch(() => {}); }, { timezone: 'Europe/Rome' });
} else {
  vdbg('Daily refresh schedule disabled via env (VAVOO_SCHEDULE_REFRESH=0)');
}

app.listen(port, '0.0.0.0', () => console.log(`VAVOO Clean addon on http://localhost:${port}/manifest.json`));
