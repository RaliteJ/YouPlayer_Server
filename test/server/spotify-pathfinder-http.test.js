import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { getSpotifyPathfinderJson } from '../../src/server/spotify-pathfinder-http.js';

const globalFetch = mock.method(globalThis, 'fetch', async () => { throw new Error('External calls forbidden'); });
after(() => { assert.equal(globalFetch.mock.callCount(), 0); globalFetch.mock.restore(); });
const options = { getToken: async () => 'synthetic', clearToken() {} };
const response = json => ({ ok: true, status: 200, json: async () => json });

test('HTTP fallback paginates complete albums and playlists using raw item offsets', async () => {
	for (const [key, type, contentKey] of [['albumUnion', 'album', 'tracksV2'], ['playlistV2', 'playlist', 'content']]) {
		const calls = [];
		const id = 'synthetic123456', uri = `spotify:${type}:${id}`;
		const json = await getSpotifyPathfinderJson(`${type}/${id}`, key, { ...options, pageSize: 2, completePlaylist: true,
			fetchImpl: async (url, init) => {
				assert.equal(url, 'https://api-partner.spotify.com/pathfinder/v2/query');
				assert.equal(init.method, 'POST');
				assert.equal(init.redirect, 'error');
				assert.equal(init.headers.Cookie, undefined);
				assert.ok(init.signal instanceof AbortSignal);
				const payload = JSON.parse(init.body); calls.push(payload);
				const { offset, limit } = payload.variables;
				assert.equal(payload.variables.uri, uri);
				assert.match(payload.extensions.persistedQuery.sha256Hash, /^[a-f0-9]{64}$/);
				return response({ data: { [key]: {
					...(offset === 0 ? { uri, name: 'Synthetic collection' } : {}),
					[contentKey]: { totalCount: 5, items: Array.from({ length: Math.min(limit, 5 - offset) }, (_, i) => ({ index: offset + i })) }
				} } });
			} });
		assert.deepEqual(json.data[key][contentKey].items.map(item => item.index), [0, 1, 2, 3, 4]);
		assert.deepEqual(calls.map(call => call.variables.offset), [0, 2, 4]);
		assert.deepEqual(calls.map(call => call.operationName), type === 'album'
			? ['getAlbum', 'queryAlbumTracks', 'queryAlbumTracks'] : ['fetchPlaylist', 'fetchPlaylistContents', 'fetchPlaylistContents']);
	}
});

test('playlist display fetches the first page while search preserves the requested pagination', async () => {
	const requests = [];
	const fetchImpl = async (_url, init) => {
		const payload = JSON.parse(init.body); requests.push(payload);
		return response({ data: payload.operationName === 'fetchPlaylist'
			? { playlistV2: { uri: 'spotify:playlist:list123456', name: 'Synthetic', content: { totalCount: 999, items: [] } } }
			: { searchV2: {} } });
	};
	await getSpotifyPathfinderJson('playlist/list123456', 'playlistV2', { ...options, fetchImpl });
	await getSpotifyPathfinderJson('search/A%20B', 'searchV2', { ...options, fetchImpl, offset: 15, limit: 7 });
	assert.equal(requests.length, 2);
	assert.equal(requests[1].variables.searchTerm, 'A B');
	assert.equal(requests[1].variables.offset, 15);
	assert.equal(requests[1].variables.limit, 7);
});

test('HTTP fallback refreshes only once across all collection pages, without reading error bodies', async () => {
	for (const status of [401, 403]) {
		let requests = 0, tokens = 0, clears = 0;
		await assert.rejects(getSpotifyPathfinderJson('album/album123456', 'albumUnion', {
			getToken: async () => `synthetic-${++tokens}`, clearToken: () => clears++,
			fetchImpl: async () => { requests++; return { ok: false, status, text() { throw new Error('Body must not be read'); } }; }
		}), /indisponible/);
		assert.equal(requests, 2); assert.equal(tokens, 2); assert.equal(clears, 1);
	}
});

test('a token expiring on a later page is refreshed and the same page is retried', async () => {
	const offsets = [], tokens = []; let clears = 0;
	const json = await getSpotifyPathfinderJson('album/album123456', 'albumUnion', { pageSize: 1,
		getToken: async () => clears ? 'new-synthetic' : 'old-synthetic', clearToken: () => clears++,
		fetchImpl: async (_url, init) => {
			const offset = JSON.parse(init.body).variables.offset;
			offsets.push(offset); tokens.push(init.headers.Authorization);
			if (offset === 1 && !clears) return { ok: false, status: 401 };
			return response({ data: { albumUnion: { ...(offset === 0 ? { uri: 'spotify:album:album123456', name: 'Synthetic' } : {}),
				tracksV2: { totalCount: 2, items: [{ index: offset }] } } } });
		} });
	assert.equal(json.data.albumUnion.tracksV2.items.length, 2);
	assert.deepEqual(offsets, [0, 1, 1]);
	assert.deepEqual(tokens, ['Bearer old-synthetic', 'Bearer old-synthetic', 'Bearer new-synthetic']);
	assert.equal(clears, 1);
});

test('missing, changed and oversized pages fail instead of returning a partial collection', async () => {
	for (const items of [[], [{ index: 1 }], [{ index: 1 }, { index: 2 }, { index: 3 }]]) {
		let count = 0;
		await assert.rejects(getSpotifyPathfinderJson('album/album123456', 'albumUnion', { ...options,
			fetchImpl: async () => response({ data: { albumUnion: ++count === 1
				? { uri: 'spotify:album:album123456', name: 'Synthetic', tracksV2: { totalCount: 3, items: [{ index: 0 }] } }
				: { tracksV2: { totalCount: items.length === 1 ? 4 : 3, items } } } })
		}), /incomplete/);
	}
});

test('GraphQL errors, bad identity and malformed JSON never expose their contents', async () => {
	for (const json of [{}, { errors: [{ message: 'private-synthetic' }] },
		{ data: { albumUnion: { uri: 'spotify:album:other123456', name: 'Other' } } }]) {
		await assert.rejects(getSpotifyPathfinderJson('album/album123456', 'albumUnion', { ...options, fetchImpl: async () => response(json) }),
			err => /invalide/.test(err.message) && !err.message.includes('private-synthetic'));
	}
	await assert.rejects(getSpotifyPathfinderJson('album/album123456', 'albumUnion', { ...options,
		fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('private-synthetic'); } }) }), /^Error: Reponse Spotify HTTP illisible$/);
});

test('invalid sources and unsupported operations fail before token or network calls', async () => {
	let calls = 0;
	for (const [source, key] of [['album/../invalid', 'albumUnion'], ['search/', 'searchV2'], ['search', 'unknown']]) {
		await assert.rejects(getSpotifyPathfinderJson(source, key, {
			getToken: async () => { calls++; }, fetchImpl: async () => { calls++; }
		}));
	}
	assert.equal(calls, 0);
});
