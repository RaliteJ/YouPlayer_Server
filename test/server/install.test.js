import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildInstallBundle } from '../../scripts/build-install-bundle.mjs';
import { installServer, installationManifest, prepareInstallationEnvironment } from '../../scripts/install.mjs';
import { loadDotEnvFile } from '../../src/server/config.js';
import { composeEnvironment } from '../../scripts/update-deployment.mjs';
import { containerPlans } from '../../scripts/update-container-plan.mjs';
import { installationContainers, installationCompose } from '../fixtures/update-deployment.mjs';

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL('../../', import.meta.url));
const keys = generateKeyPairSync('ed25519');
const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
const manifest = { schema: 2, version: 'v1.2.3', sequence: 123, platform: 'linux/amd64',
  images: { backend: 'a'.repeat(64), frontend: 'b'.repeat(64) }, registry: {
    backend: `ghcr.io/synthetic/youplayer-backend@sha256:${'c'.repeat(64)}`,
    frontend: `ghcr.io/synthetic/youplayer-frontend@sha256:${'d'.repeat(64)}`
  } };
const envelope = value => {
  const payload = Buffer.from(JSON.stringify(value));
  return JSON.stringify({ payload: payload.toString('base64'), signature: sign(null, payload, keys.privateKey).toString('base64') });
};

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-installer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'keys'));
  await fs.writeFile(path.join(root, 'keys/release-public-key.pem'), publicKey);
  await fs.writeFile(path.join(root, 'youplayer-update.json'), envelope(manifest));
  const compose = installationCompose();
  compose.services.redis.image = `docker.io/library/redis@sha256:${'e'.repeat(64)}`;
  await fs.writeFile(path.join(root, 'docker-compose.yml'), JSON.stringify(compose));
  const calls = [], reports = [];
  let started = false;
  const containers = installationContainers(root, manifest.images);
  const run = async (program, args) => {
    calls.push([program, args]);
    if (program === 'python3') return JSON.stringify(compose);
    if (program === 'podman-compose') { if (args.includes('up')) started = true; return ''; }
    if (program === 'flock' || program === 'tar') return '';
    if (args[0] === 'info') return 'linux/amd64';
    if (args[0] === 'ps') return started ? containers.map(c => c.Id).join('\n') : '';
    if (args[0] === 'image') {
      const service = args[2].includes('backend') ? 'backend' : 'frontend';
      return JSON.stringify([{ Id: `sha256:${manifest.images[service]}`, Os: 'linux', Architecture: 'amd64', RepoDigests: [manifest.registry[service]] }]);
    }
    if (args[0] === 'inspect') return JSON.stringify(containers);
    if (args[0] === 'pull' || args[0] === 'tag') return '';
    throw new Error('Unexpected simulated command');
  };
  return { root, calls, reports, run, compose, options: { root, run, wait: async () => {},
    report: message => reports.push(message), pseudo: 'synthetic-admin', password: 'synthetic-password-123' } };
}

test('installer bundle contains only host tools, a buildless compatible Compose and the signed release', async t => {
  const h = await fixture(t);
  const archive = await buildInstallBundle({ root: projectRoot, directory: h.root, publicKey });
  const files = (await execute('tar', ['-tzf', archive])).stdout.split('\n').filter(Boolean);
  assert.ok(files.includes('youplayer-server/install.sh'));
  assert.ok(files.includes('youplayer-server/scripts/update-service.mjs'));
  assert.equal(files.some(file => /(?:^|\/)(?:\.env|\.git|\.updates|node_modules|graphify-out|\.vscode)(?:\/|$)/.test(file)), false);
  assert.equal(files.some(file => /(?:private|signing).*\.pem$/.test(file)), false);
  const extracted = path.join(h.root, 'extracted');
  await fs.mkdir(extracted);
  await execute('tar', ['-xzf', archive, '-C', extracted]);
  const root = path.join(extracted, 'youplayer-server');
  const imported = await import(pathToFileURL(path.join(root, 'scripts/install.mjs')));
  assert.equal((await imported.installationManifest(root)).manifest.version, manifest.version);
  assert.ok((await fs.stat(path.join(root, 'install.sh'))).mode & 0o100);
  await prepareInstallationEnvironment(root, 'synthetic-admin', 'synthetic $${UNSET} # " password');
  const { stdout } = await execute('python3', [path.join(root, 'scripts/update-compose-config.py'), root, 'youplayer-server'],
    { cwd: root, env: composeEnvironment(root, 'youplayer-server') });
  const compose = JSON.parse(stdout);
  assert.equal(Object.values(compose.services).some(service => service.build), false);
  assert.equal(compose.services.backend.environment.YOUPLAYER_ADMIN_PASSWORD, 'synthetic $${UNSET} # " password');
  assert.equal(compose.services.backend.environment.YOUPLAYER_AUTH_ENABLED, 'true');
  containerPlans(compose, { root, project: 'youplayer-server' });
});

