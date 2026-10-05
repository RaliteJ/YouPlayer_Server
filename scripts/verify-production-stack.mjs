import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
import { backupProduction, verifyBackup } from './production.mjs';
const run = promisify(execFile);
const root = process.cwd(), project = `youplayer-check-${process.pid}`;
const folder = path.join(root, 'coverage', 'production', project);
const composeEnvironment = Object.fromEntries(Object.entries(process.env)
  .filter(([key]) => !/^(YOUPLAYER_|FIRST_TRACK_|DATABASE_URL$)/.test(key)));
const rollbackIndex = process.argv.indexOf('--rollback-release');
const rollbackFile = rollbackIndex >= 0 ? path.resolve(process.argv[rollbackIndex + 1], 'rollback.json') : null;
if (!rollbackFile && !process.argv.includes('--public-media')) throw new Error('Utiliser --public-media pour autoriser les essais musicaux publics, ou --rollback-release DOSSIER');
const { default: puppeteer } = await import(createRequire(path.join(root, 'src/package.json')).resolve('puppeteer'));
let browser, page, progressTimer, started = false, stage='Compose';
const compose = async args => {
  try { const result = await run('podman-compose', ['--env-file', path.join(folder, '.env'), '-p', project, '-f', path.join(folder, 'compose.json'), ...args], { env: composeEnvironment, timeout: 180000, maxBuffer: 2 ** 20 });
    const errors = (result.stderr + result.stdout).split('\n').filter(line => /^Error:/.test(line));
    if (errors.length) console.log(JSON.stringify({ composeErrors: errors }));
    return result; }
  catch (error) {
    const diagnostic = String(error.stderr || '') + String(error.stdout || '');
    console.log(JSON.stringify({ errors: diagnostic.split('\n').filter(line => /^(Error:|Error response|podman:)/.test(line)).map(line => line.replace(/(password|secret|token)[^ ,]*/gi, '[masked]')).slice(-8) }));
    console.log(JSON.stringify({ check: 'Compose diagnostic', killed: !!error.killed, code: error.code,
      permissionError: /permission denied|operation not permitted/i.test(diagnostic),
      userNamespaceError: /user namespace|uid_map|gid_map|newuidmap/i.test(diagnostic),
      missingImage: /image.*not found|no such image/i.test(diagnostic),
      storageError: /chown|mount.*error|directory.*not/i.test(diagnostic) }));
    throw new Error('Compose verification command failed');
  }
};
const podman = async args => { try { return (await run('podman', args, { timeout: 120000, maxBuffer: 2 ** 20 })).stdout; } catch (error) { console.log(JSON.stringify({ command: args[0], errors: String(error.stderr || '').split('\n').filter(line => /^Error:/.test(line)) })); throw new Error('Container verification failed'); } };
function request(base, route, { method = 'GET', body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const req = https.request(base + route, { method, rejectUnauthorized: false,
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data ? { Origin: base, 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => { const bytes = Buffer.concat(chunks); let json;
        try { json = JSON.parse(bytes.toString()); } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, bytes }); });
    });
    req.setTimeout(60000, () => req.destroy(new Error('HTTP verification timeout'))); req.on('error', reject);
    if (data) req.write(data); req.end();
  });
}
function requireCheck(value, message) { if (!value) throw new Error(message); }
try {
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  for (const d of ['playlists', 'local_song']) await fs.mkdir(path.join(folder, 'src', d), { recursive: true });
  const password = randomBytes(24).toString('hex');
  const env = { YOUPLAYER_ADMIN_PSEUDO: 'synthetic-admin', YOUPLAYER_ADMIN_PASSWORD: password,
    YOUPLAYER_SESSION_SECRET: randomBytes(32).toString('hex'), YOUPLAYER_SPOTIFY_TOKEN_SECRET: randomBytes(32).toString('hex'),
    YOUPLAYER_LOG_LEVEL: 'silent', YOUPLAYER_YOUTUBE_API_KEY: '', YOUPLAYER_SPOTIFY_WEB_USERNAME: '', YOUPLAYER_SPOTIFY_WEB_PASSWORD: '',
    YOUPLAYER_SPOTIFY_CLIENT_ID: '', YOUPLAYER_SPOTIFY_CLIENT_SECRET: '', YOUPLAYER_SPOTIFY_REDIRECT_URI: '', YOUPLAYER_SPOTIFY_SCOPES: '' };
  await fs.writeFile(path.join(folder, '.env'), Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'), { mode: 0o600 });
  const source = JSON.parse((await run('python3', ['-c', 'import yaml,json;print(json.dumps(yaml.safe_load(open("docker-compose.yml"))))'])).stdout);
  delete source.services.backend.build; delete source.services.frontend.build;
  for (const service of ['backend']) source.services[service].image = 'localhost/youplayer-server-backend:production-check';
  source.services.frontend.image = 'localhost/youplayer-server-frontend:production-check';
  if (rollbackFile) {
    const previous = JSON.parse(await fs.readFile(rollbackFile, 'utf8'));
    for (const service of ['backend', 'frontend']) Object.assign(source.services[service], previous.services[service]);
  }
  const readinessPath = rollbackFile ? '/auth/me' : '/health/ready', readinessStatus = rollbackFile ? 401 : 200;
  source.services.frontend.ports = ['127.0.0.1::443'];
  source.services.backend.volumes = [`${folder}/src/playlists:/var/www/html/playlists:Z`, `${folder}/src/local_song:/var/www/html/local_song:Z`, 'youplayer_data:/var/lib/youplayer:Z,U'];
  const samples = 44100 * 8, tone = Buffer.alloc(44 + samples * 2);
  tone.write('RIFF'); tone.writeUInt32LE(tone.length - 8, 4); tone.write('WAVEfmt ', 8); tone.writeUInt32LE(16, 16);
  tone.writeUInt16LE(1, 20); tone.writeUInt16LE(1, 22); tone.writeUInt32LE(44100, 24); tone.writeUInt32LE(88200, 28);
  tone.writeUInt16LE(2, 32); tone.writeUInt16LE(16, 34); tone.write('data', 36); tone.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) tone.writeInt16LE(Math.round(2000 * Math.sin(i * 2 * Math.PI * 440 / 44100)), 44 + i * 2);
  await fs.writeFile(path.join(folder, 'src', 'local_song', 'synthetic-second.wav'), tone);
  await fs.writeFile(path.join(folder, 'compose.json'), JSON.stringify(source, null, 2));
  started = true; await compose(['up', '-d']);
  const frontend = `${project}_frontend_1`, backend = `${project}_backend_1`;
  const address = (await podman(['port', frontend, '443/tcp'])).trim().split('\n')[0];
  const base = `https://${address}`;
  for (let i = 0; i < 60; i++) { if ((await request(base, readinessPath).catch(() => ({ status: 0 }))).status === readinessStatus) break;
    if (i === 59) throw new Error('Full stack readiness failed'); await new Promise(resolve => setTimeout(resolve, 1000)); }
  requireCheck((await request(base, '/auth/me')).status === 401, 'Anonymous authentication guard failed');
  const health = await request(base, readinessPath);
  requireCheck(rollbackFile || (!health.headers['set-cookie'] && health.json?.status === 'ok'), 'Health probe created a session or exposed data');
  const login = await request(base, '/auth/login', { method: 'POST', body: { pseudo: env.YOUPLAYER_ADMIN_PSEUDO, password } });
  requireCheck(login.status === 200, 'Production bootstrap login failed');
  const setCookie = login.headers['set-cookie'][0], cookie = setCookie.split(';')[0];
  requireCheck(/Secure/i.test(setCookie) && /HttpOnly/i.test(setCookie), 'HTTPS cookie flags failed');
  const other = await request(base, '/auth/login', { method: 'POST', body: { pseudo: env.YOUPLAYER_ADMIN_PSEUDO, password } });
  const otherCookie = other.headers['set-cookie'][0].split(';')[0];
  console.log(JSON.stringify({ check: 'Compose HTTPS health / bootstrap admin / secure cookies', passed: true }));
  const song = JSON.parse(await fs.readFile(path.join(root, 'test/fixtures/production-public-track.json'), 'utf8'));
  requireCheck((await request(base, '/spotify_import_browser_playlist', { method: 'POST', cookie, body: { playlist: 'Integration', items: [song] } })).status === 200, 'Spotify metadata import failed');
  requireCheck((await request(base, '/update_playlist', { method: 'POST', cookie, body: { arg: { playlist: 'Integration.json', song: { type: 'local', title: 'Synthetic second', url: 'synthetic-second.wav' } } } })).status === 200, 'Local second track failed');
  requireCheck((await request(base, '/playlist_preview?playlist=Integration.json', { cookie })).json?.length === 2, 'Playlist persistence failed');
  await podman(['restart', backend]);
  if (rollbackFile) await podman(['restart', frontend]);
  for (let i = 0; i < 30; i++) { if ((await request(base, readinessPath).catch(() => ({ status: 0 }))).status === readinessStatus) break; await new Promise(resolve => setTimeout(resolve, 1000)); }
  requireCheck((await request(base, '/auth/me', { cookie })).status === 200, 'Redis session did not survive backend restart');
  requireCheck((await request(base, '/playlist_preview?playlist=Integration.json', { cookie })).json?.length === 2, 'Playlist did not survive restart');
  console.log(JSON.stringify({ check: 'Redis session and file-store persistence after restart', passed: true }));
  await backupProduction({ root: folder, project }).then(() => {
    throw new Error('Active services should reject an offline backup');
  }, error => { requireCheck(/Services actifs/.test(error.message), 'Offline backup refusal failed'); });
  const backup = await backupProduction({ root: folder, project, maintenance: true });
  await verifyBackup(backup.directory);
  if (rollbackFile) await podman(['restart', frontend]);
  for (let i = 0; i < 30; i++) { if ((await request(base, readinessPath).catch(() => ({ status: 0 }))).status === readinessStatus) break; await new Promise(resolve => setTimeout(resolve, 1000)); }
  requireCheck((await request(base, '/auth/me', { cookie })).status === 200, 'Maintenance backup did not preserve the session');
  requireCheck((await request(base, '/playlist_preview?playlist=Integration.json', { cookie })).json?.length === 2, 'Maintenance backup did not preserve the playlist');
  console.log(JSON.stringify({ check: 'active backup refusal / coherent maintenance / service recovery', volumes: backup.volumes, passed: true }));
  if (rollbackFile) { console.log(JSON.stringify({check:'previous-image rollback / authentication / persistence',passed:true})); }
  else {
  const search = await request(base, '/spotify_test', { method: 'POST', cookie, body: { action: 'search', query: 'Radiohead', limit: 1 } });
  requireCheck(search.status === 200 && search.json?.data?.tracks?.items?.length, 'Real Spotify search through HTTPS failed');
  browser = await puppeteer.launch({ executablePath: '/usr/bin/chromium', headless: true, acceptInsecureCerts: true, protocolTimeout: 300000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--autoplay-policy=no-user-gesture-required'] });
  page = await browser.newPage(); page.on('pageerror', error => console.log(JSON.stringify({browserError: String(error.message).replaceAll(password,'[masked]').slice(0,180)}))); page.on('response', response => {if(response.status() >= 400) console.log(JSON.stringify({browserHttpError:response.status(),path:new URL(response.url()).pathname}));}); const foreground = await browser.newPage(); stage='browser login';
  await page.bringToFront();
  const initialAuth = page.waitForResponse(response => new URL(response.url()).pathname === '/auth/me');
  await page.goto(base, { waitUntil: 'domcontentloaded' }); await initialAuth;
  await page.waitForFunction(() => typeof document.querySelector('#login-form')?.onsubmit === 'function');
  await page.type('#login-pseudo', env.YOUPLAYER_ADMIN_PSEUDO); await page.type('#login-password', password);
  await page.click('#login-form button[type=submit]');
  await page.waitForFunction(() => !document.body.classList.contains('auth-required'));
  stage='frontend playlist and audio start';
  const streamId = await page.evaluate(async () => {
    const { App } = await import(document.querySelector('script[type=module]').src); window.fixtureApp = App; window.originalAudio = App.lecteur;
    await App.apiFetch('/playlist_used', 'POST', { arg: ['Integration.json'], random: false });
    App.selectedPlaylists = ['Integration.json']; await App.fetchPlaylist();
    if (!App.currentSpecialStream && !App.lecteur.currentSrc) await App.nextSong('select');
    return App.currentSpecialStream?.id;
  });
  stage='real audio playback';
  await page.waitForFunction(() => !window.fixtureApp.lecteur.paused && window.fixtureApp.lecteur.currentTime > 0.1, { timeout: 45000 });
  const actualStreamId = streamId || await page.evaluate(() => window.fixtureApp.currentSpecialStream?.stream_id);
  const forbidden = await request(base, `/audio/${actualStreamId}/status`, { cookie: otherCookie });
  requireCheck(forbidden.status === 403, 'Real stream isolation through HTTPS failed');
  stage='next-track prefetch';
  await page.waitForFunction(() => Number(window.fixtureApp.nextTrackPrefetch?.trackId) === 1, { timeout: 45000 });
  stage='hidden native handoff';
  await foreground.goto('about:blank'); await foreground.bringToFront();
  console.log(JSON.stringify({check:'real audio playing / next track ready / hidden playback',passed:true}));
  progressTimer = setInterval(() => { void page.evaluate(() => ({check:'audio progress',seconds:Math.round(window.fixtureApp.lecteur.currentTime),hidden:document.hidden})).then(value=>console.log(JSON.stringify(value))).catch(()=>{}); },30000);
  await page.waitForFunction(() => Number(window.fixtureApp.currentId) === 1 && !window.fixtureApp.lecteur.paused
    && window.fixtureApp.lecteur.currentTime > 0.2, { timeout: 250000, polling: 100 });
  const player = await page.evaluate(() => ({ hidden: document.hidden, persistentAudio: window.fixtureApp.lecteur === window.originalAudio,
    audioElements: document.querySelectorAll('audio').length, secondPlaying: !window.fixtureApp.lecteur.paused }));
  requireCheck(player.persistentAudio && player.audioElements === 1, 'Persistent player failed');
  console.log(JSON.stringify({ check: 'real Spotify -> YouTube through Nginx and actual frontend handoff', ...player, otherSessionStatus: forbidden.status }));
  await page.evaluate(async () => { await window.fixtureApp.logout(); });
  await new Promise(resolve => setTimeout(resolve, 2000));
  const processProbe = await podman(['exec', backend, 'sh', '-c', 'if pgrep -x yt-dlp >/dev/null || pgrep -x ffmpeg >/dev/null; then exit 1; fi']);
  console.log(JSON.stringify({ check: 'logout and child-process cleanup', passed: true }));
  }
} catch (error) { if(page) console.log(JSON.stringify(await page.evaluate(() => ({authRequired:document.body.classList.contains('auth-required'),appReady:!!window.fixtureApp, audioError:window.fixtureApp?.lecteur?.error?.code,durationFinite:Number.isFinite(window.fixtureApp?.lecteur?.duration),currentTime:window.fixtureApp?.lecteur?.currentTime,prefetchTrackId:window.fixtureApp?.nextTrackPrefetch?.trackId,currentId:window.fixtureApp?.currentId,loginError:!!document.querySelector('#login-error')?.textContent})).catch(()=>({browserInspectionFailed:true})))); console.log(JSON.stringify({ check: 'production stack verification failed', stage, error: error.message?.includes('Command failed') ? 'Container command failed; private output masked' : error.message.slice(0, 180) })); process.exitCode = 1; }
finally {
  clearInterval(progressTimer);
  await browser?.close();
  if (started) await compose(['down', '-v']).catch(() => { process.exitCode = 1; }); // Only this unique synthetic project.
  await fs.rm(folder, { recursive: true, force: true });
}
