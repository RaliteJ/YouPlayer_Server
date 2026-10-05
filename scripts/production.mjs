import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadDotEnvFile, loadServerConfig } from '../src/server/config.js';

const execute = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
async function fileHash(file) {
	const digest = createHash('sha256');
	for await (const chunk of createReadStream(file)) digest.update(chunk);
	return digest.digest('hex');
}
async function command(program, args, options = {}) {
	try { return (await execute(program, args, { timeout: 120_000, maxBuffer: 16 * 1024 * 1024, ...options })).stdout; }
	catch { throw new Error(`Commande ${program} echouee (sortie privee masquee)`); }
}
const podman = args => command('podman', args);
function safeName(name) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new Error('Nom de projet ou volume invalide');
	return name;
}

export async function preflight({ root = ROOT, dataFile } = {}) {
	const envPath = path.join(root, '.env');
	const env = {};
	loadDotEnvFile(envPath, env);
	const checks = {};
	const stat = await fs.stat(envPath).catch(() => null);
	checks.environmentPrivate = Boolean(stat && (stat.mode & 0o077) === 0);
	try {
		loadServerConfig({ ...env, NODE_ENV: 'production', YOUPLAYER_AUTH_ENABLED: 'true', YOUPLAYER_REDIS_URL: 'redis://redis:6379' });
		checks.productionSecrets = true;
	} catch { checks.productionSecrets = false; }
	checks.adminBootstrap = Boolean(String(env.YOUPLAYER_ADMIN_PSEUDO || '').trim()
		&& String(env.YOUPLAYER_ADMIN_PASSWORD || '').length >= 12
		&& !/replace|change|example|^\$\{/i.test(String(env.YOUPLAYER_ADMIN_PASSWORD || '')));
	if (dataFile) {
		try {
			const store = JSON.parse(await fs.readFile(dataFile, 'utf8'));
			checks.existingAdmin = store.version === 1 && store.users.some(([, user]) => user.role === 'admin');
		} catch { checks.existingAdmin = false; }
	}
	checks.optionalOAuthComplete = ![env.YOUPLAYER_SPOTIFY_CLIENT_ID, env.YOUPLAYER_SPOTIFY_CLIENT_SECRET, env.YOUPLAYER_SPOTIFY_REDIRECT_URI].some(Boolean)
		|| [env.YOUPLAYER_SPOTIFY_CLIENT_ID, env.YOUPLAYER_SPOTIFY_CLIENT_SECRET, env.YOUPLAYER_SPOTIFY_REDIRECT_URI].every(Boolean);
	const ok = checks.environmentPrivate && checks.productionSecrets && checks.optionalOAuthComplete
		&& (checks.existingAdmin || checks.adminBootstrap);
	return { ok, checks };
}

async function privateCopy(source, target) {
	const stat = await fs.lstat(source);
	if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error('Entree de sauvegarde non reguliere');
	if (stat.isDirectory()) {
		await fs.mkdir(target, { mode: 0o700 });
		for (const name of await fs.readdir(source)) await privateCopy(path.join(source, name), path.join(target, name));
	} else {
		await fs.copyFile(source, target, 1);
		await fs.chmod(target, 0o600);
	}
}
async function inventory(directory, prefix = '') {
	const result = {};
	for (const name of (await fs.readdir(directory)).sort()) {
		if (!prefix && name === 'manifest.json') continue;
		const relative = prefix ? `${prefix}/${name}` : name;
		const file = path.join(directory, name), stat = await fs.lstat(file);
		if (stat.isSymbolicLink()) throw new Error('Lien interdit dans la sauvegarde');
		if (stat.isDirectory()) Object.assign(result, await inventory(file, relative));
		else if (stat.isFile()) result[relative] = await fileHash(file);
		else throw new Error('Entree de sauvegarde invalide');
	}
	return result;
}

export async function verifyBackup(directory) {
	let manifest;
	try { manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8')); }
	catch { throw new Error('Manifeste de sauvegarde illisible'); }
	if (manifest.version !== 1 || !Array.isArray(manifest.volumes) || !manifest.files) throw new Error('Manifeste invalide');
	const actual = await inventory(directory);
	if (JSON.stringify(actual) !== JSON.stringify(manifest.files)) throw new Error('Integrite de sauvegarde invalide');
	for (const volume of manifest.volumes) {
		safeName(volume);
		const archive = path.join(directory, 'volumes', `${volume}.tar`);
		const entries = await command('tar', ['-tf', archive]);
		if (entries.split('\n').filter(Boolean).some(entry => entry.startsWith('/') || entry.split('/').includes('..'))) {
			throw new Error('Chemin archive invalide');
		}
		const details = await command('tar', ['-tvf', archive]);
		if (details.split('\n').filter(Boolean).some(line => !['-', 'd'].includes(line[0]))) throw new Error('Lien ou fichier special interdit dans archive');
	}
	return manifest;
}

export async function backupProduction({ root = ROOT, project = 'youplayer-server', maintenance = false, backupRoot = path.join(root, 'backups') } = {}) {
	safeName(project);
	await fs.mkdir(backupRoot, { recursive: true, mode: 0o700 });
	await fs.chmod(backupRoot, 0o700);
	const lock = path.join(backupRoot, '.backup-lock');
	await fs.mkdir(lock, { mode: 0o700 }).catch(() => { throw new Error('Sauvegarde deja active ou verrou a examiner'); });
	const directory = path.join(backupRoot, stamp());
	const restart = [];
	let succeeded = false;
	let interrupted = false;
	const interrupt = () => { interrupted = true; };
	const checkInterrupted = () => { if (interrupted) throw new Error('Sauvegarde interrompue ; reprise des services initialement actifs'); };
	process.on('SIGTERM', interrupt);
	process.on('SIGINT', interrupt);
	try {
		const names = (await podman(['volume', 'ls', '--format', '{{.Name}}'])).trim().split('\n')
			.filter(name => name.startsWith(`${project}_`));
		if (!names.length) throw new Error('Aucun volume du projet : sauvegarde refusee');
		const ids = (await podman(['ps', '-q'])).trim().split('\n').filter(Boolean);
		const running = ids.length ? JSON.parse(await podman(['inspect', ...ids])) : [];
		const sources = [path.join(root, 'src/playlists'), path.join(root, 'src/local_song')];
		const writers = running.filter(container => container.Mounts?.some(mount => names.includes(mount.Name) || sources.includes(mount.Source)));
		if (writers.length && !maintenance) throw new Error('Services actifs : utiliser --maintenance pour une copie coherente');
		// Backend writers stop before Redis; only originally running containers restart.
		writers.sort((a, b) => Number(/redis/.test(a.Name)) - Number(/redis/.test(b.Name)));
		for (const container of writers) {
			checkInterrupted();
			restart.unshift(container.Id);
			await podman(['stop', '--time', '30', container.Id]);
		}
		checkInterrupted();
		await fs.mkdir(directory, { mode: 0o700 });
		await privateCopy(path.join(root, '.env'), path.join(directory, '.env'));
		await privateCopy(path.join(root, 'src/playlists'), path.join(directory, 'playlists'));
		await privateCopy(path.join(root, 'src/local_song'), path.join(directory, 'local_song'));
		await fs.mkdir(path.join(directory, 'volumes'), { mode: 0o700 });
		for (const volume of names) {
			checkInterrupted();
			const target = path.join(directory, 'volumes', `${safeName(volume)}.tar`);
			// Reserve a private output before Podman writes to it.
			await fs.writeFile(target, '', { mode: 0o600, flag: 'wx' });
			await podman(['volume', 'export', '--output', target, volume]);
			await fs.chmod(target, 0o600);
		}
		const manifest = { version: 1, project, createdAt: new Date().toISOString(), volumes: names, files: await inventory(directory) };
		await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600, flag: 'wx' });
		await verifyBackup(directory);
		checkInterrupted();
		succeeded = true;
		return { ok: true, directory, volumes: names.length };
	} finally {
		const failures = [];
		for (const id of restart) { try { await podman(['start', id]); } catch { failures.push(true); } }
		if (!succeeded) await fs.rm(directory, { recursive: true, force: true });
		await fs.rm(lock, { recursive: true, force: true });
		process.off('SIGTERM', interrupt);
		process.off('SIGINT', interrupt);
		if (failures.length) throw new Error('Sauvegarde terminee mais redemarrage a verifier');
	}
}

