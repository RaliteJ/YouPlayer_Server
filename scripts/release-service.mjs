import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createReleaseSource, compareVersions, verifyManifest, releaseError } from './release-channel.mjs';
import { createDeployment } from './release-deployment.mjs';
import { readReleaseJob, writeReleaseJson, safeReleaseFailure } from '../src/server/release-control.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const identity = envelope => createHash('sha256').update(envelope.payload).digest('hex');

export async function createReleaseWorker({ root = ROOT, config, publicKey, source, deployment, now = Date.now }) {
  const host = path.join(root, '.updates/host');
  const stateFile = path.join(host, 'release-state.json');
  const transactionFile = path.join(host, 'transaction.json');
  let installed = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  function installedImages(value) {
    const manifest = verifyManifest(value.envelope, publicKey);
    return manifest.platforms[config.platform];
  }
  installedImages(installed);
  let candidate = null;
  const state = { phase: 'idle', installedVersion: verifyManifest(installed.envelope, publicKey).version,
    latestVersion: null, checkedAt: null, candidateId: null, failure: null, requestId: null };
  let writing = Promise.resolve(), busy = false;
  function heartbeat() {
    const snapshot = { ...state, heartbeat: now() };
    writing = writing.catch(() => {}).then(() => writeReleaseJson(path.join(root, '.updates/status/release.json'), snapshot));
    return writing;
  }
  async function phase(value) { state.phase = value; await heartbeat(); }
  async function rollback(previous, recovery = false) {
    await phase('rolling-back');
    await deployment.activate(installedImages(previous), recovery);
    await deployment.healthy(installedImages(previous));
    await writeReleaseJson(stateFile, previous);
    installed = previous;
    state.installedVersion = verifyManifest(previous.envelope, publicKey).version;
    await fs.rm(transactionFile);
    state.phase = 'rolled-back';
  }
  // A durable journal is written before changing containers; restart recovers the old pair.
  let transaction;
  try { transaction = JSON.parse(await fs.readFile(transactionFile, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (transaction) {
    try { await rollback(transaction.previous, true); state.failure = 'interrupted'; }
    catch { state.phase = 'recovery-required'; state.failure = 'rollback-failed'; }
  } else {
    try { await deployment.resume(installedImages(installed)); }
    catch (error) { state.phase = 'recovery-required'; state.failure = safeReleaseFailure(error); }
  }
  await heartbeat();

  async function tick() {
    if (busy || state.phase === 'recovery-required') return;
    const file = path.join(root, '.updates/requests/release.json');
    let job;
    try { job = await readReleaseJob(file); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      await fs.rm(file, { force: true });
      state.failure = 'invalid-request'; await phase('failed'); return;
    }
    busy = true;
    state.requestId = job.id;
    state.failure = null;
    await fs.rm(file);
    try {
      if (job.action === 'check') {
        candidate = null; state.candidateId = null; state.latestVersion = null;
        await phase('checking');
        const result = await source.latest();
        const manifest = verifyManifest(result.envelope, publicKey);
        const current = verifyManifest(installed.envelope, publicKey);
        state.latestVersion = manifest.version;
        state.checkedAt = new Date(now()).toISOString();
        if (compareVersions(manifest.version, current.version) === 0 && identity(result.envelope) === identity(installed.envelope)) {
          await phase('up-to-date');
        } else {
          if (compareVersions(manifest.version, current.version) <= 0 || manifest.sequence <= current.sequence) throw releaseError('stale-candidate');
          candidate = { envelope: result.envelope, checkedAt: now() };
          state.candidateId = identity(result.envelope);
          await phase('available');
        }
      } else {
        if (state.phase !== 'available' || !candidate || job.candidateId !== state.candidateId
          || now() - candidate.checkedAt > 30 * 60_000) throw releaseError('stale-candidate');
        const manifest = verifyManifest(candidate.envelope, publicKey);
        const images = manifest.platforms[config.platform];
        await phase('downloading');
        await deployment.assertCurrent(installedImages(installed));
        await deployment.pull(images);
        await deployment.assertCurrent(installedImages(installed));
        const previous = installed;
        await writeReleaseJson(transactionFile, { previous, candidate: candidate.envelope });
        try {
          await phase('installing');
          await deployment.activate(images);
          await phase('verifying');
          await deployment.healthy(images);
          const next = { envelope: candidate.envelope, previous: previous.envelope };
          await writeReleaseJson(stateFile, next);
          await fs.rm(transactionFile);
          installed = next;
          state.installedVersion = manifest.version;
          // Status publication must not undo a transaction already committed to disk.
          state.phase = 'installed';
        } catch (error) {
          state.failure = safeReleaseFailure(error);
          try { await rollback(previous); }
          catch { state.phase = 'recovery-required'; state.failure = 'rollback-failed'; }
        }
        candidate = null; state.candidateId = null;
      }
    } catch (error) {
      candidate = null; state.candidateId = null;
      state.failure = safeReleaseFailure(error); state.phase = 'failed';
    } finally { busy = false; await heartbeat(); }
  }
  return { tick, heartbeat, async close() { await writing; await writeReleaseJson(path.join(root, '.updates/status/release.json'), { ...state, heartbeat: 0 }); } };
}

async function serve() {
  const config = JSON.parse(await fs.readFile(path.join(ROOT, '.updates/host/config.json'), 'utf8'));
  const publicKey = await fs.readFile(path.join(ROOT, 'keys/release-public-key.pem'), 'utf8');
  const deployment = createDeployment({ root: ROOT, config });
  await deployment.checkTools();
  const worker = await createReleaseWorker({ config, publicKey, deployment, source: createReleaseSource({ publicKey }) });
  let stopped = false;
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { stopped = true; });
  const timer = setInterval(() => worker.heartbeat().catch(() => {}), 5000);
  try {
    while (!stopped) { await worker.tick(); if (!stopped) await new Promise(resolve => setTimeout(resolve, 1000)); }
  } finally { clearInterval(timer); await worker.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv[2] === '--locked') {
    serve().catch(() => { console.error('Service de mise à jour indisponible ; vérifier la configuration locale.'); process.exitCode = 1; });
  } else {
    // flock releases the lock even after a crash, before systemd restarts the worker.
    const child = spawn('flock', ['--nonblock', '--no-fork', path.join(ROOT, '.updates/host/service.lock'), process.execPath, fileURLToPath(import.meta.url), '--locked'], { stdio: 'inherit' });
    for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
    child.on('error', () => { process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  }
}
