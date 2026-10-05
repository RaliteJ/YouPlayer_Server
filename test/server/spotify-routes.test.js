import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerSpotifyRoutes } from '../../src/server/spotify-routes.js';

const globalFetch = mock.method(globalThis, 'fetch', async () => {
	throw new Error('External calls are forbidden in route tests');
});
after(() => {
	const calls = globalFetch.mock.callCount();
	globalFetch.mock.restore();
	assert.equal(calls, 0, 'Routes must use their injected network dependency');
});

function harness(overrides = {}) {
	const routes = new Map(), errors = [];
	const requireAuth = () => {};
	const unexpectedCalls = [];
	const unexpected = async () => { unexpectedCalls.push(true); throw new Error('Unexpected external call'); };
	const defaults = {
		spotifyAccessTokenForUser: unexpected, spotifySearchForUser: unexpected,
		spotifyAlbumForUser: unexpected, spotifyAlbumFromAnonymousWebToken: unexpected,
		getSpotifyAnonymousToken: unexpected, clearSpotifyAnonymousToken: () => {},
		getSpotifyPlaylistTracksPage: unexpected, getSpotifyPathfinderJson: unexpected,
		fetchSpotifyCurrentUserPlaylists: unexpected,
		spotifyLoginSandboxStatus: () => ({ available: true }), runSpotifyLoginSandboxProbe: unexpected,
		fetch: unexpected,
		...overrides
	};
	registerSpotifyRoutes({ post: register('post'), get: register('get') }, {
		...defaults, catalog: defaults, fetchImpl: defaults.fetch,
		requireAuth, logger: { warn() {}, error() {} },
		sendJsonError(res, error) { errors.push(error); res.status(error.statusCode || 400).json({ error: 'Erreur Spotify' }); },
	});
	function register(method) {
		return (path, guard, handler) => {
			assert.equal(guard, requireAuth);
			routes.set(method + path, handler);
		};
	}
	return { errors, unexpectedCalls, async request(body = {}, method = 'post', path = '/spotify_test') {
		const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
		await routes.get(method + path)({ body, session: { userId: 'synthetic-user' } }, res);
		return res;
	} };
}

test('Spotify search uses the user catalog first and normalizes the query and pagination', async () => {
	const data = { tracks: { items: [{ name: 'Synthetic' }] } };
	const h = harness({ spotifySearchForUser: async (userId, query, options) => {
		assert.equal(userId, 'synthetic-user');
		assert.equal(query, 'Artiste');
		assert.equal(options.limit, 50);
		assert.equal(options.offset, 0);
		return data;
	} });
	const res = await h.request({ query: '  Artiste  ', limit: 1000, offset: -2 });
	assert.equal(res.statusCode, 200);
	assert.equal(res.body.data, data);
});

test('anonymous partner search refreshes once after 401 or 403 and retains its request', async () => {
	for (const status of [401, 403]) {
		const tokens = [], requests = [];
		let clears = 0;
		const h = harness({
			spotifySearchForUser: async () => null,
			getSpotifyAnonymousToken: async source => { tokens.push(source); return tokens.length === 1 ? 'synthetic-old' : 'synthetic-new'; },
			clearSpotifyAnonymousToken: () => clears++,
			fetch: async (url, options) => {
				requests.push({ url, options });
				return requests.length === 1 ? { status, ok: false } : { status: 200, ok: true, json: async () => ({ data: { searchV2: {} } }) };
			}
		});
		const res = await h.request({ query: 'A B', offset: 12, limit: 8 });
		assert.equal(res.statusCode, 200);
		assert.equal(clears, 1);
		assert.deepEqual(tokens, ['search/A%20B', 'search/A%20B']);
		assert.equal(requests[1].options.headers.Authorization, 'Bearer synthetic-new');
		assert.equal(requests[0].options.body, requests[1].options.body);
		const payload = JSON.parse(requests[1].options.body);
		assert.equal(payload.operationName, 'searchDesktop');
		assert.equal(payload.variables.offset, 12);
		assert.equal(payload.variables.limit, 8);
		assert.equal(res.body.data.tracks.items.length, 0);
	}
});

