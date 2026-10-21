import path from 'node:path';
import { composeEnvironment, runHostCommand } from './release-host.mjs';
import { SERVICES, releaseError } from './release-channel.mjs';
import { writeReleaseJson } from '../src/server/release-control.js';

export function createDeployment({ root, config, run = (program, args, env) => runHostCommand(program, args, root, env),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!['docker', 'podman'].includes(config.engine) || config.project !== 'youplayer-server'
    || !['linux/amd64', 'linux/arm64'].includes(config.platform)) throw releaseError('incompatible-release');
  const engine = config.engine;
  const override = path.join(root, '.updates/host/images.json');
  const env = () => composeEnvironment(root, config.project);
  const engineRun = args => run(engine, args, process.env);
  const compose = args => run(engine === 'docker' ? 'docker' : 'podman-compose', [
    ...(engine === 'docker' ? ['compose'] : []), '--env-file', '/dev/null', '-p', config.project,
    '-f', path.join(root, 'docker-compose.release.yml'), '-f', override, ...args], env());
  async function inspect() {
    const projectLabel = engine === 'podman' ? 'io.podman.compose.project' : 'com.docker.compose.project';
    const ids = (await engineRun(['ps', '-a', '-q', '--filter', `label=${projectLabel}=${config.project}`])).trim().split(/\s+/).filter(Boolean);
    if (ids.length < 2) throw releaseError('deployment-changed');
    const containers = JSON.parse(await engineRun(['inspect', ...ids]));
    const found = {};
    for (const container of containers) {
      const labels = container.Config?.Labels || {};
      const service = labels['com.docker.compose.service'] || labels['io.podman.compose.service'];
      if (service === 'redis') continue;
      if (!SERVICES.includes(service) || found[service]
        || (labels['com.docker.compose.project'] || labels['io.podman.compose.project']) !== config.project) throw releaseError('deployment-changed');
      found[service] = container;
    }
    if (Object.keys(found).length !== 2) throw releaseError('deployment-changed');
    return found;
  }
  async function select(images) {
    const services = Object.fromEntries(SERVICES.map(service => [service, { image: images[service], pull_policy: 'never' }]));
    if (engine === 'podman') Object.assign(services.backend, { userns_mode: 'keep-id:uid=1000,gid=1000',
      volumes: ['youplayer_data:/var/lib/youplayer:Z,U'] });
    else services.backend.user = `${process.getuid()}:${process.getgid()}`;
    await writeReleaseJson(override, { services });
  }
  async function healthy(images) {
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        const containers = await inspect();
        if (SERVICES.every(service => {
          const c = containers[service];
          return c.Config?.Image === images[service] && c.State?.Status === 'running'
            && (c.State.Health?.Status || c.State.Healthcheck?.Status) === 'healthy';
        })) return;
      } catch { /* Compose may still be recreating the pair. */ }
      await wait(2000);
    }
    throw releaseError('health-failed');
  }
  return {
    select, healthy,
    async resume(images) {
      const containers = await inspect();
      if (!SERVICES.every(service => containers[service].Config?.Image === images[service])) throw releaseError('deployment-changed');
      if (SERVICES.some(service => containers[service].State?.Status !== 'running')) {
        await select(images);
        await compose(['up', '-d', '--no-build', ...SERVICES]);
      }
      await healthy(images);
    },
    async checkTools() {
      const platform = (await engineRun(['info', '--format', engine === 'docker' ? '{{.OSType}}/{{.Architecture}}' : '{{.Host.OS}}/{{.Host.Arch}}'])).trim()
        .replace('/x86_64', '/amd64').replace('/aarch64', '/arm64');
      if (platform !== config.platform) throw releaseError('platform-mismatch');
      if (engine === 'docker' && (await engineRun(['info', '--format', '{{json .SecurityOptions}}'])).includes('rootless')) {
        throw releaseError('incompatible-release');
      }
      await run(engine === 'docker' ? 'docker' : 'podman-compose', engine === 'docker' ? ['compose', 'version'] : ['--version'], process.env);
    },
    async assertFresh() {
      for (const label of ['com.docker.compose.project', 'io.podman.compose.project']) {
        if ((await engineRun(['ps', '-a', '-q', '--filter', `label=${label}=${config.project}`])).trim()) throw releaseError('deployment-changed');
      }
      // Do not silently attach a new installation to pre-existing named volumes.
      const volumes = (await engineRun(['volume', 'ls', '--format', '{{.Name}}'])).split(/\s+/);
      if (volumes.some(name => name.startsWith(`${config.project}_`))) throw releaseError('deployment-changed');
    },
    async pull(images) {
      for (const service of SERVICES) {
        await engineRun(['pull', images[service]]);
        const values = JSON.parse(await engineRun(['image', 'inspect', images[service]]));
        if (`${values[0]?.Os}/${values[0]?.Architecture}` !== config.platform) throw releaseError('platform-mismatch');
      }
    },
    async assertCurrent(images) {
      const containers = await inspect();
      if (!SERVICES.every(service => containers[service].Config?.Image === images[service])) throw releaseError('deployment-changed');
      await healthy(images);
    },
    async initializeData(images) {
      if (engine !== 'docker') return;
      await engineRun(['volume', 'create', `${config.project}_youplayer_data`]);
      await engineRun(['run', '--rm', '--network', 'none', '--user', '0:0', '--entrypoint', 'chown',
        '-v', `${config.project}_youplayer_data:/data`, images.backend, `${process.getuid()}:${process.getgid()}`, '/data']);
    },
    async activate(images, firstInstall = false) {
      await select(images);
      // Only the application pair is replaced; persistent data and Redis remain in place.
      await compose(['up', '-d', '--no-build', ...(firstInstall ? [] : ['--no-deps']), ...SERVICES]);
    }
  };
}
