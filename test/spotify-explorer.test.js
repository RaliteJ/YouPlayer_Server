import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpotifyExplorer } from '../src/spotify-explorer.js';

const tracks = (start, count) => Array.from({ length: count }, (_, index) => ({
	track: { id: `track${start + index}`, name: `Titre ${start + index}`, artists: [] }
}));

function harness(playlist, pages = [], callbacks = {}) {
	const elements = new Map();
	const requests = [];
	const root = {
		classList: { toggle() {} },
		listeners: {},
		addEventListener(type, handler) { this.listeners[type] = handler; },
		querySelectorAll: () => [],
		querySelector(selector) {
			if (!elements.has(selector)) elements.set(selector, {
				value: 'playlist123456789', innerHTML: '', textContent: '',
				scrollTop: 0, scrollHeight: 5000, clientHeight: 500,
				classList: { toggle() {} }, listeners: {},
				addEventListener(type, handler) { this.listeners[type] = handler; }
			});
			return elements.get(selector);
		}
	};
	const explorer = createSpotifyExplorer({
		...callbacks,
		root, escapeHtml: String, playlistEntries: () => [],
		apiErrorMessage: () => 'Erreur simulee',
		apiFetch: async (url, method, body) => {
			requests.push(body);
			return body.action === 'playlist' ? { data: playlist } : pages.shift();
		}
	});
	explorer.init();
	const results = root.querySelector('[data-spotify-results]');
	return {
		requests, results,
		connect: () => explorer.refreshConnection(),
		search: () => root.querySelector('[data-spotify-search-form]').listeners.submit({ preventDefault() {} }),
		artist: id => results.listeners.click({ target: { closest: selector => selector === '[data-entity-type][data-entity-id]'
			? { dataset: { entityType: 'artist', entityId: id } } : null } }),
		status: root.querySelector('[data-spotify-status]'),
		count: () => (results.innerHTML.match(/class="spotify-track-row"/g) || []).length,
		open: () => root.querySelector('[data-spotify-playlist-open-form]').listeners.submit({ preventDefault() {} }),
		more: () => {
			results.scrollTop = results.scrollHeight - results.clientHeight;
			return root.listeners.wheel({ deltaY: 100 });
		},
		scroll: top => {
			results.scrollTop = top;
			return root.listeners.scroll({ target: results });
		},
		wheel: deltaY => root.listeners.wheel({ deltaY }),
		touch: (startY, endY) => {
			root.listeners.touchstart({ touches: [{ clientY: startY }] });
			return root.listeners.touchmove({ touches: [{ clientY: endY }] });
		},
		play: () => results.listeners.click({ target: { closest: selector => selector === '[data-play-current]' ? {} : null } })
	};
}

test('bridge artist portraits are completed by matching IDs without replacing bridge results', async () => {
	const images = [{ url: 'https://example.test/portrait.jpg' }];
	const relatedImages = [{ url: 'https://example.test/related.jpg' }];
	const existingImages = [{ url: 'https://example.test/existing.jpg' }];
	const artist = { id: 'artist12345', name: 'Bridge artist' };
	const existing = { id: 'existing12345', name: 'Already pictured', images: existingImages };
	const search = { artists: { items: [artist, existing], total: 2 }, playlists: { items: [{ id: 'playlist12345', name: 'Bridge playlist' }] } };
	const detail = { artist, related_artists: [{ id: 'related12345', name: 'Bridge related' }], albums: [{ id: 'album12345', name: 'Bridge album' }] };
	const h = harness(null, [
		{ data: { artists: { items: [{ ...artist, name: 'Public name', images }, { ...existing, images }], total: 2 } } },
		{ data: { artist: { ...artist, name: 'Public name', images }, related_artists: [{ id: 'related12345', images: relatedImages }] } }
	], { browserBridge: {
		status: async () => ({ installed: true, authenticated: true, tokenCaptured: true }),
		search: async () => search, getArtist: async () => detail
	} });
	await h.connect();
	await h.search();
	assert.match(h.results.innerHTML, /portrait\.jpg/);
	assert.match(h.results.innerHTML, /existing\.jpg/);
	assert.match(h.results.innerHTML, /Bridge playlist/);
	assert.doesNotMatch(h.results.innerHTML, /Public name/);
	await h.artist(artist.id);
	assert.match(h.results.innerHTML, /spotify-hero-cover artist.*portrait\.jpg/);
	assert.match(h.results.innerHTML, /related\.jpg/);
	assert.match(h.results.innerHTML, /Bridge related/);
	assert.match(h.results.innerHTML, /Bridge album/);
	assert.deepEqual(h.requests.map(body => body.action), ['search', 'artist']);
	assert.equal(artist.images, undefined, 'bridge objects are not mutated');
});

