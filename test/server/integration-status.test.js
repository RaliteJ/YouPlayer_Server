import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createIntegrationStatus } from '../../src/server/integration-status.js';
import { registerAuthRoutes } from '../../src/server/auth-routes.js';

const globalFetch = mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected live request'); });
after(() => {
    const count = globalFetch.mock.callCount();
    globalFetch.mock.restore();
    assert.equal(count, 0, 'All probes must use an injected request');
});
const config = {
    authEnabled: true, youtubeApiKey: 'synthetic-youtube-key', spotifyClientId: 'synthetic-client',
    spotifyClientSecret: 'synthetic-secret', spotifyRedirectUri: 'https://player.test/auth/spotify/callback'
};
const time = Date.UTC(2026, 9, 5, 12);
const guestPage = () => new Response(`<script id="__NEXT_DATA__">${JSON.stringify({ props: { pageProps: { state: { settings: { session: {
    isAnonymous: true, accessToken: 'synthetic-guest-token', accessTokenExpirationTimestampMs: time + 3600000
} } } } } })}</script>`);
function successful(url) {
    const target = new URL(url);
    if (target.hostname === 'www.googleapis.com') return Response.json({ items: [] });
    if (target.hostname === 'accounts.spotify.com') return Response.json({ access_token: 'synthetic-app-token' });
    if (target.hostname === 'open.spotify.com') return guestPage();
    throw new Error('Unexpected host');
}

test('reading configuration does not probe services and distinguishes absent settings from unchecked services', () => {
    const status = createIntegrationStatus({ config: {}, fetchImpl: () => assert.fail('Unexpected request') });
    const value = status.snapshot();
    assert.deepEqual(value.connections, {
        youtube: { state: 'not_configured', checkedAt: null },
        spotifyPublic: { state: 'not_checked', checkedAt: null },
        spotifyOAuth: { state: 'not_configured', checkedAt: null }
    });
    assert.equal(value.checkedAt, null);
});

test('explicit probes validate fixed service endpoints and expose only safe states and dates', async () => {
    const calls = [];
    const status = createIntegrationStatus({ config, now: () => time, fetchImpl: async (url, options) => {
        calls.push({ url: new URL(url), options });
        assert.ok(options.signal);
        assert.equal(options.redirect, 'error');
        return successful(url);
    } });
    const result = await status.check();
    assert.equal(calls.length, 3);
    assert.equal(calls[0].url.pathname, '/youtube/v3/videos');
    assert.equal(calls[0].url.searchParams.get('part'), 'id');
    assert.equal(calls[0].url.searchParams.get('key'), config.youtubeApiKey);
    const oauth = calls.find(call => call.url.hostname === 'accounts.spotify.com');
    assert.equal(oauth.options.method, 'POST');
    assert.match(oauth.options.headers.Authorization, /^Basic /);
    assert.equal(new URLSearchParams(oauth.options.body).get('grant_type'), 'client_credentials');
    assert.ok(Object.values(result.connections).every(row => row.state === 'connected'));
    assert.equal(result.checkedAt, new Date(time).toISOString());
    assert.doesNotMatch(JSON.stringify(result), /synthetic|token|secret|key/i);
});

test('simultaneous checks share one request set and the cooldown prevents repeated quota use', async () => {
    let release;
    const barrier = new Promise(resolve => { release = resolve; });
    let calls = 0;
    let currentTime = time;
    const status = createIntegrationStatus({ config, now: () => currentTime, fetchImpl: async url => {
        calls++; await barrier; return successful(url);
    } });
    const first = status.check();
    const second = status.check();
    assert.equal(first, second);
    assert.equal(status.snapshot().connections.youtube.state, 'checking');
    release();
    await first;
    await status.check();
    assert.equal(calls, 3);
    currentTime += 31000;
    await status.check();
    assert.equal(calls, 6);
});

test('quota errors and invalid OAuth credentials do not hide a successful public Spotify connection', async () => {
    const status = createIntegrationStatus({ config, now: () => time, fetchImpl: async url => {
        const hostname = new URL(url).hostname;
        if (hostname === 'www.googleapis.com') return Response.json({ error: { message: 'synthetic-private-detail', errors: [{ reason: 'quotaExceeded' }] } }, { status: 403 });
        if (hostname === 'accounts.spotify.com') return Response.json({ error: 'invalid_client', error_description: 'synthetic-private-detail' }, { status: 401 });
        return guestPage();
    } });
    const result = await status.check();
    assert.equal(result.connections.youtube.state, 'quota_exceeded');
    assert.equal(result.connections.spotifyOAuth.state, 'rejected');
    assert.equal(result.connections.spotifyPublic.state, 'connected');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private|invalid_client/);
});

test('missing integration settings skip their requests and timeouts are reported without diagnostics', async () => {
    let count = 0;
    const status = createIntegrationStatus({ config: {}, now: () => time, fetchImpl: async () => {
        count++; throw new DOMException('synthetic-private-address', 'TimeoutError');
    } });
    const result = await status.check();
    assert.equal(count, 1);
    assert.equal(result.connections.youtube.state, 'not_configured');
    assert.equal(result.connections.spotifyOAuth.state, 'not_configured');
    assert.equal(result.connections.spotifyPublic.state, 'timeout');
    assert.doesNotMatch(JSON.stringify(result), /synthetic-private/);
});

test('rate limits, malformed successful responses and network failures never report a service connected', async () => {
    const status = createIntegrationStatus({ config, now: () => time, fetchImpl: async url => {
        const hostname = new URL(url).hostname;
        if (hostname === 'www.googleapis.com') return Response.json({ private: 'synthetic-detail' });
        if (hostname === 'open.spotify.com') return new Response('', { status: 429 });
        throw new Error('synthetic-network-details');
    } });
    const result = await status.check();
    assert.equal(result.connections.youtube.state, 'invalid_response');
    assert.equal(result.connections.spotifyPublic.state, 'rate_limited');
    assert.equal(result.connections.spotifyOAuth.state, 'unavailable');
});

test('admin check routes require a real admin session even in local mode and rate-limit explicit checks', async () => {
    const routes = new Map();
    let checks = 0;
    const value = { connections: {}, checkedAt: null };
    const register = method => (path, ...handlers) => routes.set(method + path, handlers);
    registerAuthRoutes({ get: register('GET'), post: register('POST') }, {
        config: { authEnabled: false }, store: {}, requireAuth: (_req, _res, next) => next(),
        requireAdmin: (_req, _res, next) => next(),
        integrationStatus: { snapshot: () => value, check: async () => { checks++; return value; } }
    });
    async function request(method, session) {
        const req = { session, ip: 'synthetic-admin' };
        const res = { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
            json(body) { this.body = body; return this; }, setHeader(key, data) { this.headers[key] = data; } };
        for (const handler of routes.get(method + '/admin/integrations' + (method === 'POST' ? '/check' : ''))) {
            let next = false;
            await handler(req, res, () => { next = true; });
            if (!next) break;
        }
        return res;
    }
    assert.equal((await request('GET', {})).statusCode, 403);
    assert.equal((await request('POST', { userId: 'u', role: 'user' })).statusCode, 403);
    const admin = { userId: 'a', role: 'admin' };
    assert.equal((await request('GET', admin)).statusCode, 200);
    assert.equal(checks, 0);
    for (let i = 0; i < 4; i++) {
        const response = await request('POST', admin);
        assert.equal(response.statusCode, 200);
        assert.equal(response.headers['Cache-Control'], 'no-store');
    }
    assert.equal((await request('POST', admin)).statusCode, 429);
    assert.equal(checks, 4);
});
