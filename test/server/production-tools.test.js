import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm, chmod, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { preflight, verifyBackup, writeRestoreOverride, createRelease } from '../../scripts/production.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

test('source releases exclude updater signing keys and private configuration even if tracked', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'youplayer-source-release-'));
	const execute = promisify(execFile);
	try {
		await mkdir(path.join(root, '.updates'), { recursive: true });
		await writeFile(path.join(root, '.updates', 'private-key.pem'), 'synthetic-private-key');
		await writeFile(path.join(root, 'app.js'), 'export const synthetic = true;');
		await execute('git', ['init', '-q'], { cwd: root });
		await execute('git', ['add', '.'], { cwd: root });
		await execute('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test', '-c', 'core.hooksPath=/dev/null',
			'-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic'], { cwd: root });
		for (const label of ['../escape', '.', '..', 'v1/escape', 'v1\\escape']) {
			await assert.rejects(createRelease({ root, label }), /Nom de release invalide/);
		}
		const result = await createRelease({ root, label: 'v1.0.2' });
		assert.equal(path.basename(result.directory), 'v1.0.2');
		const manifest = JSON.parse(await readFile(path.join(result.directory, 'manifest.json'), 'utf8'));
		assert.ok(manifest.files['app.js']);
		assert.equal(Object.keys(manifest.files).some(file => file.startsWith('.updates/')), false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('preflight reports booleans only and rejects unsafe environment permissions and placeholders', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'youplayer-preflight-'));
	const file = path.join(root, '.env');
	try {
		await writeFile(file, 'YOUPLAYER_SESSION_SECRET=synthetic-production-secret-long-enough-123456\nYOUPLAYER_ADMIN_PSEUDO=synthetic-admin\nYOUPLAYER_ADMIN_PASSWORD=synthetic-long-password\n', { mode: 0o600 });
		assert.equal((await preflight({ root })).ok, true);
		assert.ok(!JSON.stringify(await preflight({ root })).includes('synthetic-'));
		await chmod(file, 0o644); assert.equal((await preflight({ root })).ok, false);
		await chmod(file, 0o600); await writeFile(file, 'YOUPLAYER_SESSION_SECRET=replace-with-a-long-random-session-secret\n');
		assert.equal((await preflight({ root })).ok, false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('restore override selects copied data and refuses incomplete mappings or overwrites', async () => {
	const targetRoot = await mkdtemp(path.join(os.tmpdir(), 'youplayer-restore-'));
	try {
		await assert.rejects(writeRestoreOverride({ project: 'synthetic', volumes: {}, targetRoot }), /Volumes courants absents/);
		const volumes = { synthetic_youplayer_data: 'restore-data', synthetic_redis_data: 'restore-redis' };
		await writeRestoreOverride({ project: 'synthetic', volumes, targetRoot });
		const file = path.join(targetRoot, 'restore-compose.json');
		const override = JSON.parse(await readFile(file, 'utf8'));
		assert.deepEqual(override.volumes.youplayer_data, { external: true, name: 'restore-data' });
		assert.deepEqual(override.volumes.redis_data, { external: true, name: 'restore-redis' });
		assert.ok(override.services.backend.volumes[0].startsWith(targetRoot + '/playlists:'));
		assert.equal((await stat(file)).mode & 0o077, 0);
		await assert.rejects(writeRestoreOverride({ project: 'synthetic', volumes, targetRoot }), { code: 'EEXIST' });
	} finally { await rm(targetRoot, { recursive: true, force: true }); }
});
test('existing admin permits removal of bootstrap credentials, but partial OAuth is refused', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'youplayer-preflight-'));
	try {
		const env = 'YOUPLAYER_SESSION_SECRET=synthetic-production-secret-long-enough-123456\n';
		await writeFile(path.join(root, '.env'), env, { mode: 0o600 });
		const dataFile = path.join(root, 'store.json');
		await writeFile(dataFile, JSON.stringify({ version: 1, users: [['1', { role: 'admin' }]] }));
		assert.equal((await preflight({ root, dataFile })).ok, true);
		await writeFile(path.join(root, '.env'), env + 'YOUPLAYER_SPOTIFY_CLIENT_ID=synthetic\n');
		assert.equal((await preflight({ root, dataFile })).ok, false);
	} finally { await rm(root, { recursive: true, force: true }); }
});
test('backup verification rejects malformed manifests and modified or added files', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'youplayer-backup-'));
	try {
		await writeFile(path.join(root, 'manifest.json'), '{ private-synthetic');
		await assert.rejects(verifyBackup(root), /^Error: Manifeste de sauvegarde illisible$/);
		await writeFile(path.join(root, 'manifest.json'), JSON.stringify({ version: 1, volumes: [], files: {} }));
		await verifyBackup(root);
		await writeFile(path.join(root, 'unexpected'), 'synthetic');
		await assert.rejects(verifyBackup(root), /Integrite/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
