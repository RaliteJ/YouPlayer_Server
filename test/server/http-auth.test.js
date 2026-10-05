import test, { after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { trackLikeKey } from '../../src/client-utils.js';

let app;
let tempRoot;
let downloadQueue;
let clientNumber = 0;
const originalConsole = {
	error: console.error,
	log: console.log
};
const originalFetch = globalThis.fetch;
const originalUploadMaxBytes = process.env.YOUPLAYER_UPLOAD_MAX_BYTES;
let spotifyTokenRequests = 0;
let spotifySearchRequests = 0;

function rememberCookies(response, cookieJar) {
	const rawSetCookie = response.headers.get('set-cookie');
	const setCookies = Array.isArray(rawSetCookie)
		? rawSetCookie
		: [rawSetCookie].filter(Boolean);

	for (const cookie of setCookies) {
		const pair = cookie.split(';', 1)[0];
		const [name, ...valueParts] = pair.split('=');
		if (name) {
			cookieJar.set(name, valueParts.join('='));
		}
	}
}

function bindOwnMethods(target, methodNames) {
	for (const methodName of methodNames) {
		if (typeof target[methodName] === 'function') {
			target[methodName] = target[methodName].bind(target);
		}
	}
}

function createMockRequest({ method, url, headers, body, remoteAddress }) {
	const payload = body ? Buffer.from(body) : null;
	let sent = false;
	const req = new Readable({
		read() {
			if (sent) return;
			sent = true;
			if (payload) this.push(payload);
			this.push(null);
		}
	});

	req.method = method;
	req.url = url;
	req.originalUrl = url;
	req.headers = headers;
	if (String(headers['content-type'] || '').startsWith('multipart/form-data')) req.complete = true;
	req.socket = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		}
	});
	req.socket.remoteAddress = remoteAddress;
	req.connection = req.socket;

	bindOwnMethods(req, [
		'destroy',
		'_destroy',
		'addListener',
		'emit',
		'on',
		'once',
		'pause',
		'pipe',
		'read',
		'removeListener',
		'resume',
		'setEncoding',
		'unpipe'
	]);

	return req;
}

function createMockResponse(resolve) {
	const chunks = [];
	const headers = new Map();
	let headersSent = false;

	const res = new Writable({
		write(chunk, encoding, callback) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
			callback();
		}
	});

	res.statusCode = 200;
	res.statusMessage = 'OK';
	res.locals = {};

	Object.defineProperty(res, 'headersSent', {
		get() {
			return headersSent;
		}
	});

	res.setHeader = (name, value) => {
		headers.set(String(name).toLowerCase(), value);
	};
	res.getHeader = (name) => headers.get(String(name).toLowerCase());
	res.getHeaders = () => Object.fromEntries(headers);
	res.hasHeader = (name) => headers.has(String(name).toLowerCase());
	res.removeHeader = (name) => headers.delete(String(name).toLowerCase());
	res.writeHead = (statusCode, statusMessage, headerValues) => {
		res.statusCode = statusCode;
		if (typeof statusMessage === 'string') {
			res.statusMessage = statusMessage;
		} else if (statusMessage && typeof statusMessage === 'object') {
			headerValues = statusMessage;
		}
		if (headerValues) {
			for (const [name, value] of Object.entries(headerValues)) {
				res.setHeader(name, value);
			}
		}
		headersSent = true;
		return res;
	};
	res.write = (chunk, encoding, callback) => {
		if (chunk) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
		}
		if (typeof callback === 'function') callback();
		return true;
	};
	res.end = (chunk, encoding, callback) => {
		if (chunk) {
			chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
		}
		headersSent = true;
		if (typeof callback === 'function') callback();
		resolve({
			bodyBuffer: Buffer.concat(chunks),
			headers,
			status: res.statusCode,
			statusMessage: res.statusMessage
		});
		return res;
	};

	bindOwnMethods(res, [
		'addListener',
		'cork',
		'emit',
		'on',
		'once',
		'removeListener',
		'uncork'
	]);

	return res;
}

async function dispatchRequest({ method = 'GET', url, headers = {}, body = null, remoteAddress }) {
	return new Promise((resolve, reject) => {
		const req = createMockRequest({ method, url, headers, body, remoteAddress });
		const res = createMockResponse(resolve);
		const timeout = setTimeout(() => {
			reject(new Error(`Request timed out: ${method} ${url}`));
		}, 2000);

		const resolveOnce = (value) => {
			clearTimeout(timeout);
			resolve(value);
		};
		res.end = ((end) => function wrappedEnd(...args) {
			clearTimeout(timeout);
			return end.apply(this, args);
		})(res.end);

		try {
			app.handle(req, res, (err) => {
				if (err) {
					clearTimeout(timeout);
					reject(err);
					return;
				}
				resolveOnce({
					bodyBuffer: Buffer.alloc(0),
					headers: new Map(),
					status: 404,
					statusMessage: 'Not Found'
				});
			});
		} catch (err) {
			clearTimeout(timeout);
			reject(err);
		}
	});
}

function createClient() {
	const cookieJar = new Map();
	const remoteAddress = `127.0.0.${++clientNumber}`;

	return {
		sessionId() {
			return decodeURIComponent(cookieJar.get('connect.sid')).slice(2).split('.')[0];
		},
		async request(urlPath, options = {}) {
			const headers = Object.fromEntries(Object.entries(options.headers || {})
				.map(([name, value]) => [name.toLowerCase(), value]));
			const method = options.method || 'GET';
			if (!headers.host) {
				headers.host = 'localhost';
			}
			let requestBody = options.body || null;
			if (requestBody && typeof requestBody !== 'string') {
				requestBody = JSON.stringify(requestBody);
			}
			if (requestBody && !headers['content-type']) {
				headers['content-type'] = 'application/json';
			}
			if (requestBody && !headers['content-length']) {
				headers['content-length'] = Buffer.byteLength(requestBody);
			}
			if (cookieJar.size > 0) {
				headers.cookie = Array.from(cookieJar, ([name, value]) => `${name}=${value}`).join('; ');
			}
			if (!options.skipOrigin && !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) && !headers.origin) {
				headers.origin = `http://${headers.host}`;
			}

			const response = await dispatchRequest({
				remoteAddress,
				method,
				url: urlPath,
				headers,
				body: requestBody
			});
			rememberCookies(response, cookieJar);

			const text = response.bodyBuffer.toString('utf8');
			let responseBody = text;
			try {
				responseBody = text ? JSON.parse(text) : null;
			} catch {
				// Keep plain text bodies as-is.
			}

			return {
				body: responseBody,
				headers: response.headers,
				status: response.status,
				text
			};
		}
	};
}

async function login(client, pseudo = 'user', password = 'password123') {
	const response = await client.request('/auth/login', {
		method: 'POST',
		body: {
			pseudo,
			password
		}
	});

	assert.equal(response.status, 200);
	return response.body.user;
}

