export const CLOUDFLARE_API_URL = String(
  import.meta.env.VITE_CLOUDFLARE_API_URL ||
  import.meta.env.VITE_KCP_API_BASE_URL ||
  (import.meta.env.DEV ? 'http://127.0.0.1:8787' : '')
).replace(/\/+$/, '');

export const CLOUD_SESSION_STORAGE_KEY = 'kcp:cloud-session:v1';

export function getCloudSession() {
  try {
    const raw = window.localStorage.getItem(CLOUD_SESSION_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setCloudSession(session) {
  try {
    if (session?.token) window.localStorage.setItem(CLOUD_SESSION_STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(CLOUD_SESSION_STORAGE_KEY);
  } catch {
    // localStorage can be unavailable in private contexts; callers still receive the session object.
  }
}

export function clearCloudSession() {
  setCloudSession(null);
}

export function getCloudSessionToken() {
  return String(getCloudSession()?.token || '').trim();
}

export async function callCloudflareRoute(path, {
  method = 'GET',
  payload,
  query,
  token = getCloudSessionToken(),
  headers = {}
} = {}) {
  const resourcePath = String(path || '').replace(/^\/+/, '');
  const url = createApiUrl(resourcePath);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  const requestMethod = String(method || 'GET').toUpperCase();
  const requestHeaders = {
    'Content-Type': 'application/json',
    ...headers
  };
  if (token) requestHeaders.Authorization = `Bearer ${token}`;

  const response = await fetch(url.toString(), {
    method: requestMethod,
    headers: requestHeaders,
    cache: requestMethod === 'GET' ? 'no-store' : 'default',
    body: requestMethod === 'GET' ? undefined : JSON.stringify(payload || {})
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.ok === false) {
    throw new Error(result.message || result.error || `Live data request failed (${response.status}).`);
  }
  return result;
}

export async function callCloudflareWorkspaceRoute(workspaceId, resource, {
  method = 'GET',
  payload,
  query
} = {}) {
  const token = getCloudSessionToken();
  if (!token) throw new Error('Sign in before loading workspace data.');

  const workspaceKey = String(workspaceId || '').trim();
  if (!workspaceKey) throw new Error('Workspace is required.');

  const url = createApiUrl(`api/workspaces/${encodeURIComponent(workspaceKey)}/${resource}`);
  Object.entries(query || {}).forEach(([key, value]) => {
    if (value === undefined || value === null || value === '') return;
    url.searchParams.set(key, String(value));
  });

  return callCloudflareRoute(url.pathname + url.search, { method, payload, token });
}

function createApiUrl(path) {
  const resourcePath = String(path || '').replace(/^\/+/, '');
  if (CLOUDFLARE_API_URL) return new URL(`${CLOUDFLARE_API_URL}/${resourcePath}`);
  return new URL(`/${resourcePath}`, window.location.origin);
}
