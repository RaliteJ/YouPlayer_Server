import test from 'node:test';
import assert from 'node:assert/strict';
import { getYoutubePlaylistTracks, registerImportRoutes } from '../../src/server/import-routes.js';

const video = (id, title, position = 0) => ({ snippet: {
	resourceId: { videoId: id }, title, videoOwnerChannelTitle: 'Artiste &amp; groupe',
	position, thumbnails: { high: { url: 'https://example.test/cover.jpg' } }
} });
const page = data => ({ ok: true, json: async () => data });
const track = { type: 'youtube', id: 'abcdefghijk', url: 'https://www.youtube.com/watch?v=abcdefghijk', title: 'Titre', artist: 'Artiste' };

function harness(overrides = {}) {
	const routes = new Map();
	const writes = [], actions = [];
	const guard = () => {};
	registerImportRoutes({ post(path, middleware, handler) {
		assert.equal(middleware, guard);
		routes.set(path, handler);
	} }, {
		requireAuth: guard, youtubeApiKey: 'synthetic-key',
		appendPlaylistItemsForRequest: async (_req, playlist, items) => writes.push({ playlist, items }),
		recordAction: async (...args) => actions.push(args),
		sendJsonError: (res, error, fallback, status) => res.status(error.statusCode || status || 500).json({ error: fallback }),
		importSpotifyPlaylist: async () => { throw new Error('Unexpected Spotify call'); },
		fetchImpl: async () => { throw new Error('Unexpected YouTube call'); },
		...overrides
	});
	return { writes, actions, async request(path, body) {
		const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
		await routes.get(path)({ body, session: { userId: 'synthetic-user' } }, res);
		return res;
	} };
}

test('YouTube import follows every page and preserves source metadata while skipping unavailable videos', async () => {
	const urls = [];
	const tracks = await getYoutubePlaylistTracks('synthetic-list', {
		apiKey: 'synthetic-key', fetchImpl: async url => {
			urls.push(url);
			return urls.length === 1
				? page({ items: [video('abcdefghijk', 'Titre &amp; suite'), video('xxxxxxxxxxx', 'Deleted video'), video('', 'Sans identifiant')], nextPageToken: 'page-two' })
				: page({ items: [video('lmnopqrstuv', 'Suite', 1), video('yyyyyyyyyyy', 'Private video')] });
		}
	});
	assert.equal(urls.length, 2);
	assert.equal(urls[0].searchParams.get('maxResults'), '50');
	assert.equal(urls[1].searchParams.get('pageToken'), 'page-two');
	assert.deepEqual(tracks.map(({ title, artist, id, trackNumber }) => ({ title, artist, id, trackNumber })), [
		{ title: 'Titre & suite', artist: 'Artiste & groupe', id: 'abcdefghijk', trackNumber: 0 },
		{ title: 'Suite', artist: 'Artiste & groupe', id: 'lmnopqrstuv', trackNumber: 1 }
	]);
});

test('a failed YouTube page does not persist or audit a partial import', async () => {
	let requests = 0;
	const h = harness({ fetchImpl: async () => ++requests === 1
		? page({ items: [video('abcdefghijk', 'Titre')], nextPageToken: 'next' })
		: { ok: false, status: 503 } });
	const res = await h.request('/youtube_import_playlist', { playlistId: 'synthetic-list', title: 'Test' });
	assert.equal(res.statusCode, 400);
	assert.equal(requests, 2);
	assert.deepEqual(h.writes, []);
	assert.deepEqual(h.actions, []);
});

test('missing YouTube configuration fails before making a request', async () => {
	const h = harness({ youtubeApiKey: '' });
	assert.equal((await h.request('/youtube_import_playlist', { playlistId: 'synthetic-list' })).statusCode, 503);
	assert.deepEqual(h.writes, []);
});

test('successful Spotify imports use the authenticated request and normalized target', async () => {
	const h = harness({ importSpotifyPlaylist: async url => {
		assert.equal(url, 'https://open.spotify.com/playlist/synthetic');
		return { name: 'Test', tracks: [track] };
	} });
	const res = await h.request('/spotify_import_playlist', { url: 'https://open.spotify.com/playlist/synthetic' });
	assert.equal(res.statusCode, 200);
	assert.equal(res.body.count, 1);
	assert.deepEqual(h.writes, [{ playlist: 'Test.json', items: [track] }]);
	assert.equal(h.actions[0][0].session.userId, 'synthetic-user');
});

test('browser imports validate the entire batch before writing and strip queue metadata', async () => {
	const h = harness();
	for (const items of [[], Array(51).fill(track), [track, { type: 'local', url: 'file.mp3' }]]) {
		assert.equal((await h.request('/spotify_import_browser_playlist', { items })).statusCode, 400);
	}
	assert.deepEqual(h.writes, []);
	const res = await h.request('/spotify_import_browser_playlist', { playlist: 'Test', items: [{ ...track, __queueId: 'untrusted' }] });
	assert.equal(res.statusCode, 200);
	assert.equal(h.writes[0].playlist, 'Test.json');
	assert.equal(h.writes[0].items[0].__queueId, undefined);
});
