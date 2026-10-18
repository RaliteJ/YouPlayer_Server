import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadDotEnvFile, loadServerConfig } from '../src/server/config.js';
import { preflight } from './production.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'youplayer-server';
const deploymentError = code => Object.assign(new Error('Installation refusée ; diagnostic privé masqué'), { updateCode: code });

// Compose gets literal installation values, never exported production variables.
// Callers use --env-file /dev/null to prevent dotenv interpolation/overrides.
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

export async function prepareInstallationEnvironment(root, pseudo, password) {
  const file = path.join(root, '.env');
  const existing = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing) {
    if (!existing.isFile()) throw new Error('.env doit être un fichier régulier.');
    return; // Never replace existing passwords or session secrets.
  }
  // shortcut: the host dotenv parser does not unescape quotes; support them when that parser does.
  if (typeof pseudo !== 'string' || !/^[a-zA-Z0-9_.@-]{1,100}$/.test(pseudo)
      || typeof password !== 'string' || password.length < 12 || /['\\\r\n\0]/.test(password)) {
    throw new Error('Pseudo invalide ou mot de passe trop court / contenant une apostrophe ou un antislash.');
  }
  const values = {
    COMPOSE_PROJECT_NAME: PROJECT, YOUPLAYER_ADMIN_PSEUDO: pseudo, YOUPLAYER_ADMIN_PASSWORD: password,
    YOUPLAYER_SESSION_SECRET: randomBytes(48).toString('hex'), YOUPLAYER_SPOTIFY_TOKEN_SECRET: randomBytes(48).toString('hex'),
    YOUPLAYER_LOG_LEVEL: 'info', YOUPLAYER_SESSION_MAX_AGE_MS: '259200000',
    FIRST_TRACK_SPECIAL_STREAM: 'true', FIRST_TRACK_SPECIAL_STREAM_NEXT: 'true',
    YOUPLAYER_YOUTUBE_API_KEY: '', YOUPLAYER_SPOTIFY_CLIENT_ID: '', YOUPLAYER_SPOTIFY_CLIENT_SECRET: '',
    YOUPLAYER_SPOTIFY_REDIRECT_URI: '', YOUPLAYER_SPOTIFY_SCOPES: '',
    YOUPLAYER_SPOTIFY_WEB_USERNAME: '', YOUPLAYER_SPOTIFY_WEB_PASSWORD: ''
  };
  await fs.writeFile(file, Object.entries(values).map(([name, value]) => `${name}='${value}'`).join('\n') + '\n',
    { flag: 'wx', mode: 0o600 });
}

