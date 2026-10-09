import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
import { createPublicKey } from 'node:crypto';
import { backupProduction, verifyBackup } from './production.mjs';
import { createGitReleaseSource, updateProvider, validateImageRepository, validateRegistryImages, compareReleaseVersions } from './update-channel.mjs';
import { writeUpdateJson, updateBusy } from '../src/server/update-control.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const imageIdsValid = images => ['backend', 'frontend'].every(service => /^[a-f0-9]{64}$/.test(images?.[service]));

function validateJob(job) {
	if (!/^[a-f0-9-]{36}$/.test(job?.id) || !['check', 'install'].includes(job.action)
		|| (job.action === 'install' && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(job.version))) throw new Error('Demande invalide');
	return job;
}

async function readJob(file) {
	const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size > 1024) throw new Error('Demande non reguliere');
		return validateJob(JSON.parse(await handle.readFile('utf8')));
	} finally { await handle.close(); }
}

async function command(program, args, cwd) {
	const timeout = program === 'podman-compose' ? 5 * 60_000 : ['load', 'pull'].includes(args[0]) ? 10 * 60_000 : 30_000;
	try { return (await execute(program, args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024 })).stdout; }
	catch { throw new Error('Commande de mise a jour echouee ; sortie privee masquee'); }
}

export async function initializeUpdates(root = ROOT) {
	for (const directory of ['requests', 'status', 'host']) {
		await fs.mkdir(path.join(root, '.updates', directory), { recursive: true, mode: 0o700 });
		await fs.chmod(path.join(root, '.updates', directory), 0o700);
	}
}

