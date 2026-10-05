import {
 spotifyPlaylistContentItems, spotifyPlaylistName, spotifyPlaylistTotal,
 pathfinderItemsToStoredTracks, pathfinderItemsToApiTracks
} from './spotify-metadata.js';

const SPOTIFY_PLAYLIST_PAGE_SIZE = 100;
const SPOTIFY_PLAYLIST_QUERY_HASH = "7982b11e21535cd2594badc40030b745671b61a1fa66766e569d45e6364f3422";

async function fetchSpotifyPlaylistPathfinderJson(bearerToken, playlistId, {
	offset = 0,
	limit = SPOTIFY_PLAYLIST_PAGE_SIZE,
	operation = "fetchPlaylistContents",
	fetchImpl = fetch
} = {}) {
	const TARGET_URL = 'https://api-partner.spotify.com/pathfinder/v2/query';
	const request = await get_payload(bearerToken, playlistId, limit, operation, offset);
	const response = await fetchImpl(TARGET_URL, request);

	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Spotify partner ${response.status}: ${body.slice(0, 240)}`);
	}

	return response.json();
}

async function getSpotifyPlaylistInfo(bearerToken, playlistId, fetchImpl = fetch) {
	const json = await fetchSpotifyPlaylistPathfinderJson(bearerToken, playlistId, {
		offset: 0,
		limit: 1,
		operation: "fetchPlaylist",
		fetchImpl
	});
	const items = spotifyPlaylistContentItems(json);
	return {
		name: spotifyPlaylistName(json),
		total: spotifyPlaylistTotal(json, items.length)
	};
}

export async function getSpotifyPlaylistTracksPage(bearerToken, playlistId, {
	offset = 0,
	limit = SPOTIFY_PLAYLIST_PAGE_SIZE,
	fetchImpl = fetch
} = {}) {
	const safeOffset = Math.max(0, Number(offset) || 0);
	const safeLimit = Math.min(
		SPOTIFY_PLAYLIST_PAGE_SIZE,
		Math.max(1, Number(limit) || SPOTIFY_PLAYLIST_PAGE_SIZE)
	);
	const json = await fetchSpotifyPlaylistPathfinderJson(bearerToken, playlistId, {
		offset: safeOffset,
		limit: safeLimit,
		operation: "fetchPlaylistContents",
		fetchImpl
	});
	const rawItems = spotifyPlaylistContentItems(json);
	const total = spotifyPlaylistTotal(json, safeOffset + rawItems.length);
	const nextOffset = safeOffset + rawItems.length;

	return {
		name: spotifyPlaylistName(json),
		items: pathfinderItemsToApiTracks(rawItems),
		storedTracks: pathfinderItemsToStoredTracks(rawItems),
		total,
		limit: safeLimit,
		offset: safeOffset,
		fetched: rawItems.length,
		next: rawItems.length > 0 && nextOffset < total ? nextOffset : null
	};
}

export async function getCompleteSpotifyPlaylist(bearerToken, playlistId, {
	fetchImpl = fetch,
	pageSize = SPOTIFY_PLAYLIST_PAGE_SIZE
} = {}) {
	const info = await getSpotifyPlaylistInfo(bearerToken, playlistId, fetchImpl);
	const safePageSize = Math.min(
		SPOTIFY_PLAYLIST_PAGE_SIZE,
		Math.max(1, Number(pageSize) || SPOTIFY_PLAYLIST_PAGE_SIZE)
	);
	const tracks = [];
	let offset = 0;
	let expectedTotal = info.total;

	while (offset < Math.max(expectedTotal || safePageSize, safePageSize)) {
		const page = await getSpotifyPlaylistTracksPage(bearerToken, playlistId, {
			offset,
			limit: safePageSize,
			fetchImpl
		});
		if (!Number.isInteger(expectedTotal) || expectedTotal <= 0) {
			expectedTotal = page.total;
		}
		if (!page.fetched) {
			break;
		}
		tracks.push(...page.storedTracks);
		offset += page.fetched;
		if (!page.next || page.fetched < safePageSize) {
			break;
		}
	}

	if (offset < expectedTotal) throw new Error('Playlist Spotify incomplete');

	return {
		name: info.name,
		total: expectedTotal,
		tracks
	};
}

async function get_payload(bearerToken, playlistId, limit_tracks, operation, offset = 0){
    const payload = {
        variables: {
            uri: `spotify:playlist:${playlistId}`,
            offset,
            limit: limit_tracks,
            enableWatchFeedEntrypoint:false
        },
        operationName: operation,
        extensions: {
            persistedQuery: {
                version: 1,
                sha256Hash: SPOTIFY_PLAYLIST_QUERY_HASH
            }
        }
    };

    const json_request = {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${bearerToken}`,
            'Content-Type': 'application/json;charset=UTF-8',
            'Accept': 'application/json',
            'App-Platform': 'WebPlayer',
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
            'Accept-Language': 'fr',
            'Sec-Fetch-Dest': 'empty',
            'Sec-Fetch-Mode': 'cors',
            'Sec-Fetch-Site': 'same-site'
        },
        body: JSON.stringify(payload)
    }
    return json_request

}
