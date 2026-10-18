import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeSecurityJson, dependencyLockHash, safeSecurityFailure } from '../src/server/security-control.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const levels = ['info', 'low', 'moderate', 'high', 'critical'];
const failure = (auditCode, message) => Object.assign(new Error(message), { auditCode });
async function npm(args, cwd) {
  // Do not pass production credentials to npm or to the test suite.
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { CI: 'true', NODE_ENV: 'test', PUPPETEER_SKIP_DOWNLOAD: 'true' });
  try {
    const { stdout } = await execute('npm', args, { cwd, env, timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout };
  } catch (error) {
    if (typeof error.code === 'number' && !error.killed) return { code: error.code, stdout: error.stdout, stderr: error.stderr };
    throw failure(error.code === 'ENOENT' ? 'npm-missing' : error.killed ? 'npm-timeout' : 'npm-failed', 'Commande npm indisponible ou interrompue ; sortie privee masquee');
  }
}

function counts(result) {
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw failure('audit-response', 'Reponse audit illisible'); }
  const vulnerabilities = value?.metadata?.vulnerabilities;
  if (value.error || !vulnerabilities || !levels.every(key => Number.isSafeInteger(vulnerabilities[key]) && vulnerabilities[key] >= 0)) throw failure('audit-unavailable', 'Audit indisponible');
  return Object.fromEntries(levels.map(key => [key, vulnerabilities[key]]));
}
const total = value => Object.values(value).reduce((a, b) => a + b, 0);

async function copyCode(source, target) {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'playlists', 'local_song', 'musiq', 'downloads', 'spotify-downloader'].includes(entry.name)) continue;
    const from = path.join(source, entry.name), to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyCode(from, to);
    else if (entry.isFile() && /\.(?:js|mjs|json|html|css|svg|png|webp|ico)$/.test(entry.name)) await fs.copyFile(from, to);
  }
}

export async function auditDependencies({ root = ROOT, fix = false, runNpm = npm } = {}) {
  const state = path.join(root, '.updates', 'dependency-audit');
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  const lock = path.join(state, 'running');
  try { await fs.mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === 'EEXIST') throw failure('lock-busy', 'Un audit est deja actif (ou son verrou doit etre verifie)'); throw error; }
  let stage;
  let currentStage = 'setup';
  try {
    const manifestFile = path.join(root, 'src', 'package.json');
    const lockFile = path.join(root, 'src', 'package-lock.json');
    const originalManifest = await fs.readFile(manifestFile);
    const originalLock = await fs.readFile(lockFile);
    const previous = await fs.readFile(path.join(state, 'report.json'), 'utf8').then(JSON.parse, () => ({}));
    stage = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-dependency-audit-'));
    await fs.chmod(stage, 0o700);
    const cwd = path.join(stage, 'src');
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, 'package.json'), originalManifest);
    await fs.writeFile(path.join(cwd, 'package-lock.json'), originalLock);
    async function run(args, step) {
      currentStage = step;
      const result = await runNpm(args, cwd);
      if (result.code !== 0 || step === 'validation') {
        const file = path.join(state, 'last-command.log');
        const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
        try {
          await handle.chmod(0o600);
          await handle.writeFile(`${step} (exit ${result.code})\n${String(result.stdout || '').slice(-2 * 1024 * 1024)}\n${String(result.stderr || '').slice(-2 * 1024 * 1024)}`);
        } finally { await handle.close(); }
      }
      return result;
    }
    const before = counts(await run(['audit', '--json', '--ignore-scripts'], 'audit'));
    let report = { checkedAt: new Date().toISOString(), status: total(before) ? 'vulnerable' : 'clean', before,
      auditedLockHash: dependencyLockHash(originalLock), pendingLockHash: previous.pendingLockHash || null };
    if (fix && total(before)) {
      // npm may return 1 if some advisories have no compatible fix.
      const correction = await run(['audit', 'fix', '--package-lock-only', '--ignore-scripts', '--no-fund'], 'correction');
      if (correction.code > 1) throw failure('npm-failed', 'Preparation des corrections npm echouee');
      const after = counts(await run(['audit', '--json', '--ignore-scripts'], 'correction'));
      const updatedLock = await fs.readFile(path.join(cwd, 'package-lock.json'));
      const updatedManifest = await fs.readFile(path.join(cwd, 'package.json'));
      if (!updatedManifest.equals(originalManifest)) throw failure('manifest-change', 'Correction refusée : package.json modifie');
      if (updatedLock.equals(originalLock) || total(after) >= total(before) || levels.some(key => after[key] > before[key])) {
        report.status = 'manual-review';
      } else {
        currentStage = 'validation';
        for (const directory of ['src', 'scripts', 'test']) await copyCode(path.join(root, directory), path.join(stage, directory));
        // Copying the source above restores the old lock; restore the candidate.
        await fs.writeFile(path.join(cwd, 'package-lock.json'), updatedLock);
        if ((await run(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], 'installation')).code !== 0) throw failure('install-failed', 'Installation candidate echouee ; fichiers originaux conserves');
        if ((await run(['run', 'test:security', '--ignore-scripts'], 'validation')).code !== 0) throw failure('tests-failed', 'Tests candidats echoues ; fichiers originaux conserves');
        currentStage = 'save';
        if (!(await fs.readFile(manifestFile)).equals(originalManifest) || !(await fs.readFile(lockFile)).equals(originalLock)) throw failure('dependencies-changed', 'Dependances modifiees pendant le controle ; correction annulee');
        await fs.writeFile(path.join(state, 'previous-package-lock.json'), originalLock, { mode: 0o600 });
        const pending = path.join(root, 'src', '.dependency-audit-lock.tmp');
        await fs.writeFile(pending, updatedLock, { flag: 'wx', mode: 0o644 });
        await fs.rename(pending, lockFile);
        report.status = 'updated-rebuild-required';
        report.after = after;
        report.auditedLockHash = report.pendingLockHash = dependencyLockHash(updatedLock);
      }
    }
    currentStage = 'save';
    await writeSecurityJson(path.join(state, 'report.json'), report);
    await fs.rm(path.join(state, 'failure.json'), { force: true });
    return report;
  } catch (error) {
    const diagnostic = safeSecurityFailure(error, currentStage);
    await writeSecurityJson(path.join(state, 'failure.json'), { ...diagnostic, failedAt: new Date().toISOString() }).catch(() => {});
    throw Object.assign(error, { auditCode: diagnostic.code, stage: diagnostic.stage });
  } finally {
    try { if (stage) await fs.rm(stage, { recursive: true, force: true }); }
    finally { await fs.rmdir(lock); }
  }
}

