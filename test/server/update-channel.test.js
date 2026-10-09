import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createGitReleaseSource, validateUpdateManifest, compareReleaseVersions } from '../../scripts/update-channel.mjs';
import { prepareSignedUpdate } from '../../scripts/prepare-update.mjs';
import { buildUpdateRelease } from '../../scripts/build-update-release.mjs';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const archive = Buffer.from('synthetic image archive');

test('stable release versions compare numeric components and reject ambiguous labels', () => {
	assert.equal(compareReleaseVersions('v1.10.0', 'v1.9.9'), 1);
	assert.equal(compareReleaseVersions('v1.0.3', 'v1.0.4'), -1);
	assert.equal(compareReleaseVersions('v2', '2.0.0'), 0);
	assert.equal(compareReleaseVersions('v2.0.0', 'v1.99.99'), 1);
	for (const version of ['latest', 'v1.01.0', 'v1.2.3-rc.1', 'v1.2.3+build', null]) {
		assert.throws(() => compareReleaseVersions(version, 'v1'));
	}
});
const manifest = { schema: 1, version: 'v2', sequence: 2, images: { backend: 'a'.repeat(64), frontend: 'b'.repeat(64) },
	archive: { name: 'youplayer-images.tar', size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') } };
function signed(value) {
	const payload = Buffer.from(JSON.stringify(value));
	return { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') };
}

const registryManifest = { schema: 2, version: 'v2', sequence: 2, images: manifest.images, platform: 'linux/amd64', registry: {
	backend: `registry.example.test/youplayer-backend@sha256:${'c'.repeat(64)}`,
	frontend: `registry.example.test/youplayer-frontend@sha256:${'d'.repeat(64)}`
} };

test('signed registry manifests require immutable qualified references and a single supported platform', () => {
	assert.deepEqual(validateUpdateManifest(signed(registryManifest), publicKey), registryManifest);
	for (const patch of [ { platform: 'linux/unknown' }, { archive: manifest.archive },
		...['registry.example.test/app:latest', 'backend@sha256:' + 'c'.repeat(64),
			'https://registry.example.test/app@sha256:' + 'c'.repeat(64),
			'registry.example.test/app@evil@sha256:' + 'c'.repeat(64),
			'registry.example.test/../app@sha256:' + 'c'.repeat(64)].map(backend => ({ registry: { ...registryManifest.registry, backend } })) ]) {
		assert.throws(() => validateUpdateManifest(signed({ ...registryManifest, ...patch }), publicKey));
	}
});

test('registry release discovery needs no archive but requires explicitly approved repositories', async () => {
	const options = { fetchImpl: async url => url.endsWith('/releases/latest')
		? Response.json({ tag_name: 'v2', assets: [{ name: 'youplayer-update.json', url: 'https://api.github.com/assets/manifest' }] })
		: Response.json(signed(registryManifest)) };
	const config = { repository: 'https://github.com/example/public', publicKey };
	await assert.rejects(createGitReleaseSource(config, options).latest(), /Registre non configure/);
	await assert.rejects(createGitReleaseSource({ ...config, allowedImageRepositories: ['registry.example.test/other'] }, options).latest(), /Depot image refuse/);
	const source = createGitReleaseSource({ ...config, allowedImageRepositories: Object.values(registryManifest.registry).map(ref => ref.split('@')[0]) }, options);
	assert.deepEqual(await source.latest(), { manifest: registryManifest });
});

test('registry publisher signs pushed manifest digests separately from local image IDs without exporting an archive', async t => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-registry-publisher-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const keyFile = path.join(directory, 'signing.pem');
	await fs.writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
	const calls = [];
	const result = await buildUpdateRelease('v2', keyFile, { registryPrefix: 'registry.example.test/youplayer',
		releaseFactory: async () => ({ directory }), runPodman: async args => {
			calls.push(args);
			if (args[0] === 'image') return args.at(-1).includes('Architecture') ? 'linux/amd64' : manifest.images[args[2].includes('backend') ? 'backend' : 'frontend'];
			if (args[0] === 'push') await fs.writeFile(args[args.indexOf('--digestfile') + 1], `sha256:${args.at(-1).includes('backend') ? 'c'.repeat(64) : 'd'.repeat(64)}`);
			return '';
		} });
	const value = validateUpdateManifest(JSON.parse(await fs.readFile(path.join(result.directory, 'youplayer-update.json'), 'utf8')), publicKey);
	assert.deepEqual(value.registry, registryManifest.registry);
	assert.deepEqual(value.images, manifest.images);
	assert.equal(value.platform, 'linux/amd64');
	assert.equal(calls.some(args => args[0] === 'save'), false);
	assert.ok(calls.filter(args => args[0] === 'build').every(args => args.includes('--layers') && args.includes('--cache-from') && args.includes('--cache-to')));
	assert.deepEqual(await fs.readdir(result.directory), ['youplayer-update.json']);
});

test('release verification rejects tampering, unknown schema and invalid images', () => {
	assert.deepEqual(validateUpdateManifest(signed(manifest), publicKey), manifest);
	const forged = signed(manifest); forged.payload = Buffer.from(JSON.stringify({ ...manifest, version: 'evil' })).toString('base64');
	assert.throws(() => validateUpdateManifest(forged, publicKey));
	for (const value of [{ ...manifest, schema: 2 }, { ...manifest, images: { ...manifest.images, backend: '--shell' } },
		{ ...manifest, archive: { ...manifest.archive, size: 11 * 1024 ** 3 } }]) {
		assert.throws(() => validateUpdateManifest(signed(value), publicKey));
	}
});

test('public GitHub assets need no authentication and verify downloads before publishing them', async t => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-update-download-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const calls = [];
	const source = createGitReleaseSource({ repository: 'https://github.com/example/public', publicKey, token: 'synthetic-token' }, {
		fetchImpl: async (url, options) => {
			calls.push({ url, options });
			if (url.endsWith('/releases/latest')) return Response.json({ tag_name: 'v2', assets: [
				{ name: 'youplayer-update.json', url: 'https://api.github.com/assets/manifest' },
				{ name: 'youplayer-images.tar', url: 'https://api.github.com/assets/archive' } ] });
			if (url.endsWith('/manifest')) return Response.json(signed(manifest));
			if (url.endsWith('/archive')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/download' } });
			return new Response(archive);
		}
	});
	const candidate = await source.latest();
	const destination = path.join(directory, 'images.tar');
	await source.download(candidate, destination);
	assert.deepEqual(await fs.readFile(destination), archive);
	assert.ok(calls.every(call => call.options.headers.Authorization === undefined && call.options.headers['PRIVATE-TOKEN'] === undefined));
	const bad = { ...candidate, manifest: { ...manifest, archive: { ...manifest.archive, sha256: '0'.repeat(64) } } };
	await assert.rejects(source.download(bad, path.join(directory, 'bad.tar')));
	await assert.rejects(fs.stat(path.join(directory, 'bad.tar')));
	await assert.rejects(fs.stat(path.join(directory, 'bad.tar.partial')));
});

test('release redirects cannot send requests to an unapproved origin', async () => {
	let calls = 0;
	const source = createGitReleaseSource({ repository: 'https://github.com/example/public', publicKey, token: 'synthetic-token' }, {
		fetchImpl: async () => { calls++; return new Response(null, { status: 302, headers: { location: 'https://untrusted.test/steal' } }); }
	});
	await assert.rejects(source.latest()); assert.equal(calls, 1);
});

test('public GitLab latest release links use the configured repository origin without authentication', async () => {
	const source = createGitReleaseSource({ repository: 'https://git.example.test/group/public', provider: 'gitlab', publicKey, token: 'synthetic-token' }, {
		fetchImpl: async (url, options) => {
			assert.equal(options.headers['PRIVATE-TOKEN'], undefined);
			assert.equal(options.headers.Authorization, undefined);
			if (url.includes('/api/v4/')) return Response.json({ tag_name: 'v2', assets: { links: [
				{ name: 'youplayer-update.json', url: 'https://git.example.test/manifest' },
				{ name: 'youplayer-images.tar', url: 'https://git.example.test/archive' } ] } });
			return Response.json(signed(manifest));
		}
	});
	assert.equal((await source.latest()).manifest.version, 'v2');
});

test('publisher prepares two private release assets with a verifiable signature', async t => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-update-publisher-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	await fs.writeFile(path.join(directory, 'images.tar'), archive);
	await fs.writeFile(path.join(directory, 'images.json'), JSON.stringify({ images: manifest.images, archives: { 'images.tar': manifest.archive.sha256 } }));
	const keyFile = path.join(directory, 'signing.pem');
	await fs.writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
	const result = await prepareSignedUpdate({ releaseDirectory: directory, privateKeyFile: keyFile, version: 'v2', sequence: 2 });
	const envelope = JSON.parse(await fs.readFile(path.join(result.directory, 'youplayer-update.json'), 'utf8'));
	assert.deepEqual(validateUpdateManifest(envelope, publicKey), manifest);
	assert.equal((await fs.stat(path.join(result.directory, 'youplayer-images.tar'))).mode & 0o077, 0);
});

test('failed registry publication never creates an installable signed manifest', async t => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-registry-failure-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const keyFile = path.join(directory, 'signing.pem');
	await fs.writeFile(keyFile, keys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
	await assert.rejects(buildUpdateRelease('v2', keyFile, { registryPrefix: 'registry.example.test/youplayer',
		releaseFactory: async () => ({ directory }), runPodman: async args => {
			if (args[0] === 'image') return args.at(-1).includes('Architecture') ? 'linux/amd64' : manifest.images[args[2].includes('backend') ? 'backend' : 'frontend'];
			if (args[0] === 'push') {
				if (args.at(-1).includes('frontend')) throw new Error('synthetic interrupted push');
				await fs.writeFile(args[args.indexOf('--digestfile') + 1], `sha256:${'c'.repeat(64)}`);
			}
			return '';
		} }));
	await assert.rejects(fs.stat(path.join(directory, 'update-assets', 'youplayer-update.json')));
});