before(async () => {
	process.env.NODE_ENV = 'test';
	console.error = () => {};
	console.log = () => {};
	tempRoot = await mkdtemp(path.join(os.tmpdir(), 'youplayer-auth-'));
	process.env.YOUPLAYER_MUSIQ_DIR = path.join(tempRoot, 'musiq');
	process.env.YOUPLAYER_LOCAL_SONG_DIR = path.join(tempRoot, 'local_song');
	process.env.YOUPLAYER_REQUIRE_ORIGIN = 'true';
	process.env.YOUPLAYER_UPLOAD_MAX_BYTES = '1024';
	delete process.env.YOUPLAYER_YOUTUBE_API_KEY;
	delete process.env.YOUTUBE_API_KEY;
	process.env.YOUPLAYER_SPOTIFY_CLIENT_ID = 'test-client-id';
	process.env.YOUPLAYER_SPOTIFY_CLIENT_SECRET = 'test-client-secret';
	process.env.YOUPLAYER_SPOTIFY_REDIRECT_URI = 'https://localhost/auth/spotify/callback';
	process.env.YOUPLAYER_SPOTIFY_TOKEN_SECRET = 'test-spotify-token-secret';
	globalThis.fetch = async (url) => {
		const target = String(url);
		if (target === 'https://accounts.spotify.com/api/token') {
			spotifyTokenRequests += 1;
			return {
				ok: true,
				status: 200,
				json: async () => ({
					access_token: `spotify-access-${spotifyTokenRequests}`,
					refresh_token: 'spotify-refresh',
					expires_in: 3600,
					scope: 'user-read-private playlist-read-private playlist-read-collaborative'
				})
			};
		}
		if (target === 'https://api.spotify.com/v1/me') {
			return {
				ok: true,
				status: 200,
				json: async () => ({ account_id: 'spotify-stable-account', display_name: 'Spotify Test' })
			};
		}
		if (target.startsWith('https://api.spotify.com/v1/search?')) {
			spotifySearchRequests += 1;
			return {
				ok: true,
				status: 200,
				json: async () => ({
					tracks: { items: [{ id: 'oauth-track', name: 'OAuth Track', artists: [], album: {} }], total: 1 },
					playlists: { items: [], total: 0 },
					albums: { items: [], total: 0 },
					artists: { items: [], total: 0 }
				})
			};
		}
		throw new Error(`Unexpected external request: ${target}`);
	};

	({ app } = await import('../../src/server/server.js'));
	({ downloadQueue } = await import('../../src/server/download-queue.js'));
	// HTTP tests use synthetic cache files; never start real media downloads.
	mock.method(downloadQueue, 'enqueue', async () => {});
});

after(async () => {
	mock.restoreAll();
	console.error = originalConsole.error;
	console.log = originalConsole.log;
	globalThis.fetch = originalFetch;
	await rm(tempRoot, { recursive: true, force: true });
	delete process.env.YOUPLAYER_MUSIQ_DIR;
	delete process.env.YOUPLAYER_LOCAL_SONG_DIR;
	delete process.env.YOUPLAYER_REQUIRE_ORIGIN;
	if (originalUploadMaxBytes === undefined) delete process.env.YOUPLAYER_UPLOAD_MAX_BYTES;
	else process.env.YOUPLAYER_UPLOAD_MAX_BYTES = originalUploadMaxBytes;
	delete process.env.YOUPLAYER_YOUTUBE_API_KEY;
	delete process.env.YOUTUBE_API_KEY;
	delete process.env.YOUPLAYER_SPOTIFY_CLIENT_ID;
	delete process.env.YOUPLAYER_SPOTIFY_CLIENT_SECRET;
	delete process.env.YOUPLAYER_SPOTIFY_REDIRECT_URI;
	delete process.env.YOUPLAYER_SPOTIFY_TOKEN_SECRET;
});

test('strict origin mode rejects mutating requests without Origin or Referer', async () => {
	const client = createClient();
	const response = await client.request('/auth/login', {
		method: 'POST',
		skipOrigin: true,
		body: {
			pseudo: 'user',
			password: 'password123'
		}
	});

	assert.equal(response.status, 403);
	assert.deepEqual(response.body, { error: 'Origine non autorisee' });
});

test('library preferences require auth, origin and playlist ownership and stay isolated', async () => {
	const anonymous = createClient();
	assert.equal((await anonymous.request('/playlist_preferences')).status, 401);
	assert.equal((await anonymous.request('/playlist_preferences', { method: 'POST', body: { action: 'clear_recent' } })).status, 401);
	const first = createClient();
	const second = createClient();
	const user = await login(first);
	await login(second, 'second');
	await app.locals.youplayerStore.appendPlaylistItems(user.id, 'synthetic-library', [{ title: 'Synthetic' }]);
	const change = { action: 'pin', playlist: 'synthetic-library.json', enabled: true };
	assert.equal((await first.request('/playlist_preferences', { method: 'POST', skipOrigin: true, body: change })).status, 403);
	assert.equal((await second.request('/playlist_preferences', { method: 'POST', body: change })).status, 404);
	assert.equal((await first.request('/playlist_preferences', { method: 'POST', body: { ...change, action: 'unknown' } })).status, 400);
	assert.equal((await first.request('/playlist_preferences', { method: 'POST', body: change })).status, 200);
	assert.equal((await first.request('/playlist_preferences', { method: 'POST', body: { action: 'visit', playlist: change.playlist } })).status, 200);
	const saved = await first.request('/playlist_preferences');
	assert.deepEqual(saved.body, { pinned: [change.playlist], recent: [change.playlist] });
	assert.deepEqual((await second.request('/playlist_preferences')).body, { pinned: [], recent: [] });
	await first.request('/playlist_preferences', { method: 'POST', body: { action: 'clear_recent' } });
	assert.deepEqual((await first.request('/playlist_preferences')).body.recent, []);
	await app.locals.youplayerStore.deletePlaylist(user.id, change.playlist);
	assert.deepEqual((await first.request('/playlist_preferences')).body, { pinned: [], recent: [] });
});

test('POST /auth/login authenticates a user and stores user_id plus role in the session', async () => {
	const client = createClient();
	const loginResponse = await client.request('/auth/login', {
		method: 'POST',
		body: {
			pseudo: 'user',
			password: 'password123'
		}
	});
	const me = await client.request('/auth/me');

	assert.equal(loginResponse.status, 200);
	assert.equal(loginResponse.body.user.pseudo, 'user');
	assert.equal(loginResponse.body.user.role, 'user');
	assert.equal(me.status, 200);
	assert.equal(me.body.user.pseudo, 'user');
});

test('GET /auth/providers reports configured minimal Spotify scopes without requiring a session', async () => {
	const client = createClient();
	const response = await client.request('/auth/providers');

	assert.equal(response.status, 200);
	assert.equal(response.body.authEnabled, true);
	assert.equal(response.body.spotify.enabled, true);
	assert.ok(response.body.spotify.scopes.includes('playlist-read-private'));
	assert.equal(response.body.spotify.scopes.includes('user-read-email'), false);
});

test('GET /auth/spotify/start requires a logged-in account', async () => {
	const client = createClient();
	const response = await client.request('/auth/spotify/start');

	assert.equal(response.status, 401);
	assert.equal(response.body.error, 'Authentification requise');
});

