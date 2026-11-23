import test from 'node:test';
import assert from 'node:assert/strict';
import {
	browserLaunchOptions,
	getCompleteSpotifyPlaylist,
	getSpotifyPlaylistTracksPage,
	importSpotifyPlaylist,
	parseSpotifyPublicPlaylist,
	spotifyWebApiTrackToStoredTrack
} from '../../src/server/spotify.js';

test('Chromium keeps its sandbox enabled in server launch options', () => {
	const options = browserLaunchOptions();
	assert.equal(options.headless, true);
	assert.equal(options.args, undefined);
});

test('the native public-page fallback replaces SpottyDL metadata parsing', async () => {
	const playlistId = 'playlist12345678901234';
	const state = {
		entities: {
			items: {
				[`spotify:playlist:${playlistId}`]: {
					name: 'Public Mix',
					content: { items: [{ itemV2: { data: trackData(3) } }] }
				}
			}
		}
	};
	const encoded = encodeURIComponent(Buffer.from(JSON.stringify(state)).toString('base64'));
	const playlist = parseSpotifyPublicPlaylist(
		`<script id="initialState" type="text/plain">${encoded}</script>`,
		playlistId
	);
	assert.equal(playlist.name, 'Public Mix');
	assert.equal(playlist.tracks.length, 1);
	assert.equal(playlist.tracks[0].title, 'Track 3');
	assert.equal(playlist.tracks[0].type, 'spotify');
	state.entities.items[`spotify:playlist:${playlistId}`].content.totalCount = 2;
	const truncated = encodeURIComponent(Buffer.from(JSON.stringify(state)).toString('base64'));
	assert.throws(() => parseSpotifyPublicPlaylist(
		`<script id="initialState" type="text/plain">${truncated}</script>`, playlistId
	), /incomplete/);
	assert.throws(() => parseSpotifyPublicPlaylist('<html></html>', playlistId), /absentes/);
});

test('playlist import falls back from legacy and capture paths to the public page', async () => {
	const calls = [];
	const imported = await importSpotifyPlaylist('https://open.spotify.com/playlist/playlist12345678901234', {
		getLegacyPlaylist: async () => { calls.push('legacy'); throw new Error('legacy unavailable'); },
		getCapturedPlaylist: async () => { calls.push('capture'); throw new Error('capture unavailable'); },
		getPublicPlaylist: async () => {
			calls.push('public');
			return { name: 'Public / Mix', tracks: [{ title: 'Track' }] };
		}
	});
	assert.deepEqual(calls, ['legacy', 'capture', 'public']);
	assert.equal(imported.name, 'Public Mix');
	assert.equal(imported.tracks.length, 1);
});
import {
	fetchSpotifyAlbum,
	fetchSpotifyCatalogSearch,
	fetchSpotifyClientCredentialsToken
} from '../../src/server/spotify-oauth.js';

function trackData(index) {
	return {
		uri: `spotify:track:track${String(index).padStart(6, '0')}`,
		name: `Track ${index}`,
		artists: {
			items: [{
				data: {
					uri: `spotify:artist:artist${index}`,
					profile: { name: `Artist ${index}` }
				}
			}]
		},
		albumOfTrack: {
			uri: `spotify:album:album${index}`,
			name: `Album ${index}`,
			coverArt: { sources: [{ url: `cover-${index}.jpg` }] }
		},
		trackNumber: index + 1,
		duration: { totalMilliseconds: 180000 + index }
	};
}

function playlistJson(name, total, tracks) {
	return {
		data: {
			playlistV2: {
				name,
				content: {
					totalCount: total,
					items: tracks.map((track) => ({ itemV2: { data: track } }))
				}
			}
		}
	};
}

function responseJson(json) {
	return {
		ok: true,
		json: async () => json
	};
}

test('getCompleteSpotifyPlaylist paginates past the first 100 Spotify tracks', async () => {
	const allTracks = Array.from({ length: 205 }, (_, index) => trackData(index));
	const calls = [];
	const fetchImpl = async (_url, options) => {
		const body = JSON.parse(options.body);
		const { offset, limit } = body.variables;
		calls.push({ operation: body.operationName, offset, limit });
		if (body.operationName === 'fetchPlaylist') {
			return responseJson(playlistJson('Long Mix', allTracks.length, allTracks.slice(0, 1)));
		}
		return responseJson(playlistJson('Long Mix', allTracks.length, allTracks.slice(offset, offset + limit)));
	};

	const playlist = await getCompleteSpotifyPlaylist('token', 'playlist123', { fetchImpl });

	assert.equal(playlist.name, 'Long Mix');
	assert.equal(playlist.total, 205);
	assert.equal(playlist.tracks.length, 205);
	assert.equal(playlist.tracks[0].title, 'Track 0');
	assert.equal(playlist.tracks[204].title, 'Track 204');
	assert.deepEqual(calls, [
		{ operation: 'fetchPlaylist', offset: 0, limit: 1 },
		{ operation: 'fetchPlaylistContents', offset: 0, limit: 100 },
		{ operation: 'fetchPlaylistContents', offset: 100, limit: 100 },
		{ operation: 'fetchPlaylistContents', offset: 200, limit: 100 }
	]);
});

