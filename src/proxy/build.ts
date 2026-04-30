import { getProxyConfig } from './config';

export type WrapOptions = Record<string, never>;

// Build proxy URL with explicit config: `${baseUrl}${path}?d=${encodeURIComponent(original)}&api_password=${password}`
export function buildProxyUrl(originalUrl: string, cfg: { baseUrl: string; password: string; path?: string }): string {
  const path = cfg.path || '/proxy/hls/manifest.m3u8';
  const base = cfg.baseUrl.endsWith('/') ? cfg.baseUrl : cfg.baseUrl + '/';
  const u = new URL(path, base);
  // Let URLSearchParams encode the value; avoid double-encoding
  u.searchParams.set('d', originalUrl);
  u.searchParams.set('api_password', cfg.password);
  return u.toString();
}

// Build a Mediaflow Proxy "extractor" URL:
// `${baseUrl}/extractor/video?host=Vavoo&d=${encoded}&redirect_stream=true&api_password=${password}`
export function buildMediaflowExtractorUrl(originalUrl: string, cfg: { baseUrl: string; password: string; host?: string }): string {
  const base = cfg.baseUrl.endsWith('/') ? cfg.baseUrl : cfg.baseUrl + '/';
  const u = new URL('extractor/video', base);
  u.searchParams.set('host', cfg.host || 'Vavoo');
  u.searchParams.set('d', originalUrl);
  u.searchParams.set('redirect_stream', 'true');
  u.searchParams.set('api_password', cfg.password);
  return u.toString();
}

// Wrap using environment config if available; otherwise return original
export function wrapStreamUrl(originalUrl: string, _opts: WrapOptions = {}): string {
  const cfg = getProxyConfig();
  if (!cfg) return originalUrl;
  return buildProxyUrl(originalUrl, { baseUrl: cfg.baseUrl, password: cfg.password, path: cfg.path });
}
