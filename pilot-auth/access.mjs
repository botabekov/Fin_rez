const publicRoutes = new Map([
  ['/login', 'GET'],
  ['/register', 'GET'],
  ['/recover', 'GET'],
  ['/auth/login', 'POST'],
  ['/auth/register', 'POST'],
  ['/auth/recover', 'POST'],
  ['/auth/verify', 'POST'],
  ['/auth/password', 'POST']
]);

const sessionCookie = '__Host-finrez';

function protect(response) {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Frame-Options', 'DENY');
  return new Response(response.body, { status: response.status, headers });
}

function readSessionCookie(request) {
  const cookies = (request.headers.get('Cookie') || '').split(';');
  const found = cookies.map(cookie => cookie.trim()).filter(cookie => cookie.startsWith(sessionCookie + '='));
  if (found.length !== 1) return '';
  const token = found[0].slice(sessionCookie.length + 1);
  return /^[A-Za-z0-9_-]{32,160}$/.test(token) ? token : '';
}

function reject(status) {
  return protect(new Response(null, { status }));
}

export function sessionSetCookie(token, maxAge) {
  if (!/^[A-Za-z0-9_-]{32,160}$/.test(token) || !Number.isInteger(maxAge) || maxAge < 1) {
    throw new TypeError('Invalid session cookie');
  }
  return sessionCookie + '=' + token + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + maxAge;
}

// mount at the origin's entry point, before any static file handling
export function createAccessHandler({ origin, getSession, auth, assets, api, dashboard }) {
  const ownOrigin = new URL(origin).origin;
  return async function handle(request) {
    const url = new URL(request.url);
    const method = request.method;
    const path = url.pathname;
    if (url.origin !== ownOrigin) return reject(421);
    if (method !== 'GET' && method !== 'HEAD' && request.headers.get('Origin') !== ownOrigin) {
      return reject(403);
    }
    if (publicRoutes.has(path)) {
      return method === publicRoutes.get(path)
        ? protect(await auth(request, readSessionCookie(request)))
        : reject(405);
    }
    const token = readSessionCookie(request);
    const session = token ? await getSession(token) : null;
    const isApi = path.startsWith('/api/') || path.startsWith('/auth/');
    if (!session?.verifiedEmail || session.stage !== 'active') {
      if (isApi || path === '/metrics' || (method !== 'GET' && method !== 'HEAD')) return reject(401);
      return protect(new Response(null, { status: 303, headers: { Location: '/login' } }));
    }
    if (path === '/metrics' || path.startsWith('/api/admin/')) {
      if (session.role !== 'admin') return reject(403);
      return protect(await dashboard(request, session));
    }
    if (isApi) return protect(await api(request, session));
    if (method !== 'GET' && method !== 'HEAD') return reject(405);
    return protect(await assets(request, session));
  };
}