test('Spotify OAuth binds one stable account with PKCE and rejects callback replay or duplicate linking', async () => {
	const client = createClient();
	await login(client, 'user');
	const start = await client.request('/auth/spotify/start');
	assert.equal(start.status, 302);
	const authorization = new URL(start.headers.get('location'));
	assert.equal(authorization.hostname, 'accounts.spotify.com');
	assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
	assert.ok(authorization.searchParams.get('code_challenge'));
	assert.equal(authorization.searchParams.has('code_verifier'), false);
	const state = authorization.searchParams.get('state');

	const callback = await client.request(`/auth/spotify/callback?code=test-code&state=${encodeURIComponent(state)}`);
	assert.equal(callback.status, 302);
	assert.match(callback.headers.get('location'), /spotify_connected=1/);
	const me = await client.request('/auth/me');
	assert.equal(me.body.user.spotify.connected, true);
	assert.equal(me.body.user.spotify.displayName, 'Spotify Test');
	assert.equal(me.text.includes('spotify-stable-account'), false);
	assert.equal(me.text.includes('spotify-access'), false);
	const search = await client.request('/spotify_test', {
		method: 'POST',
		body: { action: 'search', query: 'OAuth Track', limit: 16 }
	});
	assert.equal(search.status, 200);
	assert.equal(search.body.data.tracks.items[0].id, 'oauth-track');
	assert.equal(spotifySearchRequests, 1);

	const tokenRequestsAfterSuccess = spotifyTokenRequests;
	const replay = await client.request(`/auth/spotify/callback?code=replayed&state=${encodeURIComponent(state)}`);
	assert.match(replay.headers.get('location'), /spotify_error=state/);
	assert.equal(spotifyTokenRequests, tokenRequestsAfterSuccess);

	const otherClient = createClient();
	await login(otherClient, 'second');
	const otherStart = await otherClient.request('/auth/spotify/start');
	const otherState = new URL(otherStart.headers.get('location')).searchParams.get('state');
	const duplicate = await otherClient.request(`/auth/spotify/callback?code=other-code&state=${encodeURIComponent(otherState)}`);
	assert.match(duplicate.headers.get('location'), /spotify_error=callback/);
	const otherMe = await otherClient.request('/auth/me');
	assert.equal(otherMe.body.user.spotify.connected, false);

	const disconnected = await client.request('/auth/spotify/disconnect', { method: 'POST', body: {} });
	assert.equal(disconnected.status, 200);
	assert.equal(disconnected.body.user.spotify.connected, false);
});

test('POST /auth/logout destroys the current session and clears the session cookie', async () => {
	const client = createClient();
	await login(client);

	const logout = await client.request('/auth/logout', { method: 'POST' });
	const me = await client.request('/auth/me');

	assert.equal(logout.status, 200);
	assert.equal(me.status, 401);
});

test('the first remote track gets a private stream and the next track returns to normal playback', async () => {
	const clientA = createClient();
	const clientASameAccount = createClient();
	const clientB = createClient();
	await login(clientA, 'user');
	await login(clientASameAccount, 'user');
	await login(clientB, 'second');
	const playlist = 'first-special-stream.json';

	await clientA.request('/update_playlist', {
		method: 'POST',
		body: {
			arg: {
				playlist,
				song: {
					type: 'youtube',
					title: 'Premier titre distant',
					url: 'https://www.youtube.com/watch?v=first-track-test'
				}
			}
		}
	});
	await writeFile(path.join(tempRoot, 'local_song', 'third-track.mp3'), 'audio', 'utf8');
	await clientA.request('/update_playlist', {
		method: 'POST',
		body: {
			arg: {
				playlist,
				song: {
					type: 'local',
					title: 'Troisième titre normal',
					url: 'third-track.mp3'
				}
			}
		}
	});
	await writeFile(path.join(tempRoot, 'local_song', 'second-track.mp3'), 'audio', 'utf8');
	await clientA.request('/update_playlist', {
		method: 'POST',
		body: {
			arg: {
				playlist,
				song: {
					type: 'local',
					title: 'Deuxième titre normal',
					url: 'second-track.mp3'
				}
			}
		}
	});
	await clientA.request('/playlist_used', {
		method: 'POST',
		body: { arg: [playlist], random: false }
	});
	const pending = await clientA.request('/playback_state');
	assert.equal(pending.body.first_track_special_pending, true);
	const blockedLegacyPreload = await clientA.request('/play_status/0');
	assert.equal(blockedLegacyPreload.status, 409);
	assert.equal(blockedLegacyPreload.body.status, 'special_stream');

	const downloadsBefore = downloadQueue.enqueue.mock.calls.length;
	const first = await clientA.request('/next_song');
	assert.equal(first.status, 200);
	assert.equal(first.body.mode, 'special_stream');
	assert.match(first.body.stream_id, /^[0-9a-f-]{36}$/);
	assert.equal(first.body.audio_url, `/audio/${first.body.stream_id}`);
	assert.equal(first.body.currentId, 0);
	assert.equal(downloadQueue.enqueue.mock.calls.length, downloadsBefore + 1, 'first private stream also starts its cache download');

	const ownerStatus = await clientA.request(`/audio/${first.body.stream_id}/status`);
	const otherSessionStatus = await clientASameAccount.request(`/audio/${first.body.stream_id}/status`);
	const otherUserStatus = await clientB.request(`/audio/${first.body.stream_id}/status`);
	const otherUserAudio = await clientB.request(`/audio/${first.body.stream_id}`);
	const otherUserStop = await clientB.request(`/audio/${first.body.stream_id}/stop`, {
		method: 'POST',
		body: { reason: 'stop' }
	});
	assert.deepEqual(ownerStatus.body, { state: 'starting' });
	assert.equal(otherSessionStatus.status, 403);
	assert.equal(otherUserStatus.status, 403);
	assert.equal(otherUserAudio.status, 403);
	assert.equal(otherUserStop.status, 403);
	assert.equal(app.locals.firstTrackStreams.getStream(first.body.stream_id)?.state, 'starting');

	const transition = {
		transitionId: 'locked-phone-transition-1',
		previousTrackId: 0,
		expectedTrackId: 1
	};
	const second = await clientA.request('/prefetched_next', {
		method: 'POST',
		body: transition
	});
	assert.equal(second.status, 200, JSON.stringify(second.body));
	assert.equal(second.body.mode, 'normal');
	assert.equal(second.body.currentId, 1);
	const retry = await clientA.request('/prefetched_next', {
		method: 'POST',
		body: transition
	});
	assert.equal(retry.status, 200);
	assert.equal(retry.body.currentId, 1);
	assert.deepEqual(retry.body.queue, second.body.queue);
	const third = await clientA.request('/prefetched_next', {
		method: 'POST',
		body: {
			transitionId: 'locked-phone-transition-2',
			previousTrackId: 1,
			expectedTrackId: 2
		}
	});
	assert.equal(third.status, 200);
	assert.equal(third.body.currentId, 2);
	const delayedFirstRetry = await clientA.request('/prefetched_next', {
		method: 'POST',
		body: transition
	});
	assert.equal(delayedFirstRetry.status, 200);
	assert.equal(delayedFirstRetry.body.currentId, 2);
	const invalidated = await clientA.request(`/audio/${first.body.stream_id}/status`);
	assert.equal(invalidated.status, 404);

	await clientA.request('/playlist_used', {
		method: 'POST',
		body: { arg: [playlist], random: false }
	});
	const replacement = await clientA.request('/next_song');
	assert.equal(replacement.body.mode, 'special_stream');
	await clientA.request('/auth/logout', { method: 'POST' });
	assert.equal(app.locals.firstTrackStreams.getStream(replacement.body.stream_id), null);
});

