import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
test('Bash entrypoint uses the bundled executable, prompts without env and preserves existing configuration', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-installer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.copyFile(new URL('../../install.sh', import.meta.url), path.join(root, 'install.sh'));
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin);
  const calls = path.join(root, 'calls');
  for (const arch of ['amd64', 'arm64']) await fs.writeFile(path.join(bin, `youplayer-host-linux-${arch}`),
    '#!/bin/sh\nprintf "%s\\n" "$1 $2" >> "$INSTALLER_CALLS"\n', { mode: 0o700 });
  const options = { cwd: os.tmpdir(), env: { ...process.env, INSTALLER_CALLS: calls } };
  await assert.rejects(execute('bash', [path.join(root, 'install.sh'), 'podman'], options), error => {
    assert.match(error.stderr, /terminal interactif/);
    return error.code === 1;
  });
  assert.equal(await fs.readFile(calls, 'utf8'), 'check podman\n');
  await fs.writeFile(path.join(root, '.env'), 'synthetic', { mode: 0o600 });
  await fs.writeFile(calls, '');
  await execute('bash', [path.join(root, 'install.sh'), 'docker'], options);
  assert.equal(await fs.readFile(calls, 'utf8'), 'check docker\ninstall docker\n');
  assert.equal(await fs.readFile(path.join(root, '.env'), 'utf8'), 'synthetic');
  await fs.rm(bin, { recursive: true });
  await assert.rejects(execute('bash', [path.join(root, 'install.sh')], options), error => {
    assert.match(error.stderr, /youplayer-install.tar.gz/); return error.code === 1;
  });
});
