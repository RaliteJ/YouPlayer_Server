import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packageRelease, installerFiles } from '../../scripts/package-release.mjs';
import { manifest, privateKey, publicKey } from '../fixtures/release.mjs';

const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../../', import.meta.url));

// Run explicitly after build-host.sh; ordinary Node tests do not require Go artifacts.
test('real archive executes without Node and Go verifies the Node-signed manifest', {
  skip: process.env.YOUPLAYER_TEST_HOST_ARCHIVE !== 'true'
}, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-host-archive-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'), output = path.join(root, 'dist'), extracted = path.join(root, 'extracted');
  for (const file of installerFiles) {
    const destination = path.join(source, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    if (file.endsWith('.pem')) await fs.writeFile(destination, publicKey);
    else await fs.copyFile(path.join(repository, file), destination);
  }
  await packageRelease({ root: source, output, manifest: manifest(), privateKey });
  await fs.mkdir(extracted);
  await execute('tar', ['-xzf', path.join(output, 'youplayer-install.tar.gz'), '-C', extracted]);
  const arch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  assert.ok(arch);
  const binary = path.join(extracted, `bin/youplayer-host-linux-${arch}`);
  const options = { env: { PATH: '/nonexistent', HOME: os.homedir() } };
  assert.match((await execute(binary, ['version'], options)).stdout, /sans Node.js/);
  // Temporary-path refusal occurs after signature verification and before host commands.
  await assert.rejects(execute(binary, ['check', 'podman'], options), error => {
    assert.match(error.stderr, /dossier permanent/); return error.code === 1;
  });
  const file = path.join(extracted, 'youplayer-release.json');
  const envelope = JSON.parse(await fs.readFile(file));
  envelope.signature = 'bad';
  await fs.writeFile(file, JSON.stringify(envelope));
  await assert.rejects(execute(binary, ['check', 'podman'], options), error => {
    assert.match(error.stderr, /invalid-signature/); return error.code === 1;
  });
});