export async function createSecurityWorker({ root = ROOT, audit = options => auditDependencies(options), now = Date.now } = {}) {
  const requests = path.join(root, '.updates', 'requests');
  const statusFile = path.join(root, '.updates', 'status', 'security.json');
  const serviceLock = path.join(root, '.updates', 'dependency-audit', 'service');
  await fs.mkdir(requests, { recursive: true, mode: 0o700 });
  await fs.mkdir(path.dirname(serviceLock), { recursive: true, mode: 0o700 });
  await fs.mkdir(serviceLock, { mode: 0o700 });
  const priorStatus = await fs.readFile(statusFile, 'utf8').then(JSON.parse).catch(() => null);
  const state = { phase: ['checking', 'fixing'].includes(priorStatus?.phase) ? 'failed' : 'idle',
    failure: ['checking', 'fixing'].includes(priorStatus?.phase) ? { code: 'interrupted', stage: 'setup' } : null,
    requestId: priorStatus?.requestId,
    report: await fs.readFile(path.join(root, '.updates', 'dependency-audit', 'report.json'), 'utf8').then(JSON.parse).catch(() => null) };
  let writing = Promise.resolve();
  function heartbeat() {
    const snapshot = { ...state, heartbeat: now() };
    writing = writing.catch(() => {}).then(() => writeSecurityJson(statusFile, snapshot));
    return writing;
  }
  async function tick() {
    if (['checking', 'fixing'].includes(state.phase)) return;
    const queued = path.join(requests, 'security.json');
    let job;
    try {
      const handle = await fs.open(queued, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 1024) throw new Error('Demande invalide');
        job = JSON.parse(await handle.readFile('utf8'));
        if (!/^[a-f0-9-]{36}$/.test(job?.id) || !['check', 'fix'].includes(job.action)) throw new Error('Demande invalide');
      } finally { await handle.close(); }
    } catch (error) {
      if (error.code === 'ENOENT') return;
      await fs.rm(queued, { force: true });
      state.phase = 'failed';
      state.failure = { code: 'invalid-request', stage: 'setup' };
      await heartbeat();
      return;
    }
    state.phase = job.action === 'fix' ? 'fixing' : 'checking';
    state.failure = null;
    state.requestId = job.id;
    await heartbeat();
    await fs.rm(queued);
    try {
      state.report = await audit({ root, fix: job.action === 'fix' });
      state.phase = 'finished';
    } catch (error) {
      state.phase = 'failed';
      state.failure = safeSecurityFailure(error);
      console.error(`Securite : ${state.failure.code} (${state.failure.stage})`);
    }
    await heartbeat();
  }
  async function close() {
    await writing;
    await fs.rmdir(serviceLock);
    await writeSecurityJson(statusFile, { ...state, heartbeat: 0 });
  }
  try { await heartbeat(); } catch (error) { await fs.rmdir(serviceLock); throw error; }
  return { tick, heartbeat, close };
}

async function cli() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--fix', '--watch', '--serve'].includes(arg)) || (args.includes('--serve') && args.length !== 1)) throw new Error('Usage : node scripts/dependency-audit.mjs [--fix] [--watch] | --serve');
  if (process.getuid?.() === 0) throw new Error('Utiliser le compte utilisateur, sans sudo');
  let stopped = false, wake;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; wake?.(); });
  if (args.includes('--serve')) {
    const worker = await createSecurityWorker();
    const timer = setInterval(() => worker.heartbeat().catch(() => {}), 5000);
    try {
      console.log('Service securite actif ; controles sur demande depuis Admin');
      while (!stopped) {
        await worker.tick();
        if (!stopped) await new Promise(resolve => {
          const timer = setTimeout(resolve, 1000);
          wake = () => { clearTimeout(timer); resolve(); };
        });
      }
    } finally { clearInterval(timer); await worker.close(); }
    return;
  }
  do {
    try { console.log(JSON.stringify(await auditDependencies({ fix: args.includes('--fix') }))); }
    catch (error) { const diagnostic = safeSecurityFailure(error); console.error(`Securite : ${diagnostic.code} (${diagnostic.stage})`); if (!args.includes('--watch')) { process.exitCode = 1; return; } }
    if (!args.includes('--watch') || stopped) break;
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 24 * 60 * 60_000);
      wake = () => { clearTimeout(timer); resolve(); };
    });
    wake = undefined;
  } while (!stopped);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli().catch(() => { console.error('Controle des dependances impossible ; sortie privee masquee'); process.exitCode = 1; });
}
