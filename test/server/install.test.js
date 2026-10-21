import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { installServer, prepareInstallationEnvironment, composeEnvironment, runInstallCommand, serviceUnit } from '../../scripts/install-release.mjs';
import { envelope, publicKey } from '../fixtures/release.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-installer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'keys'));
  await fs.writeFile(path.join(root, 'keys/release-public-key.pem'), publicKey);
  await fs.writeFile(path.join(root, 'youplayer-release.json'), JSON.stringify(envelope()));
  const calls = [], reports = [];
  const run = async (program, args) => { calls.push([program, args]); return program === 'loginctl' ? 'yes' : ''; };
  const deployment = Object.fromEntries(['checkTools', 'assertFresh', 'pull', 'initializeData', 'activate', 'healthy'].map(name =>
    [name, async (...args) => { calls.push([name, args]); }]));
  return { root, calls, reports, run, deployment, options: { root, run, home: path.join(root, 'home'),
    deploymentFactory: () => deployment, report: message => reports.push(message), pseudo: 'synthetic-admin', password: 'synthetic-password-123' } };
}

test('first installation pulls signed images, verifies health and enables the persistent updater without building', async t => {
  const h = await fixture(t);
  await installServer(h.options);
  assert.ok(h.calls.findIndex(([name]) => name === 'pull') < h.calls.findIndex(([name]) => name === 'activate'));
  assert.ok(h.calls.findIndex(([name]) => name === 'healthy') < h.calls.findIndex(([name, args]) => name === 'systemctl' && args.includes('enable')));
  assert.equal((await fs.stat(path.join(h.root, '.env'))).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await fs.readFile(path.join(h.root, '.updates/host/config.json'))).engine, 'podman');
  assert.ok(!h.reports.join(' ').includes(h.options.password));
  assert.ok(!h.calls.some(([program, args]) => ['npm', 'git'].includes(program) || args.some(arg => ['build', 'rm', 'down'].includes(arg))));
  assert.match(await fs.readFile(path.join(h.options.home, '.config/systemd/user/youplayer-updates.service'), 'utf8'), /Restart=on-failure/);
});

test('precheck makes no installation changes and needs no env', async t => {
  const h = await fixture(t);
  const before = await fs.readdir(h.root);
  await installServer({ ...h.options, checkOnly: true });
  assert.deepEqual(await fs.readdir(h.root), before);
  assert.ok(!h.calls.some(([name]) => ['pull', 'activate'].includes(name)));
});

for (const failure of ['checkTools', 'assertFresh', 'pull', 'healthy']) test(`installer refuses ${failure} without deleting data or enabling the service`, async t => {
  const h = await fixture(t);
  h.deployment[failure] = async () => { throw new Error('Synthetic failure'); };
  await assert.rejects(installServer(h.options));
  assert.ok(!h.calls.some(([, args]) => args.includes('enable') || args.includes('down')));
});

test('installer rejects a tampered bundle before invoking the container engine', async t => {
  const h = await fixture(t);
  await fs.writeFile(path.join(h.root, 'youplayer-release.json'), JSON.stringify({ payload: 'bad', signature: 'bad' }));
  await assert.rejects(installServer(h.options), { updateCode: 'invalid-signature' });
  assert.deepEqual(h.calls, []);
});

test('systemd paths are quoted and specifiers escaped', () => {
  assert.match(serviceUnit('/tmp/installation space%'), /space%%/);
  assert.throws(() => serviceUnit('/tmp/new\nline'));
});

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
