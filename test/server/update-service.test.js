import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createUpdateWorker, initializeUpdates } from '../../scripts/update-service.mjs';
import { writeUpdateJson } from '../../src/server/update-control.js';

const previous = { backend: 'a'.repeat(64), frontend: 'b'.repeat(64) };
const next = { backend: 'c'.repeat(64), frontend: 'd'.repeat(64) };
const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
async function harness(t, { unhealthy = false, backupFailure = false } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-update-worker-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await initializeUpdates(root);
	const host = path.join(root, '.updates', 'host');
	await writeUpdateJson(path.join(host, 'config.json'), { repository: 'https://github.com/example/public', publicKey });
	const events = []; let current = { ...previous };
	const options = { root,
		sourceFactory: () => ({
			latest: async () => ({ manifest: { version: 'v2', sequence: 2, images: next } }),
			download: async (_candidate, file, progress) => { events.push('download'); await fs.writeFile(file, 'synthetic'); await progress(100); }
		}),
		runCommand: async (program, args) => {
			if (program === 'podman-compose') {
				const override = JSON.parse(await fs.readFile(args[args.lastIndexOf('-f') + 1], 'utf8'));
				current = Object.fromEntries(Object.entries(override.services).map(([name, config]) => [name, config.image]));
				events.push(current.backend === next.backend ? 'restart-new' : 'restart-old');
				assert.ok(args.includes('--no-build')); assert.ok(args.includes('--no-deps'));
				assert.equal(args.includes('--volumes'), false); return '';
			}
			if (args[0] === 'inspect') {
				if (args.at(-1).includes('Healthcheck')) return JSON.stringify({ Test: ['CMD', 'node', 'health.js'] });
				return current[args[1].includes('backend') ? 'backend' : 'frontend'];
			}
			if (args[0] === 'load') events.push('load');
			return '';
		},
		backup: async () => { events.push('backup'); if (backupFailure) throw new Error('synthetic-private'); return { directory: path.join(root, 'snapshot') }; },
		verify: async () => { events.push('verify-backup'); },
		readiness: async images => { events.push(images.backend === next.backend ? 'healthy-new' : 'healthy-old'); if (unhealthy && images.backend === next.backend) throw new Error('unhealthy'); }
	};
	const worker = createUpdateWorker(options); await worker.initialize();
	return { root, host, worker, options, events, current: () => current };
}

test('public release configuration enables the worker without a Git token', async t => {
	const h = await harness(t);
	assert.equal(h.worker.state().enabled, true);
});

test('installation downloads, loads and verifies backup before restart, then commits the new release', async t => {
	const h = await harness(t);
	const id = randomUUID();
	await writeUpdateJson(path.join(h.root, '.updates', 'requests', 'request.json'), { id, action: 'install', version: 'v2' });
	await h.worker.tick();
	assert.equal(h.worker.state().phase, 'succeeded'); assert.equal(h.worker.state().currentVersion, 'v2');
	assert.deepEqual(h.events, ['download', 'load', 'backup', 'verify-backup', 'restart-new', 'healthy-new']);
	assert.deepEqual(h.current(), next);
	await assert.rejects(fs.stat(path.join(h.host, 'transaction.json')));
	await assert.rejects(fs.stat(path.join(h.host, 'job.json')));
	await assert.rejects(fs.stat(path.join(h.root, 'backups', '.backup-lock')));
});

test('failed readiness restores the exact previous images and health checks', async t => {
	const h = await harness(t, { unhealthy: true });
	await h.worker.processRequest({ id: randomUUID(), action: 'install', version: 'v2' });
	assert.equal(h.worker.state().phase, 'failed'); assert.equal(h.worker.state().rolledBack, true);
	assert.deepEqual(h.current(), previous);
	assert.deepEqual(h.events.slice(-4), ['restart-new', 'healthy-new', 'restart-old', 'healthy-old']);
	const override = JSON.parse(await fs.readFile(path.join(h.host, 'deploy.json'), 'utf8'));
	assert.deepEqual(override.services.backend.healthcheck.test, ['CMD', 'node', 'health.js']);
});

test('backup failure leaves the running version untouched and emits no private details', async t => {
	const h = await harness(t, { backupFailure: true });
	await h.worker.processRequest({ id: randomUUID(), action: 'install', version: 'v2' });
	assert.equal(h.worker.state().phase, 'failed'); assert.deepEqual(h.current(), previous);
	assert.equal(h.events.some(event => event.startsWith('restart-')), false);
	assert.equal(JSON.stringify(h.worker.state()).includes('synthetic-private'), false);
});

test('checking cannot install, and a changed version is rejected before download', async t => {
	const h = await harness(t);
	await h.worker.processRequest({ id: randomUUID(), action: 'check' });
	assert.equal(h.worker.state().phase, 'idle'); assert.equal(h.worker.state().updateAvailable, true);
	assert.deepEqual(h.events, []);
	await h.worker.processRequest({ id: randomUUID(), action: 'install', version: 'v1' });
	assert.equal(h.worker.state().phase, 'failed'); assert.deepEqual(h.events, []);
});

test('worker startup recovers an interrupted restart using the durable transaction', async t => {
	const h = await harness(t);
	await writeUpdateJson(path.join(h.host, 'transaction.json'), { requestId: randomUUID(),
		previous: { images: previous }, active: { version: 'v1', sequence: 1 } });
	const restarted = createUpdateWorker(h.options);
	await restarted.initialize();
	assert.equal(restarted.state().rolledBack, true); assert.equal(restarted.state().currentVersion, 'v1');
	assert.deepEqual(h.current(), previous);
});

test('host worker refuses symlink requests without publishing their private contents', async t => {
	const h = await harness(t);
	const secret = path.join(h.root, 'synthetic-private.json');
	await fs.writeFile(secret, JSON.stringify({ id: 'synthetic-private-detail', action: 'install' }));
	await fs.symlink(secret, path.join(h.root, '.updates', 'requests', 'request.json'));
	await h.worker.tick();
	assert.deepEqual(h.events, []);
	assert.equal(h.worker.state().phase, 'failed');
	assert.equal(JSON.stringify(h.worker.state()).includes('synthetic-private-detail'), false);
	assert.equal((await fs.stat(secret)).isFile(), true);
});
