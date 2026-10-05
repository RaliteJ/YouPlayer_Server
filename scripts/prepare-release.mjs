import { promises as fs, createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRelease } from './production.mjs';

const execute = promisify(execFile);
async function podman(args) {
	try { return (await execute('podman', args, { timeout: 300_000, maxBuffer: 1024 * 1024 })).stdout; }
	catch { throw new Error('Preparation image echouee ; sortie privee masquee'); }
}
async function checksum(file) {
	const digest = createHash('sha256');
	for await (const chunk of createReadStream(file)) digest.update(chunk);
	return digest.digest('hex');
}

try {
	const release = await createRelease({ label: process.argv[2] });
	const images = {};
	for (const service of ['backend', 'frontend']) {
		images[service] = (await podman(['image', 'inspect', `localhost/youplayer-server-${service}:production-check`, '--format', '{{.Id}}'])).trim();
	}
	const previous = {};
	const original = {};
	for (const service of ['backend', 'frontend']) {
		original[service] = (await podman(['inspect', `youplayer-server_${service}_1`, '--format', '{{.Image}}'])).trim();
		// Last validated baseline supports the current persistent file-store format.
		previous[service] = (await podman(['image', 'inspect', `localhost/youplayer-server-${service}:production-previous`, '--format', '{{.Id}}'])).trim();
	}
	const override = values => ({ services: { backend: { image: values.backend }, frontend: { image: values.frontend } } });
	await fs.writeFile(path.join(release.directory, 'deploy.json'), JSON.stringify(override(images), null, 2), { mode: 0o600 });
	const rollback = override(previous);
	// Previous images predate /health/ready and the new probe file.
	rollback.services.backend.healthcheck = { test: ['CMD-SHELL',
		'node --input-type=module -e \'try { const r = await fetch("http://127.0.0.1:3000/auth/me", { signal: AbortSignal.timeout(4000) }); if (r.status !== 401) process.exitCode = 1; } catch { process.exitCode = 1; }\''
	] };
	rollback.services.frontend.healthcheck = { test: ['CMD', 'wget', '--no-check-certificate', '-q', '-O', '/dev/null', 'https://127.0.0.1/'] };
	await fs.writeFile(path.join(release.directory, 'rollback.json'), JSON.stringify(rollback, null, 2), { mode: 0o600 });
	const archives = {};
	for (const [name, values] of [['images', images], ['rollback-images', previous], ['original-images', original]]) {
		// Podman cannot reliably reload multiple images saved with empty RepoTags.
		// Keep exact IDs in Compose, but export named references in the archive.
		const references = [];
		for (const [service, id] of Object.entries(values)) {
			const reference = `localhost/youplayer-server-${service}:release-${id.replace(/^sha256:/, '')}`;
			await podman(['tag', id, reference]);
			references.push(reference);
		}
		const file = path.join(release.directory, `${name}.tar`);
		await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
		await podman(['save', '--format', 'docker-archive', '--multi-image-archive', '--output', file, ...references]);
		await fs.chmod(file, 0o600);
		archives[`${name}.tar`] = await checksum(file);
	}
	archives['source.tar.gz'] = await checksum(path.join(release.directory, 'source.tar.gz'));
	await fs.writeFile(path.join(release.directory, 'images.json'), JSON.stringify({ images, previous, original, archives }, null, 2), { mode: 0o600 });
	console.log(JSON.stringify({ ok: true, directory: release.directory, sourceFiles: release.sourceFiles, imagesArchived: 6 }));
} catch (error) { console.error(error.message?.startsWith('E') ? 'Preparation release echouee' : error.message); process.exitCode = 1; }