export async function restoreBackup(directory, { targetRoot = path.join(ROOT, 'backups', `restore-${stamp()}`), prefix = `youplayer-restore-${Date.now()}` } = {}) {
	safeName(prefix);
	const manifest = await verifyBackup(directory);
	const created = [];
	await fs.mkdir(targetRoot, { mode: 0o700 }); // Never overwrite an existing destination.
	try {
		await privateCopy(path.join(directory, '.env'), path.join(targetRoot, '.env'));
		await privateCopy(path.join(directory, 'playlists'), path.join(targetRoot, 'playlists'));
		await privateCopy(path.join(directory, 'local_song'), path.join(targetRoot, 'local_song'));
		const volumes = {};
		for (const [index, original] of manifest.volumes.entries()) {
			const name = `${prefix}-${index}`;
			if ((await podman(['volume', 'ls', '--format', '{{.Name}}'])).split('\n').includes(name)) throw new Error('Volume cible deja existant');
			await podman(['volume', 'create', name]); created.push(name);
			await podman(['volume', 'import', name, path.join(directory, 'volumes', `${original}.tar`)]);
			volumes[original] = name;
		}
		await fs.writeFile(path.join(targetRoot, 'restore.json'), JSON.stringify({ version: 1, source: path.resolve(directory), volumes }, null, 2), { mode: 0o600 });
		await writeRestoreOverride({ project: manifest.project, volumes, targetRoot });
		return { ok: true, targetRoot, volumes };
	} catch (error) {
		for (const name of created) await podman(['volume', 'rm', name]);
		await fs.rm(targetRoot, { recursive: true, force: true });
		throw error;
	}
}

