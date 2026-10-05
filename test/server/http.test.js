import test, { after, before, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';

let app;
let tempRoot;
const originalConsole = {
	error: console.error,
	log: console.log
};

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

function createMockRequest({ method, url, headers, body }) {
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
	req.socket = new Writable({
		write(_chunk, _encoding, callback) {
			callback();
		}
	});
	req.socket.remoteAddress = '127.0.0.1';
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

async function dispatchRequest({ method = 'GET', url, headers = {}, body = null }) {
	return new Promise((resolve, reject) => {
		const req = createMockRequest({ method, url, headers, body });
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

	return {
		async request(urlPath, options = {}) {
			const headers = Object.fromEntries(Object.entries(options.headers || {})
				.map(([name, value]) => [name.toLowerCase(), value]));
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

			const response = await dispatchRequest({
				method: options.method || 'GET',
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

async function login(client, pseudo = 'user') {
	const response = await client.request('/auth/login', {
		method: 'POST',
		body: {
			pseudo,
			password: 'password123'
		}
	});

	assert.equal(response.status, 200);
	assert.equal(response.body.user.pseudo, pseudo);
	return response.body.user;
}

before(async () => {
	process.env.NODE_ENV = 'test';
	console.error = () => {};
	console.log = () => {};
	tempRoot = await mkdtemp(path.join(os.tmpdir(), 'youplayer-http-'));
	process.env.YOUPLAYER_MUSIQ_DIR = path.join(tempRoot, 'musiq');
	process.env.YOUPLAYER_LOCAL_SONG_DIR = path.join(tempRoot, 'local_song');
	delete process.env.YOUPLAYER_YOUTUBE_API_KEY;
	delete process.env.YOUTUBE_API_KEY;

	({ app } = await import('../../src/server/server.js'));
	const { downloadQueue } = await import('../../src/server/download-queue.js');
	mock.method(downloadQueue, 'enqueue', async () => {});
	const user = await app.locals.youplayerStore.findUserByPseudo('user');
	await app.locals.youplayerStore.appendPlaylistItems(user.id, 'Synthetic.json', [{
		title: 'Synthetic local fixture', type: 'local', url: 'synthetic-fixture.wav'
	}]);
});

after(async () => {
	mock.restoreAll();
	console.error = originalConsole.error;
	console.log = originalConsole.log;
	await rm(tempRoot, { recursive: true, force: true });
	delete process.env.YOUPLAYER_MUSIQ_DIR;
	delete process.env.YOUPLAYER_LOCAL_SONG_DIR;
	delete process.env.YOUPLAYER_YOUTUBE_API_KEY;
	delete process.env.YOUTUBE_API_KEY;
});

test('GET /playback_state returns an empty playback state for a fresh session', async () => {
	const client = createClient();
	await login(client);
	const response = await client.request('/playback_state');

	assert.equal(response.status, 200);
	assert.deepEqual(response.body, {
		currentId: null,
		current: null,
		previousId: null,
		queue: [],
		random: false
	});
});

test('GET /playlist rejects fresh sessions without a selected playlist', async () => {
	const client = createClient();
	await login(client);
	const response = await client.request('/playlist');

	assert.equal(response.status, 400);
	assert.equal(response.text, 'Aucune playlist sélectionnée.');
});

test('GET /different_playlist and /playlist_summaries expose readable playlist lists', async () => {
	const client = createClient();
	await login(client);
	const playlists = await client.request('/different_playlist');
	const summaries = await client.request('/playlist_summaries');

	assert.equal(playlists.status, 200);
	assert.ok(Array.isArray(playlists.body));
	assert.ok(playlists.body.length > 0);
	assert.ok(playlists.body.every((playlist) => playlist.endsWith('.json')));

	assert.equal(summaries.status, 200);
	assert.ok(Array.isArray(summaries.body));
	assert.equal(summaries.body.length, playlists.body.length + (playlists.body.includes('liked Youplayer.json') ? 0 : 1));
	assert.ok(summaries.body.every((playlist) =>
		playlist.name.endsWith('.json')
		&& typeof playlist.title === 'string'
		&& Number.isInteger(playlist.count)
	));
});

test('static backend allowlist does not expose server files or raw playlists', async () => {
	const client = createClient();
	const serverFile = await client.request('/server/token.txt');
	const rawPlaylist = await client.request('/playlists/playlist.json');

	assert.equal(serverFile.status, 404);
	assert.equal(rawPlaylist.status, 404);
});

test('GET /playlist_preview returns playlist contents without selecting playback session', async () => {
	const client = createClient();
	await login(client);
	const summaries = await client.request('/playlist_summaries');
	const selectedPlaylist = summaries.body.find((playlist) => playlist.count > 0)?.name;

	assert.ok(selectedPlaylist);

	const preview = await client.request(`/playlist_preview?playlist=${encodeURIComponent(selectedPlaylist)}`);
	const activePlaylist = await client.request('/playlist');

	assert.equal(preview.status, 200);
	assert.ok(Array.isArray(preview.body));
	assert.ok(preview.body.length > 0);
	assert.ok(preview.body.every((track, index) =>
		track.__playlist === selectedPlaylist
		&& track.__playlistIndex === index
	));
	assert.equal(activePlaylist.status, 400);
	assert.equal(activePlaylist.text, 'Aucune playlist sélectionnée.');
});

test('POST /playlist_used stores the selected playlist in the current session', async () => {
	const client = createClient();
	await login(client);
	const playlists = await client.request('/different_playlist');
	const selectedPlaylist = playlists.body[0];

	const selection = await client.request('/playlist_used', {
		method: 'POST',
		body: {
			arg: [selectedPlaylist],
			random: false
		}
	});
	const playlist = await client.request('/playlist');

	assert.equal(selection.status, 200);
	assert.equal(playlist.status, 200);
	assert.ok(Array.isArray(playlist.body));
	assert.ok(playlist.body.every((track, index) =>
		track.__playlist === selectedPlaylist
		&& track.__playlistIndex === index
	));
});

test('playlist selection is isolated by browser session cookie', async () => {
	const clientA = createClient();
	const clientB = createClient();
	await login(clientA);
	await login(clientB, 'second');
	const playlists = await clientA.request('/different_playlist');

	await clientA.request('/playlist_used', {
		method: 'POST',
		body: {
			arg: [playlists.body[0]],
			random: false
		}
	});

	const selectedForA = await clientA.request('/playlist');
	const selectedForB = await clientB.request('/playlist');

	assert.equal(selectedForA.status, 200);
	assert.equal(selectedForB.status, 400);
	assert.equal(selectedForB.text, 'Aucune playlist sélectionnée.');
});

test('POST /playlist_used keeps the random flag in playback state', async () => {
	const client = createClient();
	await login(client);
	const playlists = await client.request('/different_playlist');

	await client.request('/playlist_used', {
		method: 'POST',
		body: {
			arg: [playlists.body[0]],
			random: true
		}
	});
	const playback = await client.request('/playback_state');

	assert.equal(playback.status, 200);
	assert.equal(playback.body.random, true);
});

test('POST /random updates shuffle state and GET /random no longer mutates playback', async () => {
	const client = createClient();
	await login(client);
	const playlists = await client.request('/different_playlist');

	await client.request('/playlist_used', {
		method: 'POST',
		body: {
			arg: [playlists.body[0]],
			random: false
		}
	});

	const updated = await client.request('/random', {
		method: 'POST',
		body: {
			enabled: true
		}
	});
	const legacyGet = await client.request('/random?enabled=false');
	const playback = await client.request('/playback_state');

	assert.equal(updated.status, 200);
	assert.equal(updated.body.random, true);
	assert.equal(legacyGet.status, 405);
	assert.equal(playback.body.random, true);
});

test('POST /delete_from_playlist validates the song index before mutating files', async () => {
	const client = createClient();
	await login(client);
	const response = await client.request('/delete_from_playlist', {
		method: 'POST',
		body: {
			playlist: 'missing.json',
			index: -1
		}
	});

	assert.equal(response.status, 400);
	assert.deepEqual(response.body, { error: 'Index de musique invalide' });
});

test('POST /update_playlist rejects unsafe playlist filenames', async () => {
	const client = createClient();
	await login(client);
	const response = await client.request('/update_playlist', {
		method: 'POST',
		body: {
			arg: {
				playlist: '../outside.json',
				song: {
					type: 'local',
					title: 'No write'
				}
			}
		}
	});

	assert.equal(response.status, 400);
	assert.deepEqual(response.body, { error: 'Nom de playlist invalide' });
});

test('POST /update_playlist rejects unsafe local song filenames', async () => {
	const client = createClient();
	await login(client);
	const response = await client.request('/update_playlist', {
		method: 'POST',
		body: {
			arg: {
				playlist: 'safe.json',
				song: {
					type: 'local',
					title: 'No read',
					url: '../secret.mp3'
				}
			}
		}
	});

	assert.equal(response.status, 400);
	assert.deepEqual(response.body, { error: 'Nom de fichier local invalide' });
});

test('POST /spotify_import_browser_playlist stores normalized extension tracks without a bearer', async () => {
	const client = createClient();
	await login(client);
	const response = await client.request('/spotify_import_browser_playlist', {
		method: 'POST',
		body: {
			playlist: 'extension-import.json',
			items: [{
				type: 'spotify',
				title: 'Titre extension',
				artist: 'Artiste extension',
				url: 'https://open.spotify.com/track/track1234567890'
			}]
		}
	});
	const preview = await client.request('/playlist_preview?playlist=extension-import.json');

	assert.equal(response.status, 200);
	assert.equal(response.body.count, 1);
	assert.equal(preview.status, 200);
	assert.equal(preview.body.at(-1).title, 'Titre extension');
	assert.equal(preview.body.at(-1).accessToken, undefined);
});

test('GET /play rejects non-integer track ids before path lookup', async () => {
	const client = createClient();
	await login(client);
	const response = await client.request('/play/not-a-number');

	assert.equal(response.status, 400);
	assert.equal(response.text, 'TrackID invalide');
});

test('GET /play_status reports local tracks as ready only when the stored file exists', async () => {
	const client = createClient();
	await login(client);
	const localFileName = 'status-track.mp3';
	await writeFile(path.join(tempRoot, 'local_song', localFileName), 'audio', 'utf8');

	await client.request('/update_playlist', {
		method: 'POST',
		body: {
			arg: {
				playlist: 'status.json',
				song: {
					type: 'local',
					title: 'Ready local',
					url: localFileName
				}
			}
		}
	});
	await client.request('/playlist_used', {
		method: 'POST',
		body: {
			arg: ['status.json']
		}
	});

	const ready = await client.request('/play_status/0');
	assert.equal(ready.status, 200);
	assert.deepEqual(ready.body, {
		status: 'ready',
		path: '/play/0'
	});
});

test('legacy direct download and Spotify add routes are closed', async () => {
	const client = createClient();
	await login(client);

	const download = await client.request('/run-script', {
		method: 'POST',
		body: {
			arg: ['https://youtu.be/abc123XYZ00', 0]
		}
	});
	const spotify = await client.request('/spotify_add_song', {
		method: 'POST',
		body: {
			arg: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'
		}
	});

	assert.equal(download.status, 410);
	assert.equal(spotify.status, 410);
});

test('POST /send_search_youtube reports missing API key without calling YouTube', async () => {
	const client = createClient();
	await login(client);
	const response = await client.request('/send_search_youtube', {
		method: 'POST',
		body: {
			arg: 'test'
		}
	});

	assert.equal(response.status, 503);
	assert.deepEqual(response.body, { error: 'Cle API YouTube non configuree' });
});
