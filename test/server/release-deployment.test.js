import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createDeployment } from '../../scripts/release-deployment.mjs';
import { prepareInstallationEnvironment } from '../../scripts/release-host.mjs';
import { manifest } from '../fixtures/release.mjs';

for (const engine of ['docker', 'podman']) test(`${engine} deployment pins images, validates identity and never builds or removes data`, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-deployment-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await prepareInstallationEnvironment(root, 'synthetic', 'synthetic-password');
  const config = { engine, project: 'youplayer-server', platform: 'linux/amd64' };
  const images = manifest().platforms[config.platform], calls = [];
  let wrongImage = false, stopped = false;
  const run = async (program, args, env) => {
    calls.push([program, args, env]);
    if (args[0] === 'info') return args.at(-1).includes('SecurityOptions') ? '[]' : 'linux/amd64';
    if (args.includes('ps')) return 'backend-id\nfrontend-id';
    if (args[0] === 'image') return JSON.stringify([{ Os: 'linux', Architecture: 'amd64' }]);
    if (args[0] === 'inspect') return JSON.stringify(['backend', 'frontend'].map(service => ({ Config: {
      Image: wrongImage ? 'unexpected' : images[service], Labels: { 'com.docker.compose.service': service, 'com.docker.compose.project': config.project }
    }, State: { Status: stopped ? 'exited' : 'running', Health: { Status: 'healthy' } } })));
    if (args.includes('up')) stopped = false;
    return '';
  };
  const d = createDeployment({ root, config, run, wait: async () => {} });
  await d.checkTools(); await d.pull(images); await d.activate(images); await d.healthy(images);
  const override = JSON.parse(await fs.readFile(path.join(root, '.updates/host/images.json')));
  assert.equal(override.services.backend.image, images.backend);
  assert.equal(override.services.frontend.image, images.frontend);
  assert.equal(override.services.redis, undefined);
  const up = calls.find(([, args]) => args.includes('up'));
  assert.ok(up[1].includes('--no-build') && up[1].includes('--no-deps'));
  assert.equal(up[1][up[1].indexOf('--env-file') + 1], '/dev/null');
  assert.ok(!calls.some(([, args]) => args.some(arg => ['build', 'down', 'rm', '--volumes'].includes(arg))));
  stopped = true;
  await d.resume(images);
  assert.equal(stopped, false);
  assert.ok(!calls.at(-3)?.[1]?.includes('build'));
  wrongImage = true;
  await assert.rejects(d.assertCurrent(images), { updateCode: 'deployment-changed' });
});
