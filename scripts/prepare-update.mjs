import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { imageArchiveHash, validateUpdateManifest } from './update-channel.mjs';

export async function prepareSignedUpdate({ releaseDirectory, privateKeyFile, version, sequence = Date.now() }) {
	const release = path.resolve(releaseDirectory);
	const metadata = JSON.parse(await fs.readFile(path.join(release, 'images.json'), 'utf8'));
	const archive = path.join(release, 'images.tar');
	const digest = await imageArchiveHash(archive);
	if (digest !== metadata.archives['images.tar']) throw new Error('Archive de release alteree');
	const privateKey = createPrivateKey(await fs.readFile(privateKeyFile));
	if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Cle Ed25519 requise');
	const payload = Buffer.from(JSON.stringify({ schema: 1, version, sequence, images: metadata.images,
		archive: { name: 'youplayer-images.tar', size: (await fs.stat(archive)).size, sha256: digest } }));
	const envelope = { payload: payload.toString('base64'), signature: sign(null, payload, privateKey).toString('base64') };
	const { createPublicKey } = await import('node:crypto');
	validateUpdateManifest(envelope, createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64'));
	const output = path.join(release, 'update-assets');
	await fs.mkdir(output, { mode: 0o700 });
	await fs.copyFile(archive, path.join(output, 'youplayer-images.tar'), fs.constants.COPYFILE_EXCL);
	await fs.chmod(path.join(output, 'youplayer-images.tar'), 0o600);
	await fs.writeFile(path.join(output, 'youplayer-update.json'), JSON.stringify(envelope), { flag: 'wx', mode: 0o600 });
	return { ok: true, directory: output, version };
}

async function cli() {
	const [action, ...args] = process.argv.slice(2);
	if (action === 'keygen') {
		const directory = path.resolve(args[0] || '.updates/publisher');
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const { privateKey, publicKey } = generateKeyPairSync('ed25519');
		await fs.writeFile(path.join(directory, 'private-key.pem'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 });
		await fs.writeFile(path.join(directory, 'public-key.pem'), publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o600 });
		console.log(JSON.stringify({ ok: true, directory })); return;
	}
	if (action !== 'release' || args.length !== 3) throw new Error('Commande : keygen [DOSSIER] | release DOSSIER_RELEASE CLE_PRIVEE TAG_GIT');
	console.log(JSON.stringify(await prepareSignedUpdate({ releaseDirectory: args[0], privateKeyFile: path.resolve(args[1]), version: args[2] })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	cli().catch(() => { console.error('Preparation de mise a jour echouee ; sortie privee masquee'); process.exitCode = 1; });
}