test('installer creates private independent secrets and never replaces an existing .env', async t => {
  const h = await fixture(t);
  await prepareInstallationEnvironment(h.root, 'synthetic-admin', 'synthetic-password-123');
  const file = path.join(h.root, '.env'), before = await fs.readFile(file);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const env = {}; loadDotEnvFile(file, env);
  assert.match(env.YOUPLAYER_SESSION_SECRET, /^[a-f0-9]{96}$/);
  assert.notEqual(env.YOUPLAYER_SESSION_SECRET, env.YOUPLAYER_SPOTIFY_TOKEN_SECRET);
  await prepareInstallationEnvironment(h.root, 'different', 'different-password-123');
  assert.deepEqual(await fs.readFile(file), before);
});

test('installer rejects unsafe credentials and symlinked configuration without overwriting files', async t => {
  const h = await fixture(t);
  for (const [pseudo, password] of [['admin\nOTHER=value', 'synthetic-password-123'], ['admin', 'too-short'],
    ['admin', "synthetic'apostrophe"], ['admin', 'synthetic\\backslash'], ['admin', 'synthetic\nnewline']]) {
    await assert.rejects(prepareInstallationEnvironment(h.root, pseudo, password));
  }
  const target = path.join(h.root, 'private');
  await fs.writeFile(target, 'synthetic-private');
  await fs.symlink(target, path.join(h.root, '.env'));
  await assert.rejects(prepareInstallationEnvironment(h.root), /fichier régulier/);
  assert.equal(await fs.readFile(target, 'utf8'), 'synthetic-private');
});

test('installer pulls signed digests, verifies image identity, starts without build and records only a healthy installation', async t => {
  const h = await fixture(t);
  await installServer(h.options);
  assert.deepEqual(h.calls.filter(([p, args]) => p === 'podman' && args[0] === 'pull').slice(0, 2).map(([, args]) => args.at(-1)), Object.values(manifest.registry));
  assert.ok(h.calls.filter(([p, args]) => p === 'podman' && args[0] === 'pull').every(([, args]) => args.includes('--tls-verify=true')));
  const start = h.calls.find(([p, args]) => p === 'podman-compose' && args.includes('up'));
  assert.ok(start[1].includes('--no-build'));
  const active = JSON.parse(await fs.readFile(path.join(h.root, '.updates/host/active.json')));
  assert.deepEqual(active, { version: manifest.version, sequence: manifest.sequence, images: manifest.images });
  const config = JSON.parse(await fs.readFile(path.join(h.root, '.updates/host/config.json')));
  assert.deepEqual(config.allowedImageRepositories, Object.values(manifest.registry).map(ref => ref.split('@')[0]));
  assert.equal(h.calls.some(([, args]) => args.some(arg => arg.includes(h.options.password))), false);
  assert.equal(h.reports.some(message => message.includes(h.options.password)), false);
  assert.equal(h.calls.some(([, args]) => ['rm', 'stop', 'build'].includes(args[0])), false);
});

test('installer precheck needs no .env, downloads nothing and does not configure automatic updates', async t => {
  const h = await fixture(t);
  await installServer({ ...h.options, checkOnly: true });
  await assert.rejects(fs.stat(path.join(h.root, '.env')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(h.root, '.updates/host/config.json')), { code: 'ENOENT' });
  assert.equal(h.calls.some(([, args]) => ['pull', 'tag', 'up'].includes(args[0]) || args.includes('up')), false);
});

for (const failure of ['signature', 'platform', 'existing', 'dependencies', 'image-id', 'image-digest', 'build', 'unhealthy']) {
  test(`installer refuses ${failure} and does not record an installed version`, async t => {
    const h = await fixture(t);
    if (failure === 'signature') {
      const value = JSON.parse(envelope(manifest)); value.payload = Buffer.from('{}').toString('base64');
      await fs.writeFile(path.join(h.root, 'youplayer-update.json'), JSON.stringify(value));
    }
    if (failure === 'build') h.compose.services.backend.build = { context: './src' };
    const run = async (program, args) => {
      const result = await h.run(program, args);
      if (failure === 'platform' && args[0] === 'info') return 'linux/arm64';
      if (failure === 'existing' && args[0] === 'ps') return 'youplayer-server_backend_1';
      if (failure === 'dependencies' && program === 'flock') throw new Error('Missing prerequisite');
      if (failure.startsWith('image-') && args[0] === 'image') {
        const images = JSON.parse(result);
        if (failure === 'image-id') images[0].Id = 'f'.repeat(64);
        else images[0].RepoDigests = [];
        return JSON.stringify(images);
      }
      if (failure === 'unhealthy' && args[0] === 'inspect') return '[]';
      return result;
    };
    await assert.rejects(installServer({ ...h.options, run }));
    await assert.rejects(fs.stat(path.join(h.root, '.updates/host/active.json')), { code: 'ENOENT' });
    if (failure !== 'unhealthy') assert.equal(h.calls.some(([p, args]) => p === 'podman-compose' && args.includes('up')), false);
    if (['signature', 'platform', 'existing', 'dependencies', 'build'].includes(failure)) {
      assert.equal(h.calls.some(([, args]) => args[0] === 'pull'), false);
    }
  });
}