export async function writeRestoreOverride({ project, volumes, targetRoot }) {
	const data = volumes[`${project}_youplayer_data`], redis = volumes[`${project}_redis_data`];
	if (!data || !redis) throw new Error('Volumes courants absents de la sauvegarde');
	const override = { services: { backend: { volumes: [
		`${targetRoot}/playlists:/var/www/html/playlists:Z`, `${targetRoot}/local_song:/var/www/html/local_song:Z`,
		'youplayer_data:/var/lib/youplayer:Z,U'
	] } }, volumes: { youplayer_data: { external: true, name: data }, redis_data: { external: true, name: redis } } };
	await fs.writeFile(path.join(targetRoot, 'restore-compose.json'), JSON.stringify(override, null, 2), { mode: 0o600, flag: 'wx' });
}

export async function monitor({ root = ROOT, project = 'youplayer-server', maxBackupAgeHours = 36, minFreeBytes = 2 * 1024 ** 3 } = {}) {
	safeName(project);
	const storage = await fs.statfs(root);
	const checks = { diskSpace: storage.bavail * storage.bsize >= minFreeBytes };
	const ids = (await podman(['ps', '-aq', '--filter', `label=io.podman.compose.project=${project}`])).trim().split('\n').filter(Boolean);
	const containers = ids.length ? JSON.parse(await podman(['inspect', ...ids])) : [];
	for (const service of ['backend', 'frontend', 'redis']) {
		const c = containers.find(item => (item.Config?.Labels?.['com.docker.compose.service']
			|| item.Config?.Labels?.['io.podman.compose.service']) === service);
		checks[service] = Boolean(c?.State?.Running && (c.State.Health?.Status || c.State.Healthcheck?.Status) === 'healthy');
	}
	const directories = (await fs.readdir(path.join(root, 'backups')).catch(() => [])).filter(name => /^\d{4}-/.test(name)).sort();
	const latest = directories.at(-1);
	checks.recentBackup = false;
	if (latest) {
		try { const manifest = JSON.parse(await fs.readFile(path.join(root, 'backups', latest, 'manifest.json'), 'utf8'));
			checks.recentBackup = Date.now() - Date.parse(manifest.createdAt) < maxBackupAgeHours * 3600_000;
		} catch { /* Failed verification must make monitoring fail. */ }
	}
	return { ok: Object.values(checks).every(Boolean), checks };
}

export async function createRelease({ root = ROOT, label = stamp() } = {}) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(label)) throw new Error('Nom de release invalide');
	const output = path.join(root, 'releases', label);
	await fs.mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
	await fs.mkdir(output, { mode: 0o700 });
	const staged = path.join(output, 'source');
	await fs.mkdir(staged, { mode: 0o700 });
	const files = (await command('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root })).split('\0').filter(Boolean);
	for (const relative of files) {
		if (/^(?:src\/(?:node_modules|playlists|local_song|musiq|spotify\/spotify-downloader)|coverage|backups|releases|\.updates)(?:\/|$)/.test(relative)
			|| /(^|\/)\.env(?:\.|$)/.test(relative) && relative !== '.env.example') continue;
		const source = path.join(root, relative);
		const stat = await fs.lstat(source).catch(() => null);
		if (!stat) continue; // Deleted tracked files belong to the current snapshot.
		if (!stat.isFile()) throw new Error('Source de release non reguliere');
		await fs.mkdir(path.dirname(path.join(staged, relative)), { recursive: true });
		await privateCopy(source, path.join(staged, relative));
	}
	for (const folder of ['src/playlists', 'src/local_song']) {
		await fs.mkdir(path.join(staged, folder), { recursive: true });
		await fs.writeFile(path.join(staged, folder, '.gitkeep'), '');
	}
	const manifest = { version: 1, createdAt: new Date().toISOString(), gitBase: (await command('git', ['rev-parse', 'HEAD'], { cwd: root })).trim(), files: await inventory(staged) };
	await fs.writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
	await command('tar', ['-czf', path.join(output, 'source.tar.gz'), '-C', staged, '.']);
	await fs.chmod(path.join(output, 'source.tar.gz'), 0o600);
	await fs.rm(staged, { recursive: true });
	return { ok: true, directory: output, sourceFiles: Object.keys(manifest.files).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	const [action, ...args] = process.argv.slice(2);
	try {
		let result;
		if (action === 'preflight') result = await preflight();
		else if (action === 'backup') result = await backupProduction({ maintenance: args.includes('--maintenance') });
		else if (action === 'verify-backup') { await verifyBackup(path.resolve(args[0])); result = { ok: true }; }
		else if (action === 'restore') result = await restoreBackup(path.resolve(args[0]));
		else if (action === 'monitor') result = await monitor();
		else if (action === 'release') result = await createRelease({ label: args[0] || stamp() });
		else throw new Error('Commande : preflight | backup [--maintenance] | verify-backup DOSSIER | restore DOSSIER | monitor | release [VERSION]');
		console.log(JSON.stringify(result));
		if (!result.ok) process.exitCode = 1;
	} catch (error) {
		console.error(error.message?.startsWith('E') ? 'Operation fichier echouee (details prives masques)' : error.message);
		process.exitCode = 1;
	}
}
