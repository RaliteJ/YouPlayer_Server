import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installServer, prepareInstallationEnvironment, composeEnvironment, runInstallCommand } from '../../scripts/install.mjs';

const execute = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-installer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, '.git'));
  const calls = [], reports = [];
  const run = async (program, args) => {
    calls.push([program, args]);
    if (program === 'podman-compose') return '';
    if (program === 'git') return args[0] === 'status' ? '' : 'a'.repeat(40);
    if (args[0] === 'info') return 'linux/amd64';
    if (args[0] === 'ps') return '';
    if (args[0] === 'inspect') return JSON.stringify(Array.from({ length: 3 }, () => ({ State: { Status: 'running', Health: { Status: 'healthy' } } })));
    throw new Error('Unexpected simulated command');
  };
  return { root, calls, reports, run, options: { root, run, wait: async () => {},
    report: message => reports.push(message), pseudo: 'synthetic-admin', password: 'synthetic-password-123' } };
}

test('first installation builds local sources before startup, keeps private config and never configures an updater', async t => {
  const h = await fixture(t);
  await installServer(h.options);
  const commands = h.calls.filter(([program]) => program === 'podman-compose');
  assert.ok(commands[0][1].includes('--version'));
  assert.ok(commands[1][1].includes('build'));
  assert.ok(commands[1][1].includes(`YOUPLAYER_BUILD_COMMIT=${'a'.repeat(40)}`));
  assert.equal(commands[2][1].at(-1), '--no-build');
  for (const [, args] of commands.slice(1)) assert.equal(args[args.indexOf('--env-file') + 1], '/dev/null');
  assert.equal((await fs.stat(path.join(h.root, '.env'))).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(path.join(h.root, '.updates/host/active.json')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(h.root, '.updates/host/config.json')), { code: 'ENOENT' });
  assert.ok(!h.reports.join(' ').includes(h.options.password));
  assert.ok(!h.calls.some(([program, args]) => program === 'git' && !['status', 'rev-parse'].includes(args[0]) || args.some(arg => ['rm', 'stop', 'down', 'tag', 'load'].includes(arg))));
});

test('an installation from modified sources marks its build as unknown instead of claiming the HEAD commit', async t => {
  const h = await fixture(t);
  await installServer({ ...h.options, run: async (program, args) => {
    if (program === 'git' && args[0] === 'status') return ' M src/server/server.js';
    return h.run(program, args);
  } });
  assert.ok(h.calls.some(([, args]) => args.includes('YOUPLAYER_BUILD_COMMIT=unknown')));
  assert.ok(!h.calls.some(([program, args]) => program === 'git' && args[0] === 'rev-parse'));
});

test('precheck needs no env and makes no build, startup or data changes', async t => {
  const h = await fixture(t);
  await installServer({ ...h.options, checkOnly: true });
  assert.deepEqual(await fs.readdir(h.root), ['.git']);
  assert.equal(h.calls.some(([, args]) => args.includes('build') || args.includes('up')), false);
});

for (const failure of ['checkout', 'existing', 'dependencies', 'build', 'unhealthy']) {
  test(`installation refuses ${failure} without deleting data`, async t => {
    const h = await fixture(t);
    if (failure === 'checkout') await fs.rmdir(path.join(h.root, '.git'));
    const run = async (program, args) => {
      const result = await h.run(program, args);
      if (failure === 'existing' && args[0] === 'ps') return 'youplayer-server_backend_1';
      if (failure === 'dependencies' && args.includes('--version')) throw new Error('Missing prerequisite');
      if (failure === 'build' && args.includes('build')) throw new Error('Build failed');
      if (failure === 'unhealthy' && args[0] === 'inspect') return '[]';
      return result;
    };
    await assert.rejects(installServer({ ...h.options, run }));
    if (failure !== 'unhealthy') assert.equal(h.calls.some(([, args]) => args.includes('up')), false);
    assert.equal(h.calls.some(([, args]) => args.some(arg => ['rm', 'down', 'stop'].includes(arg))), false);
  });
}

test('configuration preserves existing values and passes dollar signs literally without inherited production overrides', async t => {
  const h = await fixture(t);
  const password = 'synthetic $${UNSET} # " password';
  await prepareInstallationEnvironment(h.root, 'synthetic-admin', password);
  const before = await fs.readFile(path.join(h.root, '.env'));
  await prepareInstallationEnvironment(h.root, 'other', 'other-password-123');
  assert.deepEqual(await fs.readFile(path.join(h.root, '.env')), before);
  const env = composeEnvironment(h.root, 'youplayer-server', { PATH: process.env.PATH, UNSET: 'must-not-be-expanded',
    YOUPLAYER_ADMIN_PASSWORD: 'wrong', YOUPLAYER_SPOTIFY_CLIENT_SECRET: 'wrong', COMPOSE_FILE: 'wrong.yml' });
  assert.equal(env.YOUPLAYER_ADMIN_PASSWORD, password);
  assert.equal(env.YOUPLAYER_SPOTIFY_CLIENT_SECRET, '');
  assert.equal(env.COMPOSE_FILE, undefined);
  await assert.rejects(async () => composeEnvironment(h.root, 'another-project'), { updateCode: 'project-mismatch' });
  // Exercise the installed Compose parser with synthetic credentials only.
  await fs.writeFile(path.join(h.root, 'docker-compose.yml'), JSON.stringify({ services: { backend: {
    image: 'synthetic', environment: { PASSWORD: '${YOUPLAYER_ADMIN_PASSWORD}' }
  } } }));
  const { stdout } = await execute('podman-compose', ['--env-file', '/dev/null', '-p', 'youplayer-server', 'config'], { cwd: h.root, env });
  const parsed = await execute('python3', ['-c', 'import sys,yaml,json; print(json.dumps(yaml.safe_load(sys.argv[1])))', stdout]);
  assert.equal(JSON.parse(parsed.stdout).services.backend.environment.PASSWORD, password);
});

test('command failures keep raw output in a private host log', async t => {
  const h = await fixture(t);
  await fs.mkdir(path.join(h.root, '.updates/host'), { recursive: true });
  await assert.rejects(runInstallCommand(process.execPath, ['-e', 'console.error("synthetic-private");process.exit(1)'], h.root),
    error => error.updateCode === 'command-failed' && !error.message.includes('synthetic-private'));
  const log = path.join(h.root, '.updates/host/last-command.log');
  assert.match(await fs.readFile(log, 'utf8'), /synthetic-private/);
  assert.equal((await fs.stat(log)).mode & 0o777, 0o600);
});
