import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';

const phases = new Set(['idle', 'checking', 'fixing', 'finished', 'failed']);
export const securityBusy = phase => ['checking', 'fixing'].includes(phase);
export const dependencyLockHash = data => createHash('sha256').update(data).digest('hex');

export function createSecurityControl({ requestsDirectory, statusDirectory, now = Date.now,
  installedLock = new URL('../package-lock.json', import.meta.url) } = {}) {
  async function status() {
    const empty = { online: false, phase: 'idle', result: 'not-checked', rebuildRequired: false };
    if (!requestsDirectory || !statusDirectory) return empty;
    let value;
    try { value = JSON.parse(await fs.readFile(path.join(statusDirectory, 'security.json'), 'utf8')); }
    catch { return empty; }
    const age = now() - Number(value.heartbeat);
    const report = value.report || {};
    const count = input => {
      if (!input) return null;
      return Object.fromEntries(['info', 'low', 'moderate', 'high', 'critical'].map(level =>
        [level, Number.isSafeInteger(input[level]) && input[level] >= 0 ? input[level] : 0]));
    };
    const installedHash = await fs.readFile(installedLock).then(dependencyLockHash, () => null);
    const pendingHash = /^[a-f0-9]{64}$/.test(report.pendingLockHash) ? report.pendingLockHash : null;
    return {
      online: age >= 0 && age < 30_000,
      phase: phases.has(value.phase) ? value.phase : 'idle',
      requestId: /^[a-f0-9-]{36}$/.test(value.requestId) ? value.requestId : null,
      result: ['clean', 'vulnerable', 'manual-review', 'updated-rebuild-required'].includes(report.status) ? report.status : 'not-checked',
      checkedAt: typeof report.checkedAt === 'string' && Number.isFinite(Date.parse(report.checkedAt)) ? report.checkedAt : null,
      counts: count(report.after || report.before),
      rebuildRequired: Boolean(pendingHash && pendingHash !== installedHash),
      installedMatchesAudit: Boolean(installedHash && installedHash === report.auditedLockHash)
    };
  }
  async function request(action) {
    if (!['check', 'fix'].includes(action)) throw Object.assign(new Error('Action invalide'), { statusCode: 400 });
    const current = await status();
    if (!current.online) throw Object.assign(new Error('Service securite arrete'), { statusCode: 503 });
    if (securityBusy(current.phase)) throw Object.assign(new Error('Controle deja actif'), { statusCode: 409 });
    if (action === 'fix' && !['vulnerable', 'manual-review'].includes(current.result)) throw Object.assign(new Error('Verifier les dependances avant correction'), { statusCode: 409 });
    const job = { id: randomUUID(), action };
    const temporary = path.join(requestsDirectory, `${job.id}.tmp`);
    try {
      await fs.writeFile(temporary, JSON.stringify(job), { flag: 'wx', mode: 0o600 });
      await fs.link(temporary, path.join(requestsDirectory, 'security.json'));
    } catch (error) {
      throw Object.assign(new Error('Demande securite indisponible'), { statusCode: error.code === 'EEXIST' ? 409 : 503 });
    } finally { await fs.rm(temporary, { force: true }); }
    return job;
  }
  return { status, request };
}
