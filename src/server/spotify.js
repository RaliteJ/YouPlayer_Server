import { getSpotifyAnonymousToken } from './spotify-anonymous-token.js';
import { getSpotifyPathfinderJson } from './spotify-pathfinder-http.js';
export {
 browserLaunchOptions, getSpotifyAnonymousToken, clearSpotifyAnonymousToken,
 spotifyLoginSandboxStatus, runSpotifyLoginSandboxProbe, captureSpotifyPathfinderJson
} from './spotify-web-player.js';
import { getCompleteSpotifyPlaylist } from './spotify-playlist-api.js';
export { getCompleteSpotifyPlaylist, getSpotifyPlaylistTracksPage } from './spotify-playlist-api.js';
import {
	spotifyTrackToStoredTrack,
	toFinalStoredTrack,
	parseSpotifyPublicPlaylist
} from './spotify-metadata.js';
export { spotifyWebApiTrackToStoredTrack, parseSpotifyPublicPlaylist } from './spotify-metadata.js';
import { resolveMusicTrack } from './music-resolver.js';
import { logger } from './logger.js';
import { getSpotifyResourceId } from './media-utils.js';

async function mapWithConcurrency(items, limit, mapper) {
	const results = new Array(items.length);
	let index = 0;

	async function worker() {
		while (index < items.length) {
			const currentIndex = index++;
			results[currentIndex] = await mapper(items[currentIndex], currentIndex);
		}
	}

	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

export async function resolvePlaylistYoutubeIds(tracks, { resolveTrack = resolveMusicTrack } = {}) {
	return mapWithConcurrency(tracks, 3, async (track, index) => {
		let id = '';
		try { id = (await resolveTrack(track)).id; } catch {
			logger.warn("Correspondance musicale introuvable pendant l'import Spotify");
		}
		logger.debug(`Import Spotify ${index + 1}/${tracks.length}:`, track.title, id || "ID introuvable");
		return toFinalStoredTrack({ ...track, id });
	});
}

async function get_playlist_from_public_page(url, { fetchImpl = fetch } = {}) {
	const playlistId = getSpotifyResourceId(url, 'playlist');
	const response = await fetchImpl(`https://open.spotify.com/playlist/${playlistId}`, {
		signal: AbortSignal.timeout(12_000)
	});
	if (!response.ok) throw new Error(`Page Spotify indisponible (${response.status})`);
	const playlist = parseSpotifyPublicPlaylist(await response.text(), playlistId);
	return { ...playlist, tracks: await resolvePlaylistYoutubeIds(playlist.tracks) };
}

function safePlaylistFileName(name) {
	return String(name || "spotify-playlist")
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120) || "spotify-playlist";
}

async function get_playlist_with_pathfinder_http(url) {
	const playlistId = await get_id_playlist(url);
	const json = await getSpotifyPathfinderJson(`playlist/${playlistId}`, "playlistV2", { completePlaylist: true });
	const playlistName = json.data.playlistV2.name;
	const tracks = await scrap_spotify_playlist(json) || [];

	if (!tracks.length) {
		throw new Error("Aucun titre Spotify trouvé dans la playlist.");
	}

	return {
		name: playlistName,
		tracks: await resolvePlaylistYoutubeIds(tracks)
	};
}

async function get_playlist_with_legacy_token(url) {
	const playlistId = await get_id_playlist(url);
	const token = await getSpotifyAnonymousToken(url);
	const dat = await get_playlist_2(token, playlistId);

	if (!Array.isArray(dat?.[0]) || !dat[0].length) {
		throw new Error("Aucun titre Spotify trouvé dans la playlist.");
	}

	return {
		name: dat[1],
		tracks: await resolvePlaylistYoutubeIds(dat[0])
	};
}

export async function importSpotifyPlaylist(url, {
	getLegacyPlaylist = get_playlist_with_legacy_token,
	getPathfinderPlaylist = get_playlist_with_pathfinder_http,
	getCapturedPlaylist = getPathfinderPlaylist,
	getPublicPlaylist = get_playlist_from_public_page
} = {}) {
	let importedPlaylist;
	try {
		importedPlaylist = await getLegacyPlaylist(url);
	} catch (err) {
		logger.warn("Import Spotify paginé échoué, fallback HTTP:", err.message);
		try {
			importedPlaylist = await getCapturedPlaylist(url);
		} catch (httpErr) {
			logger.warn("Import Spotify HTTP échoué, fallback page publique:", httpErr.message);
			importedPlaylist = await getPublicPlaylist(url);
		}
	}

	return {
		name: safePlaylistFileName(importedPlaylist.name),
		tracks: importedPlaylist.tracks
	};
}

async function scrap_spotify_playlist (data){
	try {
		const jsonData = data

		const items = jsonData?.data?.playlistV2?.content?.items || [];
		const result = items.map(item => {
			const data = item?.itemV2?.data || item?.item?.data || item?.data;
			if (!data) return null;

			return spotifyTrackToStoredTrack(data);
		}).filter(e => e !== null);
		return result

	} catch (e) {
		logger.error("Erreur lors de la lecture du JSON :", e.message);
	}

}

async function get_playlist_2(bearerToken, playlistId){
	const playlist = await getCompleteSpotifyPlaylist(bearerToken, playlistId);
	if (!Array.isArray(playlist.tracks)) {
		throw new Error("Titres playlist Spotify introuvables.");
	}
	logger.debug("Titres Spotify récupérés:", playlist.tracks.length, "/", playlist.total);
	return [playlist.tracks, playlist.name]
}

async function get_id_playlist(url) {
	return getSpotifyResourceId(url, 'playlist');
}