test('Spotify search retries with HTTP after a direct partner failure', async () => {
	const h = harness({
		spotifySearchForUser: async () => null, getSpotifyAnonymousToken: async () => 'synthetic',
		fetch: async () => ({ status: 503, ok: false, text: async () => 'synthetic error' }),
		getSpotifyPathfinderJson: async (path, field, options) => {
			assert.equal(path, 'search/A%20B'); assert.equal(field, 'searchV2');
			assert.deepEqual(options, { offset: 17, limit: 8 });
			return { data: { searchV2: {} } };
		}
	});
	assert.equal((await h.request({ query: 'A B', offset: 17, limit: 8 })).statusCode, 200);
});

test('playlist details and later pages preserve totals, offsets and next cursors', async () => {
	const calls = [];
	const track = { id: 'track123456', name: 'Synthetic' };
	const h = harness({
		getSpotifyAnonymousToken: async source => { assert.equal(source, 'playlist/list123456'); return 'synthetic'; },
		getSpotifyPlaylistTracksPage: async (_token, id, options) => {
			calls.push({ id, ...options });
			return { name: 'Synthetic list', items: [track], total: 123, ...options, next: 'synthetic-next' };
		}
	});
	const first = await h.request({ action: 'playlist', url: 'https://open.spotify.com/playlist/list123456' });
	assert.equal(first.body.data.name, 'Synthetic list');
	assert.equal(first.body.data.tracks.items[0].track, track);
	assert.equal(first.body.data.tracks.total, 123);
	const next = await h.request({ action: 'playlist_tracks', id: 'list123456', offset: 50, limit: 999 });
	assert.equal(next.body.data.next, 'synthetic-next');
	assert.equal(next.body.data.offset, 50);
	assert.deepEqual(calls, [{ id: 'list123456', offset: 0, limit: 50 }, { id: 'list123456', offset: 50, limit: 100 }]);
});

test('playlist HTTP fallback preserves the original error if both paths fail', async () => {
	const original = new Error('Synthetic partner failure');
	const h = harness({
		getSpotifyAnonymousToken: async () => 'synthetic',
		getSpotifyPlaylistTracksPage: async () => { throw original; },
		getSpotifyPathfinderJson: async () => ({ data: { playlistV2: { data: { uri: 'spotify:playlist:list123456', name: 'Captured', content: { items: [] } } } } })
	});
	assert.equal((await h.request({ action: 'playlist', id: 'list123456' })).body.data.name, 'Captured');
	const failed = harness({
		getSpotifyAnonymousToken: async () => 'synthetic',
		getSpotifyPlaylistTracksPage: async () => { throw original; },
		getSpotifyPathfinderJson: async () => { throw new Error('Synthetic capture failure'); }
	});
	assert.equal((await failed.request({ action: 'playlist', id: 'list123456' })).statusCode, 400);
	assert.equal(failed.errors[0], original);
});

test('personal playlists refresh an expired user token once, but do not retry other errors', async () => {
	for (const status of [401, 403]) {
		const refreshes = []; let requests = 0;
		const h = harness({
			spotifyAccessTokenForUser: async (userId, options) => {
				assert.equal(userId, 'synthetic-user'); refreshes.push(Boolean(options?.forceRefresh)); return 'synthetic';
			},
			fetchSpotifyCurrentUserPlaylists: async () => {
				if (++requests === 1) throw Object.assign(new Error('Synthetic denied'), { spotifyStatus: status });
				return { items: [] };
			}
		});
		assert.equal((await h.request({ action: 'me_playlists' })).statusCode, status === 401 ? 200 : 400);
		assert.deepEqual(refreshes, status === 401 ? [false, true] : [false]);
	}
});

test('album details try user, anonymous and Pathfinder HTTP in order', async () => {
	const calls = [];
	const h = harness({
		spotifyAlbumForUser: async (userId, id) => { calls.push('user'); assert.equal(userId, 'synthetic-user'); assert.equal(id, 'album123456'); return null; },
		spotifyAlbumFromAnonymousWebToken: async () => { calls.push('anonymous'); return null; },
		getSpotifyPathfinderJson: async (path, field) => {
			calls.push(path);
			return { data: { [field]: field === 'albumUnion'
				? { uri: 'spotify:album:album123456', name: 'Captured album' }
				: { uri: 'spotify:artist:artist123456', profile: { name: 'Captured artist' } } } };
		}
	});
	assert.equal((await h.request({ action: 'album', id: 'album123456' })).body.data.name, 'Captured album');
	assert.deepEqual(calls, ['user', 'anonymous', 'album/album123456']);
});

