import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createPilot } from './worker.mjs';
import { createIdentityProvider } from './supabase.mjs';

const origin = 'https://fin-rez.example';

function setup() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));
  const DB = {
    prepare(sql) {
      return { bind(...args) {
        const statement = sqlite.prepare(sql);
        return { first: () => statement.get(...args), run: () => statement.run(...args), all: () => ({ results: statement.all(...args) }) };
      } };
    },
    async batch(queries) {
      sqlite.exec('BEGIN');
      try {
        for (const query of queries) query.run();
        sqlite.exec('COMMIT');
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  const mail = new Map();
  const passwords = new Map();
  const getUser = email => ({ id: 'id:' + email, email, email_confirmed_at: '2026-11-27T00:00:00Z' });
  const identity = {
    async sendCode(email, purpose) { mail.set(email, { value: '040506', purpose }); return { data: {} }; },
    async verifyCode(email, code, purpose) {
      const sent = mail.get(email);
      if (sent?.value !== code || sent.purpose !== purpose) return {};
      mail.delete(email);
      return { data: { user: getUser(email), access_token: email } };
    },
    async setPassword(email, password) { passwords.set(email, password); return { data: getUser(email) }; },
    async signIn(email, password) { return passwords.get(email) === password ? { data: { user: getUser(email) } } : {}; }
  };
  let clock = Math.floor(Date.now() / 1000);
  const env = { DB, ORIGIN: origin, RATE_KEY: 'x'.repeat(40), ADMIN_EMAIL: 'admin@example.test' };
  const server = createPilot(env, identity, () => clock);
  function req(path, { form, cookie, ip = '192.0.2.1' } = {}) {
    const headers = new Headers({ 'CF-Connecting-IP': ip });
    if (cookie) headers.set('Cookie', cookie);
    if (form) headers.set('Origin', origin);
    return server(new Request(origin + path, { method: form ? 'POST' : 'GET', headers, body: form && new URLSearchParams(form) }));
  }
  return { req, mail, advance: seconds => { clock += seconds; } };
}

function cookieOf(response) {
  return response.headers.get('Set-Cookie')?.split(';')[0];
}

const email = 'member@example.test';
const original = 'ExamplePassword0001';
const changed = 'ExamplePassword0002';

async function register(req, account, password) {
  const start = await req('/auth/register', { form: { email: account } });
  assert.match(await start.text(), /подтвердите электронную почту/i);
  const verify = await req('/auth/verify', { form: { code: '040506' }, cookie: cookieOf(start) });
  assert.match(await verify.text(), /создайте пароль/i);
  const pending = cookieOf(verify);
  assert.equal((await req('/', { cookie: pending })).headers.get('Location'), '/login');
  const mismatch = await req('/auth/password', { form: { password, confirmPassword: 'another-string' }, cookie: pending });
  assert.match(await mismatch.text(), /Пароли должны совпадать/);
  const result = await req('/auth/password', { form: { password, confirmPassword: password }, cookie: pending });
  assert.equal(result.headers.get('Location'), '/login');
  const retry = await req('/auth/password', { form: { password, confirmPassword: password }, cookie: pending });
  assert.match(await retry.text(), /истёк/);
  const login = await req('/auth/login', { form: { email: account, password } });
  assert.equal(login.headers.get('Location'), '/');
  return cookieOf(login);
}

test('registration, email/password sign-in, server FIFO and logout', async () => {
  const { req } = setup();
  assert.equal((await req('/api/calculate', { form: {} })).status, 401);
  const active = await register(req, email, original);
  assert.match(await (await req('/api/calculate', { form: {}, cookie: active })).text(), /560,00 USD/);
  assert.equal((await req('/metrics', { cookie: active })).status, 403);
  await req('/auth/logout', { form: {}, cookie: active });
  assert.equal((await req('/api/calculate', { form: {}, cookie: active })).status, 401);
});

test('recovery changes the password and revokes existing Fin_rez sessions', async () => {
  const { req, advance } = setup();
  const oldSession = await register(req, email, original);
  advance(120);
  const start = await req('/auth/recover', { form: { email } });
  const verify = await req('/auth/verify', { form: { code: '040506' }, cookie: cookieOf(start) });
  const result = await req('/auth/password', { form: { password: changed, confirmPassword: changed }, cookie: cookieOf(verify) });
  assert.equal(result.headers.get('Location'), '/login');
  assert.equal((await req('/', { cookie: oldSession })).headers.get('Location'), '/login');
  assert.match(await (await req('/auth/login', { form: { email, password: original } })).text(), /Проверьте электронную почту и пароль/);
  assert.equal((await req('/auth/login', { form: { email, password: changed } })).headers.get('Location'), '/');
});

test('wrong and expired codes are rejected and unknown emails get a neutral response', async () => {
  const { req, mail, advance } = setup();
  const unknown = await req('/auth/recover', { form: { email: 'unknown@example.test' } });
  assert.match(await unknown.text(), /Если адрес подходит/);
  assert.equal(mail.size, 0);
  const start = await req('/auth/register', { form: { email } });
  const wrong = await req('/auth/verify', { form: { code: '999999' }, cookie: cookieOf(start) });
  assert.match(await wrong.text(), /Код просрочен или введён неверно/);
  advance(601);
  const expired = await req('/auth/verify', { form: { code: '040506' }, cookie: cookieOf(start) });
  assert.match(await expired.text(), /истёк/);
});

test('admin metrics contain aggregate counts with neither email nor passwords', async () => {
  const { req } = setup();
  const active = await register(req, 'admin@example.test', original);
  await req('/api/calculate', { form: {}, cookie: active });
  assert.match(await (await req('/metrics', { cookie: active })).text(), /Успешные входы/);
  const content = await (await req('/api/admin/metrics', { cookie: active })).json();
  assert(content.some(row => row.event === 'calculation_succeeded' && row.count === 1));
  assert(content.every(row => Object.keys(row).sort().join(',') === 'count,day,event'));
});

test('Supabase adapter uses separate registration and recovery code routes', async () => {
  const sent = [];
  const identity = createIdentityProvider({ url: 'https://provider.example.test', key: 'project-key', http: async (url, options) => {
    sent.push([url, options.method, JSON.parse(options.body), options.headers.Authorization || null]);
    return Response.json({});
  } });
  await identity.sendCode(email, 'register');
  await identity.sendCode(email, 'recover');
  await identity.verifyCode(email, '321654', 'recover');
  await identity.setPassword('server-held-token', 'example-secret');
  assert.deepEqual(sent.map(([url, method, body, bearer]) => [new URL(url).pathname, method, body.type, bearer]), [
    ['/auth/v1/otp', 'POST', undefined, null], ['/auth/v1/recover', 'POST', undefined, null],
    ['/auth/v1/verify', 'POST', 'recovery', null], ['/auth/v1/user', 'PUT', undefined, 'Bearer server-held-token']
  ]);
});
