import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createUpdateControl, writeUpdateJson } from '../../src/server/update-control.js';
import { registerUpdateRoutes } from '../../src/server/update-routes.js';

test('update queue publishes complete requests once, hides private status and rejects busy or stale agents', async t => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-update-control-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	const requestsDirectory = path.join(root, 'requests'), statusDirectory = path.join(root, 'status');
	await fs.mkdir(requestsDirectory);
	const control = createUpdateControl({ requestsDirectory, statusDirectory, now: () => 50_000 });
	const status = { heartbeat: 50_000, enabled: true, phase: 'idle', updateAvailable: true, latestVersion: 'v2', token: 'synthetic-private', repository: 'private' };
	await writeUpdateJson(path.join(statusDirectory, 'status.json'), status);
	assert.equal(JSON.stringify(await control.status()).includes('synthetic-private'), false);
	await assert.rejects(control.request('install', 'v1'), { statusCode: 409 });
	await assert.rejects(control.request('shell'), { statusCode: 400 });
	const results = await Promise.allSettled([control.request('check'), control.request('check')]);
	assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
	assert.equal(results.find(result => result.status === 'rejected').reason.statusCode, 409);
	const queued = JSON.parse(await fs.readFile(path.join(requestsDirectory, 'request.json'), 'utf8'));
	assert.equal(queued.action, 'check'); assert.match(queued.id, /^[a-f0-9-]{36}$/);
	await fs.rm(path.join(requestsDirectory, 'request.json'));
	await writeUpdateJson(path.join(statusDirectory, 'status.json'), { ...status, phase: 'restarting' });
	await assert.rejects(control.request('check'), { statusCode: 409 });
	await writeUpdateJson(path.join(statusDirectory, 'status.json'), { ...status, heartbeat: 0 });
	await assert.rejects(control.request('check'), { statusCode: 503 });
});

test('update endpoints require a real admin session even when the supplied auth guard allows local access', async () => {
	const routes = new Map(), jobs = [], audits = [];
	registerUpdateRoutes({
		get: (path, ...handlers) => routes.set('GET ' + path, handlers),
		post: (path, ...handlers) => routes.set('POST ' + path, handlers)
	}, { requireAdmin: (_req, _res, next) => next(), recordAction: async (...args) => audits.push(args),
		control: { status: async () => ({ enabled: true }), request: async (...args) => { jobs.push(args); return { id: 'job' }; } } });
	async function request(route, session, body = {}) {
		const res = { statusCode: 200, set() {}, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; } };
		for (const handler of routes.get(route)) {
			let next = false;
			await handler({ session, body }, res, () => { next = true; });
			if (!next) break;
		}
		return res;
	}
	for (const route of routes.keys()) {
		assert.equal((await request(route, {})).statusCode, 401);
		assert.equal((await request(route, { userId: 'user', role: 'user' })).statusCode, 403);
	}
	assert.equal(jobs.length, 0);
	assert.equal((await request('POST /admin/updates/install', { userId: 'admin', role: 'admin' }, { version: 'v2', url: 'https://untrusted.test', command: 'rm' })).statusCode, 202);
	assert.deepEqual(jobs, [['install', 'v2']]); assert.equal(audits.length, 1);
});