test('previous history survives prefetched retries and enqueue-next leaves current playback unchanged', async () => {
	const client = createClient();
	await login(client);
	const playlist = 'previous-and-enqueue.json';
	for (let i = 0; i < 3; i++) {
		const url = `previous-${i}.mp3`;
		await writeFile(path.join(tempRoot, 'local_song', url), 'audio');
		assert.equal((await client.request('/update_playlist', {
			method: 'POST', body: { arg: { playlist, song: { type: 'local', title: `Fixture ${i}`, url } } }
		})).status, 200);
	}
	await client.request('/playlist_used', { method: 'POST', body: { arg: [playlist], random: false } });
	const first = await client.request('/next_song');
	assert.equal(first.body.currentId, 0);
	assert.equal((await client.request('/previous_song', { method: 'POST' })).status, 409);
	assert.equal((await client.request('/playback_state')).body.currentId, 0);
	const transition = { transitionId: 'history-prefetch-1', previousTrackId: 0, expectedTrackId: 1 };
	for (let i = 0; i < 2; i++) {
		const response = await client.request('/prefetched_next', { method: 'POST', body: transition });
		assert.equal(response.status, 200);
		assert.equal(response.body.previousId, 0);
	}
	const queued = await client.request('/add_song_ecoute', { method: 'POST', body: { arg: 2 } });
	assert.equal(queued.body.queue[0].__sessionIndex, 2);
	assert.equal((await client.request('/playback_state')).body.currentId, 1);
	const previous = await client.request('/previous_song', { method: 'POST' });
	assert.equal(previous.status, 200);
	assert.equal(previous.body.currentId, 0);
	assert.equal(previous.body.previousId, null, 'prefetch retry must not duplicate history');
	assert.equal(previous.body.queue[0].__sessionIndex, 1, 'return to the song we left next');
	assert.equal((await client.request('/next_song')).body.currentId, 1);
	assert.equal((await client.request('/next_song')).body.currentId, 2);
	assert.equal((await client.request('/previous_song', { method: 'POST' })).body.currentId, 1);
	assert.equal((await client.request('/previous_song', { method: 'POST' })).body.currentId, 0);
	await client.request('/playlist_used', { method: 'POST', body: { arg: [playlist], random: false } });
	assert.equal((await client.request('/playback_state')).body.previousId, null);
	const other = createClient();
	assert.equal((await other.request('/previous_song', { method: 'POST' })).status, 401);
	await login(other, 'second');
	assert.equal((await other.request('/previous_song', { method: 'POST' })).status, 409);
});

test('YouTube queue works without a playlist, preserves metadata and isolates sessions', async () => {
	const client = createClient();
	const stranger = createClient();
	const song = { type: 'youtube', title: 'Source title', channelTitle: 'Source channel',
		url: 'https://www.youtube.com/watch?v=queue-test-1', thumbnail: 'https://example.test/cover.jpg',
		__queueId: '../../untrusted', __playlist: 'untrusted.json', __playlistIndex: 0 };
	assert.equal((await stranger.request('/add_song_ecoute', { method: 'POST', body: { song } })).status, 401);
	await login(client);
	const playlists = (await client.request('/different_playlist')).body;
	for (const invalid of [null, [], { type: 'local', url: 'test.mp3' }, { url: 'https://example.test/audio' },
		{ type: 'spotify', url: 'https://open.spotify.com/track/abc' }]) {
		assert.equal((await client.request('/add_song_ecoute', { method: 'POST', body: { song: invalid } })).status, 400);
	}
	const added = await client.request('/add_song_ecoute', { method: 'POST', body: { song } });
	assert.equal(added.status, 200);
	assert.equal(added.body.currentId, null);
	const track = added.body.queue[0];
	assert.equal(track.title, song.title);
	assert.equal(track.artist, song.channelTitle);
	assert.equal(track.thumbnail, song.thumbnail);
	assert.match(track.__queueId, /^[a-f0-9-]{36}$/);
	assert.equal(track.__playlist, undefined);
	assert.equal((await client.request('/playlist')).body.length, 1);
	assert.equal((await client.request('/random', { method: 'POST', body: { enabled: true } })).status, 200);
	assert.equal((await client.request('/playback_state')).body.queue[0].__queueId, track.__queueId);
	const first = await client.request('/next_song?reason=select');
	assert.equal(first.body.mode, 'special_stream');
	assert.equal(first.body.currentId, 0);
	await login(stranger);
	assert.equal((await stranger.request(`/audio/${first.body.stream_id}/status`)).status, 403);
	assert.equal((await stranger.request('/playback_state')).body.currentId, null);
	const secondSong = { ...song, url: 'https://www.youtube.com/watch?v=queue-test-2' };
	const queued = await client.request('/add_song_ecoute', { method: 'POST', body: { song: secondSong } });
	assert.equal(queued.body.currentId, 0, 'enqueue must keep playing the first track');
	assert.equal(queued.body.queue[0].__sessionIndex, 1);
	await writeFile(path.join(tempRoot, 'musiq', client.sessionId(), `queue-${queued.body.queue[0].__queueId}.mp3`), 'second fixture');
	const transition = { transitionId: 'youtube-temporary-next', previousTrackId: 0, expectedTrackId: 1 };
	for (let i = 0; i < 2; i++) {
		assert.equal((await client.request('/prefetched_next', { method: 'POST', body: transition })).body.currentId, 1);
	}
	const previous = await client.request('/previous_song', { method: 'POST' });
	assert.equal(previous.body.currentId, 0);
	assert.equal(previous.body.previousId, null);
	const repeated = await client.request('/add_song_ecoute', { method: 'POST', body: { song } });
	assert.equal(repeated.body.queue[0].__queueId, track.__queueId);
	assert.equal((await client.request('/playlist')).body.length, 2);
	assert.deepEqual((await client.request('/different_playlist')).body, playlists, 'temporary playback must not create a playlist');
	await client.request('/auth/logout', { method: 'POST' });
});

test('temporary YouTube cache follows its track when an active playlist grows or shrinks', async () => {
	const client = createClient();
	await login(client);
	const playlist = 'youtube-cache-remap.json';
	await writeFile(path.join(tempRoot, 'local_song', 'youtube-local.mp3'), 'local fixture');
	const local = { type: 'local', title: 'Local fixture', url: 'youtube-local.mp3' };
	const append = song => client.request('/update_playlist', { method: 'POST', body: { arg: { playlist, song } } });
	await append(local);
	await client.request('/playlist_used', { method: 'POST', body: { arg: [playlist], random: false } });
	assert.equal((await client.request('/next_song')).body.currentId, 0);
	const song = { type: 'youtube', title: 'Temporary fixture', url: 'https://www.youtube.com/watch?v=temp-cache-1' };
	const added = await client.request('/add_song_ecoute', { method: 'POST', body: { song } });
	assert.equal(added.body.currentId, 0);
	assert.equal(added.body.queue[0].__sessionIndex, 1);
	const cacheDir = path.join(tempRoot, 'musiq', client.sessionId());
	const file = `queue-${added.body.queue[0].__queueId}.mp3`;
	await writeFile(path.join(cacheDir, file), 'temporary audio fixture');
	await append(local);
	const refreshed = await client.request('/playlist');
	assert.equal(refreshed.body[2].__queueId, added.body.queue[0].__queueId);
	assert.equal((await client.request('/play_status/2')).body.status, 'ready');
	const selected = await client.request('/next_song?reason=select');
	assert.equal(selected.body.currentId, 2);
	assert.equal(selected.body.mode, 'normal');
	await client.request('/delete_from_playlist', { method: 'POST', body: { playlist, index: 0 } });
	assert.equal((await client.request('/playback_state')).body.currentId, 1);
	assert.equal((await client.request('/play_status/1')).body.status, 'ready');
	assert.ok((await readdir(cacheDir)).includes(file));
});

