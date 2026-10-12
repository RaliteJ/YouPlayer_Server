import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createUpdateWorker, initializeUpdates, runUpdateCommand } from '../../scripts/update-service.mjs';
import { writeUpdateJson } from '../../src/server/update-control.js';
import { installationEnvironment, installationContainers, simulatedDeployment } from '../fixtures/update-deployment.mjs';
import { createDeployment } from '../../scripts/update-deployment.mjs';

const previous = { backend: 'a'.repeat(64), frontend: 'b'.repeat(64) };
const next = { backend: 'c'.repeat(64), frontend: 'd'.repeat(64) };
const publicKey = generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
async function harness(t, { unhealthy = false, backupFailure = false, registry = false, pullFailure = false, wrongImage = false, wrongDigest = false, wrongPlatform = false, releaseVersion = 'v2', installedVersion = 'v1' } = {}) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-update-worker-'));
	t.after(() => fs.rm(root, { recursive: true, force: true }));
	await initializeUpdates(root);
	await fs.writeFile(path.join(root, '.env'), installationEnvironment, { mode: 0o600 });
	await fs.writeFile(path.join(root, 'docker-compose.yml'), 'services: {}\n');
	const host = path.join(root, '.updates', 'host');
	const repositories = ['registry.example.test/youplayer-backend', 'registry.example.test/youplayer-frontend'];
	const refs = Object.fromEntries(['backend', 'frontend'].map((service, index) => [service, `${repositories[index]}@sha256:${String(index + 1).repeat(64)}`]));
	await writeUpdateJson(path.join(host, 'config.json'), { repository: 'https://github.com/example/public', publicKey,
		...(registry ? { allowedImageRepositories: repositories } : {}) });
	const events = []; let current = { ...previous };
	const engine = simulatedDeployment(root, previous);
	const options = { root, initialVersion: installedVersion,
		sourceFactory: () => ({
			latest: async () => ({ manifest: { version: releaseVersion, sequence: 2, images: next,
				...(registry ? { schema: 2, registry: refs, platform: 'linux/amd64' } : {}) } }),
			download: async (_candidate, file, progress) => { events.push('download'); await fs.writeFile(file, 'synthetic'); await progress(100); }
		}),
		runCommand: async (program, args) => {
			if (args[0] === 'info') return wrongPlatform ? 'linux/arm64' : 'linux/amd64';
			if (args[0] === 'pull') {
				assert.ok(args.includes('--tls-verify=true')); assert.ok(args.includes('--policy=always'));
				assert.equal(args[args.indexOf('--platform') + 1], 'linux/amd64');
				events.push('pull'); if (pullFailure) throw new Error('interrupted'); return '';
			}
			if (args[0] === 'image' && args[1] === 'inspect') {
				const service = args[2].includes('backend') ? 'backend' : 'frontend';
				return JSON.stringify([{ Id: `sha256:${wrongImage ? previous[service] : next[service]}`, Os: 'linux', Architecture: 'amd64', RepoDigests: wrongDigest ? [] : [refs[service]] }]);
			}
			const output = await engine.run(program, args);
			if (args[0] === 'start') {
				const container = engine.all.find(c => c.Id === args.at(-1));
				const service = container?.Config.Labels['com.docker.compose.service'];
				if (service && service !== 'redis') {
					current[service] = container.Image.replace(/^sha256:/, '');
					if (service === 'backend') events.push(current.backend === next.backend ? 'restart-new' : 'restart-old');
				}
			}
			if (args[0] === 'load') events.push('load');
			if (args[0] === 'tag') assert.match(args.at(-1), /^localhost\/youplayer-server-(backend|frontend):latest$/);
			return output;
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
	assert.equal(override.engine, 'podman-create-v1');
	assert.deepEqual(override.images, previous);
});

test('backup failure leaves the running version untouched and emits no private details', async t => {
	const h = await harness(t, { backupFailure: true });
	await h.worker.processRequest({ id: randomUUID(), action: 'install', version: 'v2' });
	assert.equal(h.worker.state().phase, 'failed'); assert.deepEqual(h.current(), previous);
	assert.equal(h.events.some(event => event.startsWith('restart-')), false);
	assert.equal(JSON.stringify(h.worker.state()).includes('synthetic-private'), false);
});

