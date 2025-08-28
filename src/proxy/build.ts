import { getProxyConfig } from './config';

export type WrapOptions = Record<string, never>;

// Build proxy URL with explicit config: `${baseUrl}${path}?d=${encodeURIComponent(original)}&api_password=${password}`
export function buildProxyUrl(originalUrl: string, cfg: { baseUrl: string; password: string; path?: string }): string {
  const path = cfg.path || '/proxy/hls/manifest.m3u8';
  const base = cfg.baseUrl.endsWith('/') ? cfg.baseUrl : cfg.baseUrl + '/';
  const u = new URL(path, base);
  u.searchParams.set('d', encodeURIComponent(originalUrl));
  u.searchParams.set('api_password', cfg.password);
  return u.toString();
}

// Wrap using environment config if available; otherwise return original
export function wrapStreamUrl(originalUrl: string, _opts: WrapOptions = {}): string {
  const cfg = getProxyConfig();
  if (!cfg) return originalUrl;
  return buildProxyUrl(originalUrl, { baseUrl: cfg.baseUrl, password: cfg.password, path: cfg.path });
}
