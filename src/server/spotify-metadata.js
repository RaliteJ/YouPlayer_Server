import { normalizePathfinderTrack } from './media-utils.js';

function getBestImageUrl(images) {
	return images?.slice?.(-1)?.[0]?.url || images?.[0]?.url || "";
}

export function spotifyTrackToStoredTrack(data) {
	const artists = (data.artists?.items || data.artists || [])
		.map((artist) => artist?.profile?.name || artist?.name)
		.filter(Boolean)
		.join(", ");
	const album = data.albumOfTrack || {};
	const trackId = data.uri?.split(':')?.[2] || "";

	return {
		title: data.name || "",
		artist: artists,
		album: album.name || "",
		id: "",
		albumCoverURL: getBestImageUrl(album.coverArt?.sources),
		trackNumber: data.trackNumber || 0,
		...(Number(data.duration?.totalMilliseconds) > 0 ? { duration_ms: data.duration.totalMilliseconds } : {}),
		url: trackId ? `https://open.spotify.com/track/${trackId}` : "",
		type: "spotify"
	};
}

export function spotifyWebApiTrackToStoredTrack(track = {}) {
	const artists = (track.artists || [])
		.map((artist) => artist?.name)
		.filter(Boolean)
		.join(", ");
	const image = track.album?.images?.[0]?.url || track.album?.images?.slice?.(-1)?.[0]?.url || "";
	const trackUrl = track.external_urls?.spotify || (track.id ? `https://open.spotify.com/track/${track.id}` : "");

	return {
		title: track.name || "",
		artist: artists,
		album: track.album?.name || "",
		id: "",
		albumCoverURL: image,
		trackNumber: track.track_number || 0,
		...(Number(track.duration_ms) > 0 ? { duration_ms: track.duration_ms } : {}),
		url: trackUrl,
		type: "spotify"
	};
}

export function spotifyPathfinderTrackData(item) {
	return item?.itemV2?.data || item?.item?.data || item?.data || item?.featured?.data || item || null;
}

function spotifyPlaylistV2(json = {}) {
	return json?.data?.playlistV2 || {};
}

export function spotifyPlaylistContentItems(json = {}) {
	const items = spotifyPlaylistV2(json)?.content?.items;
	return Array.isArray(items) ? items : [];
}

export function spotifyPlaylistName(json = {}) {
	return spotifyPlaylistV2(json)?.name || "spotify-playlist";
}

export function spotifyPlaylistTotal(json = {}, fallback = 0) {
	const total = Number(spotifyPlaylistV2(json)?.content?.totalCount);
	return Number.isInteger(total) && total >= 0 ? total : fallback;
}

export function pathfinderItemsToStoredTracks(items = []) {
	return items
		.map(spotifyPathfinderTrackData)
		.filter(Boolean)
		.map((data) => spotifyTrackToStoredTrack(data))
		.filter((track) => track.title || track.url);
}

export function pathfinderItemsToApiTracks(items = []) {
	return items
		.map((item) => normalizePathfinderTrack(item))
		.filter((track) => track.name || track.id);
}

function getSpotifyTrackUrl(track) {
	if (typeof track.url === "string" && track.url.includes("open.spotify.com/track/")) {
		return track.url;
	}

	const uriId = typeof track.uri === "string" ? track.uri.split(':')?.[2] : "";
	const directId = typeof track.spotifyId === "string" ? track.spotifyId : "";
	const trackId = uriId || directId;
	return trackId ? `https://open.spotify.com/track/${trackId}` : "";
}

export function toFinalStoredTrack(track) {
	const storedTrack = {
		title: track.title || track.name || "",
		artist: track.artist || "",
		album: track.album || "",
		id: track.id || "",
		albumCoverURL: track.albumCoverURL || "",
		trackNumber: track.trackNumber || 0
	};

	const spotifyUrl = getSpotifyTrackUrl(track);
	if (Number(track.duration_ms) > 0) storedTrack.duration_ms = track.duration_ms;
	if (spotifyUrl) {
		storedTrack.url = spotifyUrl;
		storedTrack.type = "spotify";
	}

	return storedTrack;
}

export function parseSpotifyPublicPlaylist(html, playlistId) {
	const encodedState = String(html || '').match(/<script id="initialState" type="text\/plain">(.*?)<\/script>/s)?.[1];
	if (!encodedState) throw new Error('Metadonnees de playlist Spotify absentes');
	const state = JSON.parse(Buffer.from(decodeURIComponent(encodedState), 'base64').toString('utf8'));
	const playlist = state?.entities?.items?.[`spotify:playlist:${playlistId}`];
	if (!playlist?.name || !Array.isArray(playlist?.content?.items)) {
		throw new Error('Playlist Spotify publique illisible');
	}
	if (Number(playlist.content.totalCount) > playlist.content.items.length) {
		throw new Error('Playlist Spotify publique incomplete');
	}
	return {
		name: playlist.name,
		tracks: playlist.content.items
			.map(spotifyPathfinderTrackData)
			.filter(Boolean)
			.map(spotifyTrackToStoredTrack)
	};
}
