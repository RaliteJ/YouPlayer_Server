import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHealthRoutes, checkWritableDirectories } from '../../src/server/health-routes.js';

function harness(checkDependencies) {
	const routes = new Map();
	registerHealthRoutes({ get(path, guard, handler) { routes.set(path, handler); assert.equal(typeof guard, 'function'); } }, { checkDependencies });
	return async path => {
		const res = { statusCode: 200, headers: {}, set(key, value) { this.headers[key] = value; return this; },
			status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
		await routes.get(path)({}, res);
		return res;
	};
}
test('liveness answers without depending on Redis or storage and disables caching', async () => {
	const request = harness(async () => { throw new Error('Must not be called'); });
	const res = await request('/health/live');
	assert.equal(res.statusCode, 200); assert.deepEqual(res.body, { status: 'ok' });
	assert.equal(res.headers['Cache-Control'], 'no-store');
});
test('readiness requires dependencies and hides every failure detail', async () => {
	for (const fails of [false, true]) {
		let calls = 0;
		const request = harness(async () => { calls++; if (fails) throw new Error('private-fixture-secret'); });
		const res = await request('/health/ready');
		assert.equal(calls, 1); assert.equal(res.statusCode, fails ? 503 : 200);
		assert.deepEqual(res.body, { status: fails ? 'unavailable' : 'ok' });
		assert.equal(res.headers['Cache-Control'], 'no-store');
	}
});
test('readiness checks actual writable directories and rejects a missing directory', async () => {
	await checkWritableDirectories([process.cwd()]);
	await assert.rejects(checkWritableDirectories(['/a-synthetic-directory-that-does-not-exist']));
});
