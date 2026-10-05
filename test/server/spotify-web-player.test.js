import test, { after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import {
	getSpotifyAnonymousToken, clearSpotifyAnonymousToken,
	captureSpotifyPathfinderJson, runSpotifyLoginSandboxProbe, browserLaunchOptions, spotifyLoginSandboxStatus
} from '../../src/server/spotify.js';
import { cachedSpotifyAnonymousToken } from '../../src/server/spotify-web-player.js';

const require = createRequire(new URL('../../src/package.json', import.meta.url));
const { default: puppeteer } = await import(require.resolve('puppeteer'));

const globalFetch = mock.method(globalThis, 'fetch', async () => {
	throw new Error('External calls are forbidden in browser transport tests');
});
after(() => {
	const calls = globalFetch.mock.callCount();
	globalFetch.mock.restore();
	assert.equal(calls, 0);
});

async function fakeBrowser(visit, check) {
	const previous = process.env.YOUPLAYER_SPOTIFY_BROWSER_ENABLED;
	process.env.YOUPLAYER_SPOTIFY_BROWSER_ENABLED = 'true';
	const launches = [], visits = [];
	let closed = 0;
	const page = new EventEmitter();
	page.setUserAgent = async () => {};
	page.setRequestInterception = async () => {};
	page.goto = async (url, options) => { visits.push({ url, options }); await visit(page); };
	page.url = () => visits.at(-1)?.url;
	const launch = mock.method(puppeteer, 'launch', async options => {
		launches.push(options);
		return { newPage: async () => page, close: async () => { closed++; } };
	});
	clearSpotifyAnonymousToken();
	try { await check({ launches, visits, closed: () => closed }); }
	finally {
		launch.mock.restore(); clearSpotifyAnonymousToken();
		if (previous === undefined) delete process.env.YOUPLAYER_SPOTIFY_BROWSER_ENABLED;
		else process.env.YOUPLAYER_SPOTIFY_BROWSER_ENABLED = previous;
	}
}

const emitToken = page => page.emit('request', {
	continue() {}, headers: () => ({ authorization: 'Bearer synthetic-token' })
});

test('the public token entrypoint uses HTTP and shares its cache without launching a browser', async () => {
 const requests = [];
 const transport = mock.method(globalThis, 'fetch', async (url, options) => {
  requests.push({ url, options });
  const state = { props: { pageProps: { state: { settings: { session: {
   accessToken: 'synthetic-http-token', isAnonymous: true, accessTokenExpirationTimestampMs: Date.now() + 120_000
  } } } } } };
  return { ok: true, headers: { get: () => null }, text: async () => '<script id="__NEXT_DATA__">' + JSON.stringify(state) + '</script>' };
 });
 const launch = mock.method(puppeteer, 'launch', () => { throw new Error('Unexpected browser launch'); });
 clearSpotifyAnonymousToken();
 try {
  assert.equal(await getSpotifyAnonymousToken('search'), 'synthetic-http-token');
  assert.equal(await getSpotifyAnonymousToken('search'), 'synthetic-http-token');
  assert.equal(requests.length, 1);
  clearSpotifyAnonymousToken();
  assert.equal(await getSpotifyAnonymousToken('search'), 'synthetic-http-token');
  assert.equal(requests.length, 2);
  assert.equal(launch.mock.callCount(), 0);
 } finally { transport.mock.restore(); launch.mock.restore(); clearSpotifyAnonymousToken(); }
});

test('Pathfinder capture ignores unrelated responses and shares the captured anonymous token', async () => {
	const data = { data: { playlistV2: { name: 'Synthetic', content: { items: [] } } } };
	await fakeBrowser(page => {
		emitToken(page);
		page.emit('response', { url: () => 'https://synthetic.test', json: async () => data });
		page.emit('response', { url: () => 'https://api-partner.spotify.com/pathfinder/v2/query', json: async () => ({ data: { albumUnion: {} } }) });
		page.emit('response', { url: () => 'https://api-partner.spotify.com/pathfinder/v2/query', json: async () => data });
	}, async ({ launches, closed }) => {
		assert.deepEqual(await captureSpotifyPathfinderJson('playlist/synthetic', 'playlistV2', 100), data);
		assert.equal(await getSpotifyAnonymousToken(), 'synthetic-token');
		assert.equal(launches.length, 1);
		assert.equal(closed(), 1);
	});
});

test('Pathfinder timeout closes its browser without returning partial data', async () => {
	await fakeBrowser(() => {}, async ({ closed }) => {
		await assert.rejects(captureSpotifyPathfinderJson('search', 'playlistV2', 5), /introuvable/);
		assert.equal(closed(), 1);
	});
});

test('the import cache accessor returns no token after expiry or explicit clearing', async () => {
	await fakeBrowser(page => {
		emitToken(page);
		page.emit('response', { url: () => 'https://api-partner.spotify.com/pathfinder/v2/query',
			json: async () => ({ data: { playlistV2: { name: 'Synthetic' } } }) });
	}, async () => {
		assert.equal(cachedSpotifyAnonymousToken(), '');
		await captureSpotifyPathfinderJson('search', 'playlistV2', 100);
		assert.equal(cachedSpotifyAnonymousToken(), 'synthetic-token');
		const future = Date.now() + 46 * 60 * 1000;
		const clock = mock.method(Date, 'now', () => future);
		try { assert.equal(cachedSpotifyAnonymousToken(), ''); }
		finally { clock.mock.restore(); }
		clearSpotifyAnonymousToken();
		assert.equal(cachedSpotifyAnonymousToken(), '');
	});
});

test('sandbox probe reports a token summary and preserves visible persistent browser options', async () => {
	await assert.rejects(runSpotifyLoginSandboxProbe({ mode: 'invalid' }), /inconnu/);
	await fakeBrowser(emitToken, async ({ launches, closed }) => {
		const result = await runSpotifyLoginSandboxProbe({ mode: 'manual-visible', source: 'search' });
		assert.equal(result.ok, true);
		assert.equal(result.token.captured, true);
		assert.equal(result.token.length, 'synthetic-token'.length);
		assert.equal(result.token.sha256.length, 16);
		assert.equal(cachedSpotifyAnonymousToken(), '', 'A persistent session must not populate the shared guest cache');
		assert.equal(JSON.stringify(result).includes('synthetic-token'), false);
		assert.equal(launches[0].headless, false);
		assert.equal(launches[0].userDataDir, browserLaunchOptions({ persistentProfile: true }).userDataDir);
		assert.equal(launches[0].args, undefined);
		assert.equal(closed(), 1);
	});
});

test('release disables all browser diagnostics before any launch', async () => {
	const previous = process.env.YOUPLAYER_SPOTIFY_BROWSER_ENABLED;
	process.env.YOUPLAYER_SPOTIFY_BROWSER_ENABLED = 'false';
	const launch = mock.method(puppeteer, 'launch', () => { throw new Error('Unexpected browser launch'); });
	try {
		const status = spotifyLoginSandboxStatus();
		assert.equal(status.browserEnabled, false);
		assert.match(status.disabledReason, /diagnostics Spotify.*desactives/);
		for (const mode of ['anonymous', 'credentials-headless', 'persistent-headless', 'manual-visible']) {
			const result = await runSpotifyLoginSandboxProbe({ mode });
			assert.equal(result.ok, false);
			assert.equal(result.error, status.disabledReason);
		}
		await assert.rejects(captureSpotifyPathfinderJson('search', 'playlistV2'), { message: status.disabledReason });
		assert.equal(launch.mock.callCount(), 0);
	} finally {
		launch.mock.restore();
		if (previous === undefined) delete process.env.YOUPLAYER_SPOTIFY_BROWSER_ENABLED;
		else process.env.YOUPLAYER_SPOTIFY_BROWSER_ENABLED = previous;
	}
});