export function createUpdateWorker({ root = ROOT, project = 'youplayer-server', sourceFactory = createGitReleaseSource,
	initialVersion,
	runCommand = (program, args) => command(program, args, root),
	backup = () => backupProduction({ root, project, maintenance: true }),
	verify = verifyBackup, readiness, wait = sleep } = {}) {
	if (!/^[a-z][a-z0-9-]*$/.test(project)) throw new Error('Projet invalide');
	const directory = path.join(root, '.updates');
	const host = path.join(directory, 'host');
	const statusFile = path.join(directory, 'status', 'status.json');
	let state = { enabled: false, phase: 'idle', currentVersion: 'Installation actuelle' };
	let active = null;
	let writing = Promise.resolve();
	const maintenanceLock = path.join(root, 'backups', '.backup-lock');
	let maintenanceOwner = null;
	async function lockMaintenance(id) {
		await fs.mkdir(path.dirname(maintenanceLock), { recursive: true, mode: 0o700 });
		await fs.mkdir(maintenanceLock, { mode: 0o700 });
		maintenanceOwner = id;
		await fs.writeFile(path.join(maintenanceLock, '.update-owner'), id, { mode: 0o600 });
	}
	async function unlockMaintenance() {
		if (!maintenanceOwner) return;
		await fs.rm(path.join(maintenanceLock, '.update-owner'), { force: true });
		await fs.rmdir(maintenanceLock);
		maintenanceOwner = null;
	}
	async function publish(patch = {}) {
		Object.assign(state, patch, { heartbeat: Date.now() });
		const snapshot = { ...state };
		writing = writing.catch(() => {}).then(() => writeUpdateJson(statusFile, snapshot));
		await writing;
	}
	async function config() {
		const value = JSON.parse(await fs.readFile(path.join(host, 'config.json'), 'utf8'));
		updateProvider(value);
		const key = createPublicKey({ key: Buffer.from(value.publicKey, 'base64'), format: 'der', type: 'spki' });
		if (key.asymmetricKeyType !== 'ed25519') throw new Error('Cle Ed25519 requise');
		if (value.allowedImageRepositories !== undefined) {
			if (!Array.isArray(value.allowedImageRepositories)) throw new Error('Depots images invalides');
			value.allowedImageRepositories.forEach(validateImageRepository);
		}
		return { repository: value.repository, provider: value.provider, publicKey: value.publicKey,
			allowedDownloadOrigins: value.allowedDownloadOrigins, allowedImageRepositories: value.allowedImageRepositories };
	}
	async function deployment() {
		const images = {}, healthchecks = {};
		for (const service of ['backend', 'frontend']) {
			images[service] = (await runCommand('podman', ['inspect', `${project}_${service}_1`, '--format', '{{.Image}}'])).trim().replace(/^sha256:/, '');
			const health = JSON.parse((await runCommand('podman', ['inspect', `${project}_${service}_1`, '--format', '{{json .Config.Healthcheck}}'])).trim());
			if (health?.Test) healthchecks[service] = { test: health.Test };
		}
		if (!imageIdsValid(images)) throw new Error('Images actuelles indisponibles');
		return { images, healthchecks };
	}
	async function apply(images, healthchecks = {}) {
		if (!imageIdsValid(images)) throw new Error('Images invalides');
		const override = path.join(host, 'deploy.json');
		await writeUpdateJson(override, { services: Object.fromEntries(['backend', 'frontend'].map(service =>
			[service, { image: images[service], ...(healthchecks[service] ? { healthcheck: healthchecks[service] } : {}) }])) });
		await runCommand('podman', ['start', `${project}_redis_1`]);
		await runCommand('podman-compose', ['-p', project, '-f', 'docker-compose.yml', '-f', override,
			'up', '-d', '--no-build', '--force-recreate', '--no-deps', 'backend', 'frontend']);
	}
	async function healthy(images) {
		if (readiness) return readiness(images);
		const deadline = Date.now() + 180_000;
		for (let attempt = 0; attempt < 90 && Date.now() < deadline; attempt++) {
			let ok = true;
			for (const service of ['backend', 'frontend', 'redis']) {
				try {
					const values = (await runCommand('podman', ['inspect', `${project}_${service}_1`, '--format', '{{.State.Status}} {{.State.Health.Status}} {{.Image}}'])).trim().split(/\s+/);
					if (values[0] !== 'running' || values[1] !== 'healthy' || (service !== 'redis' && values[2].replace(/^sha256:/, '') !== images[service])) ok = false;
				} catch { ok = false; }
			}
			if (ok) {
				const ready = await new Promise(resolve => {
					const request = https.get('https://127.0.0.1:8443/health/ready', { rejectUnauthorized: false, timeout: 5000 }, response => {
						response.resume(); resolve(response.statusCode === 200);
					});
					request.on('error', () => resolve(false));
					request.on('timeout', () => { request.destroy(); resolve(false); });
				});
				if (ready) return;
			}
			await wait(2000);
		}
		throw new Error('Nouvelle version non saine');
	}
	async function setTags(images) {
		for (const service of ['backend', 'frontend']) {
			await runCommand('podman', ['tag', images[service], `localhost/youplayer-${service}:latest`]);
		}
	}
	async function rollback(transaction) {
		await publish({ phase: 'rolling_back' });
		await apply(transaction.previous.images, transaction.previous.healthchecks);
		await healthy(transaction.previous.images);
		await setTags(transaction.previous.images);
		active = transaction.active;
		await writeUpdateJson(path.join(host, 'active.json'), active);
		await fs.rm(path.join(host, 'transaction.json'));
		await publish({ phase: 'failed', rolledBack: true, currentVersion: active.version, updateAvailable: true });
	}
	async function initialize() {
		await initializeUpdates(root);
		try {
			active = JSON.parse(await fs.readFile(path.join(host, 'active.json'), 'utf8'));
			if (active.version === 'Installation actuelle' && active.sequence === 0) {
				throw Object.assign(new Error('Ancienne installation sans version'), { code: 'ENOENT' });
			}
			compareReleaseVersions(active.version, active.version);
			if (!Number.isSafeInteger(active.sequence) || active.sequence < 0) throw new Error('Sequence invalide');
		}
		catch (error) {
			if (error.code !== 'ENOENT') throw new Error('Version installee illisible');
			let version = initialVersion;
			if (!version) {
				// The host checkout must be updated alongside its installed images on
				// first migration. Afterwards active.json is the authoritative version.
				try { version = (await runCommand('git', ['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*'])).trim(); } catch {}
				try { compareReleaseVersions(version, version); }
				catch { version = JSON.parse(await fs.readFile(path.join(root, 'src', 'package.json'), 'utf8')).version; }
			}
			compareReleaseVersions(version, version);
			active = { version, sequence: 0 };
		}
		state.currentVersion = active.version;
		let transaction;
		try { transaction = JSON.parse(await fs.readFile(path.join(host, 'transaction.json'), 'utf8')); }
		catch (error) { if (error.code !== 'ENOENT') throw new Error('Transaction de mise a jour illisible'); }
		let interruptedJob;
		try { interruptedJob = await readJob(path.join(host, 'job.json')); }
		catch (error) { if (error.code !== 'ENOENT') throw new Error('Demande de mise a jour illisible'); }
		if (transaction) {
			state.requestId = transaction.requestId;
			const owner = await fs.readFile(path.join(maintenanceLock, '.update-owner'), 'utf8').catch(() => null);
			if (owner === transaction.requestId) {
				await fs.rm(path.join(maintenanceLock, '.update-owner')); await fs.rmdir(maintenanceLock);
			}
			await lockMaintenance(transaction.requestId);
			try { await rollback(transaction); } finally { await unlockMaintenance(); }
			await fs.rm(path.join(host, 'job.json'), { force: true });
		}
		try { await config(); state.enabled = true; } catch { state.enabled = false; }
		await publish();
		if (interruptedJob && !transaction) {
			const owner = await fs.readFile(path.join(maintenanceLock, '.update-owner'), 'utf8').catch(() => null);
			if (owner === interruptedJob.id) {
				await fs.rm(path.join(maintenanceLock, '.update-owner')); await fs.rmdir(maintenanceLock);
			}
			await fs.rm(path.join(host, 'images.tar.partial'), { force: true });
			await processRequest(interruptedJob);
		}
	}
	async function processRequest(job) {
		validateJob(job);
		await publish({ requestId: job.id, phase: 'checking', progress: 0, rolledBack: false });
		let transaction;
		try {
			const settings = await config();
			const source = sourceFactory(settings);
			const candidate = await source.latest();
			const manifest = candidate.manifest;
			if (manifest.schema === 2) validateRegistryImages(manifest, settings.allowedImageRepositories);
			const previous = await deployment();
			const available = manifest.sequence > active.sequence
				&& compareReleaseVersions(manifest.version, active.version) > 0
				&& ['backend', 'frontend'].some(service => manifest.images[service] !== previous.images[service]);
			await publish({ enabled: true, latestVersion: manifest.version, updateAvailable: available });
			if (job.action === 'check') { await publish({ phase: 'idle' }); return; }
			if (manifest.version === active.version && !available && manifest.sequence === active.sequence) {
				await publish({ phase: 'succeeded', updateAvailable: false }); return;
			}
			if (!available || manifest.version !== job.version) throw new Error('Release changee ou deja installee');
			await publish({ phase: 'downloading' });
			if (manifest.schema === 2) {
				const platform = (await runCommand('podman', ['info', '--format', '{{.Host.OS}}/{{.Host.Arch}}'])).trim();
				if (platform !== manifest.platform) throw new Error('Plateforme incompatible');
				for (const [index, service] of ['backend', 'frontend'].entries()) {
					const reference = manifest.registry[service];
					await runCommand('podman', ['pull', '--tls-verify=true', '--policy=always', '--platform', manifest.platform, reference]);
					// A registry manifest digest differs from a local image config ID.
					// Inspect the exact pulled reference, then bind it to the signed ID.
					const image = JSON.parse(await runCommand('podman', ['image', 'inspect', reference]));
					if (image.length !== 1 || image[0].Id?.replace(/^sha256:/, '') !== manifest.images[service]
						|| `${image[0].Os}/${image[0].Architecture}` !== manifest.platform
						|| !image[0].RepoDigests?.includes(reference)) throw new Error('Image recuperee invalide');
					await publish({ progress: (index + 1) * 50 });
				}
			} else {
				const archive = path.join(host, 'images.tar');
				let lastProgress = -1;
				await source.download(candidate, archive, async progress => {
					if (progress !== lastProgress) { lastProgress = progress; await publish({ progress }); }
				});
				await runCommand('podman', ['load', '--input', archive]);
			}
			for (const identity of Object.values(manifest.images)) await runCommand('podman', ['image', 'exists', identity]);
			await publish({ phase: 'backing_up', progress: 100 });
			const snapshot = await backup();
			await verify(snapshot.directory);
			// Share the existing backup mutex through restart/rollback so a daily
			// maintenance backup cannot stop containers in the middle of deployment.
			await lockMaintenance(job.id);
			transaction = { requestId: job.id, previous, active, backup: snapshot.directory };
			await writeUpdateJson(path.join(host, 'transaction.json'), transaction);
			await publish({ phase: 'restarting' });
			await apply(manifest.images);
			await healthy(manifest.images);
			await setTags(manifest.images);
			active = { version: manifest.version, sequence: manifest.sequence, images: manifest.images };
			await writeUpdateJson(path.join(host, 'active.json'), active);
			await fs.rm(path.join(host, 'transaction.json'));
			await publish({ phase: 'succeeded', currentVersion: active.version, updateAvailable: false });
		} catch {
			if (transaction) {
				try { await rollback(transaction); } catch { await publish({ phase: 'failed', rolledBack: false, enabled: false }); }
			} else await publish({ phase: 'failed' });
		} finally { await unlockMaintenance(); await fs.rm(path.join(host, 'job.json'), { force: true }); }
	}
	async function tick() {
		if (updateBusy(state.phase)) return;
		if (await fs.stat(path.join(host, 'transaction.json')).then(() => true, () => false)) return;
		const requestFile = path.join(directory, 'requests', 'request.json');
		let job;
		try {
			job = await readJob(requestFile);
		} catch (error) {
			if (error.code === 'ENOENT') return;
			await fs.rm(requestFile, { force: true }); await publish({ phase: 'failed' }); return;
		}
		// Mark busy before removing the queue slot so concurrent admins cannot install twice.
		await publish({ phase: 'checking', requestId: job.id });
		await fs.rename(requestFile, path.join(host, 'job.json'));
		try { await processRequest(job); } catch { await publish({ phase: 'failed' }); }
	}
	async function heartbeat() {
		if (!updateBusy(state.phase)) {
			try {
				await config();
				state.enabled = !(await fs.stat(path.join(host, 'transaction.json')).then(() => true, () => false));
			} catch { state.enabled = false; }
		}
		await publish();
	}
	return { initialize, tick, heartbeat, processRequest, state: () => ({ ...state }) };
}