test('portrait enrichment is optional and skips artists already carrying images', async () => {
	const artist = { id: 'artist12345', name: 'Bridge artist' };
	const search = { artists: { items: [artist], total: 1 } };
	const h = harness(null, [null], { browserBridge: {
		status: async () => ({ installed: true, authenticated: true, tokenCaptured: true }),
		search: async () => search
	} });
	await h.connect();
	await h.search();
	assert.match(h.results.innerHTML, /Bridge artist/);
	assert.equal(h.status.textContent, '');
	assert.equal(h.requests.length, 1);
	search.artists.items = [{ ...artist, images: [{ url: 'https://example.test/portrait.jpg' }] }];
	await h.search();
	assert.equal(h.requests.length, 1, 'no supplementary request when the bridge includes portraits');
});

test('large complete playlists render 50 tracks at a time without fetching again', async () => {
	const h = harness({ id: 'playlist123456789', tracks: { items: tracks(0, 123), total: 123, next: null } });
	await h.open();
	assert.equal(h.count(), 50);
	assert.match(h.results.innerHTML, /data-playlist-scroll-hint/);
	assert.doesNotMatch(h.results.innerHTML, /data-load-more-playlist/);
	await h.more();
	assert.equal(h.count(), 100);
	await h.more();
	assert.equal(h.count(), 123);
	assert.doesNotMatch(h.results.innerHTML, /data-playlist-scroll-hint/);
	assert.equal(h.requests.length, 1);
	await h.open();
	assert.equal(h.count(), 50);
});

test('only downward scrolling near the end reveals more tracks, including touch at the boundary', async () => {
	const h = harness({ id: 'playlist123456789', tracks: { items: tracks(0, 123), total: 123, next: null } });
	await h.open();
	await h.scroll(3000);
	await h.wheel(100);
	assert.equal(h.count(), 50);
	await h.scroll(4450);
	assert.equal(h.count(), 100);
	assert.equal(h.results.scrollTop, 4450);
	await h.scroll(4430);
	await h.wheel(-100);
	await h.touch(100, 150);
	assert.equal(h.count(), 100);
	await h.touch(150, 100);
	assert.equal(h.count(), 123);
	await h.more();
	assert.equal(h.count(), 123);
	assert.equal(h.requests.length, 1);
});

test('repeated scroll gestures during a pending page issue only one request', async () => {
	let resolvePage;
	const page = new Promise(resolve => { resolvePage = resolve; });
	const h = harness({ id: 'playlist123456789', tracks: { items: tracks(0, 50), total: 51, next: 50 } }, [page]);
	await h.open();
	const pending = h.more();
	await h.more();
	await h.touch(150, 100);
	assert.equal(h.requests.length, 2);
	resolvePage({ data: { items: tracks(50, 1), total: 51, next: null } });
	await pending;
	assert.equal(h.count(), 51);
});

test('playing a Spotify playlist fetches every remaining page without importing it', async () => {
	const played = [];
	const firstPage = tracks(0, 50);
	firstPage[0].track.duration_ms = 180000;
	const h = harness({ id: 'playlist123456789', tracks: { items: firstPage, total: 101, next: 50 } }, [
		{ data: { items: tracks(50, 50), total: 101, next: 100 } },
		{ data: { items: tracks(100, 1), total: 101, next: null } }
	], { playCollection: collection => played.push(collection) });
	await h.open();
	await h.play();
	assert.equal(played.length, 1);
	assert.equal(played[0].length, 101);
	assert.equal(played[0][0].duration_ms, 180000);
	assert.equal(played[0][100].title, 'Titre 100');
	assert.deepEqual(h.requests.map(request => request.action), ['playlist', 'playlist_tracks', 'playlist_tracks']);
});

