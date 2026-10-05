import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const UPDATE_PHASES = new Set(['idle', 'checking', 'downloading', 'backing_up', 'restarting', 'rolling_back', 'succeeded', 'failed']);
export const updateBusy = phase => ['checking', 'downloading', 'backing_up', 'restarting', 'rolling_back'].includes(phase);

export async function writeUpdateJson(file, value) {
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		await fs.writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
		await fs.rename(temporary, file);
	} finally { await fs.rm(temporary, { force: true }); }
}

export function createUpdateControl({ requestsDirectory, statusDirectory, now = Date.now } = {}) {
	async function status() {
		if (!requestsDirectory || !statusDirectory) return { enabled: false, online: false, phase: 'idle' };
		let value;
		try { value = JSON.parse(await fs.readFile(path.join(statusDirectory, 'status.json'), 'utf8')); }
		catch { return { enabled: false, online: false, phase: 'idle' }; }
		// Return only display data, never URLs, paths, keys or command output.
		const label = text => typeof text === 'string' ? text.slice(0, 120) : '';
		const phase = UPDATE_PHASES.has(value.phase) ? value.phase : 'idle';
		const age = now() - Number(value.heartbeat);
		return {
			enabled: value.enabled === true, online: age >= 0 && age < 30_000,
			phase, currentVersion: label(value.currentVersion), latestVersion: label(value.latestVersion),
			updateAvailable: value.updateAvailable === true, requestId: label(value.requestId),
			progress: Math.min(100, Math.max(0, Number(value.progress) || 0)),
			rolledBack: value.rolledBack === true
		};
	}
	async function request(action, version) {
		if (!['check', 'install'].includes(action)) throw Object.assign(new Error('Action invalide'), { statusCode: 400 });
		const current = await status();
		if (!current.enabled || !current.online) throw Object.assign(new Error('Service de mise a jour indisponible'), { statusCode: 503 });
		if (updateBusy(current.phase)) throw Object.assign(new Error('Mise a jour deja en cours'), { statusCode: 409 });
		if (action === 'install' && (!current.updateAvailable || version !== current.latestVersion)) {
			throw Object.assign(new Error('Verifier la nouvelle version avant installation'), { statusCode: 409 });
		}
		const job = { id: randomUUID(), action, ...(action === 'install' ? { version } : {}) };
		// Publish a complete file atomically, with no overwrite of a queued request.
		const temporary = path.join(requestsDirectory, `${job.id}.tmp`);
		try {
			await fs.writeFile(temporary, JSON.stringify(job), { flag: 'wx', mode: 0o600 });
			await fs.link(temporary, path.join(requestsDirectory, 'request.json'));
		} catch (error) {
			throw Object.assign(new Error(error.code === 'EEXIST' ? 'Demande deja en attente' : 'Demande de mise a jour impossible'),
				{ statusCode: error.code === 'EEXIST' ? 409 : 503 });
		} finally { await fs.rm(temporary, { force: true }); }
		return job;
	}
	return { status, request };
}
