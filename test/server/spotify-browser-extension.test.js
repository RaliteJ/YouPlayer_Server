import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extensionFile, extensionAvailable } from '../../scripts/spotify-extension-path.mjs';
const test = extensionAvailable ? nodeTest : (name, fn) => nodeTest(name, { skip: 'Pont optionnel non configure (YOUPLAYER_EXTENSION_DIR)' }, fn);
const {
	fetchBrowserSpotifyLikedTracks,
	fetchBrowserSpotifyPlaylist,
	fetchBrowserSpotifyPlaylists,
	LIKED_SONGS_PLAYLIST_ID
} = extensionAvailable ? await import(extensionFile('spotify-client.js')) : {};
const {
	getAllowedYouPlayerOrigins,
	normalizeYouPlayerOrigin
} = extensionAvailable ? await import(extensionFile('youplayer-origin.js')) : {};

test('browser extension manifest supports Firefox and Chromium MV3 backgrounds', async () => {
	const manifestUrl = extensionFile('manifest.json');
	const packageUrl = extensionFile('package.json');
	const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
	const packageJson = JSON.parse(await readFile(packageUrl, 'utf8'));

	assert.equal(manifest.version, packageJson.version);
	assert.equal(manifest.icons['96'], 'icons/youplayer.svg');
	assert.deepEqual(manifest.background.scripts, ['background.js']);
	assert.equal(manifest.background.service_worker, 'background.js');
	assert.equal(manifest.background.type, 'module');
	assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '128.0');
	assert.deepEqual(
		manifest.browser_specific_settings.gecko.data_collection_permissions.required,
		['websiteContent']
	);
	assert.equal(manifest.content_scripts[0].world, 'MAIN');
	assert.ok(manifest.content_scripts.every((script) => script.matches.every((origin) => origin === 'https://open.spotify.com/*')));
	assert.ok(!manifest.host_permissions.includes('https://*/*'));
	assert.deepEqual(manifest.optional_host_permissions, ['https://*/*']);
	assert.ok(manifest.host_permissions.includes('https://api-partner.spotify.com/*'));
	assert.ok(!manifest.host_permissions.includes('https://api.spotify.com/*'));
});

test('browser extension normalizes the configurable YouPlayer origin', async () => {
	assert.equal(
		normalizeYouPlayerOrigin(' https://192.168.1.50:8443/?view=add_spotify#spotify '),
		'https://192.168.1.50:8443'
	);
	assert.equal(normalizeYouPlayerOrigin('http://192.168.1.50:8443'), '');
	assert.equal(normalizeYouPlayerOrigin('not-an-origin'), '');
});

test('browser extension trusts only the explicitly configured origin', async () => {
	const extensionApi = {
		storage: {
			local: {
				async get() {
					return { youplayerOrigin: 'https://192.168.1.50:8443/path?q=1' };
				}
			}
		}
	};

	const origins = await getAllowedYouPlayerOrigins(extensionApi);
	assert.deepEqual([...origins], ['https://192.168.1.50:8443']);
});

function jsonResponse(data, status = 200, headers = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: {
			get(name) {
				return headers[String(name).toLowerCase()] || null;
			}
		},
		json: async () => data
	};
}

test('browser extension exposes the Spotify retry delay on a 429', async () => {
	const fetchImpl = async () => jsonResponse({
		error: { status: 429, message: 'API rate limit exceeded' }
	}, 429, { 'retry-after': '42' });

	await assert.rejects(
		() => fetchBrowserSpotifyPlaylists('webplayer-token', fetchImpl),
		(error) => {
			assert.equal(error.status, 429);
			assert.equal(error.retryAfterSeconds, 42);
			assert.match(error.message, /42 secondes/);
			return true;
		}
	);
});

test('browser extension fetches every page of the current WebPlayer playlists', async () => {
	const playlists = Array.from({ length: 75 }, (_, index) => ({
		item: {
			__typename: 'PlaylistResponseWrapper',
			data: {
				__typename: 'Playlist',
				uri: `spotify:playlist:playlist${String(index).padStart(10, '0')}`,
				name: `Playlist ${index}`,
				images: { items: [] }
			}
		}
	}));
	const calls = [];
	const fetchImpl = async (url, options) => {
		const body = JSON.parse(options.body);
		const { offset, limit } = body.variables;
		calls.push({
			url,
			operationName: body.operationName,
			offset,
			authorization: options.headers.Authorization,
			hash: body.extensions.persistedQuery.sha256Hash
		});
		return jsonResponse({
			data: {
				me: {
					libraryV3: {
						__typename: 'LibraryPage',
						items: playlists.slice(offset, offset + limit),
						totalCount: playlists.length
					}
				}
			}
		});
	};

	const dynamicHash = 'a'.repeat(64);
	const result = await fetchBrowserSpotifyPlaylists('webplayer-token', {
		fetchImpl,
		queryHashes: { libraryV3: dynamicHash }
	});

	assert.equal(result.items.length, 76);
	assert.equal(result.total, 76);
	assert.equal(result.items[0].id, LIKED_SONGS_PLAYLIST_ID);
	assert.equal(result.items[0].uri, 'spotify:collection:tracks');
	assert.equal(result.items[1].name, 'Playlist 0');
	assert.deepEqual(calls, [
		{
			url: 'https://api-partner.spotify.com/pathfinder/v2/query',
			operationName: 'libraryV3',
			offset: 0,
			authorization: 'Bearer webplayer-token',
			hash: dynamicHash
		},
		{
			url: 'https://api-partner.spotify.com/pathfinder/v2/query',
			operationName: 'libraryV3',
			offset: 50,
			authorization: 'Bearer webplayer-token',
			hash: dynamicHash
		}
	]);
});

