import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDotEnvFile, loadServerConfig } from '../src/server/config.js';
import { writeUpdateJson } from '../src/server/update-control.js';
import { containerPlans } from './update-container-plan.mjs';

export const deploymentError = code => Object.assign(new Error('Deploiement refuse ; diagnostic prive masque'), { updateCode: code });
const services = ['backend', 'frontend', 'redis'];
const volumeTargets = { youplayer_data: '/var/lib/youplayer', redis_data: '/data', frontend_certs: '/etc/nginx/certs' };
const owner = labels => labels?.['io.podman.compose.project'] || labels?.['com.docker.compose.project'];
const name = c => c.Name?.replace(/^\//, '');
const image = c => c.Image?.replace(/^sha256:/, '');

// Compose gets the installation's values, never exported production variables
// from the terminal (which take precedence over --env-file in Compose).
export function composeEnvironment(root, project, inherited = process.env) {
  const local = {};
  if (!loadDotEnvFile(path.join(root, '.env'), local)) throw deploymentError('environment-invalid');
  if (local.COMPOSE_PROJECT_NAME && local.COMPOSE_PROJECT_NAME !== project) throw deploymentError('project-mismatch');
  try {
    loadServerConfig({ ...local, NODE_ENV: 'production', YOUPLAYER_AUTH_ENABLED: 'true', YOUPLAYER_REDIS_URL: 'redis://redis:6379' });
  } catch { throw deploymentError('environment-invalid'); }
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !key.startsWith('YOUPLAYER_') && !key.startsWith('COMPOSE_') && !['SESSION_SECRET', 'DATABASE_URL', 'REDIS_URL'].includes(key)));
  // Only values used by this installation's Compose file are imported.
  for (const [key, value] of Object.entries(local)) if (key.startsWith('YOUPLAYER_')) env[key] = value;
  return { ...env, COMPOSE_PROJECT_NAME: project };
}

