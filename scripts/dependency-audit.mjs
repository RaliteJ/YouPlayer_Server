import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const levels = ['info', 'low', 'moderate', 'high', 'critical'];
async function npm(args, cwd) {
  // Do not pass production credentials to npm or to the test suite.
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'PUPPETEER_EXECUTABLE_PATH'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { CI: 'true', NODE_ENV: 'test', PUPPETEER_SKIP_DOWNLOAD: 'true' });
  try {
    const { stdout } = await execute('npm', args, { cwd, env, timeout: 20 * 60_000, maxBuffer: 16 * 1024 * 1024 });
    return { code: 0, stdout };
  } catch (error) {
    if (error.code === 1 && !error.killed) return { code: 1, stdout: error.stdout };
    throw new Error('Commande npm indisponible ou interrompue ; sortie privee masquee');
  }
}

function counts(result) {
  let value;
  try { value = JSON.parse(result.stdout); } catch { throw new Error('Reponse audit illisible'); }
  const vulnerabilities = value?.metadata?.vulnerabilities;
  if (value.error || !vulnerabilities || !levels.every(key => Number.isSafeInteger(vulnerabilities[key]) && vulnerabilities[key] >= 0)) throw new Error('Audit indisponible');
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
  catch (error) { if (error.code === 'EEXIST') throw new Error('Un audit est deja actif (ou son verrou doit etre verifie)'); throw error; }
  let stage;
  try {
    const manifestFile = path.join(root, 'src', 'package.json');
    const lockFile = path.join(root, 'src', 'package-lock.json');
    const originalManifest = await fs.readFile(manifestFile);
    const originalLock = await fs.readFile(lockFile);
    stage = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-dependency-audit-'));
    await fs.chmod(stage, 0o700);
    const cwd = path.join(stage, 'src');
    await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, 'package.json'), originalManifest);
    await fs.writeFile(path.join(cwd, 'package-lock.json'), originalLock);
    const before = counts(await runNpm(['audit', '--json', '--ignore-scripts'], cwd));
    let report = { checkedAt: new Date().toISOString(), status: total(before) ? 'vulnerable' : 'clean', before };
    if (fix && total(before)) {
      // npm may return 1 if some advisories have no compatible fix.
      await runNpm(['audit', 'fix', '--package-lock-only', '--ignore-scripts', '--no-fund'], cwd);
      const after = counts(await runNpm(['audit', '--json', '--ignore-scripts'], cwd));
      const updatedLock = await fs.readFile(path.join(cwd, 'package-lock.json'));
      const updatedManifest = await fs.readFile(path.join(cwd, 'package.json'));
      if (!updatedManifest.equals(originalManifest)) throw new Error('Correction refusée : package.json modifie');
      report = { ...report, after };
      if (updatedLock.equals(originalLock) || total(after) >= total(before) || levels.some(key => after[key] > before[key])) {
        report.status = 'manual-review';
      } else {
        for (const directory of ['src', 'scripts', 'test']) await copyCode(path.join(root, directory), path.join(stage, directory));
        // Copying the source above restores the old lock; restore the candidate.
        await fs.writeFile(path.join(cwd, 'package-lock.json'), updatedLock);
        if ((await runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd)).code !== 0) throw new Error('Installation candidate echouee ; fichiers originaux conserves');
        if ((await runNpm(['test', '--ignore-scripts'], cwd)).code !== 0) throw new Error('Tests candidats echoues ; fichiers originaux conserves');
        if (!(await fs.readFile(manifestFile)).equals(originalManifest) || !(await fs.readFile(lockFile)).equals(originalLock)) throw new Error('Dependances modifiees pendant le controle ; correction annulee');
        await fs.writeFile(path.join(state, 'previous-package-lock.json'), originalLock, { mode: 0o600 });
        const pending = path.join(root, 'src', '.dependency-audit-lock.tmp');
        await fs.writeFile(pending, updatedLock, { flag: 'wx', mode: 0o644 });
        await fs.rename(pending, lockFile);
        report.status = 'updated-rebuild-required';
      }
    }
    await fs.writeFile(path.join(state, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    return report;
  } finally {
    try { if (stage) await fs.rm(stage, { recursive: true, force: true }); }
    finally { await fs.rmdir(lock); }
  }
}

async function cli() {
  const args = process.argv.slice(2);
  if (args.some(arg => !['--fix', '--watch'].includes(arg))) throw new Error('Usage : node scripts/dependency-audit.mjs [--fix] [--watch]');
  if (process.getuid?.() === 0) throw new Error('Utiliser le compte utilisateur, sans sudo');
  let stopped = false, wake;
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopped = true; wake?.(); });
  do {
    try { console.log(JSON.stringify(await auditDependencies({ fix: args.includes('--fix') }))); }
    catch (error) { console.error(error.message); if (!args.includes('--watch')) { process.exitCode = 1; return; } }
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
