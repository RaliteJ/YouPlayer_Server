import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateUpdateManifest } from './update-channel.mjs';

const execute = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Only these host tools belong in the installer; never copy a checkout or data directory.
const files = ['install.sh', 'INSTALL.md', '.env.example', 'scripts/install.mjs',
  'scripts/production.mjs', 'scripts/update-service.mjs', 'scripts/update-channel.mjs',
  'scripts/update-deployment.mjs', 'scripts/update-container-plan.mjs', 'scripts/update-compose-config.py',
  'src/package.json', 'src/server/config.js', 'src/server/update-control.js'];

export async function buildInstallBundle({ root = ROOT, directory, publicKey }) {
  const key = createPublicKey(publicKey);
  const manifestFile = path.join(directory, 'youplayer-update.json');
  const manifest = validateUpdateManifest(JSON.parse(await fs.readFile(manifestFile, 'utf8')),
    key.export({ type: 'spki', format: 'der' }).toString('base64'));
  if (manifest.schema !== 2) throw new Error('Une release registre est requise pour cet installateur');
  const bundle = path.join(directory, 'youplayer-server');
  await fs.mkdir(bundle, { mode: 0o700 });
  for (const file of files) {
    const source = path.join(root, file);
    if (!(await fs.lstat(source)).isFile()) throw new Error('Fichier installateur non regulier');
    const destination = path.join(bundle, file);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination, fs.constants.COPYFILE_EXCL);
    await fs.chmod(destination, file === 'install.sh' ? 0o755 : 0o644);
  }
  // JSON is valid Compose YAML; derive the topology from the development file.
  const { stdout } = await execute('python3', ['-c',
    'import json,sys,yaml; print(json.dumps(yaml.safe_load(open(sys.argv[1]))))', path.join(root, 'docker-compose.yml')]);
  const compose = JSON.parse(stdout);
  for (const service of ['backend', 'frontend']) delete compose.services[service].build;
  await fs.writeFile(path.join(bundle, 'docker-compose.yml'), JSON.stringify(compose, null, 2) + '\n');
  await fs.copyFile(manifestFile, path.join(bundle, 'youplayer-update.json'));
  await fs.mkdir(path.join(bundle, 'keys'));
  await fs.writeFile(path.join(bundle, 'keys', 'release-public-key.pem'), key.export({ type: 'spki', format: 'pem' }));
  const archive = path.join(directory, 'youplayer-install.tar.gz');
  await execute('tar', ['-czf', archive, '-C', directory, 'youplayer-server']);
  return archive;
}
