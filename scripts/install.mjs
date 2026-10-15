import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createPublicKey, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeUpdates, runUpdateCommand } from './update-service.mjs';
import { validateUpdateManifest } from './update-channel.mjs';
import { createDeployment, composeEnvironment } from './update-deployment.mjs';
import { containerPlans } from './update-container-plan.mjs';
import { preflight } from './production.mjs';
import { writeUpdateJson } from '../src/server/update-control.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROJECT = 'youplayer-server';
const REPOSITORY = 'https://github.com/RaliteJ/YouPlayer_Server';

export async function installationManifest(root = ROOT) {
  const key = createPublicKey(await fs.readFile(path.join(root, 'keys/release-public-key.pem')));
  const publicKey = key.export({ type: 'spki', format: 'der' }).toString('base64');
  const manifest = validateUpdateManifest(JSON.parse(await fs.readFile(path.join(root, 'youplayer-update.json'), 'utf8')), publicKey);
  if (manifest.schema !== 2) throw new Error('Télécharger l’archive youplayer-install.tar.gz d’une release registre.');
  return { manifest, publicKey };
}

export async function prepareInstallationEnvironment(root, pseudo, password) {
  const file = path.join(root, '.env');
  const existing = await fs.lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (existing) {
    if (!existing.isFile()) throw new Error('.env doit être un fichier régulier.');
    return; // Never replace existing passwords or session secrets.
  }
  // shortcut: the host dotenv parser does not unescape quotes; support them when that parser does.
  if (typeof pseudo !== 'string' || !/^[a-zA-Z0-9_.@-]{1,100}$/.test(pseudo)
      || typeof password !== 'string' || password.length < 12 || /['\\\r\n\0]/.test(password)) {
    throw new Error('Pseudo invalide ou mot de passe trop court / contenant une apostrophe ou un antislash.');
  }
  const values = {
    COMPOSE_PROJECT_NAME: PROJECT, YOUPLAYER_ADMIN_PSEUDO: pseudo, YOUPLAYER_ADMIN_PASSWORD: password,
    YOUPLAYER_SESSION_SECRET: randomBytes(48).toString('hex'), YOUPLAYER_SPOTIFY_TOKEN_SECRET: randomBytes(48).toString('hex'),
    YOUPLAYER_LOG_LEVEL: 'info', YOUPLAYER_SESSION_MAX_AGE_MS: '259200000',
    FIRST_TRACK_SPECIAL_STREAM: 'true', FIRST_TRACK_SPECIAL_STREAM_NEXT: 'true',
    YOUPLAYER_YOUTUBE_API_KEY: '', YOUPLAYER_SPOTIFY_CLIENT_ID: '', YOUPLAYER_SPOTIFY_CLIENT_SECRET: '',
    YOUPLAYER_SPOTIFY_REDIRECT_URI: '', YOUPLAYER_SPOTIFY_SCOPES: '',
    YOUPLAYER_SPOTIFY_WEB_USERNAME: '', YOUPLAYER_SPOTIFY_WEB_PASSWORD: ''
  };
  await fs.writeFile(file, Object.entries(values).map(([name, value]) => `${name}='${value}'`).join('\n') + '\n',
    { flag: 'wx', mode: 0o600 });
}

export async function installServer({ root = ROOT, checkOnly = false, pseudo, password,
  run = (program, args) => runUpdateCommand(program, args, root,
    ['podman-compose', 'python3'].includes(program) && !args.includes('--version') && args[0] !== '-c'
      ? composeEnvironment(root, PROJECT) : process.env),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), report = console.log } = {}) {
  const { manifest, publicKey } = await installationManifest(root);
  await initializeUpdates(root);
  if (await fs.lstat(path.join(root, '.updates/host/active.json')).catch(() => null)) {
    throw new Error('Installation déjà présente. Utiliser les mises à jour depuis Admin.');
  }
  const platform = (await run('podman', ['info', '--format', '{{.Host.OS}}/{{.Host.Arch}}'])).trim();
  if (platform !== manifest.platform) throw new Error(`Cette release nécessite ${manifest.platform}.`);
  const names = (await run('podman', ['ps', '-a', '--format', '{{.Names}}'])).split(/\s+/);
  if (names.some(name => name.startsWith(`${PROJECT}_`))) throw new Error('Une stack YouPlayer existe déjà. Aucun conteneur remplacé.');
  // Prerequisites for both installation and the existing Admin updater.
  await run('podman-compose', ['--version']);
  await run('python3', ['-c', 'import yaml, dotenv']);
  await run('flock', ['--version']);
  await run('tar', ['--version']);
  if (checkOnly) return;
  await prepareInstallationEnvironment(root, pseudo, password);
  if (!(await preflight({ root })).ok) throw new Error('Configuration .env invalide ou permissions trop ouvertes. Consulter INSTALL.md.');
  const config = JSON.parse(await run('python3', [path.join(root, 'scripts/update-compose-config.py'), root, PROJECT]));
  containerPlans(config, { root, project: PROJECT });
  if (Object.values(config.services).some(service => service.build)) throw new Error('Utiliser le Compose sans build fourni dans l’archive d’installation.');
  for (const folder of ['src/playlists', 'src/local_song']) await fs.mkdir(path.join(root, folder), { recursive: true, mode: 0o700 });
  for (const service of ['backend', 'frontend']) {
    report(`Téléchargement de ${service} (${manifest.version})…`);
    const reference = manifest.registry[service];
    await run('podman', ['pull', '--tls-verify=true', '--policy=always', '--platform', manifest.platform, reference]);
    const images = JSON.parse(await run('podman', ['image', 'inspect', reference]));
    if (images.length !== 1 || images[0].Id?.replace(/^sha256:/, '') !== manifest.images[service]
        || `${images[0].Os}/${images[0].Architecture}` !== manifest.platform || !images[0].RepoDigests?.includes(reference)) {
      throw new Error('Image téléchargée différente du manifeste signé.');
    }
  }
  // Local tags allow ordinary restarts to retain the version selected by Admin later.
  for (const service of ['backend', 'frontend']) await run('podman', ['tag', manifest.images[service], `localhost/youplayer-server-${service}:latest`]);
  await run('podman', ['pull', '--tls-verify=true', config.services.redis.image]);
  report('Démarrage des services…');
  await run('podman-compose', ['--env-file', path.join(root, '.env'), '-p', PROJECT, '-f', path.join(root, 'docker-compose.yml'), 'up', '-d', '--no-build']);
  let healthy = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const containers = JSON.parse(await run('podman', ['inspect', ...['backend', 'frontend', 'redis'].map(service => `${PROJECT}_${service}_1`)]));
    healthy = containers.length === 3 && containers.every(container => container.State?.Status === 'running'
      && (container.State?.Health?.Status || container.State?.Healthcheck?.Status) === 'healthy');
    if (healthy) break;
    await wait(2000);
  }
  if (!healthy) throw new Error('Délai de démarrage dépassé. Configuration et données conservées ; vérifier les services.');
  const snapshot = await createDeployment({ root, project: PROJECT, runCommand: run }).snapshot();
  if (['backend', 'frontend'].some(service => snapshot.images[service] !== manifest.images[service])) throw new Error('Images actives inattendues.');
  await writeUpdateJson(path.join(root, '.updates/host/config.json'), { repository: REPOSITORY, provider: 'github', publicKey,
    allowedImageRepositories: Object.values(manifest.registry).map(reference => reference.split('@')[0]) });
  await writeUpdateJson(path.join(root, '.updates/host/active.json'), { version: manifest.version, sequence: manifest.sequence, images: manifest.images });
  report('YouPlayer est prêt : https://ADRESSE_DU_SERVEUR:8443');
  report('Connecte-toi avec le compte admin, puis crée un compte user pour écouter la musique.');
  report('Pour activer le traitement des demandes Admin : node scripts/update-service.mjs run');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const [major, minor] = process.versions.node.split('.').map(Number);
    if (process.platform !== 'linux' || process.getuid?.() === 0) throw new Error('Utiliser Linux et le compte Podman utilisateur, sans sudo.');
    if (major < 22 || major === 22 && minor < 12) throw new Error('Node.js >= 22.12 requis.');
    const action = process.argv[2];
    if (!['check', 'install'].includes(action)) throw new Error('Lancer ./install.sh depuis l’archive d’installation.');
    const parts = [];
    if (action === 'install' && !(await fs.lstat(path.join(ROOT, '.env')).catch(() => null))) {
      let length = 0;
      for await (const part of process.stdin) {
        length += part.length;
        if (length > 4096) throw new Error('Identifiants trop longs.');
        parts.push(part);
      }
    }
    const [pseudo, password] = Buffer.concat(parts).toString('utf8').split('\0');
    await installServer({ checkOnly: action === 'check', pseudo, password });
  } catch (error) {
    // Command stderr remains in the updater's private log, never on the terminal.
    console.error(error.updateCode ? `Installation arrêtée (${error.updateCode}). Consulter .updates/host/last-command.log sur l’hôte.`
      : error.code || error instanceof SyntaxError ? 'Installation arrêtée : fichier manquant, inaccessible ou invalide. Consulter INSTALL.md.' : error.message);
    process.exitCode = 1;
  }
}