test('three previous downloaded tracks remain ready while older cache files are evicted', async () => {
	const client = createClient();
	await login(client);
	const playlist = 'recent-cache.json';
	await writeFile(path.join(tempRoot, 'local_song', 'cache-start.mp3'), 'local fixture');
	for (let id = 0; id < 7; id++) {
		const song = id === 0
			? { type: 'local', title: 'Local start', url: 'cache-start.mp3' }
			: { type: 'youtube', title: `Cached ${id}`, url: `https://www.youtube.com/watch?v=cache-fixture-${id}` };
		await client.request('/update_playlist', { method: 'POST', body: { arg: { playlist, song } } });
	}
	await client.request('/playlist_used', { method: 'POST', body: { arg: [playlist], random: false } });
	const cacheDir = path.join(tempRoot, 'musiq', client.sessionId());
	for (let id = 1; id < 7; id++) await writeFile(path.join(cacheDir, `${id}.mp3`), `fixture ${id}`);
	assert.equal((await client.request('/next_song')).body.currentId, 0);
	for (let id = 1; id <= 5; id++) {
		const response = id % 2 === 0
			? await client.request('/prefetched_next', { method: 'POST', body: {
				transitionId: `cache-prefetch-${id}`, previousTrackId: id - 1, expectedTrackId: id
			} })
			: await client.request('/next_song');
		assert.equal(response.status, 200);
		assert.equal(response.body.currentId, id);
	}
	assert.deepEqual((await readdir(cacheDir)).sort(), ['2.mp3', '3.mp3', '4.mp3', '5.mp3', '6.mp3']);
	for (const id of [4, 3, 2]) {
		const response = await client.request('/previous_song', { method: 'POST' });
		assert.equal(response.body.mode, 'normal', 'cached history must not create a new live stream');
		assert.equal(response.body.currentId, id);
		assert.equal((await client.request(`/play_status/${id}`)).body.status, 'ready');
	}
	assert.deepEqual((await readdir(cacheDir)).sort(), ['2.mp3', '3.mp3', '4.mp3', '5.mp3', '6.mp3']);
	await client.request('/playlist_used', { method: 'POST', body: { arg: [playlist], random: false } });
	assert.deepEqual(await readdir(cacheDir), []);
});

test('a later remote track streams while its download continues in the background', async () => {
	const client = createClient();
	await login(client, 'user');
	const playlist = 'later-remote-stream.json';

	await writeFile(path.join(tempRoot, 'local_song', 'local-first.mp3'), 'audio', 'utf8');
	await client.request('/update_playlist', {
		method: 'POST',
		body: {
			arg: {
				playlist,
				song: {
					type: 'local',
					title: 'Premier titre local',
					url: 'local-first.mp3'
				}
			}
		}
	});
	await client.request('/update_playlist', {
		method: 'POST',
		body: {
			arg: {
				playlist,
				song: {
					type: 'youtube',
					title: 'Titre distant suivant',
					url: 'https://www.youtube.com/watch?v=later-remote-test'
				}
			}
		}
	});
	await client.request('/playlist_used', {
		method: 'POST',
		body: { arg: [playlist], random: false }
	});

	const first = await client.request('/next_song');
	assert.equal(first.status, 200);
	assert.equal(first.body.mode, 'normal');
	assert.equal(first.body.currentId, 0);

	const second = await client.request('/next_song');
	assert.equal(second.status, 200);
	assert.equal(second.body.mode, 'special_stream');
	assert.equal(second.body.currentId, 1);
	assert.equal(second.body.first_track_next_enabled, true);
	assert.match(second.body.audio_url, /^\/audio\/[0-9a-f-]{36}$/);
	assert.equal(app.locals.firstTrackStreams.getStream(second.body.stream_id)?.state, 'starting');
	const previous = await client.request('/previous_song', { method: 'POST' });
	assert.equal(previous.status, 200);
	assert.equal(previous.body.currentId, 0);
	assert.equal(previous.body.mode, 'normal');
	assert.equal(previous.body.queue[0].__sessionIndex, 1);
	assert.equal(app.locals.firstTrackStreams.getStream(second.body.stream_id), null);
});

test('GET /auth/me returns the connected user without exposing password_hash or secrets', async () => {
	const client = createClient();
	await login(client);

	const response = await client.request('/auth/me');

	assert.equal(response.status, 200);
	assert.equal(response.body.user.pseudo, 'user');
	assert.equal(response.body.user.passwordHash, undefined);
	assert.equal(response.body.user.password_hash, undefined);
});

test('POST /auth/password lets a user change their own password', async () => {
	const anonymous = createClient();
	const unauthorized = await anonymous.request('/auth/password', {
		method: 'POST',
		body: {
			currentPassword: 'password123',
			newPassword: 'newpass123'
		}
	});
	assert.equal(unauthorized.status, 401);

	const client = createClient();
	await login(client, 'second');

	const wrongCurrent = await client.request('/auth/password', {
		method: 'POST',
		body: {
			currentPassword: 'wrongpass',
			newPassword: 'newpass123'
		}
	});
	assert.equal(wrongCurrent.status, 400);

	const changed = await client.request('/auth/password', {
		method: 'POST',
		body: {
			currentPassword: 'password123',
			newPassword: 'newpass123'
		}
	});
	assert.equal(changed.status, 200);
	assert.equal(changed.body.user.pseudo, 'second');
	assert.equal(changed.body.user.passwordHash, undefined);

	const oldPasswordClient = createClient();
	const oldPasswordLogin = await oldPasswordClient.request('/auth/login', {
		method: 'POST',
		body: {
			pseudo: 'second',
			password: 'password123'
		}
	});
	assert.equal(oldPasswordLogin.status, 401);

	const newPasswordClient = createClient();
	await login(newPasswordClient, 'second', 'newpass123');

	const restored = await newPasswordClient.request('/auth/password', {
		method: 'POST',
		body: {
			currentPassword: 'newpass123',
			newPassword: 'password123'
		}
	});
	assert.equal(restored.status, 200);
});

test('playlist routes reject unauthenticated requests after auth is enabled', async () => {
	const client = createClient();
	const list = await client.request('/playlist_summaries');
	const preview = await client.request('/playlist_preview?playlist=anything.json');
	const selection = await client.request('/playlist_used', {
		method: 'POST',
		body: {
			arg: ['anything.json']
		}
	});

	assert.equal(list.status, 401);
	assert.equal(preview.status, 401);
	assert.equal(selection.status, 401);
});

test('users can create playlists with the same name as other users without sharing contents', async () => {
	const clientA = createClient();
	const clientB = createClient();
	await login(clientA, 'user');
	await login(clientB, 'second');

	const seededSummaries = await clientA.request('/playlist_summaries');
	const seededPlaylist = seededSummaries.body.find((playlist) => playlist.count > 0)?.name;
	assert.ok(seededPlaylist);
	await writeFile(path.join(tempRoot, 'local_song', 'a.mp3'), 'audio-a', 'utf8');
	await writeFile(path.join(tempRoot, 'local_song', 'b.mp3'), 'audio-b', 'utf8');

	const forbiddenPreview = await clientB.request(`/playlist_preview?playlist=${encodeURIComponent(seededPlaylist)}`);
	assert.equal(forbiddenPreview.status, 404);

	await clientA.request('/update_playlist', {
		method: 'POST',
		body: {
			arg: {
				playlist: 'shared.json',
				song: {
					type: 'local',
					title: 'Song from A',
					url: 'a.mp3'
				}
			}
		}
	});
	await clientB.request('/update_playlist', {
		method: 'POST',
		body: {
			arg: {
				playlist: 'shared.json',
				song: {
					type: 'local',
					title: 'Song from B',
					url: 'b.mp3'
				}
			}
		}
	});

	await clientA.request('/playlist_used', {
		method: 'POST',
		body: {
			arg: ['shared.json'],
			random: false
		}
	});
	await clientB.request('/playlist_used', {
		method: 'POST',
		body: {
			arg: ['shared.json'],
			random: false
		}
	});

	const playlistA = await clientA.request('/playlist');
	const playlistB = await clientB.request('/playlist');

	assert.equal(playlistA.status, 200);
	assert.equal(playlistB.status, 200);
	assert.deepEqual(playlistA.body.map((song) => song.title), ['Song from A']);
	assert.deepEqual(playlistB.body.map((song) => song.title), ['Song from B']);
});

