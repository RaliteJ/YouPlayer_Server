import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createPrivateKey } from 'node:crypto';
import { createRelease } from './production.mjs';
import { imageArchiveHash, validateImageRepository } from './update-channel.mjs';
import { prepareSignedUpdate } from './prepare-update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
async function podman(args) {
	try { return (await execute('podman', args, { cwd: ROOT, timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 })).stdout; }
	catch { throw new Error('Construction de release echouee ; sortie privee masquee'); }
}

export async function buildUpdateRelease(version, privateKeyFile, { registryPrefix, runPodman = podman, releaseFactory = createRelease } = {}) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(version)) throw new Error('Tag Git invalide');
	if (registryPrefix !== undefined) for (const service of ['backend', 'frontend']) validateImageRepository(`${registryPrefix}-${service}`);
	const key = createPrivateKey(await fs.readFile(privateKeyFile));
	if (key.asymmetricKeyType !== 'ed25519') throw new Error('Cle Ed25519 requise');
	const release = await releaseFactory({ label: version }).catch(() => { throw new Error('Preparation des sources echouee : verifier le tag, Git et le dossier releases'); });
	const images = {}, references = [];
	let platform;
	for (const service of ['backend', 'frontend']) {
		const reference = `localhost/youplayer-server-${service}:update-build`;
		const cache = registryPrefix ? ['--cache-from', `${registryPrefix}-${service}-cache`, '--cache-to', `${registryPrefix}-${service}-cache`] : [];
		await runPodman(['build', '--layers', '--tls-verify=true', ...cache, '-f', `Dockerfile.${service}`, '-t', reference, service === 'backend' ? './src' : '.']);
		images[service] = (await runPodman(['image', 'inspect', reference, '--format', '{{.Id}}'])).trim().replace(/^sha256:/, '');
		if (!/^[a-f0-9]{64}$/.test(images[service])) throw new Error('Image construite invalide');
		if (registryPrefix) {
			const builtPlatform = (await runPodman(['image', 'inspect', reference, '--format', '{{.Os}}/{{.Architecture}}'])).trim();
			if (!['linux/amd64', 'linux/arm64'].includes(builtPlatform) || (platform && platform !== builtPlatform)) throw new Error('Plateforme image incompatible');
			platform = builtPlatform;
		}
		const immutable = `localhost/youplayer-server-${service}:release-${images[service]}`;
		await runPodman(['tag', images[service], immutable]); references.push(immutable);
	}
	if (registryPrefix) {
		const registry = {};
		for (const service of ['backend', 'frontend']) {
			const repository = `${registryPrefix}-${service}`;
			const digestFile = path.join(release.directory, `${service}.digest`);
			await runPodman(['push', '--tls-verify=true', '--digestfile', digestFile, images[service], `docker://${repository}:${version}`]);
			const digest = (await fs.readFile(digestFile, 'utf8')).trim();
			if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Digest publie invalide');
			registry[service] = `${repository}@${digest}`;
		}
		await fs.writeFile(path.join(release.directory, 'images.json'), JSON.stringify({ images, registry, platform }), { flag: 'wx', mode: 0o600 });
		return prepareSignedUpdate({ releaseDirectory: release.directory, privateKeyFile, version });
	}
	const archive = path.join(release.directory, 'images.tar');
	await fs.writeFile(archive, '', { flag: 'wx', mode: 0o600 });
	await runPodman(['save', '--format', 'docker-archive', '--multi-image-archive', '--output', archive, ...references]);
	await fs.chmod(archive, 0o600);
	await fs.writeFile(path.join(release.directory, 'images.json'), JSON.stringify({ images,
		archives: { 'images.tar': await imageArchiveHash(archive) } }), { flag: 'wx', mode: 0o600 });
	return prepareSignedUpdate({ releaseDirectory: release.directory, privateKeyFile, version });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	if (![4, 6].includes(process.argv.length) || (process.argv.length === 6 && process.argv[4] !== '--registry-prefix')) {
		console.error('Commande : node scripts/build-update-release.mjs TAG_GIT CLE_PRIVEE [--registry-prefix REGISTRE/ESPACE/youplayer]'); process.exitCode = 1;
	}
	else buildUpdateRelease(process.argv[2], path.resolve(process.argv[3]), { registryPrefix: process.argv[5] }).then(result => console.log(JSON.stringify(result)))
		.catch(error => {
			const messages = new Set(['Tag Git invalide', 'Nom de release invalide', 'Image construite invalide',
				'Construction de release echouee ; sortie privee masquee',
				'Preparation des sources echouee : verifier le tag, Git et le dossier releases']);
			console.error(messages.has(error.message) ? error.message : 'Preparation de release echouee ; sortie privee masquee');
			process.exitCode = 1;
		});
}
