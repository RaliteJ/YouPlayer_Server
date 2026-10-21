import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const releaseBusy = phase => ['checking', 'downloading', 'installing', 'verifying', 'rolling-back'].includes(phase);
const phases = new Set(['idle', 'available', 'up-to-date', 'installed', 'rolled-back', 'failed', 'recovery-required',
  'checking', 'downloading', 'installing', 'verifying', 'rolling-back']);
const version = value => typeof value === 'string' && /^v\d+\.\d+\.\d+$/.test(value) && value.length < 100 ? value : null;
const failures = new Set(['invalid-signature', 'invalid-release', 'incompatible-release', 'download-origin', 'no-release',
  'release-unavailable', 'stale-candidate', 'command-missing', 'command-failed', 'command-timeout', 'health-failed',
  'deployment-changed', 'platform-mismatch', 'interrupted', 'invalid-request', 'rollback-failed', 'internal']);
export const safeReleaseFailure = error => failures.has(error?.updateCode) ? error.updateCode : 'internal';

export async function writeReleaseJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
    const directory = await fs.open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function readReleaseJob(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024) throw new Error('Invalid request');
    const job = JSON.parse(await handle.readFile('utf8'));
    if (!/^[a-f0-9-]{36}$/.test(job.id || '') || !['check', 'install'].includes(job.action)
      || job.action === 'install' && !/^[a-f0-9]{64}$/.test(job.candidateId || '')) throw new Error('Invalid request');
    return job;
  } finally { await handle.close(); }
}

export function createReleaseControl({ requestsDirectory = process.env.YOUPLAYER_UPDATE_REQUESTS_DIR,
  statusDirectory = process.env.YOUPLAYER_UPDATE_STATUS_DIR, now = Date.now } = {}) {
  async function status() {
    if (!statusDirectory) return null;
    let value;
    try { value = JSON.parse(await fs.readFile(path.join(statusDirectory, 'release.json'), 'utf8')); } catch { return null; }
    const age = now() - Number(value.heartbeat);
    const online = age >= 0 && age < 30_000;
    const phase = phases.has(value.phase) ? value.phase : 'failed';
    const candidateId = /^[a-f0-9]{64}$/.test(value.candidateId || '') ? value.candidateId : null;
    return { online, phase, installedVersion: version(value.installedVersion), latestVersion: version(value.latestVersion),
      checkedAt: typeof value.checkedAt === 'string' && Number.isFinite(Date.parse(value.checkedAt)) ? value.checkedAt : null,
      requestId: /^[a-f0-9-]{36}$/.test(value.requestId || '') ? value.requestId : null,
      candidateId, canInstall: online && phase === 'available' && Boolean(candidateId),
      failure: value.failure ? safeReleaseFailure({ updateCode: value.failure }) : null };
  }
  async function request(action, candidateId) {
    if (!['check', 'install'].includes(action)) throw Object.assign(new Error('Invalid action'), { statusCode: 400 });
    const current = await status();
    if (!requestsDirectory || !current?.online) throw Object.assign(new Error('Updater offline'), { statusCode: 503 });
    if (releaseBusy(current.phase) || current.phase === 'recovery-required') throw Object.assign(new Error('Updater busy'), { statusCode: 409 });
    if (action === 'install' && (!current.canInstall || candidateId !== current.candidateId)) throw Object.assign(new Error('Check required'), { statusCode: 409 });
    const job = { id: randomUUID(), action, ...(action === 'install' ? { candidateId } : {}) };
    const temporary = path.join(requestsDirectory, `${job.id}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(job), { flag: 'wx', mode: 0o600 });
      await fs.link(temporary, path.join(requestsDirectory, 'release.json'));
    } catch (error) {
      throw Object.assign(new Error('Request unavailable'), { statusCode: error.code === 'EEXIST' ? 409 : 503 });
    } finally { await fs.rm(temporary, { force: true }); }
    return job;
  }
  return { status, request };
}
