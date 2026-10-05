import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRelease } from './production.mjs';
import { imageArchiveHash } from './update-channel.mjs';
import { prepareSignedUpdate } from './prepare-update.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execute = promisify(execFile);
async function podman(args) {
	try { return (await execute('podman', args, { cwd: ROOT, timeout: 30 * 60_000, maxBuffer: 16 * 1024 * 1024 })).stdout; }
	catch { throw new Error('Construction de release echouee ; sortie privee masquee'); }
}

export async function buildUpdateRelease(version, privateKeyFile) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(version)) throw new Error('Tag Git invalide');
	const release = await createRelease({ label: version });
	const images = {}, references = [];
	for (const service of ['backend', 'frontend']) {
		const reference = `localhost/youplayer-server-${service}:update-build`;
		await podman(['build', '-f', `Dockerfile.${service}`, '-t', reference, service === 'backend' ? './src' : '.']);
		images[service] = (await podman(['image', 'inspect', reference, '--format', '{{.Id}}'])).trim().replace(/^sha256:/, '');
		if (!/^[a-f0-9]{64}$/.test(images[service])) throw new Error('Image construite invalide');
		const immutable = `localhost/youplayer-server-${service}:release-${images[service]}`;
		await podman(['tag', images[service], immutable]); references.push(immutable);
	}
	const archive = path.join(release.directory, 'images.tar');
	await fs.writeFile(archive, '', { flag: 'wx', mode: 0o600 });
	await podman(['save', '--format', 'docker-archive', '--multi-image-archive', '--output', archive, ...references]);
	await fs.chmod(archive, 0o600);
	await fs.writeFile(path.join(release.directory, 'images.json'), JSON.stringify({ images,
		archives: { 'images.tar': await imageArchiveHash(archive) } }), { flag: 'wx', mode: 0o600 });
	return prepareSignedUpdate({ releaseDirectory: release.directory, privateKeyFile, version });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	if (process.argv.length !== 4) { console.error('Commande : node scripts/build-update-release.mjs TAG_GIT CLE_PRIVEE'); process.exitCode = 1; }
	else buildUpdateRelease(process.argv[2], path.resolve(process.argv[3])).then(result => console.log(JSON.stringify(result)))
		.catch(() => { console.error('Preparation de release echouee ; sortie privee masquee'); process.exitCode = 1; });
}