test('admin-only routes expose users, login events and audit logs only to role=admin', async () => {
	const userClient = createClient();
	const adminClient = createClient();
	await login(userClient);
	await login(adminClient, 'admin');

	const denied = await userClient.request('/admin/users');
	const users = await adminClient.request('/admin/users');
	const events = await adminClient.request('/admin/login_events');
	const logs = await adminClient.request('/admin/audit_logs');

	assert.equal(denied.status, 403);
	assert.equal(users.status, 200);
	assert.ok(users.body.some((user) => user.pseudo === 'admin' && user.role === 'admin'));
	assert.equal(events.status, 200);
	assert.ok(events.body.some((event) => event.pseudo === 'admin' && event.success === true));
	assert.equal(logs.status, 200);
	assert.equal((await userClient.request('/admin/integrations')).status, 403);
	assert.equal((await createClient().request('/admin/integrations')).status, 401);
	const integrations = await adminClient.request('/admin/integrations');
	assert.equal(integrations.status, 200);
	assert.deepEqual(integrations.body.youtube, { configured: false });
	assert.deepEqual(integrations.body.spotify, { publicCatalogAvailable: true, oauthConfigured: true });
	assert.equal(integrations.body.connections.youtube.state, 'not_configured');
	assert.equal(integrations.body.connections.spotifyPublic.state, 'not_checked');
	assert.equal(integrations.body.connections.spotifyOAuth.state, 'not_checked');
	assert.equal(integrations.body.checkedAt, null);
	assert.equal((await userClient.request('/admin/integrations/check', { method: 'POST' })).status, 403);
	assert.equal((await createClient().request('/admin/integrations/check', { method: 'POST' })).status, 401);
	assert.equal((await adminClient.request('/admin/integrations/check', { method: 'POST', skipOrigin: true })).status, 403);
	for (const route of ['/playlist', '/playlist_summaries', '/playback_state', '/auth/spotify/start']) {
		assert.equal((await adminClient.request(route)).status, 403, route);
	}
	for (const route of ['/spotify_test', '/send_search_youtube', '/add_song_ecoute', '/update_playlist', '/upload_to_playlist']) {
		assert.equal((await adminClient.request(route, { method: 'POST', body: {} })).status, 403, route);
	}
	assert.ok(logs.body.some((log) => log.action === 'auth.login'));
	const stranger = createClient();
	assert.equal((await stranger.request('/admin/updates')).status, 401);
	assert.equal((await userClient.request('/admin/updates')).status, 403);
	assert.equal((await adminClient.request('/admin/updates')).status, 200);
	assert.equal((await userClient.request('/admin/updates/install', { method: 'POST', body: { version: 'v2' } })).status, 403);
	assert.equal((await adminClient.request('/admin/updates/check', { method: 'POST', skipOrigin: true })).status, 403);
	assert.equal((await adminClient.request('/admin/updates/install', { method: 'POST', body: { version: 'v2' } })).status, 503);
});


test('admins can reset another user password but regular users cannot', async () => {
	const userClient = createClient();
	const adminClient = createClient();
	await login(userClient);
	await login(adminClient, 'admin');

	const users = await adminClient.request('/admin/users');
	const second = users.body.find((user) => user.pseudo === 'second');
	assert.ok(second);

	const denied = await userClient.request(`/admin/users/${second.id}/password`, {
		method: 'POST',
		body: {
			newPassword: 'adminpass123'
		}
	});
	assert.equal(denied.status, 403);

	const tooShort = await adminClient.request(`/admin/users/${second.id}/password`, {
		method: 'POST',
		body: {
			newPassword: 'short'
		}
	});
	assert.equal(tooShort.status, 400);

	const reset = await adminClient.request(`/admin/users/${second.id}/password`, {
		method: 'POST',
		body: {
			newPassword: 'adminpass123'
		}
	});
	assert.equal(reset.status, 200);
	assert.equal(reset.body.user.pseudo, 'second');

	const oldPasswordClient = createClient();
	const oldPasswordLogin = await oldPasswordClient.request('/auth/login', {
		method: 'POST',
		body: {
			pseudo: 'second',
			password: 'password123'
		}
	});
	assert.equal(oldPasswordLogin.status, 401);

	const newPasswordClient = createClient();
	await login(newPasswordClient, 'second', 'adminpass123');

	const restored = await adminClient.request(`/admin/users/${second.id}/password`, {
		method: 'POST',
		body: {
			newPassword: 'password123'
		}
	});
	assert.equal(restored.status, 200);
});

test('playlist switch preserves current audio, cache IDs and private streams while replacing upcoming tracks', async () => {
    const client = createClient();
    await login(client, 'user');
    for (const [playlist, title] of [['switch-old.json', 'Old'], ['switch-new.json', 'New']]) {
        await client.request('/update_playlist', { method: 'POST', body: {
            arg: { playlist, song: { type: 'youtube', title, url: 'https://www.youtube.com/watch?v=synthetic-switch' } }
        } });
    }
    await client.request('/playlist_used', { method: 'POST', body: { arg: ['switch-old.json'] } });
    const first = await client.request('/next_song');
    const streamId = first.body.stream_id;
    assert.ok(streamId);
    const cacheDir = path.join(tempRoot, 'musiq', client.sessionId());
    await writeFile(path.join(cacheDir, '0.mp3'), 'old synthetic audio');
    const selected = await client.request('/playlist_used', { method: 'POST', body: {
        arg: ['switch-new.json'], preservePlayback: true, random: false
    } });
    assert.equal(selected.status, 200);
    assert.equal(selected.body.preserved, true);
    assert.equal(selected.body.currentId, 0);
    assert.equal(selected.body.current.title, 'Old');
    assert.deepEqual(selected.body.queue.map(track => track.title), ['New']);
    assert.equal(selected.body.queue[0].__sessionIndex, 1);
    assert.ok(app.locals.firstTrackStreams.getStream(streamId), 'current private stream remains owned and active');
    assert.ok((await readdir(cacheDir)).includes('0.mp3'));
    const list = await client.request('/playlist');
    assert.deepEqual(list.body.map(track => [track.title, track.__sessionIndex]), [['New', 1]]);
    assert.equal((await client.request('/playback_state')).body.currentId, 0);
    await writeFile(path.join(cacheDir, '1.mp3'), 'new synthetic audio');
    await client.request(`/audio/${streamId}/stop`, { method: 'POST', body: { reason: 'finished' } });
    const next = await client.request('/next_song');
    assert.equal(next.body.current.title, 'New');
    assert.equal(next.body.currentId, 1);
    assert.equal(next.body.mode, 'normal');
    const back = await client.request('/playlist_used', { method: 'POST', body: {
        arg: ['switch-old.json'], preservePlayback: true, random: false
    } });
    assert.equal(back.body.currentId, 1);
    assert.equal(back.body.queue[0].__sessionIndex, 0);
    assert.equal((await client.request('/play_status/1')).body.status, 'ready');
    const rejected = await client.request('/playlist_used', { method: 'POST', body: {
        arg: ['missing-private-playlist.json'], preservePlayback: true
    } });
    assert.equal(rejected.status, 400);
    assert.equal((await client.request('/playback_state')).body.currentId, 1);
    await client.request('/delete_from_playlist', { method: 'POST', body: { playlist: 'switch-old.json', index: 0 } });
    assert.equal((await client.request('/playback_state')).body.currentId, 1);
    assert.equal((await client.request('/play_status/1')).body.status, 'ready');
});

