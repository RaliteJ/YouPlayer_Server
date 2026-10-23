import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { compareVersions, verifyManifest, createReleaseSource } from '../../scripts/release-channel.mjs';
import { packageRelease, installerFiles } from '../../scripts/package-release.mjs';
import { manifest, envelope, publicKey, privateKey } from '../fixtures/release.mjs';

test('signed releases require both architectures, immutable approved images and compatible data', () => {
  assert.equal(verifyManifest(envelope(), publicKey).version, 'v1.0.0');
  assert.equal(compareVersions('v10.0.0', 'v2.9.9'), 1);
  for (const change of [m => { m.contract = 2; }, m => { m.dataVersion = 2; }, m => { m.rollbackCompatible = false; },
    m => { delete m.platforms['linux/arm64']; }, m => { m.platforms['linux/amd64'].backend = 'ghcr.io/evil/backend@sha256:' + 'a'.repeat(64); },
    m => { m.platforms['linux/amd64'].backend = 'ghcr.io/ralitej/youplayer-server-backend:latest'; }, m => { m.version = 'v1.0.0-beta'; }]) {
    const value = manifest(); change(value);
    assert.throws(() => verifyManifest(envelope(value), publicKey));
  }
  const changed = envelope(); changed.payload = envelope(manifest('v2.0.0', 2)).payload;
  assert.throws(() => verifyManifest(changed, publicKey), { updateCode: 'invalid-signature' });
});

test('release source performs no startup request, verifies assets and refuses foreign redirects', async () => {
  const calls = [];
  const source = createReleaseSource({ publicKey, fetchImpl: async url => {
    calls.push(String(url));
    return Response.json(calls.length === 1 ? { draft: false, prerelease: false, tag_name: 'v1.0.0',
      assets: [{ name: 'youplayer-release.json', url: 'https://api.github.com/repos/RaliteJ/YouPlayer_Server/releases/assets/1' }] } : envelope());
  } });
  assert.deepEqual(calls, []);
  assert.equal((await source.latest()).manifest.version, 'v1.0.0');
  assert.equal(calls.length, 2);
  const bad = createReleaseSource({ publicKey, fetchImpl: async () => new Response('', { status: 302, headers: { Location: 'http://127.0.0.1/private' } }) });
  await assert.rejects(bad.latest(), { updateCode: 'download-origin' });
});

test('installer archive uses an explicit allowlist and verifies its signing key', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-package-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const file of installerFiles) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), file.endsWith('.pem') ? publicKey : 'synthetic');
  }
  await fs.writeFile(path.join(root, '.env'), 'synthetic-private');
  const output = path.join(root, 'dist');
  await packageRelease({ root, output, manifest: manifest(), privateKey });
  const files = execFileSync('tar', ['-tzf', path.join(output, 'youplayer-install.tar.gz')], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(files.sort(), [...installerFiles, 'youplayer-release.json'].sort());
  assert.ok(!files.some(file => file.startsWith('images/')));
  assert.ok(!files.some(file => /\.(mjs|js)$/.test(file)));
  const extracted = path.join(root, 'extracted');
  await fs.mkdir(extracted);
  execFileSync('tar', ['-xzf', path.join(output, 'youplayer-install.tar.gz'), '-C', extracted]);
  for (const arch of ['amd64', 'arm64']) {
    assert.equal((await fs.stat(path.join(extracted, `bin/youplayer-host-linux-${arch}`))).mode & 0o777, 0o755);
  }
  assert.equal(verifyManifest(JSON.parse(await fs.readFile(path.join(output, 'youplayer-release.json'))), publicKey).version, 'v1.0.0');
  await assert.rejects(packageRelease({ root, output, manifest: manifest(), privateKey }), { code: 'EEXIST' });
});
