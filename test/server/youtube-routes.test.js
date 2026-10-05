import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { registerYoutubeRoutes } from '../../src/server/youtube-routes.js';

const globalFetch = mock.method(globalThis, 'fetch', async () => {
	throw new Error('External calls are forbidden in route tests');
});
after(() => {
	const calls = globalFetch.mock.callCount();
	globalFetch.mock.restore();
	assert.equal(calls, 0);
});

function harness({ apiKey = 'synthetic-key', fetchImpl } = {}) {
	let handler;
	const requireAuth = () => {};
	registerYoutubeRoutes({ post(path, guard, callback) {
		assert.equal(path, '/send_search_youtube');
		assert.equal(guard, requireAuth);
		handler = callback;
	} }, {
		requireAuth, youtubeApiKey: apiKey,
		fetchImpl: fetchImpl || (() => { throw new Error('Unexpected network call'); }),
		sendJsonError(res, error, fallback, status) {
			res.status(error.statusCode || status).json({ error: error.message || fallback });
		}
	});
	return async arg => {
		const res = {
			statusCode: 200,
			status(code) { this.statusCode = code; return this; },
			send(body) { this.body = body; return this; },
			json(body) { this.body = body; return this; }
		};
		await handler({ body: { arg } }, res);
		return res;
	};
}

test('YouTube search refuses a missing key and an empty query without network access', async () => {
	const unavailable = await harness({ apiKey: '' })('Synthetic');
	assert.equal(unavailable.statusCode, 503);
	const empty = await harness()('   ');
	assert.equal(empty.statusCode, 400);
});

test('YouTube search encodes a trimmed query and places playlists before videos', async () => {
	const requests = [];
	const video = { id: { videoId: 'synthetic01' } }, playlist = { id: { playlistId: 'PLsynthetic' } };
	const request = harness({ fetchImpl: async url => {
		requests.push(new URL(url));
		return { ok: true, json: async () => url.searchParams.get('type') === 'video'
			? { items: [video], pageInfo: { totalResults: 1 } } : { items: [playlist] } };
	} });
	const res = await request('  Artiste & titre  ');
	assert.equal(res.statusCode, 200);
	assert.deepEqual(res.body.items, [playlist, video]);
	assert.equal(res.body.pageInfo.totalResults, 1);
	assert.equal(requests.length, 2);
	assert.deepEqual(requests.map(url => url.searchParams.get('type')), ['video', 'playlist']);
	for (const url of requests) {
		assert.equal(url.origin, 'https://www.googleapis.com');
		assert.equal(url.searchParams.get('q'), 'Artiste & titre');
		assert.equal(url.searchParams.get('maxResults'), '8');
		assert.equal(url.searchParams.get('part'), 'snippet');
		assert.equal(url.searchParams.get('key'), 'synthetic-key');
	}
});

test('YouTube search rejects either failed response without returning partial results', async () => {
	for (const failedType of ['video', 'playlist']) {
		let jsonCalls = 0;
		const res = await harness({ fetchImpl: async url => ({
			ok: url.searchParams.get('type') !== failedType,
			json: async () => { jsonCalls++; return { items: [] }; }
		}) })('Synthetic');
		assert.equal(res.statusCode, 502);
		assert.equal(jsonCalls, 0);
		assert.equal(res.body.items, undefined);
	}
});

test('YouTube search handles absent items and malformed JSON through its error response', async () => {
	const empty = await harness({ fetchImpl: async () => ({ ok: true, json: async () => ({}) }) })('Synthetic');
	assert.equal(empty.statusCode, 200);
	assert.deepEqual(empty.body.items, []);
	const invalid = await harness({ fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('Synthetic JSON error'); } }) })('Synthetic');
	assert.equal(invalid.statusCode, 500);
	assert.equal(invalid.body.items, undefined);
});
