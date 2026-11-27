import { createAccessHandler, sessionSetCookie } from './access.mjs';
import { renderAuthPage } from './auth-page.mjs';
import { createIdentityProvider } from './supabase.mjs';
import { recordMetric } from './metrics.mjs';
import { calculateFixture, renderMetrics, renderPilot } from './pilot-page.mjs';

const otpDuration = 10 * 60;
const passwordDuration = 5 * 60;
const signInDuration = 8 * 60 * 60;
const expiredCookie = '__Host-finrez=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0';

async function digest(value) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function redirect(path, cookie) {
  const headers = new Headers({ Location: path });
  if (cookie) headers.set('Set-Cookie', cookie);
  return new Response(null, { status: 303, headers });
}

function page(view, notice, cookie) {
  const response = renderAuthPage(view, notice);
  if (cookie) response.headers.set('Set-Cookie', cookie);
  return response;
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '';
}

export function createPilot(env, identity, clock = () => Math.floor(Date.now() / 1000)) {
  if (!env.DB || !env.ORIGIN || !env.RATE_KEY || env.RATE_KEY.length < 32) throw new Error('Incomplete pilot configuration');
  const db = env.DB;
  const prepare = (sql, ...args) => db.prepare(sql).bind(...args);

  async function getSession(token) {
    if (!token) return null;
    return prepare(`SELECT sessions.*, users.email AS account_email FROM sessions
      LEFT JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?`, await digest(token), clock()).first();
  }

  async function nextSession(state, duration, previous) {
    const token = crypto.randomUUID() + crypto.randomUUID();
    const bindings = [await digest(token), state.stage, clock() + duration, state.userId ?? null,
      state.email ?? null, state.purpose ?? null, state.providerToken ?? null];
    const add = prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?)', ...bindings);
    if (previous) {
      const remove = prepare('DELETE FROM sessions WHERE token_hash = ?', await digest(previous));
      await db.batch([remove, add]);
    } else {
      await add.run();
    }
    return sessionSetCookie(token, duration);
  }

  async function limit(scope, subject, period, maximum) {
    const now = clock();
    const expiry = (Math.floor(now / period) + 1) * period;
    const bucket = await digest([env.RATE_KEY, scope, subject, expiry].join('\n'));
    const result = await prepare(`INSERT INTO request_limits VALUES (?, 1, ?)
      ON CONFLICT(bucket) DO UPDATE SET requests = requests + 1 WHERE requests < ?
      RETURNING requests`, bucket, expiry, maximum).first();
    return Boolean(result);
  }

  const counters = {
    increment(day, event) {
      return prepare(`INSERT INTO daily_metrics VALUES (?, ?, 1)
        ON CONFLICT(day, event) DO UPDATE SET count = count + 1`, day, event).run();
    }
  };

  async function count(event) {
    // Metrics are auxiliary, so a failed counter never changes the auth outcome.
    try { await recordMetric(counters, event, new Date(clock() * 1000)); } catch {}
  }

  async function startOtp(email, purpose, token, ip) {
    if (!email) return page(purpose);
    if (!await limit('otp-ip', ip, 600, 8) || !await limit('otp-email', email, 60, 1)
      || !await limit('otp-global', 'all', 86400, 120)) return page(purpose, 'rateLimit');

    const account = await prepare('SELECT id FROM users WHERE email = ?', email).first();
    if ((purpose === 'register' && !account) || (purpose === 'recover' && account)) {
      await identity.sendCode(email, purpose);
    }
    const cookie = await nextSession({ stage: 'verify', email, purpose }, otpDuration, token);
    return page('verify', 'sent', cookie);
  }

  async function verifyOtp(body, token, ip) {
    const code = String(body.get('code') ?? '');
    const session = await getSession(token);
    if (session?.stage !== 'verify') return page('recover', 'expired');
    const { email, purpose } = session;
    if (!await limit('verify-ip', ip, 600, 25) || !await limit('verify-email', email, 600, 6)) {
      return page('verify', 'rateLimit');
    }
    if (!/^\d{6}$/.test(code)) return page('verify', 'invalidCode');
    const account = await prepare('SELECT id FROM users WHERE email = ?', email).first();
    if ((purpose === 'register' && account) || (purpose === 'recover' && !account)) return page('verify', 'invalidCode');

    const result = await identity.verifyCode(email, code, purpose);
    const user = result.data?.user;
    const providerToken = result.data?.access_token;
    if (!user?.id || normalizeEmail(user.email) !== email || !user.email_confirmed_at || !providerToken
      || (account && user.id !== account.id)) return page('verify', 'invalidCode');
    const cookie = await nextSession({ stage: 'set_password', email, purpose, userId: user.id, providerToken }, passwordDuration, token);
    return page('password', null, cookie);
  }

  async function finishPassword(body, token) {
    const password = String(body.get('password') ?? '');
    if (password.length < 12 || new TextEncoder().encode(password).length > 72 || password !== body.get('confirmPassword')) {
      return page('password', 'mismatch');
    }
    const pending = await getSession(token);
    if (pending?.stage !== 'set_password') return page('recover', 'expired');
    const claimed = await prepare(`DELETE FROM sessions WHERE token_hash = ? AND stage = 'set_password'
      AND expires_at > ? RETURNING user_id`, pending.token_hash, clock()).first();
    if (!claimed) return page('recover', 'expired');

    const updated = await identity.setPassword(pending.provider_token, password);
    if (updated.data?.id !== pending.user_id) return page(pending.purpose, 'passwordFailed', expiredCookie);
    // Invalidate any outstanding sessions for this account after enrollment or recovery.
    await db.batch([
      prepare('INSERT INTO users VALUES (?, ?) ON CONFLICT(id) DO NOTHING', pending.user_id, pending.email),
      prepare('DELETE FROM sessions WHERE user_id = ? OR email = ?', pending.user_id, pending.email)
    ]);
    await count(pending.purpose === 'register' ? 'registration_completed' : 'password_reset_completed');
    return redirect('/login', expiredCookie);
  }

  async function passwordLogin(email, password, token, ip) {
    if (!email || !password || password.length > 128) return page('login', 'invalidLogin');
    if (!await limit('login-ip', ip, 600, 50) || !await limit('login-email', email, 600, 10)) return page('login', 'rateLimit');
    const login = await identity.signIn(email, password);
    const user = login.data?.user;
    const account = await prepare('SELECT id FROM users WHERE email = ?', email).first();
    if (!account || user?.id !== account.id || !user.email_confirmed_at) return page('login', 'invalidLogin');
    const cookie = await nextSession({ stage: 'active', userId: user.id }, signInDuration, token);
    await count('login_succeeded');
    return redirect('/', cookie);
  }

  const auth = async (request, token) => {
    const path = new URL(request.url).pathname;
    if (request.method === 'GET') return page(path.slice(1));
    const length = Number(request.headers.get('Content-Length'));
    if (length > 4096 || !request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) {
      return new Response(null, { status: 400 });
    }
    const bodyText = await request.text();
    if (bodyText.length > 4096) return new Response(null, { status: 413 });
    const fields = new URLSearchParams(bodyText);
    const email = normalizeEmail(fields.get('email'));
    const ip = request.headers.get('CF-Connecting-IP') || '';
    if (path === '/auth/verify') return verifyOtp(fields, token, ip);
    if (path === '/auth/password') return finishPassword(fields, token);
    if (path === '/auth/login') return passwordLogin(email, fields.get('password'), token, ip);
    return startOtp(email, path === '/auth/register' ? 'register' : 'recover', token, ip);
  };

  return createAccessHandler({
    origin: env.ORIGIN,
    async getSession(token) {
      const session = await getSession(token);
      if (!session?.account_email) return null;
      return { verifiedEmail: true, stage: session.stage, tokenHash: session.token_hash,
        role: session.account_email === normalizeEmail(env.ADMIN_EMAIL) ? 'admin' : 'member' };
    },
    auth,
    assets: (request, session) => new URL(request.url).pathname === '/'
      ? renderPilot(null, session.role === 'admin') : new Response(null, { status: 404 }),
    async api(request, session) {
      const path = new URL(request.url).pathname;
      if (path === '/auth/logout' && request.method === 'POST') {
        await prepare('DELETE FROM sessions WHERE token_hash = ?', session.tokenHash).run();
        return redirect('/login', expiredCookie);
      }
      if (path === '/api/calculate' && request.method === 'POST') {
        const result = calculateFixture();
        await count('calculation_succeeded');
        return renderPilot(result, session.role === 'admin');
      }
      return new Response(null, { status: 404 });
    },
    async dashboard(request) {
      if (request.method !== 'GET') return new Response(null, { status: 405 });
      const metrics = await prepare(`SELECT day, event, count FROM daily_metrics
        WHERE day >= date('now', '-30 days') ORDER BY day DESC, event`).all();
      const path = new URL(request.url).pathname;
      if (path === '/metrics') return renderMetrics(metrics.results);
      if (path === '/api/admin/metrics') return Response.json(metrics.results);
      return new Response(null, { status: 404 });
    }
  });
}

export default {
  async fetch(request, env) {
    try {
      return await createPilot(env, createIdentityProvider({ url: env.SUPABASE_URL, key: env.SUPABASE_KEY }))(request);
    } catch {
      return new Response('Пилот временно недоступен.', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    }
  },
  async scheduled(controller, env) {
    const now = Math.floor(controller.scheduledTime / 1000);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
      env.DB.prepare('DELETE FROM request_limits WHERE expires_at <= ?').bind(now)
    ]);
  }
};
