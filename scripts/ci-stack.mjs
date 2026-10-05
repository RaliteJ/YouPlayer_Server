import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import https from 'node:https';
import assert from 'node:assert/strict';

const [action, envPath] = process.argv.slice(2);
if (!envPath || !['init', 'check'].includes(action)) {
    throw new Error('Usage: node scripts/ci-stack.mjs init|check FICHIER_ENV_TEMPORAIRE');
}
if (action === 'init') {
    const values = {
        YOUPLAYER_ADMIN_PSEUDO: 'ci-admin',
        YOUPLAYER_ADMIN_PASSWORD: randomBytes(24).toString('hex'),
        YOUPLAYER_SESSION_SECRET: randomBytes(48).toString('hex'),
        YOUPLAYER_SPOTIFY_TOKEN_SECRET: randomBytes(48).toString('hex')
    };
    await writeFile(envPath, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(''), { mode: 0o600, flag: 'wx' });
    console.log('Configuration temporaire generee pour la stack de test.');
} else {
    const values = Object.fromEntries((await readFile(envPath, 'utf8')).trim().split('\n').map(line => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
    }));
    const origin = 'https://127.0.0.1:18443';
    let cookie = '';
    const request = (route, body, authenticated = true) => new Promise((resolve, reject) => {
        const payload = body ? JSON.stringify(body) : null;
        const req = https.request(new URL(route, origin), {
            rejectUnauthorized: false, // Certificat autosigne de la stack jetable uniquement.
            method: payload ? 'POST' : 'GET',
            headers: { Origin: origin, ...(authenticated && cookie ? { Cookie: cookie } : {}),
                ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) }
        }, res => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
            res.on('error', reject);
        });
        req.setTimeout(10_000, () => req.destroy(new Error('Test HTTPS trop lent')));
        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
    assert.equal((await request('/health/ready')).status, 200, 'Backend et Redis prets');
    const page = await request('/');
    assert.equal(page.status, 200);
    assert.match(page.text, /admin-tab-integrations/);
    assert.equal((await request('/admin/integrations', null, false)).status, 401);
    const login = await request('/auth/login', { pseudo: values.YOUPLAYER_ADMIN_PSEUDO, password: values.YOUPLAYER_ADMIN_PASSWORD });
    assert.equal(login.status, 200, 'Connexion du compte temporaire');
    assert.equal(JSON.parse(login.text).user.role, 'admin');
    cookie = (login.headers['set-cookie'] || []).map(value => value.split(';')[0]).join('; ');
    assert.ok(cookie, 'Session HTTPS creee');
    assert.ok(login.headers['set-cookie'].every(value => /;\s*Secure/i.test(value) && /;\s*HttpOnly/i.test(value)));
    const snapshot = await request('/admin/integrations');
    assert.equal(snapshot.status, 200, 'Session retrouvee via Redis');
    assert.equal(JSON.parse(snapshot.text).connections.youtube.state, 'not_configured');
    assert.equal(JSON.parse(snapshot.text).connections.spotifyPublic.state, 'not_checked');
    assert.equal((await request('/playlist')).status, 403, 'Compte admin reserve a la gestion');
    assert.equal((await request('/auth/logout', {})).status, 200);
    assert.equal((await request('/admin/integrations')).status, 401, 'Session deconnectee');
    console.log('Stack HTTPS validee : interface, disponibilite, connexion admin, session Redis et protections.');
}