test('candidate creation failure does not recreate the unchanged running application', async t => {
	const h = await harness(t);
	let count = 0;
	const worker = createUpdateWorker({ ...h.options, runCommand: async (p, a) => {
		if (a[0] === 'create' && ++count === 2) throw new Error('synthetic-create-failure');
		return h.options.runCommand(p, a);
	} });
	await worker.initialize();
	await worker.processRequest({ id: randomUUID(), action: 'install', version: 'v2' });
	assert.equal(worker.state().phase, 'failed');
	assert.equal(worker.state().recoveryRequired, false);
	assert.equal(h.events.some(e => e.startsWith('restart-')), false);
	assert.deepEqual(h.current(), previous);
	await assert.rejects(fs.stat(path.join(h.host, 'transaction.json')), { code: 'ENOENT' });
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
	const previousDeployment = await createDeployment({ root: h.root, project: 'youplayer-server', runCommand: h.options.runCommand }).snapshot();
	await writeUpdateJson(path.join(h.host, 'transaction.json'), { requestId: randomUUID(),
		previous: previousDeployment, active: { version: 'v1', sequence: 1 } });
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

test('registry installation pulls immutable images then uses the existing backup and deployment transaction', async t => {
	const h = await harness(t, { registry: true });
	await h.worker.processRequest({ id: randomUUID(), action: 'install', version: 'v2' });
	assert.equal(h.worker.state().phase, 'succeeded');
	assert.deepEqual(h.events, ['pull', 'pull', 'backup', 'verify-backup', 'restart-new', 'healthy-new']);
	assert.deepEqual(h.current(), next);
});

for (const failure of ['pullFailure', 'wrongImage', 'wrongDigest', 'wrongPlatform']) {
	test(`registry ${failure} leaves running services and data untouched`, async t => {
		const h = await harness(t, { registry: true, [failure]: true });
		await h.worker.processRequest({ id: randomUUID(), action: 'install', version: 'v2' });
		assert.equal(h.worker.state().phase, 'failed');
		assert.deepEqual(h.current(), previous);
		assert.equal(h.events.includes('backup'), false);
		assert.equal(h.events.some(event => event.startsWith('restart-')), false);
	});
}

test('registry unhealthy deployment restores the previous exact images', async t => {
	const h = await harness(t, { registry: true, unhealthy: true });
	await h.worker.processRequest({ id: randomUUID(), action: 'install', version: 'v2' });
	assert.equal(h.worker.state().rolledBack, true);
	assert.deepEqual(h.current(), previous);
});

test('registry interrupted pull can be retried on startup from the durable job', async t => {
	const h = await harness(t, { registry: true });
	await writeUpdateJson(path.join(h.host, 'job.json'), { id: randomUUID(), action: 'install', version: 'v2' });
	const restarted = createUpdateWorker(h.options);
	await restarted.initialize();
	assert.equal(restarted.state().phase, 'succeeded');
	assert.deepEqual(h.current(), next);
});

test('registry release cannot bypass the configured repository allowlist', async t => {
	const h = await harness(t, { registry: true });
	await writeUpdateJson(path.join(h.host, 'config.json'), { repository: 'https://github.com/example/public', publicKey, allowedImageRepositories: ['registry.example.test/unrelated'] });
	await h.worker.processRequest({ id: randomUUID(), action: 'install', version: 'v2' });
	assert.equal(h.worker.state().phase, 'failed'); assert.deepEqual(h.events, []);
});

test('registry signed old sequence is refused before pulling images', async t => {
	const h = await harness(t, { registry: true });
	await writeUpdateJson(path.join(h.host, 'active.json'), { version: 'v3', sequence: 3, images: previous });
	const restarted = createUpdateWorker(h.options); await restarted.initialize();
	await restarted.processRequest({ id: randomUUID(), action: 'install', version: 'v2' });
	assert.equal(restarted.state().phase, 'failed'); assert.deepEqual(h.events, []);
});

for (const releaseVersion of ['v1.0.3', 'v1.0.4']) {
	test(`higher signed sequence cannot install ${releaseVersion} over v1.0.4`, async t => {
		const h = await harness(t, { registry: true, installedVersion: 'v1.0.4', releaseVersion });
		await h.worker.processRequest({ id: randomUUID(), action: 'check' });
		assert.equal(h.worker.state().updateAvailable, false);
		await h.worker.processRequest({ id: randomUUID(), action: 'install', version: releaseVersion });
		assert.equal(h.worker.state().phase, 'failed');
		assert.deepEqual(h.events, []);
		assert.deepEqual(h.current(), previous);
	});
}

test('first installation derives its baseline from the host tag, then falls back to package version', async t => {
	const h = await harness(t);
	const tagged = createUpdateWorker({ ...h.options, initialVersion: undefined,
		runCommand: async (program, args) => program === 'git' ? 'v1.0.4\n' : h.options.runCommand(program, args) });
	await tagged.initialize();
	assert.equal(tagged.state().currentVersion, 'v1.0.4');
	await fs.mkdir(path.join(h.root, 'src'));
	await fs.writeFile(path.join(h.root, 'src', 'package.json'), JSON.stringify({ version: '1.0.3' }));
	const untagged = createUpdateWorker({ ...h.options, initialVersion: undefined });
	await untagged.initialize();
	assert.equal(untagged.state().currentVersion, '1.0.3');
	await writeUpdateJson(path.join(h.host, 'active.json'), { version: 'v1.0.5', sequence: 5 });
	const installed = createUpdateWorker({ ...h.options, initialVersion: undefined });
	await installed.initialize();
	assert.equal(installed.state().currentVersion, 'v1.0.5');
});

test('a second stack sharing data blocks installation before download or backup', async t => {
	const h = await harness(t);
	const worker = createUpdateWorker({ ...h.options, runCommand: async (program, args) => {
		const output = await h.options.runCommand(program, args);
		if (args[0] !== 'inspect') return output;
		const all = JSON.parse(output);
		const duplicate = structuredClone(all[0]);
		duplicate.Id = 'f'.repeat(64); duplicate.Name = 'youplayer_backend_1';
		duplicate.Config.Labels['io.podman.compose.project'] = 'youplayer';
		return JSON.stringify([...all, duplicate]);
	} });
	await worker.initialize();
	await worker.processRequest({ id: randomUUID(), action: 'install', version: 'v2' });
	assert.deepEqual(worker.state().failure, { code: 'project-conflict', stage: 'preflight' });
	assert.equal(worker.state().updateAvailable, false);
	assert.deepEqual(h.events, []);
});

test('a failed rollback keeps the transaction and job, disables installs and can be recovered on restart', async t => {
	const h = await harness(t);
	const worker = createUpdateWorker({ ...h.options, readiness: async () => { throw new Error('synthetic-private-health'); } });
	await worker.initialize();
	const job = { id: randomUUID(), action: 'install', version: 'v2' };
	await writeUpdateJson(path.join(h.host, 'job.json'), job);
	await worker.processRequest(job);
	assert.equal(worker.state().phase, 'failed');
	assert.equal(worker.state().recoveryRequired, true);
	assert.equal(worker.state().rolledBack, false);
	assert.equal(worker.state().enabled, false);
	await worker.heartbeat();
	assert.equal(worker.state().enabled, false);
	assert.equal(JSON.stringify(worker.state()).includes('synthetic-private'), false);
	assert.equal(JSON.parse(await fs.readFile(path.join(h.host, 'job.json'), 'utf8')).id, job.id);
	assert.ok(await fs.stat(path.join(h.host, 'transaction.json')));
	await assert.rejects(worker.processRequest({ id: randomUUID(), action: 'check' }), { updateCode: 'recovery-required' });
	const recovered = createUpdateWorker(h.options);
	await recovered.initialize();
	assert.equal(recovered.state().rolledBack, true);
	assert.equal(recovered.state().recoveryRequired, false);
	assert.deepEqual(h.current(), previous);
	await assert.rejects(fs.stat(path.join(h.host, 'transaction.json')), { code: 'ENOENT' });
	await assert.rejects(fs.stat(path.join(h.host, 'job.json')), { code: 'ENOENT' });
});

test('legacy transactions without recorded resources require host recovery instead of guessing volumes', async t => {
	const h = await harness(t);
	await writeUpdateJson(path.join(h.host, 'transaction.json'), { requestId: randomUUID(),
		previous: { images: previous }, active: { version: 'v1', sequence: 1 } });
	const worker = createUpdateWorker(h.options);
	await worker.initialize();
	assert.deepEqual(worker.state().failure, { code: 'recovery-required', stage: 'rollback' });
	assert.equal(worker.state().enabled, false);
	assert.equal(worker.state().recoveryRequired, true);
	assert.deepEqual(h.events, []);
	assert.ok(await fs.stat(path.join(h.host, 'transaction.json')));
});

test('readiness accepts Podman Healthcheck status and marks a version verified only after installation', async t => {
	const h = await harness(t);
	let probes = 0;
	const worker = createUpdateWorker({ ...h.options, readiness: undefined, readinessProbe: async () => { probes++; return true; },
		runCommand: async (program, args) => {
			const output = await h.options.runCommand(program, args);
			if (args[0] !== 'inspect') return output;
			return JSON.stringify(JSON.parse(output).map(c => {
				if (c.State.Health) { c.State.Healthcheck = c.State.Health; delete c.State.Health; } return c;
			}));
		} });
	await worker.initialize();
	await worker.processRequest({ id: randomUUID(), action: 'check' });
	assert.equal(worker.state().versionVerified, false);
	await worker.processRequest({ id: randomUUID(), action: 'install', version: 'v2' });
	assert.equal(worker.state().phase, 'succeeded');
	assert.equal(worker.state().versionVerified, true);
	assert.equal(probes, 1);
	await worker.processRequest({ id: randomUUID(), action: 'check' });
	assert.equal(worker.state().versionVerified, true);
});

test('an unhealthy deployment times out and cannot claim a successful rollback', async t => {
	const h = await harness(t);
	const worker = createUpdateWorker({ ...h.options, readiness: undefined, readinessProbe: async () => false, wait: async () => {} });
	await worker.initialize();
	await worker.processRequest({ id: randomUUID(), action: 'install', version: 'v2' });
	assert.deepEqual(worker.state().failure, { code: 'unhealthy', stage: 'rollback' });
	assert.equal(worker.state().recoveryRequired, true);
	assert.equal(worker.state().rolledBack, false);
});

test('manual image changes during download are preserved and cancel installation before backup', async t => {
	const h = await harness(t);
	let downloaded = false;
	const worker = createUpdateWorker({ ...h.options,
		sourceFactory: settings => {
			const source = h.options.sourceFactory(settings);
			return { ...source, download: async (...args) => { await source.download(...args); downloaded = true; } };
		},
		runCommand: async (program, args) => {
			const output = await h.options.runCommand(program, args);
			if (args[0] !== 'inspect' || !downloaded) return output;
			const all = JSON.parse(output);
			all[0].Image = 'f'.repeat(64);
			return JSON.stringify(all);
		} });
	await worker.initialize();
	await worker.processRequest({ id: randomUUID(), action: 'install', version: 'v2' });
	assert.deepEqual(worker.state().failure, { code: 'deployment-changed', stage: 'preflight' });
	assert.deepEqual(h.events, ['download', 'load']);
});

test('actual child command failures classify port conflicts and keep stderr private on the host', async t => {
	const h = await harness(t);
	const error = await runUpdateCommand(process.execPath, ['-e',
		'require("node:fs").writeSync(2,"synthetic-private-detail: address already in use");process.exitCode=1;'], h.root).catch(error => error);
	const file = path.join(h.host, 'last-command.log');
	assert.equal(error.updateCode, 'port-conflict', await fs.readFile(file, 'utf8'));
	assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
	assert.match(await fs.readFile(file, 'utf8'), /synthetic-private-detail/);
});

test('matching signed running images establish the installed version without a deployment', async t => {
	const h = await harness(t);
	const worker = createUpdateWorker({ ...h.options, sourceFactory: settings => {
		const source = h.options.sourceFactory(settings);
		return { ...source, latest: async () => {
			const candidate = await source.latest();
			candidate.manifest.images = previous;
			return candidate;
		} };
	} });
	await worker.initialize();
	await worker.processRequest({ id: randomUUID(), action: 'check' });
	assert.equal(worker.state().currentVersion, 'v2');
	assert.equal(worker.state().versionVerified, true);
	assert.equal(worker.state().updateAvailable, false);
	assert.deepEqual(h.events, []);
	assert.deepEqual(JSON.parse(await fs.readFile(path.join(h.host, 'active.json'), 'utf8')), { version: 'v2', sequence: 2, images: previous });
});

test('a timed-out deployment command also terminates its child process before rollback', async t => {
	if (process.platform === 'win32') return t.skip('POSIX process groups');
	const h = await harness(t);
	const ready = path.join(h.root, 'child-ready');
	const late = path.join(h.root, 'late-mutation');
	const script = path.join(h.root, 'timeout-child.mjs');
	await fs.writeFile(script, `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(ready)}, 'ready');setTimeout(() => fs.writeFileSync(${JSON.stringify(late)}, 'late'), 1500);`);
	await assert.rejects(runUpdateCommand(process.execPath, ['--input-type=module', '-e',
		`import {spawn} from 'node:child_process';spawn(process.execPath, [${JSON.stringify(script)}], {stdio:'inherit'});setInterval(()=>{}, 1000);`], h.root, process.env, 700),
		{ updateCode: 'command-timeout' });
	assert.ok(await fs.stat(ready));
	await new Promise(resolve => setTimeout(resolve, 1600));
	await assert.rejects(fs.stat(late), { code: 'ENOENT' });
});
