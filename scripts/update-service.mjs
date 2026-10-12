import { promises as fs, constants } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import https from 'node:https';
import { createPublicKey } from 'node:crypto';
import { backupProduction, verifyBackup } from './production.mjs';
import { createGitReleaseSource, updateProvider, validateImageRepository, validateRegistryImages, compareReleaseVersions } from './update-channel.mjs';
import { writeUpdateJson, updateBusy, safeUpdateFailure } from '../src/server/update-control.js';
import { createDeployment, composeEnvironment, deploymentError, lockUpdateService } from './update-deployment.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const imageIdsValid = images => ['backend', 'frontend'].every(service => /^[a-f0-9]{64}$/.test(images?.[service]));
const probeReady = () => new Promise(resolve => {
	const request = https.get('https://127.0.0.1:8443/health/ready', { rejectUnauthorized: false, timeout: 5000 }, response => {
		response.resume(); resolve(response.statusCode === 200);
	});
	request.on('error', () => resolve(false));
	request.on('timeout', () => { request.destroy(); resolve(false); });
});

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

export async function runUpdateCommand(program, args, cwd, env = process.env, timeoutMs) {
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

export async function initializeUpdates(root = ROOT) {
	for (const directory of ['requests', 'status', 'host']) {
		await fs.mkdir(path.join(root, '.updates', directory), { recursive: true, mode: 0o700 });
		await fs.chmod(path.join(root, '.updates', directory), 0o700);
	}
}

export function createUpdateWorker({ root = ROOT, project = 'youplayer-server', port = 8443, sourceFactory = createGitReleaseSource,
	healthTimeoutMs = 180_000, healthIntervalMs = 2000,
	initialVersion,
	runCommand = (program, args) => runUpdateCommand(program, args, root, ['podman-compose', 'python3'].includes(program) ? composeEnvironment(root, project) : process.env),
	backup = () => backupProduction({ root, project, maintenance: true }),
	verify = verifyBackup, readiness, readinessProbe = probeReady, wait = sleep } = {}) {
	if (!/^[a-z][a-z0-9-]*$/.test(project)) throw new Error('Projet invalide');
	root = path.resolve(root);
	const directory = path.join(root, '.updates');
	const host = path.join(directory, 'host');
	const statusFile = path.join(directory, 'status', 'status.json');
	let state = { enabled: false, phase: 'idle', currentVersion: 'Version non identifiée', versionVerified: false, recoveryRequired: false };
	const target = createDeployment({ root, project, port, runCommand });
	let processing = false;
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
	async function failed(error, stage = state.stage, patch = {}) {
		const failure = safeUpdateFailure(error, stage);
		await writeUpdateJson(path.join(host, 'failure.json'), { ...failure, failedAt: new Date().toISOString() });
		console.error(`Mise a jour : ${failure.code} (${failure.stage})`);
		await publish({ phase: 'failed', updateAvailable: false, failure, ...patch });
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
	async function apply(images, previous) {
		if (!imageIdsValid(images)) throw new Error('Images invalides');
		await target.apply(images, previous, path.join(host, 'deploy.json'));
	}
	async function verifyDeployment(images, previous) {
		const installed = await target.snapshot();
		if (JSON.stringify(installed.resources) !== JSON.stringify(previous.resources)) throw deploymentError('resources-mismatch');
		if (['backend', 'frontend'].some(s => installed.images[s] !== images[s])) throw deploymentError('image-mismatch');
	}
	async function healthy(images) {
		if (readiness) return readiness(images);
		const deadline = Date.now() + healthTimeoutMs;
		for (let attempt = 0; attempt < 90 && Date.now() < deadline; attempt++) {
			let ok = true;
			for (const service of ['backend', 'frontend', 'redis']) {
				try {
					const [container] = JSON.parse(await runCommand('podman', ['inspect', `${project}_${service}_1`]));
					const health = container.State?.Health?.Status || container.State?.Healthcheck?.Status;
					if (container.State?.Status !== 'running' || health !== 'healthy'
						|| (service !== 'redis' && container.Image?.replace(/^sha256:/, '') !== images[service])) ok = false;
				} catch { ok = false; }
			}
			if (ok && await readinessProbe()) return;
			await wait(healthIntervalMs);
		}
		throw deploymentError('unhealthy');
	}
	async function setTags(images) {
		for (const service of ['backend', 'frontend']) {
			await runCommand('podman', ['tag', images[service], `localhost/youplayer-server-${service}:latest`]);
		}
	}
	async function rollback(transaction) {
		await publish({ phase: 'rolling_back', stage: 'rollback' });
		await apply(transaction.previous.images, transaction.previous);
		await healthy(transaction.previous.images);
		await verifyDeployment(transaction.previous.images, transaction.previous);
		await setTags(transaction.previous.images);
		active = transaction.active;
		await writeUpdateJson(path.join(host, 'active.json'), active);
		await fs.rm(path.join(host, 'transaction.json'));
		await publish({ phase: 'failed', rolledBack: true, currentVersion: active.version, updateAvailable: false,
			versionVerified: imageIdsValid(active.images) && ['backend', 'frontend'].every(s => active.images[s] === transaction.previous.images[s]), recoveryRequired: false });
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
			try {
				target.validateResources(transaction.previous?.resources);
				if (!imageIdsValid(transaction.previous?.images)) throw deploymentError('recovery-required');
				const owner = await fs.readFile(path.join(maintenanceLock, '.update-owner'), 'utf8').catch(() => null);
				if (owner === transaction.requestId) {
					await fs.rm(path.join(maintenanceLock, '.update-owner')); await fs.rmdir(maintenanceLock);
				}
				await lockMaintenance(transaction.requestId);
				try { await rollback(transaction); } finally { await unlockMaintenance(); }
				await fs.rm(path.join(host, 'job.json'), { force: true });
			} catch (error) {
				await failed(error, 'rollback', { enabled: false, recoveryRequired: true, rolledBack: false });
				return;
			}
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
		if (processing || state.recoveryRequired) throw deploymentError('recovery-required');
		processing = true;
		let transaction;
		try {
			await publish({ requestId: job.id, phase: 'checking', stage: 'configuration', progress: 0, rolledBack: false, failure: null, updateAvailable: false });
			const settings = await config();
			await publish({ stage: 'release' });
			const source = sourceFactory(settings);
			const candidate = await source.latest();
			const manifest = candidate.manifest;
			if (manifest.schema === 2) validateRegistryImages(manifest, settings.allowedImageRepositories);
			await publish({ stage: 'preflight' });
			composeEnvironment(root, project);
			const previous = await target.snapshot();
			// A signature binding the running image IDs is stronger evidence than
			// a host checkout tag. Recognize an already installed release without
			// restarting anything, while preserving the established replay floor.
			if (['backend', 'frontend'].every(s => manifest.images[s] === previous.images[s])
				&& (!imageIdsValid(active.images) || (manifest.sequence >= active.sequence
					&& compareReleaseVersions(manifest.version, active.version) >= 0))) {
				const confirmed = { version: manifest.version, sequence: manifest.sequence, images: manifest.images };
				if (JSON.stringify(confirmed) !== JSON.stringify(active)) await writeUpdateJson(path.join(host, 'active.json'), confirmed);
				active = confirmed;
			}
			const versionVerified = imageIdsValid(active.images) && ['backend', 'frontend'].every(s => active.images[s] === previous.images[s]);
			const available = manifest.sequence > active.sequence
				&& compareReleaseVersions(manifest.version, active.version) > 0
				&& ['backend', 'frontend'].some(service => manifest.images[service] !== previous.images[service]);
			await publish({ enabled: true, currentVersion: active.version, latestVersion: manifest.version, updateAvailable: available, versionVerified });
			if (job.action === 'check') { await publish({ phase: 'idle' }); return; }
			if (versionVerified && manifest.version === active.version && manifest.sequence === active.sequence && job.version === manifest.version) {
				await publish({ phase: 'succeeded', updateAvailable: false }); return;
			}
			if (!available || manifest.version !== job.version) throw new Error('Release changee ou deja installee');
			await publish({ phase: 'downloading', stage: 'download' });
			if (manifest.schema === 2) {
				const platform = (await runCommand('podman', ['info', '--format', '{{.Host.OS}}/{{.Host.Arch}}'])).trim();
				if (platform !== manifest.platform) throw deploymentError('image-mismatch');
				for (const [index, service] of ['backend', 'frontend'].entries()) {
					const reference = manifest.registry[service];
					await runCommand('podman', ['pull', '--tls-verify=true', '--policy=always', '--platform', manifest.platform, reference]);
					// A registry manifest digest differs from a local image config ID.
					// Inspect the exact pulled reference, then bind it to the signed ID.
					const image = JSON.parse(await runCommand('podman', ['image', 'inspect', reference]));
					if (image.length !== 1 || image[0].Id?.replace(/^sha256:/, '') !== manifest.images[service]
						|| `${image[0].Os}/${image[0].Architecture}` !== manifest.platform
						|| !image[0].RepoDigests?.includes(reference)) throw deploymentError('image-mismatch');
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
			await publish({ stage: 'preflight' });
			if (JSON.stringify(await target.snapshot()) !== JSON.stringify(previous)) throw deploymentError('deployment-changed');
			await publish({ phase: 'backing_up', stage: 'backup', progress: 100 });
			const snapshot = await backup();
			await verify(snapshot.directory);
			// Share the existing backup mutex through restart/rollback so a daily
			// maintenance backup cannot stop containers in the middle of deployment.
			await lockMaintenance(job.id);
			if (JSON.stringify(await target.snapshot()) !== JSON.stringify(previous)) throw deploymentError('deployment-changed');
			transaction = { requestId: job.id, previous, active, backup: snapshot.directory };
			await writeUpdateJson(path.join(host, 'transaction.json'), transaction);
			await publish({ phase: 'restarting', stage: 'recreate' });
			await apply(manifest.images, previous);
			await publish({ stage: 'health' });
			await healthy(manifest.images);
			await verifyDeployment(manifest.images, previous);
			await publish({ stage: 'commit' });
			await setTags(manifest.images);
			active = { version: manifest.version, sequence: manifest.sequence, images: manifest.images };
			await writeUpdateJson(path.join(host, 'active.json'), active);
			await fs.rm(path.join(host, 'transaction.json'));
			transaction = null; // The durable commit is complete; display errors must not undo it.
			await fs.rm(path.join(host, 'failure.json'), { force: true }).catch(() => {});
			await publish({ phase: 'succeeded', currentVersion: active.version, updateAvailable: false, versionVerified: true });
		} catch (error) {
			if (transaction && error.deploymentUntouched) {
				// A failed preparation must not cause a needless outage by recreating
				// the still-intact old application in the rollback path.
				try {
					if (JSON.stringify(await target.snapshot()) === JSON.stringify(transaction.previous)) {
						await fs.rm(path.join(host, 'transaction.json'));
						transaction = null;
					}
				} catch { /* If identities cannot be confirmed, retain normal recovery. */ }
			}
			// Keep polling active until rollback has actually finished.
			await failed(error, state.stage, transaction ? { phase: 'rolling_back', stage: 'rollback' } : {});
			if (transaction) {
				try { await rollback(transaction); }
				catch (rollbackError) { await failed(rollbackError, 'rollback', { rolledBack: false, enabled: false, recoveryRequired: true }); }
			}
		} finally {
			try {
				await unlockMaintenance();
				if (!state.recoveryRequired) await fs.rm(path.join(host, 'job.json'), { force: true });
			} finally { processing = false; }
		}
	}
	async function tick() {
		if (processing || updateBusy(state.phase) || state.recoveryRequired) return;
		if (await fs.stat(path.join(host, 'transaction.json')).then(() => true, () => false)) return;
		const requestFile = path.join(directory, 'requests', 'request.json');
		let job;
		try {
			job = await readJob(requestFile);
		} catch (error) {
			if (error.code === 'ENOENT') return;
			await fs.rm(requestFile, { force: true }); await failed(deploymentError('invalid-request'), 'request'); return;
		}
		// Mark busy before removing the queue slot so concurrent admins cannot install twice.
		await publish({ phase: 'checking', requestId: job.id });
		await fs.rename(requestFile, path.join(host, 'job.json'));
		try { await processRequest(job); } catch (error) { await failed(error); }
	}
	async function heartbeat() {
		if (!updateBusy(state.phase)) {
			try {
				await config();
				state.enabled = !state.recoveryRequired && !(await fs.stat(path.join(host, 'transaction.json')).then(() => true, () => false));
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
			const remote = (await runUpdateCommand('git', ['config', '--get', 'remote.origin.url'], ROOT)).trim();
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
	const releaseLock = await lockUpdateService(ROOT);
	let timer;
	try {
		const worker = createUpdateWorker();
		let stop = false;
		process.on('SIGTERM', () => { stop = true; }); process.on('SIGINT', () => { stop = true; });
		timer = setInterval(() => worker.heartbeat().catch(() => {}), 5000);
		await worker.initialize();
		while (!stop) { await worker.tick(); await sleep(1000); }
	} finally { clearInterval(timer); await releaseLock(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	cli().catch(error => { const diagnostic = safeUpdateFailure(error); console.error(`Service de mise a jour : ${diagnostic.code} (${diagnostic.stage})`); process.exitCode = 1; });
}
