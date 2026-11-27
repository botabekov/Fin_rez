import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccessHandler, sessionSetCookie } from './access.mjs';
import { recordMetric } from './metrics.mjs';
import { renderAuthPage } from './auth-page.mjs';

const origin = 'https://fin-rez.example';
const active = 'a'.repeat(48);
const pending = 'b'.repeat(48);
const admin = 'c'.repeat(48);
const sessions = new Map([
  [active, { verifiedEmail: true, stage: 'active', role: 'member' }],
  [pending, { verifiedEmail: true, stage: 'set_password', role: 'member' }],
  [admin, { verifiedEmail: true, stage: 'active', role: 'admin' }]
]);
const handler = createAccessHandler({
  origin,
  getSession: token => sessions.get(token),
  auth: () => new Response('auth form'),
  assets: () => new Response('application asset'),
  api: () => new Response('app action'),
  dashboard: () => new Response('aggregate counters')
});

function request(path, token, method = 'GET', from = origin) {
  const headers = new Headers();
  if (token) headers.set('Cookie', '__Host-finrez=' + token);
  if (method === 'POST') headers.set('Origin', from);
  return handler(new Request(origin + path, { method, headers }));
}

test('public screens are available before login', async () => {
  assert.equal(await (await request('/register')).text(), 'auth form');
  assert.equal(await (await request('/recover')).text(), 'auth form');
});

test('anonymous users cannot load application HTML, JS or calculation API', async () => {
  for (const path of ['/', '/index.html', '/fin-rez-excel.js', '/tax-report.html', '/pdf-editor/']) {
    const result = await request(path);
    assert.equal(result.status, 303);
    assert.equal(result.headers.get('Location'), '/login');
  }
  assert.equal((await request('/api/calculate', null, 'POST')).status, 401);
});

test('an OTP session is limited to auth until the password is configured', async () => {
  assert.equal((await request('/index.html', pending)).status, 303);
  assert.equal((await request('/metrics', pending)).status, 401);
  assert.equal((await request('/auth/password', pending, 'POST')).status, 200);
});

test('only active sessions can load assets and generated reports are not cached', async () => {
  const page = await request('/index.html', active);
  assert.equal(await page.text(), 'application asset');
  assert.equal(page.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(await (await request('/api/calculate', active, 'POST')).text(), 'app action');
  assert.equal((await request('/index.html', 'z'.repeat(48))).status, 303);
});

test('dashboard and metrics API require the administrator role', async () => {
  for (const path of ['/metrics', '/api/admin/metrics']) {
    assert.equal((await request(path, active)).status, 403);
    assert.equal(await (await request(path, admin)).text(), 'aggregate counters');
  }
});

test('cross-origin submissions are rejected before getting to auth or app handlers', async () => {
  const outside = 'https://other.example';
  assert.equal((await request('/auth/recover', null, 'POST', outside)).status, 403);
  assert.equal((await request('/api/calculate', active, 'POST', outside)).status, 403);
  assert.equal((await request('/auth/verify', null)).status, 405);
});

test('session cookie is restricted to HTTPS and unavailable to page scripts', () => {
  assert.equal(sessionSetCookie(active, 900),
    '__Host-finrez=' + active + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=900');
});

test('metrics accept approved event names and pass only the date and the event', () => {
  const seen = [];
  const store = { increment(...fields) { seen.push(fields); } };
  recordMetric(store, 'xlsx_generated', new Date('2026-11-27T10:00:00Z'));
  assert.throws(() => recordMetric(store, 'client_data'), RangeError);
  assert.deepEqual(seen, [['2026-11-27', 'xlsx_generated']]);
});

test('email, OTP and password screens submit only through their own POST routes', async () => {
  const register = await renderAuthPage('register').text();
  const verify = await renderAuthPage('verify', 'invalidCode').text();
  const password = await renderAuthPage('password').text();
  assert.match(register, /method="post" action="\/auth\/register"/);
  assert.match(register, /type="email"/);
  assert.match(verify, /autocomplete="one-time-code"/);
  assert.match(verify, /Код просрочен/);
  assert.equal((password.match(/autocomplete="new-password"/g) || []).length, 2);
  assert.match(password, /name="confirmPassword"/);
});
