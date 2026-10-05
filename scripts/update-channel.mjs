import { promises as fs, createReadStream } from 'node:fs';
import { createHash, createPublicKey, verify } from 'node:crypto';
import path from 'node:path';

export const MAX_IMAGE_ARCHIVE = 10 * 1024 ** 3;
const MAX_METADATA = 1024 * 1024;

export function validateUpdateManifest(envelope, publicKey) {
	if (typeof envelope?.payload !== 'string' || typeof envelope?.signature !== 'string'
		|| envelope.payload.length > 90_000 || envelope.signature.length > 100) throw new Error('Release invalide');
	const bytes = Buffer.from(envelope.payload, 'base64');
	const key = createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' });
	if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, Buffer.from(envelope.signature, 'base64'))) {
		throw new Error('Signature de release invalide');
	}
	const value = JSON.parse(bytes.toString('utf8'));
	if (value.schema !== 1 || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value.version)
		|| !Number.isSafeInteger(value.sequence) || value.sequence < 1
		|| Object.keys(value.images || {}).sort().join(',') !== 'backend,frontend'
		|| !['backend', 'frontend'].every(service => /^[a-f0-9]{64}$/.test(value.images?.[service]))
		|| value.archive?.name !== 'youplayer-images.tar' || !/^[a-f0-9]{64}$/.test(value.archive.sha256)
		|| !Number.isSafeInteger(value.archive.size) || value.archive.size < 1 || value.archive.size > MAX_IMAGE_ARCHIVE) {
		throw new Error('Format de release incompatible');
	}
	return value;
}

export function updateProvider(config) {
	const repository = new URL(config.repository);
	if (repository.protocol !== 'https:' || repository.username || repository.password || repository.search || repository.hash) {
		throw new Error('Depot HTTPS requis');
	}
	const parts = repository.pathname.replace(/\.git\/?$/, '').split('/').filter(Boolean);
	if (parts.length < 2 || parts.some(part => !/^[\w.-]+$/.test(part))) throw new Error('Depot invalide');
	const github = repository.hostname === 'github.com';
	if (github && parts.length !== 2) throw new Error('Depot GitHub invalide');
	if (!github && config.provider !== 'gitlab') throw new Error('Fournisseur Git non configure');
	const origin = github ? 'https://api.github.com' : repository.origin;
	const api = github ? `${origin}/repos/${parts.join('/')}/releases/latest`
		: `${origin}/api/v4/projects/${encodeURIComponent(parts.join('/'))}/releases/permalink/latest`;
	const allowed = new Set(github
		? [origin, repository.origin, 'https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com']
		: [origin]);
	for (const item of config.allowedDownloadOrigins || []) {
		const url = new URL(item);
		if (url.protocol !== 'https:' || url.username || url.password || url.origin !== item) throw new Error('Origine invalide');
		allowed.add(item);
	}
	return { github, api, origin, allowed };
}

export function createGitReleaseSource(config, { fetchImpl = fetch } = {}) {
	const provider = updateProvider(config);
	async function response(url, { asset = false, signal = AbortSignal.timeout(30_000) } = {}) {
		let target = new URL(url);
		for (let redirects = 0; redirects <= 4; redirects++) {
			if (target.protocol !== 'https:' || target.username || target.password || !provider.allowed.has(target.origin)) {
				throw new Error('Origine de telechargement refusee');
			}
			const headers = { Accept: asset ? 'application/octet-stream' : 'application/json', 'User-Agent': 'YouPlayer-Updater' };
			const result = await fetchImpl(target.href, { headers, redirect: 'manual', signal });
			if ([301, 302, 303, 307, 308].includes(result.status)) {
				const location = result.headers.get('location');
				await result.body?.cancel();
				if (!location) throw new Error('Redirection de release invalide');
				target = new URL(location, target);
				continue;
			}
			if (!result.ok) { await result.body?.cancel(); throw new Error('Release Git indisponible'); }
			return result;
		}
		throw new Error('Trop de redirections');
	}
	async function json(url, asset = false) {
		const result = await response(url, { asset });
		const chunks = []; let length = 0;
		try {
			for await (const chunk of result.body) {
				length += chunk.length;
				if (length > MAX_METADATA) throw new Error('Metadonnees trop grandes');
				chunks.push(chunk);
			}
			return JSON.parse(Buffer.concat(chunks).toString('utf8'));
		} catch { throw new Error('Metadonnees de release invalides'); }
	}
	async function latest() {
		const release = await json(provider.api);
		if (release.draft || release.prerelease) throw new Error('Release stable requise');
		const assets = provider.github ? release.assets : release.assets?.links;
		if (!Array.isArray(assets)) throw new Error('Assets de release manquants');
		const assetUrl = name => {
			const matches = assets.filter(asset => asset.name === name);
			if (matches.length !== 1) throw new Error('Asset de release manquant ou ambigu');
			return provider.github ? matches[0].url : matches[0].direct_asset_url || matches[0].url;
		};
		const manifest = validateUpdateManifest(await json(assetUrl('youplayer-update.json'), true), config.publicKey);
		if (release.tag_name !== manifest.version) throw new Error('Version signee differente du tag Git');
		return { manifest, archiveUrl: assetUrl(manifest.archive.name) };
	}
	async function download(candidate, destination, progress = () => {}) {
		const temporary = `${destination}.partial`;
		await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
		const result = await response(candidate.archiveUrl, { asset: true, signal: AbortSignal.timeout(10 * 60_000) });
		const hash = createHash('sha256'); let length = 0;
		let file;
		try {
			file = await fs.open(temporary, 'wx', 0o600);
			for await (const chunk of result.body) {
				length += chunk.length;
				if (length > candidate.manifest.archive.size) throw new Error('Archive trop grande');
				hash.update(chunk);
				let offset = 0;
				while (offset < chunk.length) offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
				await progress(Math.floor(length / candidate.manifest.archive.size * 100));
			}
			if (length !== candidate.manifest.archive.size || hash.digest('hex') !== candidate.manifest.archive.sha256) {
				throw new Error('Integrite de l archive invalide');
			}
			await file.sync(); await file.close(); file = null;
			await fs.rename(temporary, destination);
		} finally { await file?.close(); await fs.rm(temporary, { force: true }); }
	}
	return { latest, download };
}

export async function imageArchiveHash(file) {
	const digest = createHash('sha256');
	for await (const chunk of createReadStream(file)) digest.update(chunk);
	return digest.digest('hex');
}
