import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createSpotifyAnonymousTokenProvider } from '../../src/server/spotify-anonymous-token.js';

const require = createRequire(new URL('../../src/package.json', import.meta.url));
const { default: puppeteer } = await import(require.resolve('puppeteer'));
const launch = mock.method(puppeteer, 'launch', () => { throw new Error('A guest token must not launch Chromium'); });
after(() => {
	const calls = launch.mock.callCount();
	launch.mock.restore();
	assert.equal(calls, 0);
});

const PLAYLIST = 'aaaaaaaaaaaaaaaaaaaaaa';
const TIME = 1_900_000_000_000;
function html(session = {}, attributes = 'id="__NEXT_DATA__" type="application/json"') {
	return `<script ${attributes}>${JSON.stringify({ props: { pageProps: { state: { settings: { session: {
		accessToken: 'synthetic-token', accessTokenExpirationTimestampMs: TIME + 120_000, isAnonymous: true, ...session
	} } } } } })}</script>`;
}
const response = body => ({ ok: true, headers: { get: () => null }, text: async () => body });

test('the guest token comes from a public Embed, with a bounded cookie-free HTTP request', async () => {
	const requests = [];
	const provider = createSpotifyAnonymousTokenProvider({ now: () => TIME, fetchImpl: async (url, options) => {
		requests.push({ url, options });
		return response(html({}, "type='application/json' id='__NEXT_DATA__'"));
	} });
	assert.equal(await provider.getToken(`https://open.spotify.com/playlist/${PLAYLIST}?si=ignored`), 'synthetic-token');
	assert.equal(await provider.getToken('search/public-query'), 'synthetic-token');
	assert.equal(requests.length, 1);
	assert.equal(requests[0].url, `https://open.spotify.com/embed/playlist/${PLAYLIST}`);
	assert.deepEqual(requests[0].options.headers, { Accept: 'text/html' });
	assert.equal(requests[0].options.redirect, 'error');
	assert.ok(requests[0].options.signal instanceof AbortSignal);
});

test('resource URLs stay on Spotify and search uses a fixed public bootstrap', async () => {
	const urls = [];
	const provider = createSpotifyAnonymousTokenProvider({ now: () => TIME, fetchImpl: async url => {
		urls.push(url); return response(html());
	} });
	for (const type of ['album', 'artist', 'track', 'playlist']) {
		await provider.getToken(`${type}/${PLAYLIST}`);
		assert.equal(urls.at(-1), `https://open.spotify.com/embed/${type}/${PLAYLIST}`);
		provider.clear();
	}
	await provider.getToken('search/private-query');
	assert.equal(urls.at(-1), 'https://open.spotify.com/embed/playlist/3cEYpjA9oz9GiPac4AsH4n');
	provider.clear();
	const before = urls.length;
	for (const source of ['https://other.test/playlist/' + PLAYLIST, 'http://open.spotify.com/playlist/' + PLAYLIST,
		'https://open.spotify.com.other.test/playlist/' + PLAYLIST, 'https://user:password@open.spotify.com/playlist/' + PLAYLIST]) {
		await assert.rejects(provider.getToken(source), /Source Spotify invalide/);
	}
	assert.equal(urls.length, before);
});

test('the actual expiry drives refresh, including the thirty-second safety margin', async () => {
	let time = TIME, calls = 0;
	const provider = createSpotifyAnonymousTokenProvider({ now: () => time, fetchImpl: async () => {
		calls++; return response(html({ accessToken: `synthetic-${calls}`, accessTokenExpirationTimestampMs: time + 120_000 }));
	} });
	assert.equal(await provider.getToken(), 'synthetic-1');
	provider.rememberToken('Bearer synthetic-1');
	time += 89_999;
	assert.equal(await provider.getToken(), 'synthetic-1');
	time++;
	provider.rememberToken('Bearer synthetic-1');
	assert.equal(provider.cachedToken(), '');
	assert.equal(await provider.getToken(), 'synthetic-2');
	assert.equal(calls, 2);
});

test('simultaneous requests share one HTTP operation; clearing does not restore an old pending token', async () => {
	const releases = [];
	const provider = createSpotifyAnonymousTokenProvider({ now: () => TIME, fetchImpl: () => new Promise(resolve => releases.push(resolve)) });
	const first = provider.getToken(), shared = provider.getToken();
	assert.equal(releases.length, 1);
	provider.clear();
	const newer = provider.getToken();
	assert.equal(releases.length, 2);
	releases[1](response(html({ accessToken: 'synthetic-new' })));
	assert.equal(await newer, 'synthetic-new');
	releases[0](response(html({ accessToken: 'synthetic-old' })));
	assert.equal(await first, 'synthetic-old');
	assert.equal(await shared, 'synthetic-old');
	assert.equal(provider.cachedToken(), 'synthetic-new');
});

test('failed HTTP requests release pending work and never cache a response body', async () => {
	let calls = 0;
	const provider = createSpotifyAnonymousTokenProvider({ now: () => TIME, fetchImpl: async () => ++calls === 1
		? { ok: false, status: 403, text: () => { throw new Error('Error bodies must not be read'); } } : response(html()) });
	await assert.rejects(provider.getToken(), /indisponible \(403\)/);
	assert.equal(provider.cachedToken(), '');
	assert.equal(await provider.getToken(), 'synthetic-token');
});

test('missing, malformed, authenticated, expired and unsafe tokens are rejected without exposing their contents', async () => {
	for (const body of [
		'<html>No session</html>', '<script id="__NEXT_DATA__">{"accessToken":"SENSITIVE_EXAMPLE",</script>',
		html({ isAnonymous: false }), html({ accessToken: '' }), html({ accessToken: 'SENSITIVE_EXAMPLE\r\nheader' }),
		html({ accessTokenExpirationTimestampMs: TIME + 30_000 }), html({ accessTokenExpirationTimestampMs: 'invalid' })
	]) {
		const provider = createSpotifyAnonymousTokenProvider({ now: () => TIME, fetchImpl: async () => response(body) });
		await assert.rejects(provider.getToken(), error => !error.message.includes('SENSITIVE_EXAMPLE'));
		assert.equal(provider.cachedToken(), '');
	}
});

test('network errors and oversized pages do not poison the cache', async () => {
	for (const fetchImpl of [
		async () => { throw new Error('Synthetic network failure'); },
		async () => response('x'.repeat(2 * 1024 * 1024 + 1)),
		async () => ({ ok: true, headers: { get: () => String(3 * 1024 * 1024) }, text: () => { throw new Error('Oversized response must not be read'); } })
	]) {
		const provider = createSpotifyAnonymousTokenProvider({ now: () => TIME, fetchImpl });
		await assert.rejects(provider.getToken());
		assert.equal(provider.cachedToken(), '');
	}
});
