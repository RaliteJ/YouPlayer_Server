import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { validateManifest, verifyManifest, PLATFORMS } from './release-channel.mjs';

export const installerFiles = [
  'install.sh', 'docker-compose.release.yml', 'INSTALL.md', 'UPDATES.md', 'LICENSE', 'keys/release-public-key.pem',
  'bin/youplayer-host-linux-amd64', 'bin/youplayer-host-linux-arm64'
];

export async function packageRelease({ root, output, manifest, privateKey }) {
  validateManifest(manifest);
  const key = createPrivateKey(privateKey);
  const publicKey = await fs.readFile(path.join(root, 'keys/release-public-key.pem'));
  if (key.asymmetricKeyType !== 'ed25519' || !createPublicKey(key).equals(createPublicKey(publicKey))) throw new Error('La clé de signature ne correspond pas à la clé publique distribuée.');
  const bytes = Buffer.from(JSON.stringify(manifest));
  const envelope = { payload: bytes.toString('base64'), signature: sign(null, bytes, key).toString('base64') };
  verifyManifest(envelope, publicKey);
  await fs.mkdir(output, { recursive: true });
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), 'youplayer-release-'));
  try {
    for (const file of installerFiles) {
      const source = path.join(root, file);
      if (!(await fs.lstat(source)).isFile()) throw new Error('Entrée de distribution non régulière.');
      const destination = path.join(stage, file);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
      await fs.chmod(destination, file === 'install.sh' || file.startsWith('bin/') ? 0o755 : 0o644);
    }
    const metadata = JSON.stringify(envelope) + '\n';
    await fs.writeFile(path.join(stage, 'youplayer-release.json'), metadata);
    await fs.writeFile(path.join(output, 'youplayer-release.json'), metadata, { flag: 'wx' });
    const archive = path.join(output, 'youplayer-install.tar.gz');
    await fs.writeFile(archive, '', { flag: 'wx' });
    await promisify(execFile)('tar', ['-czf', archive, '-C', stage, ...installerFiles, 'youplayer-release.json']);
    const digest = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
    await fs.writeFile(path.join(output, 'SHA256SUMS'), `${digest}  youplayer-install.tar.gz\n`, { flag: 'wx' });
    return envelope;
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const platforms = {};
    for (const platform of PLATFORMS) platforms[platform] = JSON.parse(await fs.readFile(path.join(process.argv[2], `${platform.split('/')[1]}.json`), 'utf8'));
    if (process.env.RELEASE_DATA_COMPATIBLE !== 'true') throw new Error('Compatibilité des données non confirmée.');
    await packageRelease({ root: process.cwd(), output: path.resolve(process.argv[3]), privateKey: process.env.YOUPLAYER_RELEASE_PRIVATE_KEY,
      manifest: { schema: 3, contract: 1, dataVersion: 1, rollbackCompatible: true,
        version: process.env.RELEASE_TAG, commit: process.env.RELEASE_COMMIT, sequence: Number(process.env.RELEASE_SEQUENCE), platforms } });
    console.log('Archive d’installation et manifeste signé préparés.');
  } catch { console.error('Publication refusée : vérifier les empreintes, la clé de signature et la compatibilité de la version.'); process.exitCode = 1; }
}