test('likes build an isolated automatic playlist and unliking does not interrupt its current track', async () => {
    const first = createClient(), second = createClient(), anonymous = createClient();
    await login(first, 'user');
    await login(second, 'second');
    const playlist = 'likes-source.json';
    await first.request('/update_playlist', { method: 'POST', body: { arg: {
        playlist, song: { type: 'youtube', title: 'Like fixture', url: 'https://www.youtube.com/watch?v=liked-fixture' }
    } } });
    await first.request('/playlist_used', { method: 'POST', body: { arg: [playlist] } });
    await first.request('/playlist');
    const change = { trackId: 0, key: 'youtube:liked-fixture', liked: true };
    assert.equal((await anonymous.request('/liked_tracks', { method: 'POST', body: change })).status, 401);
    assert.equal((await second.request('/liked_tracks', { method: 'POST', body: change })).status, 404);
    assert.equal((await first.request('/liked_tracks', { method: 'POST', body: { ...change, key: 'wrong' } })).status, 409);
    for (let attempt = 0; attempt < 2; attempt++) {
        const saved = await first.request('/liked_tracks', { method: 'POST', body: change });
        assert.equal(saved.status, 200);
        assert.equal(saved.body.items.length, 1);
        assert.equal(saved.body.items[0].__playlist, undefined);
    }
    assert.deepEqual((await second.request('/liked_tracks')).body.items, []);
    const name = 'liked Youplayer.json';
    assert.equal((await first.request('/playlist_summaries')).body.find(item => item.name === name).count, 1);
    for (const [route, body] of [
        ['/update_playlist', { arg: { playlist: name, song: { type: 'youtube', title: 'Bypass', url: 'https://www.youtube.com/watch?v=bypass-fixture' } } }],
        ['/delete_playlist', { playlist: name }],
        ['/delete_from_playlist', { playlist: name, index: 0 }]
    ]) assert.equal((await first.request(route, { method: 'POST', body })).status, 400);
    await first.request('/playlist_used', { method: 'POST', body: { arg: [name] } });
    const playing = await first.request('/next_song');
    assert.equal(playing.body.current.title, 'Like fixture');
    const removed = await first.request('/liked_tracks', { method: 'POST', body: { ...change, liked: false } });
    assert.equal(removed.status, 200);
    assert.deepEqual(removed.body.items, []);
    assert.deepEqual((await first.request('/playlist')).body, []);
    const state = await first.request('/playback_state');
    assert.equal(state.body.current.title, 'Like fixture');
    assert.deepEqual(state.body.queue, []);
    assert.ok(app.locals.firstTrackStreams.getStream(playing.body.stream_id));
});

