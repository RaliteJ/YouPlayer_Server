import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-installer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.copyFile(new URL('../../install.sh', import.meta.url), path.join(root, 'install.sh'));
  await fs.mkdir(path.join(root, 'bin'));
  const commands = {
    id: 'echo 1000',
    git: `case "$1" in rev-parse) echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa;; status) printf '%s' "\${DIRTY:-}";; esac`,
    podman: `if [[ $1 == ps ]]; then printf '%s' "\${EXISTING:-}"; fi`,
    'podman-compose': `
      echo "$*" >> calls
      if [[ $* == *build* && $* != *--no-build* ]]; then
        printf '%s' "$YOUPLAYER_ADMIN_PASSWORD" > received-password
        printf '%s' "\${YOUPLAYER_SPOTIFY_CLIENT_SECRET:-}" > received-spotify
        [[ -z \${COMPOSE_FILE:-} ]] || exit 9
        [[ -z \${FAIL_BUILD:-} ]] || { echo synthetic-private-error >&2; exit 1; }
      fi`,
    curl: 'echo ready >> calls'
  };
  for (const [name, body] of Object.entries(commands)) {
    await fs.writeFile(path.join(root, 'bin', name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o700 });
  }
  const run = (extra = {}, input = '') => new Promise(resolve => {
    const child = execFile('/bin/bash', ['install.sh'], {
      cwd: root, env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, ...extra }
    }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, output: stdout + stderr }));
    child.stdin.end(input);
  });
  const configure = async (password = 'synthetic-password-123') => {
    await fs.writeFile(path.join(root, '.env'), `COMPOSE_PROJECT_NAME='youplayer-server'\nYOUPLAYER_ADMIN_PSEUDO='synthetic-admin'\nYOUPLAYER_ADMIN_PASSWORD='${password}'\nYOUPLAYER_SESSION_SECRET='${'a'.repeat(96)}'\n`, { mode: 0o600 });
  };
  return { root, run, configure, read: name => fs.readFile(path.join(root, name), 'utf8') };
}

test('Bash installer creates private configuration, builds then starts and checks HTTPS', async t => {
  const h = await fixture(t);
  const password = 'synthetic $${UNSET} # " password';
  const result = await h.run({}, `synthetic-admin\n${password}\n${password}\n`);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.includes(password), false);
  assert.equal(await h.read('received-password'), password);
  assert.equal((await fs.stat(path.join(h.root, '.env'))).mode & 0o777, 0o600);
  assert.match(await h.read('.env'), /YOUPLAYER_SESSION_SECRET='[a-f0-9]{96}'/);
  const calls = (await h.read('calls')).trim().split('\n');
  assert.match(calls[1], /--env-file \/dev\/null .*build --build-arg YOUPLAYER_BUILD_COMMIT=a{40}/);
  assert.match(calls[2], /up -d --no-build/);
  assert.equal(calls[3], 'ready');
});

test('existing config stays literal, overrides inherited variables and marks dirty sources unknown', async t => {
  const h = await fixture(t);
  const password = 'synthetic $$(touch PWNED) `touch PWNED` " password';
  await h.configure(password);
  const before = await h.read('.env');
  const result = await h.run({ DIRTY: ' M file', COMPOSE_FILE: 'wrong.yml',
    YOUPLAYER_ADMIN_PASSWORD: 'wrong', YOUPLAYER_SPOTIFY_CLIENT_SECRET: 'wrong' });
  assert.equal(result.code, 0, result.output);
  assert.equal(await h.read('.env'), before);
  assert.equal(await h.read('received-password'), password);
  assert.equal(await h.read('received-spotify'), '');
  assert.match(await h.read('calls'), /YOUPLAYER_BUILD_COMMIT=unknown/);
  await assert.rejects(fs.stat(path.join(h.root, 'PWNED')), { code: 'ENOENT' });
});

for (const failure of ['existing', 'build', 'permissions', 'invalid', 'confirmation', 'project']) {
  test(`installer stops safely on ${failure}`, async t => {
    const h = await fixture(t);
    if (failure !== 'confirmation') await h.configure();
    if (failure === 'permissions') await fs.chmod(path.join(h.root, '.env'), 0o644);
    if (failure === 'invalid') await fs.writeFile(path.join(h.root, '.env'), 'YOUPLAYER_ADMIN_PSEUDO=admin\n');
    if (failure === 'project') await fs.appendFile(path.join(h.root, '.env'), 'COMPOSE_PROJECT_NAME=other\n');
    const result = await h.run({ EXISTING: failure === 'existing' ? 'youplayer-server_backend_1' : '',
      FAIL_BUILD: failure === 'build' ? '1' : '' }, 'admin\nsynthetic-password-123\ndifferent\n');
    assert.notEqual(result.code, 0);
    if (failure === 'existing') assert.match(result.output, /même arrêtés[\s\S]*Supprimer \.env ne réinitialise pas/);
    assert.doesNotMatch(result.output, /synthetic-private-error|synthetic-password-123/);
    const calls = await h.read('calls').catch(() => '');
    assert.doesNotMatch(calls, /up -d|down|\brm\b|\bstop\b/);
    if (failure === 'build') {
      assert.match(await h.read('.updates/host/install.log'), /synthetic-private-error/);
      assert.equal((await fs.stat(path.join(h.root, '.updates/host/install.log'))).mode & 0o777, 0o600);
    }
  });
}
