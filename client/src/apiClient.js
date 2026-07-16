export const AUTH_REMEMBER_KEY = 'skyjo_auth_remember';

function getServerUrl() {
  const configuredUrl = import.meta.env.VITE_SERVER_URL?.trim();
  const configuredDevUrl = import.meta.env.VITE_DEV_SERVER_URL?.trim();
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (import.meta.env.DEV) {
    let port = '4000';
    if (configuredDevUrl) {
      try {
        const url = new URL(configuredDevUrl);
        if (url.protocol === 'http:' && localHosts.has(url.hostname) && url.port) port = url.port;
      } catch {
        port = '4000';
      }
    }
    if (typeof window === 'undefined') return `http://localhost:${port}`;
    return `http://${window.location.hostname}:${port}`;
  }
  if (!configuredUrl) return '';
  try {
    const url = new URL(configuredUrl);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return '';
    if (url.pathname && url.pathname !== '/') return '';
    return url.origin;
  } catch {
    return '';
  }
}

export const SERVER_URL = getServerUrl();
let csrfToken = '';

export function setCsrfToken(value) {
  csrfToken = typeof value === 'string' && value.length <= 256 ? value : '';
}

export function clearBrowserAuthArtifacts() {
  csrfToken = '';
  for (const storage of [localStorage, sessionStorage]) {
    storage.removeItem('sj-room-id');
    storage.removeItem('sj-player-name');
  }
}

export async function apiFetch(path, options = {}) {
  if (!SERVER_URL) throw new Error('Le serveur est mal configuré.');
  const method = String(options.method || 'GET').toUpperCase();
  const headers = new Headers(options.headers || {});
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken);
  }
  const response = await fetch(`${SERVER_URL}${path}`, {
    ...options,
    method,
    headers,
    credentials: 'include',
    cache: 'no-store',
  });
  const publicAuthenticationAttempt = path === '/api/auth/login' || path === '/api/auth/email/confirm';
  if (response.status === 401 && !publicAuthenticationAttempt && typeof window !== 'undefined') {
    window.dispatchEvent(new Event('skyjo:session-expired'));
  }
  return response;
}
