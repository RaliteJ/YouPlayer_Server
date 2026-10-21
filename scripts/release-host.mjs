import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadDotEnvFile, loadServerConfig } from '../src/server/config.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PROJECT = 'youplayer-server';
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

export async function runHostCommand(program, args, cwd, env = process.env, timeoutMs) {
	const compose = program === 'podman-compose' || program === 'docker' && args[0] === 'compose';
	const timeout = timeoutMs ?? (compose ? 5 * 60_000 : ['load', 'pull'].includes(args[0]) ? 10 * 60_000 : 30_000);
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
