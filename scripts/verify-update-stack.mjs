// Destructive scenarios run ONLY in a private /tmp Podman store with synthetic data.
import assert from 'node:assert/strict';
import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { Readable } from 'node:stream';
import https from 'node:https';
import net from 'node:net';
import { createUpdateWorker, initializeUpdates, runUpdateCommand } from './update-service.mjs';
import { composeEnvironment, createDeployment } from './update-deployment.mjs';
import { createGitReleaseSource, imageArchiveHash } from './update-channel.mjs';
import { writeUpdateJson, createUpdateControl } from '../src/server/update-control.js';
import { containerPlans } from './update-container-plan.mjs';

const archive = process.argv[2];
if (!archive || !path.resolve(archive).startsWith('/tmp/')) throw new Error('Usage : node scripts/verify-update-stack.mjs /tmp/ARCHIVE_IMAGES_BASE.tar');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = await fs.mkdtemp('/tmp/youplayer-update-proof-');
await fs.chmod(root, 0o700);
const project = `youplayer-update-proof-${process.pid}`;
const originalEnvironment = { ...process.env };
const bin = path.join(root, 'bin');
for (const d of ['bin', 'runtime', 'config', 'data', 'runroot', 'tmp', 'src/playlists', 'src/local_song']) {
  await fs.mkdir(path.join(root, d), { recursive: true, mode: 0o700 });
}
// Keep systemd-run out of this isolated PATH: Netavark then launches its DNS
// helper directly instead of trying to create a unit on the real user's bus.
for (const name of ['python3', 'podman-compose', 'tar', 'cat', 'sh', 'conmon', 'crun', 'runc',
  'newuidmap', 'newgidmap', 'pasta', 'slirp4netns', 'fusermount3', 'fuse-overlayfs', 'mount', 'umount', 'iptables', 'nft']) {
  for (const directory of ['/usr/bin', '/bin']) {
    const source = path.join(directory, name);
    if (await fs.access(source).then(() => true, () => false)) { await fs.symlink(source, path.join(bin, name)); break; }
  }
}
const env = { PATH: bin, HOME: process.env.HOME, TMPDIR: path.join(root, 'tmp'),
  XDG_RUNTIME_DIR: path.join(root, 'runtime'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data') };
const podmanFlags = ['--root', path.join(root, 'storage'), '--runroot', path.join(root, 'runroot'),
  '--storage-driver=overlay', '--cgroup-manager=cgroupfs', '--events-backend=file', '--tmpdir', path.join(root, 'tmp')];
// Generated paths contain no shell metacharacters; no user values enter this wrapper.
await fs.writeFile(path.join(bin, 'podman'), `#!/bin/sh\nexec /usr/bin/podman ${podmanFlags.join(' ')} "$@"\n`, { mode: 0o700 });
for (const key of Object.keys(process.env)) delete process.env[key];
Object.assign(process.env, env);
let completed = false;
let stage = 'initialization';
async function command(program, args, timeout = 180_000) {
  try { return await runUpdateCommand(program, args, root, env, timeout); }
  catch (error) {
    await fs.writeFile(path.join(root, stage === 'cleanup' ? 'cleanup-failure.log' : 'failure.log'), `${stage}\n${String(error.stderr || '')}\n${String(error.stdout || '')}`, { mode: 0o600 });
    throw new Error(`Verification echouee (${stage}) ; diagnostic prive dans ${root}/failure.log`);
  }
}
const podman = args => command('podman', args);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let port;
async function request(route, { method = 'GET', cookie, body } = {}) {
  return new Promise((resolve, reject) => {
    const bytes = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({ hostname: '127.0.0.1', port, path: route, method, rejectUnauthorized: false,
      timeout: 5000, headers: { Origin: `https://127.0.0.1:${port}`, ...(cookie ? { Cookie: cookie } : {}),
        ...(bytes ? { 'Content-Type': 'application/json', 'Content-Length': bytes.length } : {}) } }, res => {
      let text = ''; res.on('data', c => text += c); res.on('end', () => {
        let json; try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, cookie: res.headers['set-cookie']?.map(v => v.split(';')[0]).join('; ') });
      });
    });
    req.on('error', () => reject(new Error('HTTPS local indisponible')));
    req.on('timeout', () => req.destroy()); req.end(bytes);
  });
}
async function ready() { return (await request('/health/ready').catch(() => ({}))).status === 200; }
async function waitReady() {
  for (let i = 0; i < 100; i++) { if (await ready()) return; await delay(300); }
  throw new Error('HTTPS readiness timeout');
}
try {
  console.log(`Stockage et donnees de test : ${root}`);
  stage = 'image import';
  await podman(['load', '--input', path.resolve(archive)]);
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  port = server.address().port; await new Promise(resolve => server.close(resolve));
  const config = JSON.parse(await command('python3', ['-c', 'import json,sys,yaml;print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path.join(repo, 'docker-compose.yml')]));
  // docker-archive preserves image IDs, but a digest-only reference has no tag.
  const imported = JSON.parse(await podman(['images', '--format', 'json']));
  const redis = imported.find(i => !(i.Names || []).some(n => n.includes('youplayer-server-')));
  assert.ok(redis, 'Redis base image imported');
  config.services.redis.image = redis.Id.replace(/^sha256:/, '');
  for (const s of ['backend', 'frontend']) {
    delete config.services[s].build;
    // An isolated XDG runtime has no user systemd bus for healthcheck timers.
    // Run the real healthchecks explicitly below instead of creating host timers.
    Object.assign(config.services[s].healthcheck, { interval: 'disable', timeout: '3s', start_period: '0s', retries: 1 });
  }
  config.services.frontend.ports = [`127.0.0.1:${port}:443`];
  await fs.writeFile(path.join(root, 'docker-compose.yml'), JSON.stringify(config));
  const password = randomBytes(24).toString('hex');
  await fs.writeFile(path.join(root, '.env'), `COMPOSE_PROJECT_NAME=${project}\nYOUPLAYER_SESSION_SECRET=${randomBytes(32).toString('hex')}\nYOUPLAYER_ADMIN_PSEUDO=synthetic-admin\nYOUPLAYER_ADMIN_PASSWORD=${password}\nYOUPLAYER_LOG_LEVEL=silent\n`, { mode: 0o600 });
  // A local file checks user data persistence without contacting a media service.
  await fs.writeFile(path.join(root, 'src/local_song/synthetic.wav'), Buffer.from('synthetic-local-file'));
  await initializeUpdates(root);
  stage = 'initial synthetic installation';
  console.log('Images importees ; demarrage de la stack synthetique');
  for (const n of ['private', 'sessions']) await podman(['network', 'create', ...(n === 'sessions' ? ['--internal'] : []), `${project}_${n}`]);
  for (const v of ['youplayer_data', 'redis_data', 'frontend_certs']) await podman(['volume', 'create', `${project}_${v}`]);
  await podman(['run', '-d', '--pull=never', '--name', `${project}_redis_1`, '--label', `io.podman.compose.project=${project}`,
    '--label', 'com.docker.compose.service=redis', '--network', `${project}_sessions:alias=redis`,
    '--volume', `${project}_redis_data:/data:Z`, '--health-cmd', '["redis-cli","ping"]', '--health-interval=disable',
    config.services.redis.image, ...config.services.redis.command]);
  const resolved = JSON.parse(await runUpdateCommand('python3', [path.join(repo, 'scripts/update-compose-config.py'), root, project], root, composeEnvironment(root, project, env)));
  const initialPlans = containerPlans(resolved, { root, project, port });
  for (const s of ['backend', 'frontend']) {
    const file = path.join(root, `${s}.env`);
    await fs.writeFile(file, initialPlans[s].environment.join('\n') + '\n', { mode: 0o600 });
    await podman(['create', ...initialPlans[s].args, '--env-file', file, config.services[s].image]);
    await podman(['start', `${project}_${s}_1`]);
    await fs.unlink(file);
  }
  await waitReady();
  const deployment = createDeployment({ root, project, port, runCommand: (p, a) => runUpdateCommand(p, a, root,
    ['python3', 'podman-compose'].includes(p) ? composeEnvironment(root, project, env) : env) });
  const baseline = await deployment.snapshot();
  const admin = await request('/auth/login', { method: 'POST', body: { pseudo: 'synthetic-admin', password } });
  assert.equal(admin.status, 200);
  const user = await request('/admin/users', { method: 'POST', cookie: admin.cookie,
    body: { pseudo: 'synthetic-listener', password, role: 'user' } });
  assert.equal(user.status, 201);
  const listener = await request('/auth/login', { method: 'POST', body: { pseudo: 'synthetic-listener', password } });
  assert.equal(listener.status, 200);
  const playlist = 'Synthetic.json';
  assert.equal((await request('/update_playlist', { method: 'POST', cookie: listener.cookie,
    body: { arg: { playlist, song: { type: 'local', title: 'Synthetic', url: 'synthetic.wav' } } } })).status, 200);
  async function persistence() {
    assert.equal((await request('/auth/me', { cookie: listener.cookie })).status, 200, 'Redis user session survives');
    assert.equal((await request(`/playlist_preview?playlist=${playlist}`, { cookie: listener.cookie })).json.length, 1);
    assert.equal((await request('/admin/updates', { cookie: listener.cookie })).status, 403);
    const snapshot = await deployment.snapshot();
    assert.deepEqual(snapshot.resources, baseline.resources, 'Redis, configuration, volumes and networks survive');
  }
  stage = 'build synthetic releases';
  console.log('Stack initiale valide ; preparation des releases synthetiques');
  const releases = [];
  for (const [version, broken] of [['v2', false], ['v3', true]]) {
    const images = {};
    for (const service of ['backend', 'frontend']) {
      const reference = `localhost/synthetic-${service}:${version}`;
      const dockerfile = path.join(root, `${service}-${version}.Dockerfile`);
      await fs.writeFile(dockerfile, `FROM localhost/youplayer-server-${service}:latest\nLABEL synthetic.release=${version}\n`
        + (broken && service === 'backend' ? 'USER root\nRUN printf "process.exit(1);\\n" > /var/www/html/server/healthcheck.js\nUSER node\n' : ''));
      await podman(['build', '--pull=never', '-f', dockerfile, '-t', reference, root]);
      images[service] = (await podman(['image', 'inspect', '--format', '{{.Id}}', reference])).trim().replace(/^sha256:/, '');
    }
    const file = path.join(root, `${version}.tar`);
    await podman(['save', '--format', 'docker-archive', '--multi-image-archive', '--output', file,
      ...['backend', 'frontend'].map(s => `localhost/synthetic-${s}:${version}`)]);
    await fs.chmod(file, 0o600);
    releases.push({ version, images, file });
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const key = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  await writeUpdateJson(path.join(root, '.updates/host/config.json'), { repository: 'https://github.com/synthetic/public', publicKey: key });
  let release;
  async function selectRelease(value) {
    const payload = Buffer.from(JSON.stringify({ schema: 1, version: value.version, sequence: Number(value.version.slice(1)), images: value.images,
      archive: { name: 'youplayer-images.tar', size: (await fs.stat(value.file)).size, sha256: await imageArchiveHash(value.file) } }));
    release = { ...value, envelope: { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') } };
  }
  const options = { root, project, port, initialVersion: 'v1', runCommand: deploymentCommand,
    healthTimeoutMs: 20_000, healthIntervalMs: 250, readinessProbe: ready,
    sourceFactory: settings => createGitReleaseSource(settings, { fetchImpl: async url => {
      // Exercise real signature, size/hash and download code with a local transport.
      assert.equal(new URL(url).origin, 'https://api.github.com');
      if (url.endsWith('/releases/latest')) return Response.json({ tag_name: release.version, assets: [
        { name: 'youplayer-update.json', url: 'https://api.github.com/assets/manifest' },
        { name: 'youplayer-images.tar', url: 'https://api.github.com/assets/archive' }] });
      if (url.endsWith('/manifest')) return Response.json(release.envelope);
      if (url.endsWith('/archive')) return new Response(Readable.toWeb(createReadStream(release.file)));
      throw new Error('Unexpected test URL');
    } }) };
  async function deploymentCommand(p, a) {
    if (p === 'podman' && a[0] === 'inspect') {
      // Health commands execute inside the real containers, including the broken image.
      for (const s of ['backend', 'frontend', 'redis']) await podman(['healthcheck', 'run', `${project}_${s}_1`]).catch(() => {});
    }
    return runUpdateCommand(p, a, root, ['python3', 'podman-compose'].includes(p) ? composeEnvironment(root, project, env) : env);
  }
  const worker = createUpdateWorker(options); await worker.initialize();
  const control = createUpdateControl({ requestsDirectory: path.join(root, '.updates/requests'), statusDirectory: path.join(root, '.updates/status') });
  await selectRelease(releases[0]);
  stage = 'explicit check';
  await control.request('check'); await worker.tick();
  assert.equal(worker.state().updateAvailable, true);
  assert.deepEqual((await deployment.snapshot()).containerIds, baseline.containerIds, 'Check never recreates containers');
  await persistence();
  stage = 'successful signed update';
  await control.request('install', 'v2'); await worker.tick();
  assert.equal(worker.state().phase, 'succeeded', JSON.stringify(worker.state().failure));
  assert.deepEqual((await deployment.snapshot()).images, releases[0].images);
  await persistence();
  console.log('OK : verification explicite, archive signee, remplacement reel, HTTPS, sessions et donnees preserves');
  stage = 'failed health and rollback';
  await selectRelease(releases[1]);
  await control.request('check'); await worker.tick();
  await control.request('install', 'v3'); await worker.tick();
  assert.equal(worker.state().rolledBack, true, JSON.stringify(worker.state().failure));
  assert.equal(worker.state().currentVersion, 'v2');
  assert.deepEqual((await deployment.snapshot()).images, releases[0].images);
  await persistence();
  console.log('OK : image volontairement defectueuse refusee, anciennes images retablies et application disponible');
  stage = 'interrupted deployment recovery';
  const previous = await deployment.snapshot();
  const id = randomUUID();
  await writeUpdateJson(path.join(root, '.updates/host/transaction.json'), { requestId: id, previous,
    active: { version: 'v2', sequence: 2, images: releases[0].images } });
  await podman(['stop', previous.containerIds.frontend]);
  await podman(['rm', previous.containerIds.frontend]);
  const restarted = createUpdateWorker(options); await restarted.initialize();
  assert.equal(restarted.state().rolledBack, true, JSON.stringify(restarted.state().failure));
  await persistence();
  console.log('OK : reprise apres interruption avec frontend absent');
  completed = true;
} finally {
  stage = 'cleanup';
  // The wrapper always points at this test's private storage, including on failure.
  try {
    const ids = (await podman(['ps', '-aq'])).trim().split(/\s+/).filter(Boolean);
    if (ids.length) await podman(['rm', '--force', ...ids]);
  } catch { console.error(`Nettoyage a verifier dans le stockage prive ${root}`); }
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, originalEnvironment);
  if (completed) console.log('Tous les scenarios ont reussi ; conteneurs de test supprimes. Artefacts prives conserves dans /tmp.');
}