test('artist details use anonymous HTTP, refresh once and preserve all view sections without capture', async () => {
	for (const status of [200, 401, 403]) {
		let requests = 0, clears = 0;
		const id = 'artist123456';
		const h = harness({
			getSpotifyAnonymousToken: async source => { assert.equal(source, `artist/${id}`); return 'synthetic'; },
			clearSpotifyAnonymousToken: () => clears++,
			fetch: async (url, options) => {
				assert.equal(url, 'https://api-partner.spotify.com/pathfinder/v2/query');
				assert.equal(options.method, 'POST');
				assert.equal(options.headers.Authorization, 'Bearer synthetic');
				const payload = JSON.parse(options.body);
				assert.equal(payload.operationName, 'queryArtistOverview');
				assert.deepEqual(payload.variables, { uri: `spotify:artist:${id}`, locale: '', preReleaseV2: false });
				if (++requests === 1 && status !== 200) return { status, ok: false };
				return { status: 200, ok: true, json: async () => ({ data: { artistUnion: {
					uri: `spotify:artist:${id}`, profile: { name: 'Synthetic artist' },
					discography: {
						topTracks: { items: [{ track: { uri: 'spotify:track:track123456', name: 'Synthetic track' } }] },
						albums: { items: [{ releases: { items: [{ uri: 'spotify:album:album123456', name: 'Synthetic album' }] } }] }
					}, relatedContent: { relatedArtists: { items: [{ uri: 'spotify:artist:related123456', profile: { name: 'Related' } }] } }
				} } }) };
			}
		});
		const res = await h.request({ action: 'artist', id });
		assert.equal(res.statusCode, 200);
		assert.equal(res.body.data.artist.id, id);
		assert.equal(res.body.data.top_tracks[0].name, 'Synthetic track');
		assert.equal(res.body.data.albums[0].name, 'Synthetic album');
		assert.equal(res.body.data.related_artists[0].name, 'Related');
		assert.equal(clears, status === 200 ? 0 : 1);
		assert.equal(requests, status === 200 ? 1 : 2);
		assert.deepEqual(h.unexpectedCalls, []);
	}
});

test('artist HTTP failures and invalid GraphQL data return an error without browser capture', async () => {
	for (const response of [
		{ ok: false, status: 503, text: async () => '' },
		...[
			{}, { errors: [{ message: 'synthetic' }], data: { artistUnion: {} } },
			{ data: { artistUnion: { uri: 'spotify:artist:other123456', profile: { name: 'Other' } } } },
			{ data: { artistUnion: { uri: 'spotify:artist:artist123456' } } }
		].map(json => ({ ok: true, status: 200, json: async () => json }))
	]) {
		const h = harness({ getSpotifyAnonymousToken: async () => 'synthetic', fetch: async () => response });
		assert.equal((await h.request({ action: 'artist', id: 'artist123456' })).statusCode, 400);
		assert.deepEqual(h.unexpectedCalls, []);
	}
});

test('empty searches, invalid identifiers, unknown actions and retired track action avoid external calls', async () => {
	const h = harness();
	for (const [body, status] of [[{ query: ' ' }, 400], [{ action: 'album', id: '../invalid' }, 400], [{ action: 'artist', id: '../invalid' }, 400], [{ action: 'unknown' }, 400], [{ action: 'track' }, 410]]) {
		assert.equal((await h.request(body)).statusCode, status);
	}
	assert.deepEqual(h.unexpectedCalls, []);
});

test('Spotify diagnostic routes remain authenticated and preserve probe status', async () => {
	const h = harness({ runSpotifyLoginSandboxProbe: async input => {
		assert.equal(input.mode, 'synthetic'); assert.equal(input.timeoutMs, 123);
		return { ok: false, stage: 'synthetic' };
	} });
	assert.equal((await h.request({}, 'get', '/spotify_login_sandbox_api/status')).body.available, true);
	const probe = await h.request({ mode: 'synthetic', timeoutMs: 123 }, 'post', '/spotify_login_sandbox_api/probe');
	assert.equal(probe.statusCode, 400);
	assert.equal(probe.body.stage, 'synthetic');
});
