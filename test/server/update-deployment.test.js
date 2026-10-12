import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createDeployment, composeEnvironment, lockUpdateService } from '../../scripts/update-deployment.mjs';
import { simulatedDeployment, installationEnvironment } from '../fixtures/update-deployment.mjs';

const images = { backend: 'a'.repeat(64), frontend: 'b'.repeat(64) };
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-topology-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, '.env'), installationEnvironment, { mode: 0o600 });
  await fs.writeFile(path.join(root, 'docker-compose.yml'), 'services: {}\n');
  const engine = simulatedDeployment(root, images);
  let skipRecreate = false;
  let missingImage;
  const calls = engine.calls;
  const runCommand = async (program, args) => {
    if (args[0] === 'image' && args[1] === 'exists' && args[2] === missingImage) throw new Error('missing image');
    const result = await engine.run(program, args);
    if (skipRecreate && args[0] === 'create') engine.all.find(c => c.Id === result).Image = 'f'.repeat(64);
    return result;
  };
  const target = createDeployment({ root, project: 'youplayer-server', runCommand });
  return { root, target, calls, runCommand, get all() { return engine.all; }, set all(value) { engine.all = value; }, set skipRecreate(value) { skipRecreate = value; }, set missingImage(value) { missingImage = value; } };
}

test('Compose uses local secrets and refuses a different project without exposing values', async t => {
  const h = await fixture(t);
  const env = composeEnvironment(h.root, 'youplayer-server', {
    PATH: '/synthetic/bin', HOME: '/synthetic/home', COMPOSE_FILE: '/private/file', COMPOSE_PROJECT_NAME: 'youplayer',
    YOUPLAYER_SESSION_SECRET: 'synthetic-private-export', YOUPLAYER_ADMIN_PASSWORD: 'private-export', SESSION_SECRET: 'other-private'
  });
  assert.equal(env.COMPOSE_PROJECT_NAME, 'youplayer-server');
  assert.equal(env.COMPOSE_FILE, undefined);
  assert.equal(env.SESSION_SECRET, undefined);
  assert.equal(env.YOUPLAYER_ADMIN_PASSWORD, undefined);
  assert.match(env.YOUPLAYER_SESSION_SECRET, /^012345/);
  assert.equal(env.PATH, '/synthetic/bin');
  await fs.writeFile(path.join(h.root, '.env'), installationEnvironment.replace('youplayer-server', 'youplayer'));
  assert.throws(() => composeEnvironment(h.root, 'youplayer-server'), { updateCode: 'project-mismatch' });
  await fs.writeFile(path.join(h.root, '.env'), 'YOUPLAYER_SESSION_SECRET=synthetic-private\n');
  assert.throws(() => composeEnvironment(h.root, 'youplayer-server'), error =>
    error.updateCode === 'environment-invalid' && !error.message.includes('synthetic-private'));
});

for (const conflict of ['shared-bind', 'shared-parent', 'shared-volume', 'shared-port', 'extra-project-container']) {
  test(`preflight refuses ${conflict} before any mutation`, async t => {
    const h = await fixture(t);
    const duplicate = structuredClone(h.all[0]);
    duplicate.Id = 'f'.repeat(64); duplicate.Name = 'youplayer_backend_1';
    duplicate.Config.Labels['io.podman.compose.project'] = 'youplayer';
    duplicate.Mounts = [];
    if (conflict === 'shared-bind') duplicate.Mounts.push(h.all[0].Mounts[1]);
    if (conflict === 'shared-parent') duplicate.Mounts.push({ Type: 'bind', Source: h.root, Destination: '/synthetic/app' });
    if (conflict === 'shared-volume') duplicate.Mounts.push(h.all[0].Mounts[0]);
    if (conflict === 'shared-port') duplicate.HostConfig.PortBindings = { '443/tcp': [{ HostPort: '8443' }] };
    if (conflict === 'extra-project-container') duplicate.Config.Labels['io.podman.compose.project'] = 'youplayer-server';
    h.all.push(duplicate);
    await assert.rejects(h.target.snapshot(), { updateCode: 'project-conflict' });
    assert.ok(h.calls.every(([program, args]) => program === 'python3' || program === 'podman' && ['ps', 'inspect'].includes(args[0])));
  });
}

for (const invalid of ['label', 'volume', 'bind', 'network', 'missing']) {
  test(`preflight refuses unexpected ${invalid}`, async t => {
    const h = await fixture(t);
    if (invalid === 'label') h.all[0].Config.Labels['com.docker.compose.project'] = 'youplayer';
    if (invalid === 'volume') h.all[0].Mounts[0].Name = 'youplayer_youplayer_data';
    if (invalid === 'bind') h.all[0].Mounts[1].Source = '/synthetic/other/playlists';
    if (invalid === 'network') h.all[0].NetworkSettings.Networks.youplayer_private = {};
    if (invalid === 'missing') h.all = h.all.slice(1);
    await assert.rejects(h.target.snapshot());
  });
}