export function createDeployment({ root, project, port = 8443, runCommand }) {
  root = path.resolve(root);
  async function configuration() {
    return Object.fromEntries(await Promise.all(['.env', 'docker-compose.yml'].map(async file =>
      [file, createHash('sha256').update(await fs.readFile(path.join(root, file))).digest('hex')])));
  }
  async function containers() {
    const ids = (await runCommand('podman', ['ps', '-aq'])).trim().split(/\s+/).filter(Boolean);
    return ids.length ? JSON.parse(await runCommand('podman', ['inspect', ...ids])) : [];
  }
  function rejectConflicts(all, candidates = []) {
    const paths = ['src/playlists', 'src/local_song', '.updates/requests', '.updates/status'].map(p => path.join(root, p));
    for (const c of all) {
      if (services.some(s => name(c) === `${project}_${s}_1`)) continue;
      if (candidates.includes(c.Id)) continue;
      const mounts = c.Mounts || [];
      const sharesData = mounts.some(m => (m.Type === 'bind' && typeof m.Source === 'string' && paths.some(p =>
        p === m.Source || p.startsWith(m.Source.replace(/\/$/, '') + '/') || m.Source.startsWith(p + '/')))
        || Object.keys(volumeTargets).some(v => m.Name === `${project}_${v}`));
      const sharesPort = Object.values(c.HostConfig?.PortBindings || {}).flat().some(p => p?.HostPort === String(port));
      if (sharesData || sharesPort || owner(c.Config?.Labels) === project) throw deploymentError('project-conflict');
    }
  }
  function validateContainer(c, service, expectedName = `${project}_${service}_1`) {
    if (!c || name(c) !== expectedName) throw deploymentError('containers-missing');
    const labels = c.Config?.Labels || {};
    for (const key of ['io.podman.compose.project', 'com.docker.compose.project']) {
      if (labels[key] !== undefined && labels[key] !== project) throw deploymentError('project-mismatch');
    }
    const labelledService = labels['io.podman.compose.service'] || labels['com.docker.compose.service'];
    if (owner(labels) !== project || labelledService !== service) throw deploymentError('project-mismatch');
  }
  function validateTopology(c, service, runtime = true, expectedName) {
    validateContainer(c, service, expectedName);
    const v = service === 'backend' ? 'youplayer_data' : service === 'redis' ? 'redis_data' : 'frontend_certs';
    const mount = c.Mounts?.find(m => m.Destination === volumeTargets[v]);
    if (mount?.Type !== 'volume' || mount.Name !== `${project}_${v}`) throw deploymentError('resources-mismatch');
    if (service === 'backend') {
      for (const [source, destination] of [['src/playlists', '/var/www/html/playlists'], ['src/local_song', '/var/www/html/local_song'],
        ['.updates/requests', '/var/lib/youplayer-updates/requests'], ['.updates/status', '/var/lib/youplayer-updates/status']]) {
        if (!c.Mounts.some(m => m.Type === 'bind' && m.Source === path.join(root, source) && m.Destination === destination)) {
          throw deploymentError('resources-mismatch');
        }
      }
    }
    if (!runtime) return; // A failed recreation may leave an unattached Created container.
    const actual = Object.keys(c.NetworkSettings?.Networks || {}).sort();
    const expected = (service === 'backend' ? ['private', 'sessions'] : [service === 'redis' ? 'sessions' : 'private'])
      .map(n => `${project}_${n}`).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw deploymentError('resources-mismatch');
    if (service === 'frontend' && !c.HostConfig?.PortBindings?.['443/tcp']?.some(p => p.HostPort === String(port))) {
      throw deploymentError('resources-mismatch');
    }
  }
  async function plans() {
    composeEnvironment(root, project);
    try {
      const config = JSON.parse(await runCommand('python3', [fileURLToPath(new URL('./update-compose-config.py', import.meta.url)), root, project]));
      return containerPlans(config, { root, project, port });
    } catch (error) {
      if (error.updateCode === 'command-missing') throw error;
      throw deploymentError('environment-invalid');
    }
  }
  async function snapshot() {
    await plans(); // Refuse unsupported configuration before downloading or backing up.
    const all = await containers();
    rejectConflicts(all);
    const selected = Object.fromEntries(services.map(s => [s, all.find(c => name(c) === `${project}_${s}_1`)]));
    for (const s of services) validateTopology(selected[s], s);
    const images = {}, healthchecks = {}, volumes = {};
    for (const s of ['backend', 'frontend']) {
      images[s] = image(selected[s]);
      if (!/^[a-f0-9]{64}$/.test(images[s])) throw deploymentError('image-mismatch');
      const health = selected[s].Config?.Healthcheck;
      if (health?.Test) healthchecks[s] = { test: health.Test };
    }
    for (const volume of Object.keys(volumeTargets)) volumes[volume] = `${project}_${volume}`;
    const networks = { private: `${project}_private`, sessions: `${project}_sessions` };
    return { images, healthchecks, containerIds: Object.fromEntries(services.map(s => [s, selected[s].Id])),
      resources: { project, root, volumes, networks, redisId: selected.redis.Id, configuration: await configuration() } };
  }
  function validateResources(resources) {
    if (resources?.project !== project || resources.root !== root || !/^[a-f0-9]{64}$/.test(resources.redisId || '')) {
      throw deploymentError('recovery-required');
    }
    for (const v of Object.keys(volumeTargets)) if (resources.volumes?.[v] !== `${project}_${v}`) throw deploymentError('resources-mismatch');
    for (const n of ['private', 'sessions']) if (resources.networks?.[n] !== `${project}_${n}`) throw deploymentError('resources-mismatch');
    for (const f of ['.env', 'docker-compose.yml']) if (!/^[a-f0-9]{64}$/.test(resources.configuration?.[f] || '')) throw deploymentError('recovery-required');
  }
  async function apply(images, previous, override) {
    validateResources(previous.resources);
    if (JSON.stringify(await configuration()) !== JSON.stringify(previous.resources.configuration)) throw deploymentError('deployment-changed');
    const plan = await plans();
    const all = await containers();
    const installation = createHash('sha256').update(JSON.stringify(previous.resources)).digest('hex');
    const candidateName = s => `${project}_${s}_update_candidate`;
    const stale = [];
    for (const s of ['backend', 'frontend']) {
      const candidate = all.find(c => name(c) === candidateName(s));
      if (!candidate) continue;
      if (candidate.Config?.Labels?.['io.youplayer.update.installation'] !== installation || candidate.State?.Running) {
        throw deploymentError('project-conflict');
      }
      validateTopology(candidate, s, false, candidateName(s));
      stale.push(candidate.Id);
    }
    rejectConflicts(all, stale);
    for (const s of services) {
      const existing = all.find(c => name(c) === `${project}_${s}_1`);
      if (existing) validateTopology(existing, s, false);
    }
    const redis = all.find(c => name(c) === `${project}_redis_1`);
    validateContainer(redis, 'redis');
    if (redis.Id !== previous.resources.redisId) throw deploymentError('resources-mismatch');
    for (const s of ['backend', 'frontend']) {
      if (!/^[a-f0-9]{64}$/.test(images?.[s] || '')) throw deploymentError('image-mismatch');
      try { await runCommand('podman', ['image', 'exists', images[s]]); }
      catch { throw deploymentError('image-mismatch'); }
    }
    // This diagnostic contains identities only. Environment values never enter
    // status, command arguments or the durable transaction.
    await writeUpdateJson(override, { engine: 'podman-create-v1', images });
    for (const id of stale) await runCommand('podman', ['rm', id]);
    const directory = await fs.mkdtemp(path.join(path.dirname(override), 'deployment-'));
    await fs.chmod(directory, 0o700);
    const pending = new Map();
    let touched = false;
    try {
      // Prepare both containers without starting them. An invalid image/config
      // therefore fails before either application container is stopped.
      for (const s of ['backend', 'frontend']) {
        const file = path.join(directory, `${s}.env`);
        await fs.writeFile(file, plan[s].environment.join('\n') + '\n', { flag: 'wx', mode: 0o600 });
        const args = [...plan[s].args];
        args[args.indexOf('--name') + 1] = candidateName(s);
        const id = (await runCommand('podman', ['create', ...args, '--label', `io.youplayer.update.installation=${installation}`,
          '--env-file', file, images[s], ...plan[s].command])).trim();
        if (!/^[a-f0-9]{64}$/.test(id)) throw deploymentError('containers-missing');
        pending.set(s, id);
        const [candidate] = JSON.parse(await runCommand('podman', ['inspect', id]));
        validateTopology(candidate, s, false, candidateName(s));
        if (image(candidate) !== images[s]) throw deploymentError('image-mismatch');
      }
      if (JSON.stringify(await configuration()) !== JSON.stringify(previous.resources.configuration)) throw deploymentError('deployment-changed');
      const current = (await containers()).filter(c => ![...pending.values()].includes(c.Id));
      // Do not remove a same-named container replaced by another operator while preparing.
      for (const s of services) {
        const before = all.find(c => name(c) === `${project}_${s}_1`);
        const now = current.find(c => name(c) === `${project}_${s}_1`);
        if (before?.Id !== now?.Id || before?.Image !== now?.Image) throw deploymentError('deployment-changed');
      }
      rejectConflicts(current);
      await runCommand('podman', ['start', redis.Id]);
      for (const s of ['frontend', 'backend']) {
        const c = all.find(c => name(c) === `${project}_${s}_1`);
        if (c) {
          touched = true;
          await runCommand('podman', ['stop', '--time', '20', c.Id]);
          await runCommand('podman', ['rm', c.Id]);
        }
      }
      for (const s of ['backend', 'frontend']) {
        const id = pending.get(s);
        touched = true;
        await runCommand('podman', ['rename', id, `${project}_${s}_1`]);
        pending.delete(s); // Recovery now owns this canonical container, even if start fails.
        await runCommand('podman', ['start', id]);
      }
      const after = await snapshot();
      if (JSON.stringify(after.resources) !== JSON.stringify(previous.resources)) throw deploymentError('resources-mismatch');
      if (['backend', 'frontend'].some(s => after.images[s] !== images[s])) throw deploymentError('image-mismatch');
    } catch (error) {
      if (!touched) error.deploymentUntouched = true;
      throw error;
    } finally {
      // Only remove our own stopped candidates; never an active application.
      for (const id of pending.values()) await runCommand('podman', ['rm', id]).catch(() => {});
      await fs.rm(directory, { recursive: true, force: true });
    }
  }
  return { snapshot, apply, validateResources };
}

// A second host process must not race for the same queue/transaction.
export async function lockUpdateService(root) {
  // Respect a live service using the old directory lock during migration.
  const legacy = path.join(root, '.updates', 'host', 'service.lock', 'pid');
  try {
    const pid = Number(await fs.readFile(legacy, 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 1) throw deploymentError('service-locked');
    try { process.kill(pid, 0); throw deploymentError('service-locked'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const file = path.join(root, '.updates', 'host', 'service.flock');
  const handle = await fs.open(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  await handle.chmod(0o600);
  try {
    // flock locks the inherited descriptor's open file description. The parent
    // keeps that same description open after flock exits, so it owns the lock.
    const child = spawn('flock', ['--exclusive', '--nonblock', '3'], { stdio: ['ignore', 'ignore', 'ignore', handle.fd] });
    await new Promise((resolve, reject) => {
      child.once('error', error => reject(error.code === 'ENOENT' ? deploymentError('command-missing') : error));
      child.once('exit', code => code === 0 ? resolve() : reject(deploymentError('service-locked')));
    });
  } catch (error) { await handle.close(); throw error; }
  // On parent crash the kernel closes its descriptor and releases the lock.
  // Never unlink this file: that would permit locking a new inode.
  return async () => handle.close();
}
