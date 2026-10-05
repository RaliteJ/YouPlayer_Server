import fs from 'node:fs';
import { promises as fs_promises } from 'node:fs';
import { LIKED_PLAYLIST, trackLikeKey } from '../client-utils.js';
import { enrichYoutubeTrack } from './media-utils.js';
import { libraryPreferences, updateLibraryPreferences } from './library-preferences.js';
import { normalizePlaylistName } from './stores/store-utils.js';
import { RequestValidationError, resolveStoredFile, safeStoredFileName, sanitizeTrackInput,
	validateLocalUploadMetadata, validatePlaylistMutationPayload } from './validation.js';
import { logger } from './logger.js';

export function registerPlaylistRoutes(app, {
	authEnabled: AUTH_ENABLED, store: youplayerStore, localSongDir: LOCAL_SONG_DIR,
	requireAuth, uploadLocalAudio, playlistAccess, validateSessionTrack,
	removeSongFromSessionQueue, recordAction, sendJsonError
}) {
	const { playlistFilesForRequest, playlistItemsForRequest, playlistSummariesForRequest,
		appendPlaylistItemsForRequest, deletePlaylistItemForRequest, playlistTracksForRequest,
		setTrackLikedForRequest } = playlistAccess;
	app.get('/liked_tracks', requireAuth, async (req, res) => {
		try { res.json({ items: await playlistItemsForRequest(req, LIKED_PLAYLIST) }); }
		catch (error) { sendJsonError(res, error); }
	});
	app.post('/liked_tracks', requireAuth, async (req, res) => {
		try {
			const { trackId, playlist, index, song, liked, key } = req.body || {};
			if (typeof liked !== 'boolean') throw new RequestValidationError('Like invalide');
			let track;
			if (song !== undefined) {
				if (playlist !== undefined || trackId !== undefined) throw new RequestValidationError('Like invalide');
				track = sanitizeTrackInput(song, { allowLocal: false });
			} else if (playlist !== undefined) {
				if (!Number.isInteger(index) || index < 0) throw new RequestValidationError('Like invalide');
				track = (await playlistItemsForRequest(req, normalizePlaylistName(playlist)))[index];
				if (!track) throw new RequestValidationError('Musique introuvable', 404);
			} else {
				if (!Number.isInteger(trackId)) throw new RequestValidationError('Like invalide');
				track = validateSessionTrack(req, trackId);
			}
			if (!key || key !== trackLikeKey(track)) throw new RequestValidationError('Le morceau a changé', 409);
			const items = await setTrackLikedForRequest(req, track, liked);
			res.json({ items });
		} catch (error) { sendJsonError(res, error, 'Like impossible', 400); }
	});

	app.post("/update_playlist", requireAuth, async (req, res) => {
		try {
			const { playlist, song } = validatePlaylistMutationPayload(req.body || {});
			const track_info = await enrichYoutubeTrack(song)
			if (track_info.type === "local" && !fs.existsSync(resolveStoredFile(LOCAL_SONG_DIR, track_info.url))) {
				throw new RequestValidationError("Fichier local introuvable", 404);
			}
			logger.debug("Ajout playlist:", playlist, track_info.type, track_info.title);
			const normalizedPlaylist = normalizePlaylistName(playlist);
			await appendPlaylistItemsForRequest(req, normalizedPlaylist, track_info);
			await recordAction(req, "playlist.item.add", "playlist", normalizedPlaylist, {
				title: track_info.title || "",
				type: track_info.type || ""
			});
			res.json({ message: "Playlist mise à jour" });
		} catch (err) {
			logger.error("Erreur update_playlist:", err);
			sendJsonError(res, err, "Playlist impossible a mettre a jour", 400);
		}
	});

	app.post("/delete_from_playlist", requireAuth, async (req, res) => {
		try {
			const { playlist, index, key } = req.body;
			const songIndex = Number(index);
			if (!Number.isInteger(songIndex) || songIndex < 0) {
				return res.status(400).json({ error: "Index de musique invalide" });
			}

			const normalizedPlaylist = normalizePlaylistName(playlist);
			if (key !== undefined) {
				const current = (await playlistItemsForRequest(req, normalizedPlaylist))[songIndex];
				if (!current || key !== trackLikeKey(current)) {
					throw new RequestValidationError('Le morceau a changé', 409);
				}
			}
			const removed = await deletePlaylistItemForRequest(req, normalizedPlaylist, songIndex);
			if (!removed) {
				return res.status(404).json({ error: "Musique introuvable dans la playlist" });
			}

			await recordAction(req, "playlist.item.delete", "playlist", normalizedPlaylist, {
				index: songIndex,
				title: removed.title || ""
			});
			removeSongFromSessionQueue(req, normalizedPlaylist, songIndex);
			req.session.save(() => {
				res.json({ message: "Musique supprimée", removed });
			});
		} catch (err) {
			logger.error("Erreur delete_from_playlist:", err);
			res.status(err.statusCode || 400).json({ error: err.message });
		}
	});

	app.get("/playlist_preview", requireAuth, async (req, res) => {
		try {
			const playlist = normalizePlaylistName(req.query.playlist);
			const tracks = await playlistTracksForRequest(req, playlist);
			res.json(tracks);
		} catch (err) {
			logger.error("Erreur playlist_preview:", err);
			if (err.message === "Nom de playlist invalide") {
				return res.status(400).json({ error: err.message });
			}
			if (err.code === "ENOENT" || err.message === "Playlist introuvable") {
				return res.status(404).json({ error: "Playlist introuvable" });
			}
			res.status(500).json({ error: "Impossible de charger cette playlist." });
		}
	});

	app.get("/different_playlist", requireAuth, async (req, res) => {
	   try {
			const playlists = await playlistFilesForRequest(req);
	       res.json(playlists);
	   } catch (err) {
	       logger.error("Erreur lors de la lecture du répertoire:", err);
	       res.status(500).json({ error: "Impossible de lire le répertoire des playlists." });
	   }
	});

	app.get("/playlist_preferences", requireAuth, async (req, res) => {
		try {
			const preferences = AUTH_ENABLED
				? await youplayerStore.getLibraryPreferences(req.session.userId)
				: libraryPreferences(req.session.libraryPreferences);
			const available = new Set([...(await playlistFilesForRequest(req)), LIKED_PLAYLIST]);
			res.json({
				pinned: preferences.pinned.filter((name) => available.has(name)),
				recent: preferences.recent.filter((name) => available.has(name))
			});
		} catch (err) { sendJsonError(res, err); }
	});

	app.post("/playlist_preferences", requireAuth, async (req, res) => {
		try {
			const { action, playlist, enabled } = req.body || {};
			const change = { action, playlist, enabled };
			updateLibraryPreferences({}, change); // Validate before accessing another resource.
			const available = [...new Set([...(await playlistFilesForRequest(req)), LIKED_PLAYLIST])];
			if (action !== 'clear_recent' && !available.includes(playlist)) {
				throw new RequestValidationError("Playlist introuvable", 404);
			}
			const preferences = AUTH_ENABLED
				? await youplayerStore.updateLibraryPreferences(req.session.userId, change)
				: (req.session.libraryPreferences = updateLibraryPreferences(req.session.libraryPreferences, change, available));
			res.json(preferences);
		} catch (err) { sendJsonError(res, err, "Preference impossible a enregistrer", 400); }
	});

	app.get("/playlist_summaries", requireAuth, async (req, res) => {
		try {
			const summaries = await playlistSummariesForRequest(req);
			res.json(summaries);
		} catch (err) {
			logger.error("Erreur playlist_summaries:", err);
			res.status(500).json({ error: "Impossible de lire les playlists." });
		}
	});

	app.post('/upload_to_playlist', requireAuth, uploadLocalAudio, async (req, res) => {
		try {
			if (!req.file) {
				return res.status(400).json({ error: "Aucun fichier reçu" });
			}
			const playlistName = req.body.playlist;
			logger.debug("Fichier reçu:", req.file.originalname, req.file.filename);
			const song_item = {
			...validateLocalUploadMetadata(req.body, req.file.originalname || 'audio'),
			"url": safeStoredFileName(req.file.filename),
			"type": "local"
			}
			const normalizedPlaylist = normalizePlaylistName(playlistName);
			await appendPlaylistItemsForRequest(req, normalizedPlaylist, song_item);
			await recordAction(req, "playlist.local_upload", "playlist", normalizedPlaylist, {
				filename: req.file.filename,
				originalName: req.file.originalname
			});

			res.json({
				message: "Fichier bien reçu !",
				filename: req.file.filename
			});
		} catch (err) {
			if (req.file?.path) {
				await fs_promises.rm(req.file.path, { force: true }).catch(() => {});
			}
			logger.error("Erreur upload_to_playlist:", err);
			res.status(400).json({ error: err.message });
		}
	});

}