test('discovered YouTube and Spotify tracks can be liked and Spotify can enter the queue', async () => {
    const first = createClient(), second = createClient();
    await login(first);
    await login(second, 'second');
    const youtube = { type: 'youtube', title: 'Video', url: 'https://www.youtube.com/watch?v=liked-video1' };
    const spotify = { type: 'spotify', title: 'Track', url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' };
    for (const song of [youtube, spotify]) {
        const key = trackLikeKey(song);
        assert.equal((await first.request('/liked_tracks', { method: 'POST', body: { song, key: 'wrong', liked: true } })).status, 409);
        assert.equal((await first.request('/liked_tracks', { method: 'POST', body: { song, key, liked: true } })).status, 200);
    }
    assert.equal((await first.request('/liked_tracks')).body.items.length, 2);
    assert.deepEqual((await second.request('/liked_tracks')).body.items, []);
    const invalid = { type: 'spotify', url: 'https://example.com/open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC' };
    assert.equal((await first.request('/liked_tracks', { method: 'POST', body: { song: invalid, key: trackLikeKey(invalid), liked: true } })).status, 400);
    assert.equal((await first.request('/liked_tracks', { method: 'POST', body: { song: { type: 'local', url: 'private.mp3' }, key: 'local:private.mp3', liked: true } })).status, 400);
    const queued = await first.request('/add_song_ecoute', { method: 'POST', body: { song: spotify } });
    assert.equal(queued.status, 200);
    assert.equal(queued.body.queue[0].type, 'spotify');
    assert.equal((await second.request('/playback_state')).body.queue.length, 0);
    for (const song of [youtube, spotify]) {
        assert.equal((await first.request('/liked_tracks', { method: 'POST', body: { song, key: trackLikeKey(song), liked: false } })).status, 200);
    }
});

async function orderedPlaybackPlaylist(client, playlist) {
    const songs = Array.from({ length: 12 }, (_, index) => ({ type: 'youtube', title: `Track ${index + 1}`,
        url: `https://www.youtube.com/watch?v=controlled-track-${index + 1}` }));
    for (const song of songs) {
        assert.equal((await client.request('/update_playlist', { method: 'POST', body: { arg: { playlist, song } } })).status, 200);
    }
    return songs;
}

test('controlled playback follows the selected track and wraps without replaying the previous current track', async () => {
    const client = createClient();
    await login(client);
    const playlist = 'controlled-playback.json';
    await orderedPlaybackPlaylist(client, playlist);
    await client.request('/playlist_used', { method: 'POST', body: { arg: [playlist], random: false } });
    const first = await client.request('/next_song');
    assert.equal(first.body.current.title, 'Track 1');
    const reordered = await client.request('/add_song_ecoute', { method: 'POST', body: { arg: 7, controlled: true } });
    assert.equal(reordered.status, 200);
    assert.equal(reordered.body.current.title, 'Track 1', 'editing the queue must preserve the active audio until the selection transition');
    assert.ok(app.locals.firstTrackStreams.getStream(first.body.stream_id));
    const played = await client.request('/next_song?reason=select');
    assert.equal(played.body.current.title, 'Track 8');
    const expected = [9, 10, 11, 12, 2, 3, 4, 5, 6, 7].map(n => `Track ${n}`);
    assert.deepEqual(played.body.queue.map(track => track.title), expected);
    assert.deepEqual((await client.request('/playback_state')).body.queue.map(track => track.title), expected);
    assert.equal((await client.request('/next_song')).body.current.title, 'Track 9');
    assert.equal((await client.request('/previous_song', { method: 'POST' })).body.current.title, 'Track 8');
    const off = createClient();
    await login(off);
    await off.request('/playlist_used', { method: 'POST', body: { arg: [playlist] } });
    await off.request('/next_song');
    const added = await off.request('/add_song_ecoute', { method: 'POST', body: { arg: 7 } });
    assert.deepEqual(added.body.queue.slice(0, 2).map(track => track.title), ['Track 8', 'Track 2']);
});

test('controlled home preview uses the full owned playlist and skips a track previously queued from that preview', async () => {
    const client = createClient(), stranger = createClient();
    await login(client);
    await login(stranger, 'second');
    const playlist = 'controlled-preview.json';
    const songs = await orderedPlaybackPlaylist(client, playlist);
    await client.request('/add_song_ecoute', { method: 'POST', body: { playlist, index: 0, key: trackLikeKey(songs[0]) } });
    await client.request('/next_song');
    const request = { playlist, index: 7, key: trackLikeKey(songs[7]), controlled: true };
    assert.ok((await stranger.request('/add_song_ecoute', { method: 'POST', body: request })).status >= 400);
    assert.equal((await client.request('/add_song_ecoute', { method: 'POST', body: { ...request, key: 'wrong' } })).status, 409);
    assert.equal((await client.request('/add_song_ecoute', { method: 'POST', body: request })).status, 200);
    const played = await client.request('/next_song?reason=select');
    assert.equal(played.body.current.title, 'Track 8');
    const expected = [9, 10, 11, 12, 2, 3, 4, 5, 6, 7].map(n => `Track ${n}`);
    assert.deepEqual(played.body.queue.map(track => track.title), expected);
    assert.deepEqual((await client.request('/playback_state')).body.queue.map(track => track.title), expected);
});

test('Spotify collection playback starts without import, replaces the queue, and applies controlled ordering', async () => {
    const client = createClient(), stranger = createClient();
    const collection = Array.from({ length: 12 }, (_, index) => ({ type: 'spotify', title: `Spotify ${index + 1}`,
        url: `https://open.spotify.com/track/${String(index + 1).padStart(22, '0')}` }));
    assert.equal((await stranger.request('/add_song_ecoute', { method: 'POST', body: { collection, collectionIndex: 0 } })).status, 401);
    await login(client);
    await login(stranger, 'second');
    assert.equal((await client.request('/add_song_ecoute', { method: 'POST', body: { collection, collectionIndex: 0 } })).status, 200);
    assert.equal((await client.request('/next_song?reason=select')).body.current.title, 'Spotify 1');
    const invalid = [...collection, { type: 'local', url: 'private.mp3' }];
    assert.equal((await client.request('/add_song_ecoute', { method: 'POST', body: { collection: invalid, collectionIndex: 7 } })).status, 400);
    assert.equal((await client.request('/add_song_ecoute', { method: 'POST', body: { collection, collectionIndex: 7, controlled: true } })).status, 200);
    const played = await client.request('/next_song?reason=select');
    assert.equal(played.body.current.title, 'Spotify 8');
    const expected = [9, 10, 11, 12, 2, 3, 4, 5, 6, 7].map(n => `Spotify ${n}`);
    assert.deepEqual(played.body.queue.map(track => track.title), expected);
    assert.deepEqual((await client.request('/playback_state')).body.queue.map(track => track.title), expected);
    assert.deepEqual((await stranger.request('/playback_state')).body.queue, []);
    assert.equal((await client.request('/playlist_summaries')).body.some(item => item.title === 'Spotify 1'), false);
});

test('large public playback collections pass the queue-specific JSON limit', async () => {
    const client = createClient();
    await login(client);
    const collection = Array.from({ length: 180 }, (_, index) => ({ type: 'spotify', title: `Large ${index}`,
        albumCoverURL: 'https://example.test/' + 'a'.repeat(700), url: `https://open.spotify.com/track/${String(index + 1).padStart(22, '0')}` }));
    assert.ok(JSON.stringify(collection).length > 100 * 1024);
    const added = await client.request('/add_song_ecoute', { method: 'POST', body: { collection, collectionIndex: 40 } });
    assert.equal(added.status, 200);
    assert.equal(added.body.queue[0].title, 'Large 40');
    assert.equal((await client.request('/playlist')).body.length, 180);
});

test('home preview can like and queue an owned track without selecting its playlist', async () => {
    const first = createClient(), second = createClient();
    await login(first, 'user');
    await login(second, 'second');
    const playlist = 'home-preview-actions.json';
    const song = { type: 'youtube', title: 'Preview fixture', url: 'https://www.youtube.com/watch?v=preview-fixture' };
    assert.equal((await first.request('/update_playlist', { method: 'POST', body: { arg: { playlist, song } } })).status, 200);
    const preview = await first.request(`/playlist_preview?playlist=${encodeURIComponent(playlist)}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.body[0].__playlistIndex, 0);
    const payload = { playlist, index: 0, key: 'youtube:preview-fixture' };
    assert.equal((await second.request('/liked_tracks', { method: 'POST', body: { ...payload, liked: true } })).status, 400);
    assert.equal((await first.request('/liked_tracks', { method: 'POST', body: { ...payload, key: 'wrong', liked: true } })).status, 409);
    const liked = await first.request('/liked_tracks', { method: 'POST', body: { ...payload, liked: true } });
    assert.equal(liked.status, 200);
    assert.equal(liked.body.items.length, 1);
    const queued = await first.request('/add_song_ecoute', { method: 'POST', body: payload });
    assert.equal(queued.status, 200);
    assert.equal(queued.body.queue[0].title, 'Preview fixture');
    assert.equal((await first.request('/playlist_preview?playlist=home-preview-actions.json')).body.length, 1);
    assert.equal((await first.request('/delete_from_playlist', { method: 'POST', body: { playlist, index: 0, key: 'wrong' } })).status, 409);
    assert.equal((await first.request('/delete_from_playlist', { method: 'POST', body: { ...payload } })).status, 200);
    assert.deepEqual((await first.request('/playlist_preview?playlist=home-preview-actions.json')).body, []);
});

test('local upload saves edited title, artist and image in the owners playlist', async () => {
    const first = createClient(), second = createClient();
    await login(first, 'user');
    await login(second, 'second');
    const boundary = 'synthetic-local-upload-boundary';
    const cover = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a00000000', 'hex').toString('base64')}`;
    const fields = [
        ['playlist', 'edited-local.json'], ['title', 'Titre choisi'],
        ['artist', 'Artiste choisi'], ['albumCoverURL', cover]
    ];
    const body = fields.map(([name, value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    ).join('') + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="source.mp3"\r\nContent-Type: audio/mpeg\r\n\r\nsynthetic audio\r\n--${boundary}--\r\n`;
    const uploaded = await first.request('/upload_to_playlist', { method: 'POST', headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`
    }, body });
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    const preview = await first.request('/playlist_preview?playlist=edited-local.json');
    assert.equal(preview.status, 200);
    assert.deepEqual(preview.body.map(({ title, artist, albumCoverURL, type }) => ({ title, artist, albumCoverURL, type })), [
        { title: 'Titre choisi', artist: 'Artiste choisi', albumCoverURL: cover, type: 'local' }
    ]);
    assert.equal((await second.request('/playlist_preview?playlist=edited-local.json')).status !== 200, true);
});

test('rejected uploads leave neither a playlist nor a temporary audio file', async () => {
    const client = createClient();
    await login(client, 'user');
    const localRoot = path.join(tempRoot, 'local_song');
    const initialFiles = (await readdir(localRoot)).sort();
    for (const fixture of [
        { filename: 'oversized.mp3', mime: 'audio/mpeg', content: 'a'.repeat(1025) },
        { filename: 'document.pdf', mime: 'application/pdf', content: 'synthetic' }
    ]) {
        const boundary = 'rejected-upload-fixture';
        const playlist = `rejected-${fixture.filename}.json`;
        const body = `--${boundary}\r\nContent-Disposition: form-data; name="playlist"\r\n\r\n${playlist}\r\n`
            + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fixture.filename}"\r\nContent-Type: ${fixture.mime}\r\n\r\n${fixture.content}\r\n--${boundary}--\r\n`;
        const response = await client.request('/upload_to_playlist', { method: 'POST',
            headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, body });
        assert.equal(response.status, 400);
        assert.equal((await client.request(`/playlist_preview?playlist=${encodeURIComponent(playlist)}`)).status, 404);
        assert.deepEqual((await readdir(localRoot)).sort(), initialFiles);
    }
});
