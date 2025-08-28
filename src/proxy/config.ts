export type ProxyConfig = {
  enabled: boolean;
  baseUrl: string; // e.g., https://proxylink.org
  path: string; // e.g., /proxy/hls/manifest.m3u8
  password: string; // API password
  dataParam: string; // query param for the original URL (default: d)
  passwordParam: string; // query param for the password (default: api_password)
};

function envBool(val?: string): boolean {
  if (!val) return false;
  const v = val.toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

export function getProxyConfig(): ProxyConfig | null {
  const enabled = envBool(process.env.PROXY_ENABLED);
  if (!enabled) return null;
  const baseUrl = (process.env.PROXY_BASE_URL || '').trim();
  const password = (process.env.PROXY_PASSWORD || '').trim();
  const path = (process.env.PROXY_PATH || '/proxy/hls/manifest.m3u8').trim();
  const dataParam = (process.env.PROXY_DATA_PARAM || 'd').trim();
  const passwordParam = (process.env.PROXY_PASSWORD_PARAM || 'api_password').trim();
  if (!baseUrl || !password) return null;
  return { enabled: true, baseUrl, path, password, dataParam, passwordParam };
}

export function isProxyEnabled(): boolean {
  return !!getProxyConfig();
}
