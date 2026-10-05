import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { createGitReleaseSource, validateUpdateManifest } from '../../scripts/update-channel.mjs';
import { prepareSignedUpdate } from '../../scripts/prepare-update.mjs';

const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const archive = Buffer.from('synthetic image archive');
const manifest = { schema: 1, version: 'v2', sequence: 2, images: { backend: 'a'.repeat(64), frontend: 'b'.repeat(64) },
	archive: { name: 'youplayer-images.tar', size: archive.length, sha256: createHash('sha256').update(archive).digest('hex') } };
function signed(value) {
	const payload = Buffer.from(JSON.stringify(value));
	return { payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') };
}

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
