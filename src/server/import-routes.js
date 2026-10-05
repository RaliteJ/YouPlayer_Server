import { importSpotifyPlaylist } from './spotify.js';
import { decodeHtmlEntities, safePlaylistFileName } from './media-utils.js';
import { normalizePlaylistName } from './stores/store-utils.js';
import { requireYoutubeApiKey, sanitizeTrackInput } from './validation.js';
import { logger } from './logger.js';

export async function getYoutubePlaylistTracks(playlistId, { apiKey: API_KEY, fetchImpl = fetch }) {
	const apiKey = requireYoutubeApiKey(API_KEY);
	let pageToken = "";
	const tracks = [];

	do {
		const url = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
		url.searchParams.set("part", "snippet");
		url.searchParams.set("maxResults", "50");
		url.searchParams.set("playlistId", playlistId);
		url.searchParams.set("key", apiKey);
		if (pageToken) {
			url.searchParams.set("pageToken", pageToken);
		}

		const response = await fetchImpl(url);
		if (!response.ok) {
			throw new Error(`Import YouTube impossible: ${response.status}`);
		}
		const data = await response.json();
		for (const item of data.items || []) {
			const snippet = item.snippet || {};
			const videoId = snippet.resourceId?.videoId;
			if (!videoId || snippet.title === "Deleted video" || snippet.title === "Private video") {
				continue;
			}
			tracks.push({
				title: decodeHtmlEntities(snippet.title || ""),
				artist: decodeHtmlEntities(snippet.videoOwnerChannelTitle || snippet.channelTitle || ""),
				album: "",
				id: videoId,
				url: `https://www.youtube.com/watch?v=${videoId}`,
				type: "youtube",
				albumCoverURL: snippet.thumbnails?.high?.url || snippet.thumbnails?.default?.url || "",
				trackNumber: snippet.position || 0
			});
		}
		pageToken = data.nextPageToken || "";
	} while (pageToken);

	return tracks;
}

export function registerImportRoutes(app, {
	requireAuth, appendPlaylistItemsForRequest, recordAction, sendJsonError, youtubeApiKey,
	importSpotifyPlaylist: importPlaylist = importSpotifyPlaylist, fetchImpl = fetch
}) {
	app.post("/spotify_import_playlist", requireAuth, async (req, res) => {
		try {
			const { url, playlist } = req.body;
			if (!url || !String(url).includes("open.spotify.com/playlist/")) {
				return res.status(400).json({ error: "Lien de playlist Spotify invalide" });
			}

			const importedPlaylist = await importPlaylist(url);
			const targetPlaylist = normalizePlaylistName(playlist || safePlaylistFileName(importedPlaylist.name));

			await appendPlaylistItemsForRequest(req, targetPlaylist, importedPlaylist.tracks);
			await recordAction(req, "playlist.spotify_import", "playlist", targetPlaylist, {
				source: url,
				count: importedPlaylist.tracks.length
			});
			res.json({
				message: "Playlist Spotify importée",
				playlist: targetPlaylist,
				count: importedPlaylist.tracks.length
			});
		} catch (err) {
			logger.error("Erreur spotify_import_playlist:", err);
			sendJsonError(res, err, "Import Spotify impossible", 400);
		}
	});

	app.post("/spotify_import_browser_playlist", requireAuth, async (req, res) => {
		try {
			const rawItems = req.body?.items;
			if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 50) {
				return res.status(400).json({ error: "Lot Spotify invalide (1 a 50 titres requis)" });
			}
			const playlist = normalizePlaylistName(req.body?.playlist || "spotify-playlist");
			const items = rawItems.map((item) => sanitizeTrackInput(item, { allowLocal: false }));
			await appendPlaylistItemsForRequest(req, playlist, items);
			await recordAction(req, "playlist.spotify_browser_import", "playlist", playlist, {
				count: items.length
			});
			res.json({
				message: "Titres Spotify importes depuis l'extension",
				playlist,
				count: items.length
			});
		} catch (err) {
			logger.error("Erreur spotify_import_browser_playlist:", err);
			sendJsonError(res, err, "Import Spotify extension impossible", 400);
		}
	});

	app.post("/youtube_import_playlist", requireAuth, async (req, res) => {
		try {
			const { playlistId, title, playlist } = req.body;
			if (!playlistId) {
				return res.status(400).json({ error: "Playlist YouTube invalide" });
			}

			const tracks = await getYoutubePlaylistTracks(playlistId, { apiKey: youtubeApiKey, fetchImpl });
			const targetPlaylist = normalizePlaylistName(playlist || safePlaylistFileName(title));

			await appendPlaylistItemsForRequest(req, targetPlaylist, tracks);
			await recordAction(req, "playlist.youtube_import", "playlist", targetPlaylist, {
				playlistId,
				count: tracks.length
			});
			res.json({
				message: "Playlist YouTube importée",
				playlist: targetPlaylist,
				count: tracks.length
			});
		} catch (err) {
			logger.error("Erreur youtube_import_playlist:", err);
			sendJsonError(res, err, "Import YouTube impossible", 400);
		}
	});

}
