import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpotifyCatalog } from '../../src/server/spotify-catalog.js';

const result = () => ({ tracks: { items: [] }, playlists: { items: [] }, albums: { items: [] }, artists: { items: [] } });
const encrypted = value => `encrypted:${value}`;
const connection = (token, overrides = {}) => ({
    accessTokenEncrypted: encrypted(token), refreshTokenEncrypted: encrypted('refresh'),
    expiresAt: new Date(Date.now() + 120000).toISOString(), ...overrides
});
function harness(overrides = {}) {
    return createSpotifyCatalog({
        config: { spotifyTokenSecret: 'synthetic-secret' },
        oauthEnabled: true,
        logger: { debug() {}, warn() {} },
        store: { getSpotifyConnection: async () => null },
        decryptSpotifyToken: value => value.slice('encrypted:'.length),
        refreshSpotifyAccessToken: async () => ({ access_token: 'renewed' }),
        spotifyTokenUpdateFromRefresh: data => ({ accessTokenEncrypted: encrypted(data.access_token) }),
        fetchSpotifyClientCredentialsToken: async () => ({ access_token: 'application', expires_in: 3600 }),
        fetchSpotifyCatalogSearch: async () => result(),
        fetchSpotifyAlbum: async () => ({ tracks: { items: [] } }),
        getSpotifyAnonymousToken: async () => 'anonymous',
        ...overrides
    });
}

test('catalog tokens stay associated with their own user and missing accounts are rejected', async () => {
    const calls = [];
    const catalog = harness({ store: { getSpotifyConnection: async (id, options) => {
        calls.push([id, options]);
        return id === 'missing' ? null : connection(id);
    } } });
    assert.equal(await catalog.spotifyAccessTokenForUser('first'), 'first');
    assert.equal(await catalog.spotifyAccessTokenForUser('second'), 'second');
    await assert.rejects(catalog.spotifyAccessTokenForUser(null), { statusCode: 401 });
    await assert.rejects(catalog.spotifyAccessTokenForUser('missing'), { statusCode: 409 });
    assert.equal(calls[0][1].includeTokens, true);
});

test('expired access tokens are refreshed and persisted encrypted for the same user', async () => {
    const writes = [];
    const catalog = harness({ store: {
        getSpotifyConnection: async () => connection('expired', { expiresAt: new Date(0).toISOString() }),
        updateSpotifyTokens: async (id, tokens) => writes.push([id, tokens])
    } });
    assert.equal(await catalog.spotifyAccessTokenForUser('first'), 'renewed');
    assert.equal(writes[0][0], 'first');
    assert.equal(writes[0][1].accessTokenEncrypted, encrypted('renewed'));
});

test('invalid_grant removes only the expired connection and missing refresh tokens fail locally', async () => {
    const removed = [];
    const catalog = harness({
        store: {
            getSpotifyConnection: async id => connection('expired', {
                expiresAt: new Date(0).toISOString(), refreshTokenEncrypted: id === 'no-refresh' ? '' : encrypted('refresh')
            }),
            removeSpotifyConnection: async id => removed.push(id)
        },
        refreshSpotifyAccessToken: async () => { throw Object.assign(new Error('synthetic'), { oauthCode: 'invalid_grant' }); }
    });
    await assert.rejects(catalog.spotifyAccessTokenForUser('first'), { statusCode: 409 });
    await assert.rejects(catalog.spotifyAccessTokenForUser('no-refresh'), { statusCode: 409 });
    assert.deepEqual(removed, ['first']);
});

test('application token loads are shared, cached and retryable after failure', async () => {
    let loads = 0;
    const tokens = [];
    const catalog = harness({
        fetchSpotifyClientCredentialsToken: async () => {
            loads++;
            if (loads === 1) throw new Error('synthetic failure');
            return { access_token: `application-${loads}`, expires_in: 3600 };
        },
        fetchSpotifyCatalogSearch: async token => { tokens.push(token); return result(); }
    });
    assert.equal(await catalog.spotifySearchForUser('first', 'query'), null);
    await Promise.all([catalog.spotifySearchForUser('first', 'query'), catalog.spotifySearchForUser('second', 'query')]);
    await catalog.spotifySearchForUser('first', 'query');
    assert.equal(loads, 2);
    assert.deepEqual(tokens, ['application-2', 'application-2', 'application-2']);
});

test('a catalog 401 refreshes once whereas other errors preserve the anonymous fallback', async () => {
    const tokens = [];
    let refreshes = 0;
    const catalog = harness({
        fetchSpotifyClientCredentialsToken: async () => ({ access_token: `application-${++refreshes}` }),
        fetchSpotifyCatalogSearch: async token => {
            tokens.push(token);
            if (token === 'application-1') throw Object.assign(new Error('synthetic'), { spotifyStatus: 401 });
            return result();
        }
    });
    assert.ok(await catalog.spotifySearchForUser('first', 'query'));
    assert.deepEqual(tokens, ['application-1', 'application-2']);
    const refused = harness({ fetchSpotifyCatalogSearch: async () => { throw Object.assign(new Error('synthetic'), { spotifyStatus: 403 }); } });
    assert.equal(await refused.spotifySearchForUser('first', 'query'), null);
    const disabled = harness({ oauthEnabled: false });
    assert.equal(await disabled.spotifySearchForUser('first', 'query'), null);
});

test('album lookup refreshes a 401 and preserves the anonymous WebPlayer fallback', async () => {
    const tokens = [];
    let loads = 0;
    const catalog = harness({
        fetchSpotifyClientCredentialsToken: async () => ({ access_token: `application-${++loads}` }),
        fetchSpotifyAlbum: async token => {
            tokens.push(token);
            if (token === 'application-1') throw Object.assign(new Error('synthetic'), { spotifyStatus: 401 });
            return { id: 'album' };
        }
    });
    assert.equal((await catalog.spotifyAlbumForUser('first', 'album')).id, 'album');
    assert.equal((await catalog.spotifyAlbumFromAnonymousWebToken('album')).id, 'album');
    assert.deepEqual(tokens, ['application-1', 'application-2', 'anonymous']);
    const unavailable = harness({ fetchSpotifyAlbum: async () => { throw new Error('synthetic'); } });
    assert.equal(await unavailable.spotifyAlbumForUser('first', 'album'), null);
    assert.equal(await unavailable.spotifyAlbumFromAnonymousWebToken('album'), null);
});
