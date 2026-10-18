import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeSecurityJson, createSecurityControl, dependencyLockHash } from '../../src/server/security-control.js';
import { registerSecurityRoutes } from '../../src/server/security-routes.js';
import { createSecurityWorker } from '../../scripts/dependency-audit.mjs';

test('security status hides private data, retains pending rebuild and detects installed corrections', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-security-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requestsDirectory = path.join(root, 'requests'), statusDirectory = path.join(root, 'status');
  const installedLock = path.join(root, 'installed-lock');
  await fs.mkdir(requestsDirectory);
  await fs.writeFile(installedLock, 'old');
  const control = createSecurityControl({ requestsDirectory, statusDirectory, installedLock, now: () => 50_000 });
  const state = { heartbeat: 50_000, phase: 'finished', report: { status: 'vulnerable', checkedAt: '2026-10-11T12:00:00Z',
    before: { critical: 1 }, pendingLockHash: dependencyLockHash('new'), auditedLockHash: dependencyLockHash('new'), token: 'private-token' }, command: 'private-command' };
  await writeSecurityJson(path.join(statusDirectory, 'security.json'), state);
  assert.equal((await control.status()).rebuildRequired, true);
  assert.ok(!JSON.stringify(await control.status()).includes('private'));
  await fs.writeFile(installedLock, 'new');
  assert.equal((await control.status()).rebuildRequired, false);
  assert.equal((await control.status()).installedMatchesAudit, true);
  const results = await Promise.allSettled([control.request('check'), control.request('fix')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 409);
  await fs.rm(path.join(requestsDirectory, 'security.json'));
  await writeSecurityJson(path.join(statusDirectory, 'security.json'), { ...state, phase: 'checking' });
  await assert.rejects(control.request('check'), { statusCode: 409 });
  await writeSecurityJson(path.join(statusDirectory, 'security.json'), { ...state, heartbeat: 0 });
  await assert.rejects(control.request('check'), { statusCode: 503 });
});

test('security host worker only audits on explicit requests and fixes only on fix requests', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-security-worker-'));
  const calls = [];
  let failing = false;
  const worker = await createSecurityWorker({ root, audit: async options => {
    calls.push(options);
    if (failing) throw Object.assign(new Error('synthetic-private-details'), { auditCode: 'tests-failed', stage: 'validation' });
    return { status: 'vulnerable', before: { critical: 1 } };
  } });
  t.after(async () => { await worker.close(); await fs.rm(root, { recursive: true, force: true }); });
  await worker.tick();
  assert.equal(calls.length, 0);
  const control = createSecurityControl({ requestsDirectory: path.join(root, '.updates/requests'), statusDirectory: path.join(root, '.updates/status') });
  await control.request('check');
  await worker.tick();
  assert.equal(calls[0].fix, false);
  assert.equal((await control.status()).phase, 'finished');
  await control.request('fix');
  await worker.tick();
  assert.equal(calls[1].fix, true);
  failing = true;
  await control.request('fix');
  await worker.tick();
  const failed = await control.status();
  assert.deepEqual(failed.failure, { code: 'tests-failed', stage: 'validation' });
  assert.equal(JSON.stringify(failed).includes('synthetic-private'), false);
  await fs.writeFile(path.join(root, '.updates/requests/security.json'), '{"action":"shell"}');
  await worker.tick();
  assert.equal(calls.length, 3);
  assert.equal((await control.status()).phase, 'failed');
});

test('security routes always require an admin session and ignore client commands', async () => {
  const routes = new Map(), calls = [];
  registerSecurityRoutes({ get: (url, ...handlers) => routes.set(`GET ${url}`, handlers), post: (url, ...handlers) => routes.set(`POST ${url}`, handlers) }, {
    requireAdmin: (_req, _res, next) => next(), recordAction: async () => {},
    control: { status: async () => ({}), request: async action => { calls.push(action); return { id: 'job' }; } }
  });
  async function request(route, session) {
    const res = { code: 200, set() {}, status(code) { this.code = code; return this; }, json() {} };
    for (const handler of routes.get(route)) {
      let next = false;
      await handler({ session, body: { command: 'untrusted', url: 'https://untrusted.test' } }, res, () => { next = true; });
      if (!next) break;
    }
    return res.code;
  }
  for (const route of routes.keys()) {
    assert.equal(await request(route, {}), 401);
    assert.equal(await request(route, { userId: 'listener', role: 'user' }), 403);
  }
  assert.equal(calls.length, 0);
  assert.equal(await request('POST /admin/security/fix', { userId: 'manager', role: 'admin' }), 202);
  assert.deepEqual(calls, ['fix']);
});
