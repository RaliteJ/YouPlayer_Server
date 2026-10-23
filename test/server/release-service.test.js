import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createReleaseControl, writeReleaseJson } from '../../src/server/release-control.js';
import { registerReleaseRoutes } from '../../src/server/release-status.js';

test('Admin file protocol binds install requests, rejects concurrent jobs and hides private status fields', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-control-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requestsDirectory = path.join(root, 'requests'), statusDirectory = path.join(root, 'status');
  await fs.mkdir(requestsDirectory);
  let now = Date.now();
  const control = createReleaseControl({ requestsDirectory, statusDirectory, now: () => now });
  await writeReleaseJson(path.join(statusDirectory, 'release.json'), {
    phase: 'available', heartbeat: now, candidateId: 'a'.repeat(64), installedVersion: 'v1.0.0', command: 'private'
  });
  await assert.rejects(control.request('install', 'b'.repeat(64)), { statusCode: 409 });
  await control.request('install', 'a'.repeat(64));
  const job = JSON.parse(await fs.readFile(path.join(requestsDirectory, 'release.json')));
  assert.equal(job.action, 'install'); assert.equal(job.candidateId, 'a'.repeat(64));
  await assert.rejects(control.request('check'), { statusCode: 409 });
  assert.equal(JSON.stringify(await control.status()).includes('private'), false);
  now += 60_000;
  await assert.rejects(control.request('check'), { statusCode: 503 });
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
