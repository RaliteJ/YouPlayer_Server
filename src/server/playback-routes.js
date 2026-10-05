import fs, { promises as fs_promises } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { LIKED_PLAYLIST, trackLikeKey } from '../client-utils.js';
import { readNativeTransition, saveNextResponse } from './native-transitions.js';
import { check_downloaded, chargement_video, deleteDownloadedTrack } from './download.js';
import { normalizePlaylistName } from './stores/store-utils.js';
import { logger } from './logger.js';
import { RequestValidationError, validatePlaybackCollection, resolveStoredFile, sanitizeTrackInput, validatePlaylistSelectionPayload } from './validation.js';
import {
	getUpcomingQueue,
	buildControlledQueue,
	getPlaybackCacheEvictions,
	gestion_ecoute as dequeueNextTrack,
	listen_after as listenAfterQueue,
	order_playlist,
	playbackState,
	rememberCurrentTrack,
	takePreviousTrack,
	preloadUpcomingSongs as preloadQueueSongs,
	removeSongFromSessionQueue as removeTrackFromSessionQueue,
	syncSessionQueue,
	stablePlaylistTracks
} from './queue.js';

export function registerPlaybackRoutes(app, {
	config, firstTrackStreams, playlistAccess, requireAuth, recordAction, sendJsonError
}) {
	const MUSIQ_DIR = config.musiqDir;
	const LOCAL_SONG_DIR = config.localSongDir;
	const AUTH_ENABLED = config.authEnabled;
	const { playlistItemsForRequest, playlistTracksForRequest, deletePlaylistForRequest } = playlistAccess;

	function streamPrincipal(req) {
		return {
			userId: AUTH_ENABLED ? req.session?.userId : null,
			sessionId: req.sessionID
		};
	}

	function specialStreamResponse(req, record) {
		return {
			mode: "special_stream",
			stream_id: record.id,
			audio_url: `/audio/${record.id}`,
			status: record.state,
			first_track_next_enabled: record.nextEnabled !== false,
			...playbackState(req)
		};
	}

	function delete_youtube(id, sessionId) {
		deleteDownloadedTrack(id, sessionId).catch((error) => {
			logger.error("Erreur suppression musique:", error);
		});
	}

	async function prunePlaybackCache(req) {
		await Promise.all(getPlaybackCacheEvictions(req).map(async id => {
			id = trackCacheId(req, id);
			const filePath = path.join(MUSIQ_DIR, req.sessionID, `${id}.mp3`);
			// Keep unfinished conversions intact; a later transition can prune them.
			if (!fs.existsSync(filePath)
				|| fs.existsSync(path.join(MUSIQ_DIR, req.sessionID, `${id}.downloading`))
				|| fs.existsSync(path.join(MUSIQ_DIR, req.sessionID, `${id}.webm`))) return;
			await fs_promises.rm(filePath, { force: true }).catch(error => {
				logger.warn("Nettoyage du cache audio impossible", { code: error.code });
			});
		}));
	}

	function isDownloadPendingOrDone(id, sessionId) {
		return check_downloaded(id, sessionId)
			|| fs.existsSync(path.join(MUSIQ_DIR, sessionId, `${id}.webm`))
			|| fs.existsSync(path.join(MUSIQ_DIR, sessionId, `${id}.failed`));
	}

	function preloadUpcomingSongs(req, count = 1) {
		preloadQueueSongs(req, count,
			id => isDownloadPendingOrDone(trackCacheId(req, id), req.sessionID),
			(song, id) => chargement_video(song, trackCacheId(req, id), req.sessionID));
	}

	// Temporary tracks can move when a playlist is edited. Their downloads must
	// keep the same filename, including while a conversion is still in flight.
	function trackCacheId(req, id) {
		const queueId = req.session.items?.[id]?.__queueId;
		return queueId ? `queue-${queueId}` : id;
	}

	function hasPendingSpecialTrack(req) {
		if (!config.firstTrackSpecialStream || req.session.first_track_special_pending !== true) {
			return false;
		}
		const listOrder = req.session.list_order;
		const items = req.session.items;
		const nextId = Array.isArray(listOrder) ? listOrder.at(-1) : null;
		return Number.isInteger(nextId)
			&& Array.isArray(items)
			&& Boolean(items[nextId])
			&& items[nextId].type !== "local";
	}

	function isSpecialTrackRequest(req, trackId) {
		const nextId = Array.isArray(req.session.list_order) ? req.session.list_order.at(-1) : null;
		if (hasPendingSpecialTrack(req) && nextId === trackId) {
			return true;
		}
		return Boolean(firstTrackStreams.findForSession(req.sessionID))
			&& req.session.ecoute_actuelle === trackId;
	}

	function removeSongFromSessionQueue(req, playlist, playlistIndex) {
		removeTrackFromSessionQueue(req, playlist, playlistIndex, delete_youtube);
	}

	async function loadSelectedPlaylistTracks(req) {
		const playlists = req.session.playlists || [];
		const queueTracks = (req.session.items || []).filter(track => track.__queueId && !track.__retained && track.__playlist !== LIKED_PLAYLIST);
		if (playlists.length === 0 && queueTracks.length === 0) {
			throw new Error("Aucune playlist sélectionnée.");
		}

		const tracks = [];
		for (const playlist of playlists) {
			tracks.push(...await playlistTracksForRequest(req, playlist));
		}
		const selected = [...tracks, ...queueTracks];
		return req.session.stable_playlist_indices
			? stablePlaylistTracks(req.session.items || [], selected)
			: selected;
	}

	async function refreshSessionTracks(req) {
		const tracks = await loadSelectedPlaylistTracks(req);
		syncSessionQueue(req, tracks);
		return tracks;
	}

	async function initializeSession(req) {
		const randomEnabled = req.session.random === true;
		const sessionId = req.sessionID;
		logger.debug("Nouvelle session créée pour un utilisateur");
		firstTrackStreams.stopForSession(sessionId, "playlist_replaced");
		const sessionMusicDir = path.join(MUSIQ_DIR, sessionId);
		await fs_promises.rm(sessionMusicDir, { recursive: true, force: true });
		await fs_promises.mkdir(sessionMusicDir, { recursive: true });
		req.session.stable_playlist_indices = false;
		req.session.list_order = [];
		req.session.items = [];
		req.session.ecoute_actuelle = null;
		req.session.playback_history = [];
		req.session.playlists = []
		req.session.random = randomEnabled
		req.session.queue_initialized = false;
		delete req.session.playback_collection;
		req.session.first_track_special_pending = config.firstTrackSpecialStream;
		req.session.last_prefetched_transition_id = null;
		req.session.prefetched_transition_ids = [];
	}

	app.post("/playlist_used", requireAuth, async (req, res) => {
		try {
			const { playlists, random } = validatePlaylistSelectionPayload(req.body || {});
			const preservePlayback = req.body.preservePlayback === true
				&& Number.isInteger(req.session.ecoute_actuelle)
				&& Boolean(req.session.items?.[req.session.ecoute_actuelle]);
			if (preservePlayback) {
				// Read and authorize every playlist before changing the active queue.
				const tracks = [];
				for (const playlist of playlists) tracks.push(...await playlistTracksForRequest(req, playlist));
				req.session.items = stablePlaylistTracks(req.session.items, tracks);
				req.session.stable_playlist_indices = true;
				const selectedIds = tracks.map(track => req.session.items.findIndex(item =>
					!item.__retained && item.__playlist === track.__playlist && item.__playlistIndex === track.__playlistIndex));
				req.session.list_order = (typeof random === "boolean" ? random : req.session.random)
					? order_playlist(selectedIds) : selectedIds.reverse();
				req.session.queue_initialized = true;
				req.session.first_track_special_pending = false;
			} else {
				await initializeSession(req);
			}

			logger.debug("Playlist de la session:", playlists);
			req.session.playlists = playlists
			delete req.session.playback_collection;
			if (playlists.includes(LIKED_PLAYLIST)) req.session.stable_playlist_indices = true;
			if (typeof random === "boolean") {
				req.session.random = random
			}
			await recordAction(req, "playlist.selection", "playlist", req.session.playlists.join(","), {
				random: req.session.random === true
			});

			req.session.save(error => {
	            if (error) return res.status(503).json({ error: "Selection non sauvegardée" });
	            res.status(200).json({ preserved: preservePlayback, ...playbackState(req) });
	        });
		} catch (err) {
			sendJsonError(res, err, "Selection de playlist impossible", 400);
		}
	});

	app.post("/delete_playlist", requireAuth, async (req, res) => {
		try {
			const { playlist } = req.body;
			const normalizedPlaylist = normalizePlaylistName(playlist);
			const deletedActivePlaylist = Array.isArray(req.session.playlists)
				&& req.session.playlists.includes(normalizedPlaylist);
			await deletePlaylistForRequest(req, normalizedPlaylist);
			if (deletedActivePlaylist) {
				firstTrackStreams.stopForSession(req.sessionID, "playlist_deleted");
			}
			await recordAction(req, "playlist.delete", "playlist", normalizedPlaylist);

			if (Array.isArray(req.session.playlists)) {
				req.session.playlists = req.session.playlists.filter((item) => item !== normalizedPlaylist);
			}

			if (deletedActivePlaylist) {
				req.session.items = [];
				req.session.list_order = [];
				req.session.ecoute_actuelle = null;
				req.session.queue_initialized = false;
			}

			req.session.save(() => {
				res.json({ message: "Playlist supprimée" });
			});
		} catch (err) {
			logger.error("Erreur delete_playlist:", err);
			res.status(400).json({ error: err.message });
		}
	});

	async function updateRandomMode(req, enabled) {
		if (!req.session.playlists?.length && !req.session.items?.some(track => track.__queueId)) {
			throw new RequestValidationError("Aucune playlist sélectionnée.");
		}
		await refreshSessionTracks(req);
		if (typeof enabled === "boolean") {
			req.session.random = enabled;
		}
		else {
			req.session.random = !req.session.random;
		}
		if (req.session.random === true){
			req.session.list_order = order_playlist(req.session.list_order);
		}
		else{
			req.session.list_order = req.session.list_order.toSorted((a, b) => req.session.stable_playlist_indices
				? req.session.items[b].__selectionIndex - req.session.items[a].__selectionIndex : b - a);
		}
		if (!hasPendingSpecialTrack(req)) {
			preloadUpcomingSongs(req, 1);
		}
		logger.debug("Ordre de lecture:", req.session.list_order);
		return playbackState(req);
	}

	app.post("/random", requireAuth, async (req, res) => {
		try {
			const enabled = typeof req.body?.enabled === "boolean" ? req.body.enabled : undefined;
			const state = await updateRandomMode(req, enabled);
			req.session.save(() => {
				res.json(state);
			});
		} catch (err) {
			sendJsonError(res, err, "Mode aleatoire impossible a modifier", 400);
		}
	});

	app.get("/random", requireAuth, (_req, res) => {
		res.status(405).json({
			error: "Route modifiee: utilisez POST /random"
		});
	});


	app.get("/play/:trackId", requireAuth, async (req, res) => {
	    const trackId = Number(req.params.trackId);
		if (!Number.isInteger(trackId) || trackId < 0) {
			return res.status(400).send("TrackID invalide");
		}
		const audioHttpDebug = req.query.audio_debug === "1";
		const audioRequestId = audioHttpDebug
			? `play-${trackId}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
			: null;
		const startedAt = Date.now();
		const logAudioHttp = (event, extra = {}) => {
			if (!audioHttpDebug) return;
			logger.info("[AUDIO_HTTP_DIAG]", {
				event,
				timestamp: new Date().toISOString(),
				requestId: audioRequestId,
				trackId,
				elapsedMs: Date.now() - startedAt,
				...extra
			});
		};
		logAudioHttp("REQUEST_START", {
			range: req.get("range") || null,
			userAgent: req.get("user-agent") || null
		});
		res.once("finish", () => logAudioHttp("RESPONSE_FINISH", {
			status: res.statusCode,
			contentType: res.getHeader("content-type") || null,
			contentLength: res.getHeader("content-length") || null
		}));
		res.once("close", () => {
			if (!res.writableFinished) {
				logAudioHttp("CLIENT_CONNECTION_CLOSED", { status: res.statusCode });
			}
		});

		try{
			const readiness = await getTrackPlaybackReadiness(req, trackId);
			logAudioHttp("READINESS", { status: readiness.status });
			if (readiness.status === "special_stream") {
				return res.status(409).json({
					status: "special_stream",
					error: "Ce titre utilise le flux privé du premier morceau"
				});
			}
			if (readiness.status === "pending") {
				return res.status(202).json({
					status: "pending",
					path: `/play_status/${trackId}`
				});
			}
			if (readiness.status === "failed") {
				return res.status(502).send(readiness.reason);
			}
			res.sendFile(readiness.filePath, (err) => {
				if (err) {
					logAudioHttp("SEND_FILE_ERROR", {
						code: err.code || null,
						message: err.message || String(err),
						headersSent: res.headersSent
					});
					if (res.headersSent) {
						logger.error("Transfer interrupted (EPIPE), headers already sent.");
                        return;
					}

					logger.error("Erreur lors de l'envoi du fichier:", err);
					res.status(500).send("Erreur de lecture");
					return;
				}
				logAudioHttp("SEND_FILE_COMPLETE", { status: res.statusCode });
			});
		}
		    catch (err) {
				logAudioHttp("REQUEST_ERROR", {
					name: err?.name || "Error",
					message: err?.message || String(err)
				});
		        logger.error("Erreur TrackID does not exist:", err);
				if (err instanceof RequestValidationError) {
					return res.status(err.statusCode).send(err.message);
				}
		        res.status(500).send("Erreur TrackID does not exist");
		    }
		});

	app.get("/playlist", requireAuth, async (req, res) => {
	    try {
			const tracks = await refreshSessionTracks(req);
	        req.session.save(() => {
				res.json(req.session.stable_playlist_indices
					? tracks.flatMap((track, index) => track.__retained ? [] : [{ ...track, __sessionIndex: index }])
						.sort((a, b) => a.__selectionIndex - b.__selectionIndex)
					: tracks)
	        });

	    } catch (err) {
	        logger.error("Erreur playlist:", err);
			if (err.message === "Aucune playlist sélectionnée.") {
				return res.status(400).send(err.message);
			}
	        res.status(500).send("Erreur lors du chargement de la playlist.");
	    }
	});

	app.get("/playback_state", requireAuth, async (req, res) => {
		try {
			if (Array.isArray(req.session.playlists) && req.session.playlists.length > 0) {
				await refreshSessionTracks(req);
			}
			const state = playbackState(req);
			if (req.get("X-YouPlayer-Native") === "1") state.nativePlaybackVersion = 1;
			if (hasPendingSpecialTrack(req)) {
				state.first_track_special_pending = true;
			}
			req.session.save(() => {
				res.json(state);
			});
		} catch (err) {
			logger.error("Erreur playback_state:", err);
			res.status(500).json({ error: "Impossible de charger l'état de lecture." });
		}
	});

	async function changeSong(req, res, previous = false) {
	    try {
	        const transition = readNativeTransition(req);
	        if (transition?.receipt) return res.json(transition.receipt.data);
	        if (transition && transition.previous !== String(req.session.ecoute_actuelle ?? null)) {
	            return res.status(409).json({ error: "La file a changé", ...playbackState(req) });
	        }
			if (previous) {
				if (req.session.playlists?.length) await refreshSessionTracks(req);
				if (playbackState(req).previousId === null) {
					return res.status(409).json({ error: "Aucune musique précédente", ...playbackState(req) });
				}
			}
			const activeSpecialStream = firstTrackStreams.findForSession(req.sessionID);
			if (!previous && activeSpecialStream && activeSpecialStream.nextEnabled === false && transition?.reason !== "ended" && req.query.reason !== "select") {
	            return saveNextResponse(req, res, specialStreamResponse(req, activeSpecialStream), transition);
	        }
			if (activeSpecialStream) {
				if (transition?.reason === "ended") firstTrackStreams.finishStream(activeSpecialStream.id, "client_finished");
	            else firstTrackStreams.stopStream(activeSpecialStream.id, "next");
			}
			if (Array.isArray(req.session.playlists) && req.session.playlists.length > 0) {
				await refreshSessionTracks(req);
			}
	        const items = req.session.items;
			logger.debug("Items session:", items);
			const list_order = req.session.list_order;
			if (!Array.isArray(items) || !Array.isArray(list_order) || (!previous && list_order.length === 0)) {
				return res.status(400).send("Aucune chanson dans la file d'attente.");
			}
			const previousId = previous ? takePreviousTrack(req) : null;
			if (previous && previousId === null) {
				return res.status(409).json({ error: "Aucune musique précédente", ...playbackState(req) });
			}
			const isFirstTrack = req.session.first_track_special_pending === true;
			const firstTrackId = isFirstTrack ? list_order.at(-1) : null;
			const firstTrack = Number.isInteger(firstTrackId) ? items[firstTrackId] : null;
			const useSpecialStream = Boolean(hasPendingSpecialTrack(req)
				&& isFirstTrack
				&& firstTrack);
			req.session.first_track_special_pending = false;
			const id = previous ? previousId : useSpecialStream
				? req.session.list_order.pop()
				: gestion_ecoute(req);
			if (!previous) rememberCurrentTrack(req);
			if (useSpecialStream) {
				preloadUpcomingSongs(req, 1);
			}
			logger.debug("Item lu:", items[id]);
	        req.session.ecoute_actuelle = id;
			await prunePlaybackCache(req);
			// The first private stream does not otherwise create a reusable audio file.
			if (useSpecialStream) listen_after(req, id);
			const specialStream = useSpecialStream
				? firstTrackStreams.createStream({
					owner: streamPrincipal(req),
					track: req.session.items[id],
					nextEnabled: config.firstTrackSpecialNext
				})
				: null;
			const readiness = specialStream ? null : await getTrackPlaybackReadiness(req, id);
			const pendingPlaybackStream = !specialStream && readiness.status === "pending"
				? firstTrackStreams.createStream({
					owner: streamPrincipal(req),
					track: req.session.items[id],
					nextEnabled: true
				})
				: null;

	        const response = specialStream || pendingPlaybackStream
	            ? specialStreamResponse(req, specialStream || pendingPlaybackStream)
	            : {
	                mode: "normal", "0": id, "1": `/play/${id}`, path: `/play/${id}`,
	                ...playbackState(req)
	            };
	        saveNextResponse(req, res, response, transition);

	    } catch (err) {
	        logger.error("Erreur next_song:", err);
	        res.status(err.statusCode || 500).send("Erreur de lecture next_song");
	    }
	}

	app.get("/next_song", requireAuth, (req, res) => changeSong(req, res));
	app.post("/previous_song", requireAuth, (req, res) => changeSong(req, res, true));

	app.post("/prefetched_next", requireAuth, async (req, res) => {
		try {
			const transitionId = String(req.body?.transitionId || "");
			const expectedTrackId = Number(req.body?.expectedTrackId);
			const previousTrackId = req.body?.previousTrackId === null
				? null
				: Number(req.body?.previousTrackId);
			if (!/^[a-zA-Z0-9-]{8,100}$/.test(transitionId)
				|| !Number.isInteger(expectedTrackId)
				|| (previousTrackId !== null && !Number.isInteger(previousTrackId))) {
				throw new RequestValidationError("Transition de lecture invalide");
			}

			if (Array.isArray(req.session.playlists) && req.session.playlists.length > 0) {
				await refreshSessionTracks(req);
			}
			if (!Array.isArray(req.session.items) || !Array.isArray(req.session.list_order)) {
				throw new RequestValidationError("Aucune playlist sélectionnée.");
			}

			const completedTransitionIds = Array.isArray(req.session.prefetched_transition_ids)
				? req.session.prefetched_transition_ids
				: [];
			if (!completedTransitionIds.includes(transitionId)
				&& req.session.last_prefetched_transition_id !== transitionId) {
				const currentTrackId = Number.isInteger(req.session.ecoute_actuelle)
					? req.session.ecoute_actuelle
					: null;
				const nextTrackId = req.session.list_order.at(-1);
				if (currentTrackId !== previousTrackId || nextTrackId !== expectedTrackId) {
					return res.status(409).json({
						error: "La file de lecture a changé",
						...playbackState(req)
					});
				}

				const activeSpecialStream = firstTrackStreams.findForSession(req.sessionID);
				if (activeSpecialStream) {
					firstTrackStreams.stopStream(activeSpecialStream.id, "prefetched_next");
				}

				const advancedTrackId = gestion_ecoute(req);
				if (advancedTrackId !== expectedTrackId) {
					throw new Error("Transition préchargée incohérente");
				}
				rememberCurrentTrack(req);
				req.session.ecoute_actuelle = advancedTrackId;
				await prunePlaybackCache(req);
				req.session.last_prefetched_transition_id = transitionId;
				req.session.prefetched_transition_ids = [
					...completedTransitionIds,
					transitionId
				].slice(-20);
			}

			req.session.save(() => {
				res.json({ mode: "normal", ...playbackState(req) });
			});
		} catch (err) {
			sendJsonError(res, err, "Transition de lecture impossible", 400);
		}
	});

	app.get("/audio/:streamId/status", requireAuth, (req, res) => {
		const stream = firstTrackStreams.getStream(req.params.streamId);
		if (!stream) {
			return res.status(404).json({ error: "Flux introuvable ou expiré" });
		}
		if (!firstTrackStreams.isOwner(stream, streamPrincipal(req))) {
			return res.status(403).json({ error: "Ce flux appartient à un autre utilisateur" });
		}
		res.json({ state: stream.state });
	});

	app.post("/audio/:streamId/stop", requireAuth, (req, res) => {
		const stream = firstTrackStreams.getStream(req.params.streamId);
		if (!stream) {
			return res.status(204).end();
		}
		if (!firstTrackStreams.isOwner(stream, streamPrincipal(req))) {
			return res.status(403).json({ error: "Ce flux appartient à un autre utilisateur" });
		}
		const reason = String(req.body?.reason || "stop");
		if (reason === "finished") {
			firstTrackStreams.finishStream(stream.id, "client_finished");
		} else if (reason === "error") {
			firstTrackStreams.failStream(stream.id, "client_error");
		} else {
			firstTrackStreams.stopStream(stream.id, reason);
		}
		res.status(204).end();
	});

	app.get("/audio/:streamId", requireAuth, async (req, res) => {
		const stream = firstTrackStreams.getStream(req.params.streamId);
		if (!stream) {
			return res.status(404).json({ error: "Flux introuvable ou expiré" });
		}
		if (!firstTrackStreams.isOwner(stream, streamPrincipal(req))) {
			return res.status(403).json({ error: "Ce flux appartient à un autre utilisateur" });
		}

		try {
			res.setHeader("Content-Type", "audio/mpeg");
			res.setHeader("Cache-Control", "private, no-store");
			res.setHeader("X-Content-Type-Options", "nosniff");
			await firstTrackStreams.openStream(stream.id, streamPrincipal(req), res);
		} catch (err) {
			if (res.headersSent) {
				res.destroy(err);
				return;
			}
			sendJsonError(res, err, "Flux audio indisponible", 502);
		}
	});

	function gestion_ecoute(req) {
		return dequeueNextTrack(req, preloadUpcomingSongs);
	}


    function listen_after(req, id) {
		listenAfterQueue(req, id,
			trackId => isDownloadPendingOrDone(trackCacheId(req, trackId), req.sessionID),
			(song, trackId) => chargement_video(song, trackCacheId(req, trackId), req.sessionID));
	}

	function validateSessionTrack(req, trackId) {
		if (!Array.isArray(req.session.items) || !req.session.items[trackId]) {
			throw new RequestValidationError("TrackID does not exist", 404);
		}
		return req.session.items[trackId];
	}

	async function getTrackPlaybackReadiness(req, trackId) {
		if (
			Array.isArray(req.session.playlists)
			&& req.session.playlists.length > 0
			&& (!Array.isArray(req.session.items) || req.session.items.length === 0)
		) {
			await refreshSessionTracks(req);
		}
		if (isSpecialTrackRequest(req, trackId)) {
			return { status: "special_stream" };
		}
		const track = validateSessionTrack(req, trackId);
		if (track.type === "local") {
			const filePath = resolveStoredFile(LOCAL_SONG_DIR, track.url);
			if (!fs.existsSync(filePath)) {
				return {
					status: "failed",
					reason: "Fichier local introuvable"
				};
			}
			return {
				status: "ready",
				filePath
			};
		}

		const cacheId = trackCacheId(req, trackId);
		const realPath = path.join(MUSIQ_DIR, req.sessionID, `${cacheId}.mp3`);
		const webmPath = path.join(MUSIQ_DIR, req.sessionID, `${cacheId}.webm`);
		const failedPath = path.join(MUSIQ_DIR, req.sessionID, `${cacheId}.failed`);

		if (fs.existsSync(failedPath)) {
			const reason = await fs_promises.readFile(failedPath, "utf8").catch(() => "Téléchargement impossible");
			return {
				status: "failed",
				reason
			};
		}

		if (fs.existsSync(realPath) && !fs.existsSync(webmPath)) {
			return {
				status: "ready",
				filePath: realPath
			};
		}

		listen_after(req, trackId);
		return {
			status: "pending"
		};
	}

	app.get("/play_status/:trackId", requireAuth, async (req, res) => {
		const trackId = Number(req.params.trackId);
		if (!Number.isInteger(trackId) || trackId < 0) {
			return res.status(400).json({ error: "TrackID invalide" });
		}

		try {
			const readiness = await getTrackPlaybackReadiness(req, trackId);
			if (readiness.status === "special_stream") {
				return res.status(409).json({
					status: "special_stream",
					error: "Ce titre utilise le flux privé du premier morceau"
				});
			}
			if (readiness.status === "failed") {
				return res.status(502).json({
					status: "failed",
					error: readiness.reason
				});
			}
			res.status(readiness.status === "ready" ? 200 : 202).json({
				status: readiness.status,
				path: readiness.status === "ready" ? `/play/${trackId}` : null
			});
		} catch (err) {
			if (err instanceof RequestValidationError) {
				return res.status(err.statusCode).json({ error: err.message });
			}
			logger.error("Erreur play_status:", err);
			res.status(500).json({ error: "Statut de lecture indisponible" });
		}
	});



	function playbackCollectionIds(req, tracks) {
		const used = new Set();
		return tracks.map(track => {
			const matches = (item, index) => !used.has(index) && !item.__removed && (
				track.__playlist
					? (item.__playlist === track.__playlist && item.__playlistIndex === track.__playlistIndex)
						|| (item.__sourcePlaylist === track.__playlist && item.__sourcePlaylistIndex === track.__playlistIndex)
						|| (item.__queueId && !item.__playlist && !item.__sourcePlaylist && trackLikeKey(item) === trackLikeKey(track))
					: trackLikeKey(item) === trackLikeKey(track));
			const current = req.session.ecoute_actuelle;
			let id = Number.isInteger(current) && req.session.items[current] && matches(req.session.items[current], current)
				? current : req.session.items.findIndex(matches);
			if (id < 0) {
				id = req.session.items.length;
				const queued = { ...track, __queueId: randomUUID(), __retained: false };
				if (track.__playlist) {
					queued.__sourcePlaylist = track.__playlist;
					queued.__sourcePlaylistIndex = track.__playlistIndex;
				}
				delete queued.__playlist;
				delete queued.__playlistIndex;
				delete queued.__selectionIndex;
				req.session.items.push(queued);
			}
			used.add(id);
			return id;
		});
	}

	app.post("/add_song_ecoute", requireAuth, async (req, res) => {
		try {
			const { arg, song, playlist, index, key, controlled, collection, collectionIndex } = req.body || {};
			if (controlled !== undefined && typeof controlled !== 'boolean') throw new RequestValidationError('Lecture invalide.');
			const remoteTracks = collection === undefined ? null : validatePlaybackCollection(collection, collectionIndex);
			if (remoteTracks && (playlist !== undefined || arg !== undefined)) throw new RequestValidationError('Collection invalide.');
			let track = song === undefined ? null : sanitizeTrackInput(song, { allowLocal: false });
			if (remoteTracks && track && trackLikeKey(track) !== trackLikeKey(remoteTracks[collectionIndex])) {
				throw new RequestValidationError('Le morceau a changé', 409);
			}
			if (remoteTracks) track = remoteTracks[collectionIndex];
			let previewTracks = null;
			if (playlist !== undefined) {
				if (track || arg !== undefined || !Number.isInteger(index) || index < 0) throw new RequestValidationError('Chanson invalide.');
				previewTracks = controlled === true ? await playlistTracksForRequest(req, normalizePlaylistName(playlist)) : null;
				track = (previewTracks || await playlistItemsForRequest(req, normalizePlaylistName(playlist)))[index];
				if (!track) throw new RequestValidationError('Chanson introuvable.', 404);
				if (!key || key !== trackLikeKey(track)) throw new RequestValidationError('Le morceau a changé', 409);
			}
			if (req.session.playlists?.length) await refreshSessionTracks(req);
			else if (track && !Array.isArray(req.session.items)) await initializeSession(req);
			if (!Array.isArray(req.session.list_order) || !Array.isArray(req.session.items)) {
				throw new RequestValidationError("Aucune playlist sélectionnée.");
			}
			let id = Number(arg);
			let collectionIds = null;
			if (remoteTracks || previewTracks) {
				collectionIds = playbackCollectionIds(req, remoteTracks || previewTracks);
				id = collectionIds[remoteTracks ? collectionIndex : index];
				req.session.stable_playlist_indices = true;
			} else if (playlist !== undefined) {
				id = req.session.items.length;
				const queued = { ...track, __queueId: randomUUID() };
				delete queued.__playlist;
				delete queued.__playlistIndex;
				req.session.items.push(queued);
				req.session.queue_initialized = true;
			} else if (track) {
				id = req.session.items.findIndex(item => item.__queueId && trackLikeKey(item) === trackLikeKey(track));
				if (id === -1) {
					id = req.session.items.length;
					req.session.items.push({ ...track, __queueId: randomUUID() });
				}
				req.session.queue_initialized = true;
			}
			if (!Number.isInteger(id)) throw new RequestValidationError('Chanson invalide.');
			if (!req.session.items[id]) throw new RequestValidationError('Chanson introuvable.', 404);
			if (controlled === true && !track) {
				collectionIds = req.session.items[id].__playlist && !req.session.items[id].__retained
					? req.session.items.map((item, index) => ({ item, index }))
						.filter(({ item }) => item.__playlist && !item.__retained && !item.__removed)
						.sort((a, b) => (a.item.__selectionIndex ?? a.index) - (b.item.__selectionIndex ?? b.index))
						.map(({ index }) => index)
					: (req.session.playback_collection || []).filter(index => req.session.items[index] && !req.session.items[index].__removed);
				if (!collectionIds.includes(id)) collectionIds = null;
			}
			if (collectionIds) {
				req.session.stable_playlist_indices = true;
				req.session.list_order = buildControlledQueue(collectionIds, id, controlled === true ? req.session.ecoute_actuelle : null);
				req.session.playback_collection = collectionIds;
				req.session.queue_initialized = true;
				req.session.random = false;
				const selected = new Set(collectionIds);
				for (const [index, item] of req.session.items.entries()) {
					if (item.__queueId && item.__playlist !== LIKED_PLAYLIST) item.__retained = !selected.has(index);
				}
			} else req.session.list_order.push(id);
			const pending = hasPendingSpecialTrack(req);
			if (!pending) listen_after(req, id);
			req.session.save(error => {
				if (error) return res.status(503).json({ error: "File d'attente non sauvegardée" });
				res.json({
					message: "Chanson ajoutée à la file d'attente.",
					...playbackState(req),
					first_track_special_pending: pending
				});
			});
		} catch (error) {
			sendJsonError(res, error, "Ajout à la file impossible", 400);
		}
	});


	return { validateSessionTrack, removeSongFromSessionQueue };
}