test('a page failure prevents partial Spotify playlist playback and can be retried', async () => {
	const played = [];
	const h = harness({ id: 'playlist123456789', tracks: { items: tracks(0, 50), total: 51, next: 50 } }, [
		null, { data: { items: tracks(50, 1), total: 51, next: null } }
	], { playCollection: collection => played.push(collection) });
	await h.open();
	await h.play();
	assert.equal(played.length, 0);
	await h.play();
	assert.equal(played[0].length, 51);
	assert.deepEqual(h.requests.slice(1).map(request => request.offset), [50, 50]);
});

test('pagination uses the server cursor even when unavailable tracks were filtered', async () => {
	const h = harness({ id: 'playlist123456789', tracks: { items: tracks(0, 49), total: 101, next: 50 } }, [
		{ data: { items: tracks(50, 50), total: 101, next: 100 } },
		{ data: { items: tracks(100, 1), total: 101, next: null } }
	]);
	await h.open();
	await h.more();
	assert.equal(h.count(), 99);
	assert.equal(h.requests[1].offset, 50);
	assert.equal(h.requests[1].limit, 50);
	await h.more();
	assert.equal(h.requests[2].offset, 100);
	assert.equal(h.count(), 100);
	assert.doesNotMatch(h.results.innerHTML, /data-playlist-scroll-hint/);
});

test('failed page requests preserve tracks and allow retrying the same page', async () => {
	const h = harness({ id: 'playlist123456789', tracks: { items: tracks(0, 50), total: 51, next: 50 } }, [
		null, { data: { items: tracks(50, 1), total: 51, next: null } }
	]);
	await h.open();
	await h.more();
	assert.equal(h.count(), 50);
	await h.more();
	assert.equal(h.count(), 51);
	assert.deepEqual(h.requests.slice(1).map((request) => request.offset), [50, 50]);
});

