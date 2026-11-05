import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpotifyBrowserBridge } from '../src/spotify-browser-bridge.js';

function fakeWindow() {
	const listeners = new Set();
	return {
		location: { origin: 'https://127.0.0.1:8443' },
		lastPosted: null,
		addEventListener(type, listener) {
			if (type === 'message') listeners.add(listener);
		},
		removeEventListener(type, listener) {
			if (type === 'message') listeners.delete(listener);
		},
		postMessage(message) {
			this.lastPosted = message;
		},
		respond(data) {
			for (const listener of listeners) {
				listener({ source: this, origin: this.location.origin, data });
			}
		}
	};
}

test('Spotify browser bridge exchanges playlist data without exposing a token', async () => {
	const windowObject = fakeWindow();
	const bridge = createSpotifyBrowserBridge({ windowObject });
	const request = bridge.getPlaylists();

	assert.equal(windowObject.lastPosted.action, 'get-playlists');
	assert.equal(windowObject.lastPosted.token, undefined);
	windowObject.respond({
		source: 'youplayer-spotify-extension',
		requestId: windowObject.lastPosted.requestId,
		ok: true,
		data: { items: [{ id: 'playlist-1' }], total: 1 }
	});

	const response = await request;
	assert.equal(response.total, 1);
	assert.equal(response.items[0].id, 'playlist-1');
	bridge.destroy();
});

test('Spotify browser bridge requests lyrics by track ID without a bearer', async () => {
	const windowObject = fakeWindow();
	const bridge = createSpotifyBrowserBridge({ windowObject });
	const request = bridge.getLyrics('A'.repeat(22));
	assert.equal(windowObject.lastPosted.action, 'get-lyrics');
	assert.equal(windowObject.lastPosted.trackId, 'A'.repeat(22));
	assert.equal(windowObject.lastPosted.token, undefined);
	windowObject.respond({ source: 'youplayer-spotify-extension', requestId: windowObject.lastPosted.requestId,
		ok: true, data: { found: true, timedLines: [{ time: 0.81, text: 'Test' }] } });
	assert.equal((await request).timedLines[0].time, 0.81);
	bridge.destroy();
});
