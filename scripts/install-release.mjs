import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { ROOT, PROJECT, prepareInstallationEnvironment, prepareHostDirectories, composeEnvironment, runHostCommand } from './release-host.mjs';
import { verifyManifest, releaseError } from './release-channel.mjs';
import { createDeployment } from './release-deployment.mjs';
import { writeReleaseJson } from '../src/server/release-control.js';

export { prepareInstallationEnvironment, composeEnvironment, runHostCommand as runInstallCommand } from './release-host.mjs';

export function serviceUnit(root, executable = process.execPath) {
  const quote = value => '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%') + '"';
  if (/[\r\n\0$]/.test(root + executable)) throw releaseError('incompatible-release');
  return `[Unit]\nDescription=YouPlayer release updates\nAfter=default.target\n\n[Service]\nType=simple\nWorkingDirectory=${quote(root)}\nExecStart=${quote(executable)} ${quote(path.join(root, 'scripts/release-service.mjs'))}\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=900\nKillMode=mixed\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

export async function installServer({ root = ROOT, engine = 'podman', checkOnly = false, pseudo, password,
  home = os.homedir(), run = (program, args) => runHostCommand(program, args, root),
  deploymentFactory = options => createDeployment(options), report = console.log } = {}) {
  if (!['docker', 'podman'].includes(engine)) throw releaseError('incompatible-release');
  const platform = { x64: 'linux/amd64', arm64: 'linux/arm64' }[process.arch];
  const config = { engine, project: PROJECT, platform };
  const publicKey = await fs.readFile(path.join(root, 'keys/release-public-key.pem'), 'utf8');
  const envelope = JSON.parse(await fs.readFile(path.join(root, 'youplayer-release.json'), 'utf8'));
  const manifest = verifyManifest(envelope, publicKey);
  const deployment = deploymentFactory({ root, config });
  await deployment.checkTools();
  await deployment.assertFresh();
  await run('systemctl', ['--user', 'show-environment']);
  if ((await run('loginctl', ['show-user', String(process.getuid()), '--property=Linger', '--value'])).trim() !== 'yes') {
    throw new Error('Activer le service persistant avant installation : sudo loginctl enable-linger "$USER". Voir INSTALL.md.');
  }
  await run('flock', ['--version']);
  const unitFile = path.join(home, '.config/systemd/user/youplayer-updates.service');
  if (await fs.lstat(path.join(root, '.updates/host/config.json')).catch(() => null)
    || await fs.lstat(unitFile).catch(() => null)) throw releaseError('deployment-changed');
  if (checkOnly) return;
  serviceUnit(root);
  await prepareInstallationEnvironment(root, pseudo, password);
  if ((await fs.stat(path.join(root, '.env'))).mode & 0o077) throw new Error('Restreindre les permissions de .env avec chmod 600 .env.');
  composeEnvironment(root, PROJECT);
  await prepareHostDirectories(root);
  for (const folder of ['src/playlists', 'src/local_song']) await fs.mkdir(path.join(root, folder), { recursive: true, mode: 0o700 });
  report(`Téléchargement de YouPlayer ${manifest.version}…`);
  const images = manifest.platforms[platform];
  await deployment.pull(images);
  await deployment.initializeData(images);
  await writeReleaseJson(path.join(root, '.updates/host/config.json'), config);
  await writeReleaseJson(path.join(root, '.updates/host/release-state.json'), { envelope });
  report('Démarrage des services…');
  await deployment.activate(images, true);
  await deployment.healthy(images);
  await fs.mkdir(path.dirname(unitFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(unitFile, serviceUnit(root), { flag: 'wx', mode: 0o600 });
  await run('systemctl', ['--user', 'daemon-reload']);
  await run('systemctl', ['--user', 'enable', '--now', 'youplayer-updates.service']);
  report('YouPlayer est prêt : https://ADRESSE_DU_SERVEUR:8443');
  report('Connectez-vous avec le compte admin, puis créez un compte user pour écouter. Les mises à jour sont dans Admin → Intégrations.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (process.platform !== 'linux' || process.getuid?.() === 0) throw new Error('Utiliser Linux et un compte utilisateur, sans sudo. Voir INSTALL.md.');
    if (major < 22 || major === 22 && minor < 12) throw new Error('Node.js >= 22.12 requis.');
    const [action, engine = 'podman'] = process.argv.slice(2);
    if (!['check', 'install'].includes(action)) throw new Error('Lancer ./install.sh [podman|docker] depuis une archive de release.');
    const parts = []; let length = 0;
    if (action === 'install' && !(await fs.lstat(path.join(ROOT, '.env')).catch(() => null))) {
      for await (const part of process.stdin) {
        length += part.length;
        if (length > 4096) throw new Error('Identifiants trop longs.');
        parts.push(part);
      }
    }
    const [pseudo, password] = Buffer.concat(parts).toString('utf8').split('\0');
    await installServer({ checkOnly: action === 'check', engine, pseudo, password });
  } catch (error) {
    console.error(error.updateCode ? `Installation arrêtée (${error.updateCode}). Consulter INSTALL.md et le diagnostic privé .updates/host/last-command.log.`
      : error.code || error instanceof SyntaxError ? 'Installation arrêtée : archive incomplète ou fichier inaccessible. Consulter INSTALL.md.' : error.message);
    process.exitCode = 1;
  }
}