test('artist navigation opens albums and imports an album in batches', async () => {
	const elements = new Map();
	const requests = [];
	const root = {
		classList: { toggle() {} }, querySelectorAll: () => [],
		querySelector(selector) {
			if (!elements.has(selector)) elements.set(selector, {
				value: '', innerHTML: '', textContent: '', hidden: false, disabled: false,
				classList: { toggle() {} }, listeners: {}, setAttribute() {},
				addEventListener(type, handler) { this.listeners[type] = handler; }
			});
			return elements.get(selector);
		}
	};
	const artist = { artist: { id: 'artist12345', name: 'Artiste test' }, top_tracks: [], related_artists: [],
		albums: [{ id: 'album123456', name: 'Album test', artists: [{ id: 'artist12345', name: 'Artiste test' }] }] };
	const album = { id: 'album123456', external_urls: { spotify: 'https://open.spotify.com/album/album123456' }, tracks: { items:
			Array.from({ length: 51 }, (_, index) => ({ id: `track${100000 + index}`, name: `Titre ${index + 1}`,
				artists: [{ id: 'artist12345', name: 'Artiste test' }] })) } };
	const explorer = createSpotifyExplorer({
		root, escapeHtml: String, playlistEntries: () => [], apiErrorMessage: () => 'Erreur',
		openAddModal() {}, showNotice() {},
		apiFetch: async (url, method, body) => {
			requests.push({ url, method, body });
			if (url === '/spotify_test') return { data: body.action === 'artist' ? artist : album };
			if (url === '/spotify_import_browser_playlist') return { playlist: body.playlist, count: body.items.length };
			if (url === '/playlist_summaries') return {};
			return null;
		}
	});
	explorer.init();
	const results = root.querySelector('[data-spotify-results]');
	const entityTarget = (type, id) => ({ closest(selector) {
		if (selector === '[data-entity-type][data-entity-id]') return { dataset: { entityType: type, entityId: id } };
		return null;
	} });
	await results.listeners.click({ target: entityTarget('artist', 'artist12345') });
	assert.match(results.innerHTML, /Albums et singles/);
	assert.match(results.innerHTML, /data-entity-type="album"/);
	await results.listeners.click({ target: entityTarget('album', 'album123456') });
	assert.match(results.innerHTML, /Importer l'album/);
	assert.match(results.innerHTML, /Album test/);
	assert.equal((results.innerHTML.match(/class="spotify-track-row"/g) || []).length, 51);
	await results.listeners.click({ target: { closest(selector) { return selector === '[data-import-current]' ? {} : null; } } });
	const imported = requests.filter((request) => request.url === '/spotify_import_browser_playlist');
	assert.deepEqual(imported.map((request) => request.body.items.length), [50, 1]);
	assert.deepEqual(imported.map((request) => request.body.playlist), ['Album test', 'Album test']);
	assert.equal(imported[1].body.items[0].title, 'Titre 51');
	assert.deepEqual(requests.filter((request) => request.url === '/spotify_test').map((request) => request.body.action), ['artist', 'album']);
});

test('authenticated browser bridge handles search and album without using the backend', async () => {
	const elements = new Map();
	const backendRequests = [];
	const bridgeCalls = [];
	const root = {
		classList: { toggle() {} }, querySelectorAll: () => [],
		querySelector(selector) {
			if (!elements.has(selector)) elements.set(selector, {
				value: '', innerHTML: '', textContent: '', hidden: false, disabled: false,
				classList: { toggle() {} }, listeners: {}, setAttribute() {},
				addEventListener(type, handler) { this.listeners[type] = handler; }
			});
			return elements.get(selector);
		}
	};
	const albumSummary = {
		id: 'album123456', name: 'Album personnel', artists: [], images: [],
		external_urls: { spotify: 'https://open.spotify.com/album/album123456' }
	};
	const browserBridge = {
		async status() { return { installed: true, tokenCaptured: true, authenticated: true }; },
		async search(query) {
			bridgeCalls.push(['search', query]);
			return {
				tracks: { items: [], total: 0 }, playlists: { items: [], total: 0 },
				albums: { items: [albumSummary], total: 1 }, artists: { items: [], total: 0 }
			};
		},
		async getAlbum(id) {
			bridgeCalls.push(['album', id]);
			return { ...albumSummary, tracks: { items: [{ id: 'track123456', name: 'Titre personnel', artists: [] }] } };
		},
		async getArtist() { throw new Error('unused'); },
		async getPlaylists() { return { items: [] }; },
		async getPlaylist() { throw new Error('unused'); },
		async openSpotify() {}
	};
	const explorer = createSpotifyExplorer({
		root, browserBridge, escapeHtml: String, playlistEntries: () => [], apiErrorMessage: () => 'Erreur',
		apiFetch: async (url, method, body) => {
			backendRequests.push({ url, method, body });
			if (url === '/playlist_summaries') return {};
			throw new Error('backend Spotify request must not run');
		}
	});
	await explorer.activate();
	root.querySelector('[data-spotify-search-input]').value = 'Recherche personnelle';
	await root.querySelector('[data-spotify-search-form]').listeners.submit({ preventDefault() {} });
	const results = root.querySelector('[data-spotify-results]');
	await results.listeners.click({ target: { closest(selector) {
		if (selector === '[data-entity-type][data-entity-id]') {
			return { dataset: { entityType: 'album', entityId: 'album123456' } };
		}
		return null;
	} } });

	assert.deepEqual(bridgeCalls, [
		['search', 'Recherche personnelle'],
		['album', 'album123456']
	]);
	assert.deepEqual(backendRequests.map((request) => request.url), ['/playlist_summaries']);
	assert.match(results.innerHTML, /Titre personnel/);
});


test('Spotify failures hide technical details and result clicks remain retryable', async () => {
	const h = harness(null);
	await h.open();
	assert.match(h.status.textContent, /Réessaie/);
	assert.doesNotMatch(h.status.textContent, /Erreur simulee/);
	const click = () => h.results.listeners.click({
		target: { closest: selector => selector === '[data-entity-type][data-entity-id]'
			? { dataset: { entityType: 'album', entityId: 'synthetic' } } : null }
	});
	await assert.doesNotReject(click);
	assert.match(h.status.textContent, /Réessaie/);
	await assert.doesNotReject(click);
});
