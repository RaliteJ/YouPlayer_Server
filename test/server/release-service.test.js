import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createReleaseWorker } from '../../scripts/release-service.mjs';
import { createReleaseControl, writeReleaseJson } from '../../src/server/release-control.js';
import { registerReleaseRoutes } from '../../src/server/release-status.js';
import { manifest, envelope, publicKey } from '../fixtures/release.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-release-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const host = path.join(root, '.updates/host');
  const requestsDirectory = path.join(root, '.updates/requests'), statusDirectory = path.join(root, '.updates/status');
  await fs.mkdir(requestsDirectory, { recursive: true });
  const previous = { envelope: envelope() };
  await writeReleaseJson(path.join(host, 'release-state.json'), previous);
  const calls = [];
  let now = Date.now();
  const deployment = Object.fromEntries(['assertCurrent', 'pull', 'activate', 'healthy'].map(name => [name, async images => { calls.push([name, images]); }]));
  deployment.resume = async () => {};
  const source = { latest: async () => { calls.push(['check']); return { envelope: envelope(manifest('v2.0.0', 2)) }; } };
  const config = { engine: 'docker', project: 'youplayer-server', platform: 'linux/amd64' };
  const options = { root, config, publicKey, source, deployment, now: () => now };
  const control = createReleaseControl({ requestsDirectory, statusDirectory, now: () => now });
  const worker = await createReleaseWorker(options);
  t.after(() => worker.close());
  return { root, host, previous, calls, deployment, options, control, worker, advance: ms => { now += ms; } };
}

test('check then install uses a bound candidate, preserves old images and only reports success after health', async t => {
  const h = await fixture(t);
  assert.deepEqual(h.calls, []);
  await assert.rejects(h.control.request('install', 'a'.repeat(64)), { statusCode: 409 });
  await h.control.request('check');
  await assert.rejects(h.control.request('check'), { statusCode: 409 });
  await h.worker.tick();
  const state = await h.control.status();
  assert.equal(state.canInstall, true);
  await assert.rejects(h.control.request('install', 'a'.repeat(64)), { statusCode: 409 });
  await h.control.request('install', state.candidateId);
  await h.worker.tick();
  assert.equal((await h.control.status()).phase, 'installed');
  assert.equal((await h.control.status()).installedVersion, 'v2.0.0');
  assert.deepEqual(h.calls.map(([name]) => name), ['check', 'assertCurrent', 'pull', 'assertCurrent', 'activate', 'healthy']);
  const stored = JSON.parse(await fs.readFile(path.join(h.host, 'release-state.json')));
  assert.deepEqual(stored.previous, h.previous.envelope);
  await assert.rejects(fs.stat(path.join(h.host, 'transaction.json')), { code: 'ENOENT' });
});

for (const failure of ['pull', 'activate', 'healthy']) test(`failure during ${failure} keeps or restores the previous version`, async t => {
  const h = await fixture(t);
  let failed = false;
  const original = h.deployment[failure];
  h.deployment[failure] = async images => {
    await original(images);
    if (!failed) { failed = true; throw Object.assign(new Error('synthetic-private'), { updateCode: 'health-failed' }); }
  };
  await h.control.request('check'); await h.worker.tick();
  await h.control.request('install', (await h.control.status()).candidateId); await h.worker.tick();
  assert.equal((await h.control.status()).phase, failure === 'pull' ? 'failed' : 'rolled-back');
  assert.equal((await h.control.status()).installedVersion, 'v1.0.0');
  assert.equal(JSON.stringify(await h.control.status()).includes('synthetic-private'), false);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.host, 'release-state.json'))), h.previous);
});

test('failed rollback blocks further updates and retains the recovery journal', async t => {
  const h = await fixture(t);
  h.deployment.healthy = async () => { throw new Error('unhealthy'); };
  await h.control.request('check'); await h.worker.tick();
  await h.control.request('install', (await h.control.status()).candidateId); await h.worker.tick();
  assert.equal((await h.control.status()).phase, 'recovery-required');
  await assert.rejects(h.control.request('check'), { statusCode: 409 });
  assert.ok(await fs.stat(path.join(h.host, 'transaction.json')));
});

test('restart recovers a durable interrupted transaction without fetching a release', async t => {
  const h = await fixture(t);
  await h.worker.close();
  await writeReleaseJson(path.join(h.host, 'transaction.json'), { previous: h.previous });
  const restarted = await createReleaseWorker(h.options);
  assert.equal((await h.control.status()).phase, 'rolled-back');
  assert.deepEqual(h.calls.map(([name]) => name), ['activate', 'healthy']);
  await restarted.close();
});

test('expired candidates, invalid signatures and downgrades never reach deployment', async t => {
  const h = await fixture(t);
  await h.control.request('check'); await h.worker.tick();
  h.advance(31 * 60_000); await h.worker.heartbeat();
  await h.control.request('install', (await h.control.status()).candidateId); await h.worker.tick();
  assert.equal((await h.control.status()).failure, 'stale-candidate');
  for (const next of [envelope(manifest('v0.9.0', 2)), { ...envelope(manifest('v2.0.0', 2)), signature: 'bad' }]) {
    h.options.source.latest = async () => ({ envelope: next });
    await h.control.request('check'); await h.worker.tick();
    assert.equal((await h.control.status()).phase, 'failed');
  }
  assert.deepEqual(h.calls.map(([name]) => name), ['check']);
});

test('status cannot expose host credentials and offline workers refuse requests', async t => {
  const h = await fixture(t);
  await writeReleaseJson(path.join(h.root, '.updates/status/release.json'), {
    heartbeat: Date.now(), phase: 'failed', failure: 'synthetic-private', command: 'synthetic-private', installedVersion: '../../etc/passwd'
  });
  const state = await h.control.status();
  assert.equal(state.installedVersion, null);
  assert.equal(state.failure, 'internal');
  assert.equal(JSON.stringify(state).includes('synthetic-private'), false);
  h.advance(60_000);
  await assert.rejects(h.control.request('check'), { statusCode: 503 });
});

test('install route requires an admin and accepts only the checked candidate identifier', async () => {
  const routes = new Map(), requests = [];
  registerReleaseRoutes({ get: (url, ...handlers) => routes.set(url, handlers), post: (url, ...handlers) => routes.set(url, handlers) }, {
    requireAdmin: (_req, _res, next) => next(), control: { status: async () => ({ online: true }),
      request: async (...args) => { requests.push(args); return { id: 'synthetic' }; } }
  });
  for (const session of [undefined, { userId: 'user', role: 'user' }, { userId: 'admin', role: 'admin' }]) {
    let code = 200, index = 0;
    const handlers = routes.get('/admin/releases/install');
    const response = { status(value) { code = value; return this; }, set() {}, json() {} };
    const next = () => handlers[index++]?.({ session, body: { candidateId: 'a'.repeat(64), command: 'evil', image: 'evil' } }, response, next);
    await next();
    assert.equal(code, !session ? 401 : session.role === 'user' ? 403 : 202);
  }
  assert.deepEqual(requests, [['install', 'a'.repeat(64)]]);
});