test('browser extension paginates every liked Spotify track through Pathfinder', async () => {
	const tracks = Array.from({ length: 125 }, (_, index) => ({
		addedAt: { isoString: '2026-08-03T00:00:00Z' },
		track: {
			_uri: `spotify:track:liked${String(index).padStart(10, '0')}`,
			data: {
				__typename: 'Track',
				name: `Like ${index}`,
				artists: {
					items: [{ data: { uri: 'spotify:artist:artist123456', profile: { name: 'Artiste' } } }]
				},
				albumOfTrack: { uri: 'spotify:album:album1234567', name: 'Album', coverArt: { sources: [] } },
				duration: { totalMilliseconds: 180000 }
			}
		}
	}));
	const calls = [];
	const dynamicHash = 'b'.repeat(64);
	const fetchImpl = async (_url, options) => {
		const body = JSON.parse(options.body);
		const { offset, limit } = body.variables;
		calls.push({
			operationName: body.operationName,
			offset,
			limit,
			hash: body.extensions.persistedQuery.sha256Hash
		});
		return jsonResponse({
			data: {
				me: {
					library: {
						tracks: {
							__typename: 'UserLibraryTrackPage',
							items: tracks.slice(offset, offset + limit),
							totalCount: tracks.length,
							pagingInfo: { offset, limit }
						}
					}
				}
			}
		});
	};

	const result = await fetchBrowserSpotifyLikedTracks('webplayer-token', {
		fetchImpl,
		queryHashes: { fetchLibraryTracks: dynamicHash }
	});

	assert.equal(result.id, LIKED_SONGS_PLAYLIST_ID);
	assert.equal(result.tracks.total, 125);
	assert.equal(result.tracks.items.length, 125);
	assert.equal(result.tracks.items[0].track.name, 'Like 0');
	assert.equal(
		result.tracks.items[0].track.external_urls.spotify,
		'https://open.spotify.com/track/liked0000000000'
	);
	assert.equal(result.tracks.items[124].track.name, 'Like 124');
	assert.deepEqual(calls, [
		{ operationName: 'fetchLibraryTracks', offset: 0, limit: 50, hash: dynamicHash },
		{ operationName: 'fetchLibraryTracks', offset: 50, limit: 50, hash: dynamicHash },
		{ operationName: 'fetchLibraryTracks', offset: 100, limit: 50, hash: dynamicHash }
	]);
});

test('browser extension paginates and normalizes Pathfinder playlist items for YouPlayer', async () => {
	const tracks = Array.from({ length: 205 }, (_, index) => ({
		itemV2: {
			data: {
				__typename: 'Track',
				uri: `spotify:track:track${String(index).padStart(10, '0')}`,
				name: `Titre ${index}`,
				artists: {
					items: [{ data: { uri: 'spotify:artist:artist123456', profile: { name: 'Artiste' } } }]
				},
				albumOfTrack: { uri: 'spotify:album:album1234567', name: 'Album', coverArt: { sources: [] } },
				duration: { totalMilliseconds: 180000 }
			}
		}
	}));
	const calls = [];
	const fetchImpl = async (_url, options) => {
		const body = JSON.parse(options.body);
		calls.push({ operationName: body.operationName, offset: body.variables.offset, limit: body.variables.limit });
		if (body.operationName === 'fetchPlaylist') {
			return jsonResponse({
				data: {
					playlistV2: {
						__typename: 'Playlist',
						uri: 'spotify:playlist:playlist1234567890',
						name: 'Ma playlist',
						images: { items: [] },
						content: { totalCount: tracks.length, items: tracks.slice(0, 1) }
					}
				}
			});
		}
		const { offset, limit } = body.variables;
		return jsonResponse({
			data: {
				playlistV2: {
					content: {
						totalCount: tracks.length,
						items: tracks.slice(offset, offset + limit)
					}
				}
			}
		});
	};

	const result = await fetchBrowserSpotifyPlaylist(
		'webplayer-token',
		'playlist1234567890',
		fetchImpl
	);

	assert.equal(result.name, 'Ma playlist');
	assert.equal(result.tracks.total, 205);
	assert.equal(result.tracks.items.length, 205);
	assert.equal(result.tracks.items[0].track.name, 'Titre 0');
	assert.equal(result.tracks.items[204].track.name, 'Titre 204');
	assert.deepEqual(calls, [
		{ operationName: 'fetchPlaylist', offset: 0, limit: 1 },
		{ operationName: 'fetchPlaylistContents', offset: 0, limit: 100 },
		{ operationName: 'fetchPlaylistContents', offset: 100, limit: 100 },
		{ operationName: 'fetchPlaylistContents', offset: 200, limit: 100 }
	]);
});
