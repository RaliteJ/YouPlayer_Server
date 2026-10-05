const APP_SOURCE = "youplayer-app";
const EXTENSION_SOURCE = "youplayer-spotify-extension";

export function createSpotifyBrowserBridge({ windowObject = globalThis.window } = {}) {
	if (!windowObject) {
		throw new Error("Le pont Spotify necessite un navigateur");
	}
	const pending = new Map();

	function handleMessage(event) {
		if (event.source !== windowObject || event.origin !== windowObject.location.origin) return;
		const message = event.data;
		if (message?.source !== EXTENSION_SOURCE || !message.requestId) return;
		const request = pending.get(message.requestId);
		if (!request) return;
		pending.delete(message.requestId);
		clearTimeout(request.timer);
		if (message.ok) {
			request.resolve(message.data);
		} else {
			request.reject(new Error(message.error || "Extension Spotify indisponible"));
		}
	}

	windowObject.addEventListener("message", handleMessage);

	function request(action, payload = {}, timeoutMs = 12000) {
		const requestId = globalThis.crypto?.randomUUID?.()
			|| `spotify-${Date.now()}-${Math.random().toString(16).slice(2)}`;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(requestId);
				reject(new Error("Extension YouPlayer Spotify non detectee"));
			}, timeoutMs);
			pending.set(requestId, { resolve, reject, timer });
			windowObject.postMessage({
				source: APP_SOURCE,
				requestId,
				action,
				...payload
			}, windowObject.location.origin);
		});
	}

	return {
		status() {
			return request("status", {}, 5000);
		},
		getPlaylists() {
			return request("get-playlists", {}, 30000);
		},
		getPlaylist(playlistId) {
			return request("get-playlist", { playlistId }, 60000);
		},
		search(query, { limit = 16, offset = 0 } = {}) {
			return request("search", { query, limit, offset }, 30000);
		},
		getAlbum(albumId) {
			return request("get-album", { albumId }, 30000);
		},
		getArtist(artistId) {
			return request("get-artist", { artistId }, 30000);
		},
		openSpotify() {
			return request("open-spotify", {}, 3000);
		},
		destroy() {
			windowObject.removeEventListener("message", handleMessage);
			for (const request of pending.values()) {
				clearTimeout(request.timer);
				request.reject(new Error("Pont Spotify ferme"));
			}
			pending.clear();
		}
	};
}

export const spotifyBrowserBridge = globalThis.window
	? createSpotifyBrowserBridge({ windowObject: globalThis.window })
	: null;