test('recreation prepares both images before stopping applications and preserves Redis and resources', async t => {
  const h = await fixture(t);
  const previous = await h.target.snapshot();
  const next = { backend: 'c'.repeat(64), frontend: 'd'.repeat(64) };
  const override = path.join(h.root, '.updates/host/deploy.json');
  await h.target.apply(next, previous, override);
  const config = JSON.parse(await fs.readFile(override, 'utf8'));
  assert.equal(config.engine, 'podman-create-v1');
  const removed = h.calls.filter(([program, args]) => program === 'podman' && args[0] === 'rm');
  assert.deepEqual(removed.map(([, args]) => args.at(-1)), [previous.containerIds.frontend, previous.containerIds.backend]);
  const creates = h.calls.filter(([, args]) => args[0] === 'create');
  assert.equal(creates.length, 2);
  assert.ok(creates.every(([program, args]) => program === 'podman' && args.includes('--pull=never')));
  assert.ok(h.calls.findLastIndex(([, args]) => args[0] === 'create') < h.calls.findIndex(([, args]) => args[0] === 'stop'));
  assert.ok(h.calls.every(([program]) => program !== 'podman-compose'));
  assert.ok(creates[0][1].includes('youplayer-server_sessions:alias=backend'));
  assert.ok(creates[0][1].includes('youplayer-server_youplayer_data:/var/lib/youplayer:Z,U'));
  assert.ok(creates.every(([, args]) => !args.some(a => a.includes('synthetic-private'))));
  assert.deepEqual((await h.target.snapshot()).images, next);
  h.skipRecreate = true;
  await assert.rejects(h.target.apply(images, previous, override), { updateCode: 'image-mismatch' });
  h.all.find(c => c.Name.endsWith('_redis_1')).Id = 'f'.repeat(64);
  await assert.rejects(h.target.apply(images, previous, override), { updateCode: 'resources-mismatch' });
});

test('missing local image cancels recreation or rollback before any mutation', async t => {
  const h = await fixture(t);
  const previous = await h.target.snapshot();
  h.calls.length = 0;
  h.missingImage = images.frontend;
  const override = path.join(h.root, '.updates/host/deploy.json');
  await assert.rejects(h.target.apply(images, previous, override), { updateCode: 'image-mismatch' });
  assert.ok(h.calls.every(([program, args]) => program === 'python3' || program === 'podman' && ['ps', 'inspect', 'image'].includes(args[0])));
  await assert.rejects(fs.access(override), { code: 'ENOENT' });
});

test('host service lock rejects a second process and is released explicitly', async t => {
  const h = await fixture(t);
  await fs.mkdir(path.join(h.root, '.updates/host'), { recursive: true });
  const release = await lockUpdateService(h.root);
  await assert.rejects(lockUpdateService(h.root), { updateCode: 'service-locked' });
  assert.equal((await fs.stat(path.join(h.root, '.updates/host/service.flock'))).mode & 0o777, 0o600);
  await release();
  await (await lockUpdateService(h.root))();
});

test('rollback refuses a same-named container belonging to a different project', async t => {
  const h = await fixture(t);
  const previous = await h.target.snapshot();
  h.calls.length = 0;
  h.all[0].Config.Labels['io.podman.compose.project'] = 'other';
  await assert.rejects(h.target.apply(images, previous, path.join(h.root, '.updates/host/deploy.json')),
    { updateCode: 'project-mismatch' });
  assert.ok(h.calls.every(([program, args]) => program === 'python3' || program === 'podman' && ['ps', 'inspect'].includes(args[0])));
});

test('changing Compose after preflight cancels recreation before a container is touched', async t => {
  const h = await fixture(t);
  const previous = await h.target.snapshot();
  h.calls.length = 0;
  await fs.writeFile(path.join(h.root, 'docker-compose.yml'), 'services: {backend: {image: other}}\n');
  await assert.rejects(h.target.apply(images, previous, path.join(h.root, '.updates/host/deploy.json')),
    { updateCode: 'deployment-changed' });
  assert.deepEqual(h.calls, []);
});

test('failed second candidate creation leaves the running application intact and cleans the first candidate', async t => {
  const h = await fixture(t);
  const previous = await h.target.snapshot();
  let count = 0;
  const target = createDeployment({ root: h.root, project: 'youplayer-server', runCommand: async (p, a) => {
    if (a[0] === 'create' && ++count === 2) throw new Error('synthetic-create-failure');
    return h.runCommand(p, a);
  } });
  await assert.rejects(target.apply(images, previous, path.join(h.root, '.updates/host/deploy.json')),
    error => error.deploymentUntouched === true);
  assert.deepEqual(await h.target.snapshot(), previous);
  assert.ok(h.calls.every(([, a]) => a[0] !== 'stop'));
});

test('service lock is automatically released after its owner is killed', { timeout: 15000 }, async t => {
  const h = await fixture(t);
  await fs.mkdir(path.join(h.root, '.updates/host'), { recursive: true });
  const module = new URL('../../scripts/update-deployment.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e',
    `import { lockUpdateService } from ${JSON.stringify(module)}; await lockUpdateService(${JSON.stringify(h.root)}); process.stdout.write('ready\\n'); setInterval(()=>{},1000);`],
    { stdio: ['ignore', 'pipe', 'pipe'], env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')) });
  t.after(() => child.kill('SIGKILL'));
  let diagnostic = '';
  child.stderr.on('data', c => diagnostic += c);
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', code => reject(new Error(`Lock owner exited (${code}): ${diagnostic}`)));
    child.once('error', reject);
  });
  await assert.rejects(lockUpdateService(h.root), { updateCode: 'service-locked' });
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
  let release;
  for (let i = 0; i < 50 && !release; i++) {
    release = await lockUpdateService(h.root).catch(() => null);
    if (!release) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(release, 'Kernel releases lock after parent crash');
  await release();
});