test('getSpotifyPlaylistTracksPage returns API-shaped tracks and a next offset', async () => {
	const allTracks = Array.from({ length: 120 }, (_, index) => trackData(index));
	const fetchImpl = async (_url, options) => {
		const body = JSON.parse(options.body);
		const { offset, limit } = body.variables;
		return responseJson(playlistJson('Paged Mix', allTracks.length, allTracks.slice(offset, offset + limit)));
	};

	const page = await getSpotifyPlaylistTracksPage('token', 'playlist123', {
		offset: 50,
		limit: 50,
		fetchImpl
	});

	assert.equal(page.name, 'Paged Mix');
	assert.equal(page.total, 120);
	assert.equal(page.offset, 50);
	assert.equal(page.fetched, 50);
	assert.equal(page.next, 100);
	assert.equal(page.items.length, 50);
	assert.equal(page.items[0].name, 'Track 50');
	assert.equal(page.items[0].external_urls.spotify, 'https://open.spotify.com/track/track000050');
});

test('the primary playlist import rejects a missing or truncated later page', async () => {
	for (const lastPage of [[], [trackData(2)]]) {
		await assert.rejects(getCompleteSpotifyPlaylist('synthetic', 'playlist123', { pageSize: 2,
			fetchImpl: async (_url, options) => {
				const body = JSON.parse(options.body);
				return responseJson(playlistJson('Incomplete mix', 5,
					body.operationName === 'fetchPlaylist' ? [trackData(0)]
						: body.variables.offset === 0 ? [trackData(0), trackData(1)] : lastPage));
			}
		}), /incomplete/);
	}
});

test('fetchSpotifyCatalogSearch uses an application token and normalizes sections', async () => {
	let request;
	const result = await fetchSpotifyCatalogSearch('application-token', 'Miles Davis', {
		limit: 16,
		offset: 4,
		fetchImpl: async (url, options) => {
			request = { url, options };
			return responseJson({
				tracks: { items: [{ id: 'track-1', name: 'Track' }], total: 1 },
				playlists: { items: [null, { id: 'playlist-1', name: 'Playlist' }], total: 2 },
				albums: { items: [], total: 0 },
				artists: { items: [{ id: 'artist-1', name: 'Artist' }], total: 1 }
			});
		}
	});

	assert.equal(request.url.origin + request.url.pathname, 'https://api.spotify.com/v1/search');
	assert.equal(request.url.searchParams.get('q'), 'Miles Davis');
	assert.equal(request.url.searchParams.get('type'), 'track,playlist,album,artist');
	assert.equal(request.url.searchParams.get('limit'), '10');
	assert.equal(request.url.searchParams.get('offset'), '4');
	assert.equal(request.options.headers.Authorization, 'Bearer application-token');
	assert.equal(result.playlists.items.length, 1);
	assert.equal(result.tracks.items[0].id, 'track-1');
});

test('Spotify application tokens and album details use official API calls', async () => {
	const config = { spotifyClientId: 'client-id', spotifyClientSecret: 'client-secret' };
	let tokenRequest;
	const token = await fetchSpotifyClientCredentialsToken(config, async (url, options) => {
		tokenRequest = { url, options };
		return responseJson({ access_token: 'application-token', expires_in: 3600 });
	});
	assert.equal(token.access_token, 'application-token');
	assert.equal(String(tokenRequest.url), 'https://accounts.spotify.com/api/token');
	assert.equal(new URLSearchParams(tokenRequest.options.body).get('grant_type'), 'client_credentials');
	assert.match(tokenRequest.options.headers.Authorization, /^Basic /);

	let albumRequest;
	const album = await fetchSpotifyAlbum('application-token', 'album-123', async (url, options) => {
		albumRequest = { url, options };
		return responseJson({ id: 'album-123', name: 'Album', tracks: { items: [{ id: 'track-1' }] } });
	});
	assert.equal(album.id, 'album-123');
	assert.equal(albumRequest.url, 'https://api.spotify.com/v1/albums/album-123');
	assert.equal(albumRequest.options.headers.Authorization, 'Bearer application-token');
});

test('spotifyWebApiTrackToStoredTrack keeps enough metadata for Youplayer imports', () => {
	const track = spotifyWebApiTrackToStoredTrack({
		id: 'track123',
		name: 'Track name',
		artists: [{ name: 'Artist A' }, { name: 'Artist B' }],
		album: {
			name: 'Album name',
			images: [{ url: 'cover.jpg' }]
		},
		track_number: 7,
		external_urls: {
			spotify: 'https://open.spotify.com/track/track123'
		}
	});

	assert.deepEqual(track, {
		title: 'Track name',
		artist: 'Artist A, Artist B',
		album: 'Album name',
		id: '',
		albumCoverURL: 'cover.jpg',
		trackNumber: 7,
		url: 'https://open.spotify.com/track/track123',
		type: 'spotify'
	});
});
