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