export async function runInstallCommand(program, args, cwd, env = process.env, timeoutMs) {
	const timeout = timeoutMs ?? (program === 'podman-compose' ? 5 * 60_000 : ['load', 'pull'].includes(args[0]) ? 10 * 60_000 : 30_000);
	try {
		return await new Promise((resolve, reject) => {
			// execFile does not forward detached; spawn gives Compose and its
			// children their own process group, which can be stopped together.
			const child = spawn(program, args, { cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
			const stdout = [], stderr = [];
			let length = 0, timedOut = false, overflow = false;
			function stop() {
				try {
					if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
					else child.kill('SIGKILL');
				} catch { /* Already exited. */ }
			}
			const timer = setTimeout(() => { timedOut = true; stop(); }, timeout);
			function collect(chunks, chunk) {
				length += chunk.length;
				if (length > 4 * 1024 * 1024) { overflow = true; stop(); return; }
				chunks.push(chunk);
			}
			child.stdout.on('data', chunk => collect(stdout, chunk));
			child.stderr.on('data', chunk => collect(stderr, chunk));
			child.once('error', error => { clearTimeout(timer); reject(error); });
			child.once('close', code => {
				clearTimeout(timer);
				if (code === 0 && !timedOut && !overflow) resolve(Buffer.concat(stdout).toString('utf8'));
				else reject(Object.assign(new Error('Commande echouee'), { killed: timedOut, stderr: Buffer.concat(stderr).toString('utf8') }));
			});
		});
	}
	catch (error) {
		const output = String(error.stderr || '');
		const code = error.code === 'ENOENT' ? 'command-missing' : error.killed ? 'command-timeout'
			: /address already in use|port is already allocated/i.test(output) ? 'port-conflict'
			: /no space left on device/i.test(output) ? 'disk-full' : 'command-failed';
		// Raw command output stays on the host, outside the mounted status directory.
		await (async () => {
			const handle = await fs.open(path.join(cwd, '.updates', 'host', 'last-command.log'),
				constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
			try {
				await handle.chmod(0o600);
				await handle.writeFile(`${program} (${code})\n${output.slice(-1024 * 1024)}`);
			} finally { await handle.close(); }
		})().catch(() => {});
		throw deploymentError(code);
	}
}

export async function prepareHostDirectories(root = ROOT) {
	for (const directory of ['requests', 'status', 'host']) {
		await fs.mkdir(path.join(root, '.updates', directory), { recursive: true, mode: 0o700 });
		await fs.chmod(path.join(root, '.updates', directory), 0o700);
	}
}

export async function installServer({ root = ROOT, checkOnly = false, pseudo, password,
  run = (program, args) => runInstallCommand(program, args, root,
    program === 'podman-compose' && !args.includes('--version') ? composeEnvironment(root, PROJECT) : process.env,
    args.includes('build') ? 30 * 60_000 : undefined),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), report = console.log } = {}) {
  await fs.access(path.join(root, '.git'));
  await run('podman', ['info', '--format', '{{.Host.OS}}/{{.Host.Arch}}']);
  const names = (await run('podman', ['ps', '-a', '--format', '{{.Names}}'])).split(/\s+/);
  if (names.some(name => name.startsWith(`${PROJECT}_`))) {
    throw new Error('Une stack YouPlayer existe déjà. Pour la mettre à jour manuellement, consulter UPDATES.md.');
  }
  await run('podman-compose', ['--version']);
  if (checkOnly) return;
  await prepareInstallationEnvironment(root, pseudo, password);
  if (!(await preflight({ root })).ok) throw new Error('Configuration .env invalide ou permissions trop ouvertes. Consulter INSTALL.md.');
  await prepareHostDirectories(root);
  for (const folder of ['src/playlists', 'src/local_song']) await fs.mkdir(path.join(root, folder), { recursive: true, mode: 0o700 });
  const args = ['--env-file', '/dev/null', '-p', PROJECT, '-f', path.join(root, 'docker-compose.yml')];
  report('Construction des images depuis les sources locales…');
  const dirty = (await run('git', ['status', '--porcelain'])).trim();
  const commit = dirty ? 'unknown' : (await run('git', ['rev-parse', 'HEAD'])).trim();
  if (commit !== 'unknown' && !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Commit Git invalide.');
  await run('podman-compose', [...args, 'build', '--build-arg', `YOUPLAYER_BUILD_COMMIT=${commit}`]);
  report('Démarrage des services…');
  await run('podman-compose', [...args, 'up', '-d', '--no-build']);
  let healthy = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const containers = JSON.parse(await run('podman', ['inspect', ...['backend', 'frontend', 'redis'].map(service => `${PROJECT}_${service}_1`)]));
    healthy = containers.length === 3 && containers.every(container => container.State?.Status === 'running'
      && (container.State?.Health?.Status || container.State?.Healthcheck?.Status) === 'healthy');
    if (healthy) break;
    await wait(2000);
  }
  if (!healthy) throw new Error('Délai de démarrage dépassé. Configuration et données conservées ; vérifier les services.');
  report('YouPlayer est prêt : https://ADRESSE_DU_SERVEUR:8443');
  report('Connecte-toi avec le compte admin, puis crée un compte user pour écouter la musique.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (process.platform !== 'linux' || process.getuid?.() === 0) throw new Error('Utiliser Linux et le compte Podman utilisateur, sans sudo.');
    if (major < 22 || major === 22 && minor < 12) throw new Error('Node.js >= 22.12 requis.');
    const action = process.argv[2];
    if (!['check', 'install'].includes(action)) throw new Error('Lancer ./install.sh depuis le dépôt Git.');
    const parts = [];
    if (action === 'install' && !(await fs.lstat(path.join(ROOT, '.env')).catch(() => null))) {
      let length = 0;
      for await (const part of process.stdin) {
        length += part.length;
        if (length > 4096) throw new Error('Identifiants trop longs.');
        parts.push(part);
      }
    }
    const [pseudo, password] = Buffer.concat(parts).toString('utf8').split('\0');
    await installServer({ checkOnly: action === 'check', pseudo, password });
  } catch (error) {
    // Command stderr remains in the installer's private log, never on the terminal.
    console.error(error.updateCode ? `Installation arrêtée (${error.updateCode}). Consulter .updates/host/last-command.log sur l’hôte.`
      : error.code || error instanceof SyntaxError ? 'Installation arrêtée : fichier manquant, inaccessible ou invalide. Consulter INSTALL.md.' : error.message);
    process.exitCode = 1;
  }
}