async function cli() {
	if (process.getuid?.() === 0) throw new Error('Utiliser le compte Podman utilisateur, sans sudo');
	const [action, ...args] = process.argv.slice(2);
	await initializeUpdates();
	if (action === 'init') { console.log(JSON.stringify({ ok: true })); return; }
	if (action === 'configure') {
		const option = name => args[args.indexOf(name) + 1];
		if ((!args.includes('--repository') && !args.includes('--from-git')) || !args.includes('--public-key')) throw new Error('Depot et cle publique requis');
		let repository = option('--repository');
		if (args.includes('--from-git')) {
			const remote = (await command('git', ['config', '--get', 'remote.origin.url'], ROOT)).trim();
			if (/^git@[^:]+:/.test(remote)) repository = remote.replace(/^git@([^:]+):/, 'https://$1/');
			else { const parsed = new URL(remote); repository = `https://${parsed.host}${parsed.pathname}`; }
		}
		const key = createPublicKey(await fs.readFile(path.resolve(option('--public-key'))));
		if (key.asymmetricKeyType !== 'ed25519') throw new Error('Cle Ed25519 requise');
		const config = { repository, provider: args.includes('--gitlab') ? 'gitlab' : 'github',
			publicKey: key.export({ type: 'spki', format: 'der' }).toString('base64') };
		const repositories = args.flatMap((arg, index) => arg === '--image-repository' ? [args[index + 1]] : []);
		if (repositories.length) config.allowedImageRepositories = repositories.map(validateImageRepository);
		updateProvider(config);
		await writeUpdateJson(path.join(ROOT, '.updates', 'host', 'config.json'), config);
		console.log(JSON.stringify({ ok: true })); return;
	}
	if (action !== 'run') throw new Error('Commande : init | configure --repository URL --public-key FICHIER [--gitlab] [--image-repository REGISTRE/DEPOT] | run');
	const worker = createUpdateWorker();
	await worker.initialize();
	let stop = false;
	process.on('SIGTERM', () => { stop = true; }); process.on('SIGINT', () => { stop = true; });
	const timer = setInterval(() => worker.heartbeat().catch(() => {}), 5000);
	try { while (!stop) { await worker.tick(); await sleep(1000); } }
	finally { clearInterval(timer); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	cli().catch(() => { console.error('Service de mise a jour indisponible ; sortie privee masquee'); process.exitCode = 1; });
}
