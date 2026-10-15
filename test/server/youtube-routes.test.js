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

// SponsorBlock uses public hash buckets; no test contacts the external service.
const { createSponsorBlock, registerSponsorBlockRoutes } = await import('../../src/server/sponsorblock.js');
const { createHash } = await import('node:crypto');
const videoId = 'abcdefghijk';
const marker = (start = 1, end = 4, extra = {}) => ({ category: 'music_offtopic', actionType: 'skip', votes: 1, videoDuration: 10, segment: [start, end], ...extra });

test('SponsorBlock queries a hash prefix, filters unsafe markers and shares cached requests', async () => {
    let calls = 0;
    const lookup = createSponsorBlock({ fetchImpl: async (url, options) => {
        calls++;
        assert.equal(url.origin, 'https://sponsor.ajay.app');
        assert.equal(url.pathname, `/api/skipSegments/${createHash('sha256').update(videoId).digest('hex').slice(0, 4)}`);
        assert.equal(url.href.includes(videoId), false);
        assert.equal(url.searchParams.get('categories'), '["music_offtopic"]');
        assert.equal(options.redirect, 'error');
        assert.ok(options.signal);
        return Response.json([
            { videoID: 'otherVideo1', segments: [marker()] },
            { videoID: videoId, segments: [marker(), marker(-1, 3), marker(8, 2), marker(1, 20),
                marker(2, 4, { category: 'sponsor' }), marker(2, 4, { actionType: 'mute' }),
                marker(2, 4, { votes: -1 }), marker(2, 4, { videoDuration: 0 }), marker('1', 4), null] }
        ]);
    } });
    const [a, b] = await Promise.all([lookup(videoId), lookup(videoId)]);
    assert.deepEqual(a, { available: true, segments: [{ start: 1, end: 4, duration: 10 }] });
    assert.deepEqual(a, b);
    await lookup(videoId);
    assert.equal(calls, 1);
    assert.equal((await lookup('not-an-id')).available, false);
    assert.equal(calls, 1);
});

test('SponsorBlock caches misses and failures, expires entries and rejects oversized responses', async () => {
    for (const [response, available, ttl] of [[() => new Response(null, { status: 404 }), true, 21600000],
        [() => new Response(null, { status: 503 }), false, 60000],
        [() => new Response('x'.repeat(1000001)), false, 60000],
        [() => Response.json({ invalid: true }), false, 60000]]) {
        let time = 0, calls = 0;
        const lookup = createSponsorBlock({ now: () => time, fetchImpl: async () => { calls++; return response(); } });
        assert.deepEqual(await lookup(videoId), { available, segments: [] });
        await lookup(videoId);
        assert.equal(calls, 1);
        time = ttl + 1;
        await lookup(videoId);
        assert.equal(calls, 2);
    }
});

test('SponsorBlock route checks the session track and key before looking up public data', async () => {
    let handler, lookedUp = 0;
    const guard = () => {};
    registerSponsorBlockRoutes({ get(path, middleware, callback) {
        assert.equal(path, '/sponsorblock'); assert.equal(middleware, guard); handler = callback;
    } }, {
        requireAuth: guard,
        validateSessionTrack(req, id) {
            const track = req.session.items[id];
            if (!track) throw Object.assign(new Error('Missing'), { statusCode: 404 });
            return track;
        },
        lookup: async id => { lookedUp++; assert.equal(id, videoId); return { available: true, segments: [] }; },
        sendJsonError(res, error) { res.status(error.statusCode || 400).json({ error: error.message }); }
    });
    const request = async (query, items = [{ type: 'youtube', id: videoId }]) => {
        const res = { statusCode: 200, set() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; } };
        await handler({ query, session: { items } }, res);
        return res;
    };
    assert.equal((await request({ trackId: '../x', key: 'youtube:abcdefghijk' })).statusCode, 400);
    assert.equal((await request({ trackId: '1', key: 'youtube:abcdefghijk' })).statusCode, 404);
    assert.equal((await request({ trackId: '0', key: 'youtube:wrong' })).statusCode, 409);
    assert.equal(lookedUp, 0);
    assert.equal((await request({ trackId: '0', key: 'youtube:abcdefghijk' })).statusCode, 200);
    assert.equal(lookedUp, 1);
    await request({ trackId: '0', key: 'local:test.mp3' }, [{ type: 'local', url: 'test.mp3' }]);
    assert.equal(lookedUp, 1);
});
