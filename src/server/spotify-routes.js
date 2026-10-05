import * as spotify from './spotify.js';
import { getSpotifyPathfinderJson as defaultPathfinderJson } from './spotify-pathfinder-http.js';
import { fetchSpotifyCurrentUserPlaylists as defaultUserPlaylists } from './spotify-oauth.js';
import { clampSpotifyLimit, getSpotifyResourceId, normalizePathfinderAlbumDetail,
	normalizePathfinderArtistDetail, normalizePathfinderPlaylist, normalizePathfinderSearch } from './media-utils.js';
import { logger as defaultLogger } from './logger.js';

const SPOTIFY_PARTNER_QUERY_URL = "https://api-partner.spotify.com/pathfinder/v2/query";
const SPOTIFY_SEARCH_DESKTOP_HASH = "18173d759b3d18e057204db5f6feef97d44658dc3eb5c25c245f9a21e51970db";
const SPOTIFY_ARTIST_OVERVIEW_HASH = "9f8134ef565e78621f1e1793555bd6633c5ac144ae0f89604ed3ae3f80b3c8e6";

export function registerSpotifyRoutes(app, {
	requireAuth, sendJsonError, catalog, logger = defaultLogger,
	fetchImpl = (...args) => fetch(...args),
	getSpotifyAnonymousToken = spotify.getSpotifyAnonymousToken,
	clearSpotifyAnonymousToken = spotify.clearSpotifyAnonymousToken,
	getSpotifyPlaylistTracksPage = spotify.getSpotifyPlaylistTracksPage,
	getSpotifyPathfinderJson = defaultPathfinderJson,
	fetchSpotifyCurrentUserPlaylists = defaultUserPlaylists,
	runSpotifyLoginSandboxProbe = spotify.runSpotifyLoginSandboxProbe,
	spotifyLoginSandboxStatus = spotify.spotifyLoginSandboxStatus
}) {
	const { spotifyAccessTokenForUser, spotifySearchForUser, spotifyAlbumForUser,
		spotifyAlbumFromAnonymousWebToken } = catalog;
	async function spotifyPartnerJson(payload, tokenSource = "search") {
		async function requestWithToken(token) {
			return fetchImpl(SPOTIFY_PARTNER_QUERY_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"App-Platform": "WebPlayer",
					"Content-Type": "application/json;charset=UTF-8",
					Accept: "application/json"
				},
				body: JSON.stringify(payload)
			});
		}

		let token = await getSpotifyAnonymousToken(tokenSource);
		let response = await requestWithToken(token);
		if (response.status === 401 || response.status === 403) {
			clearSpotifyAnonymousToken();
			token = await getSpotifyAnonymousToken(tokenSource);
			response = await requestWithToken(token);
		}

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`Spotify partner ${response.status}: ${body.slice(0, 240)}`);
		}

		return response.json();
	}

	app.post("/spotify_test", requireAuth, async (req, res) => {
		try {
			const { action = "search" } = req.body || {};
			let data;

			if (action === "search") {
				const query = String(req.body.query || "").trim();
				if (!query) {
					return res.status(400).json({ error: "Recherche Spotify vide" });
				}
				const offset = Math.max(0, Number(req.body.offset) || 0);
				const limit = clampSpotifyLimit(req.body.limit, 10, 50);
				data = await spotifySearchForUser(req.session?.userId, query, { limit, offset });
				const payload = {
					variables: {
						searchTerm: query,
						offset,
						limit,
						numberOfTopResults: 5,
						includeAudiobooks: true,
						includeArtistHasConcertsField: false,
						includePreReleases: true,
						includeAlbumPreReleases: false,
						includeAuthors: false,
						includeEpisodeContentRatingsV2: true,
						isPrefix: null,
						sectionFilters: ["GENERIC"]
					},
					operationName: "searchDesktop",
					extensions: {
						persistedQuery: {
							version: 1,
							sha256Hash: SPOTIFY_SEARCH_DESKTOP_HASH
						}
					}
				};
				if (!data) {
					try {
						const json = await spotifyPartnerJson(payload, `search/${encodeURIComponent(query)}`);
						data = normalizePathfinderSearch(json.data.searchV2);
					} catch (err) {
						logger.warn("Recherche Spotify directe échouée, nouvel essai HTTP:", err.message);
						const json = await getSpotifyPathfinderJson(`search/${encodeURIComponent(query)}`, "searchV2", { offset, limit });
						data = normalizePathfinderSearch(json.data.searchV2);
					}
				}
			}
			else if (action === "playlist") {
				const playlistId = getSpotifyResourceId(req.body.id || req.body.url, "playlist");
				try {
					const token = await getSpotifyAnonymousToken(`playlist/${playlistId}`);
					const page = await getSpotifyPlaylistTracksPage(token, playlistId, { offset: 0, limit: 50 });
					data = {
						id: playlistId,
						name: page.name,
						uri: `spotify:playlist:${playlistId}`,
						images: [],
						owner: { display_name: "" },
						followers: { total: 0 },
						external_urls: { spotify: `https://open.spotify.com/playlist/${playlistId}` },
						tracks: {
							items: page.items.map((track) => ({ track })),
							total: page.total,
							offset: page.offset,
							limit: page.limit,
							next: page.next
						}
					};
				} catch (partnerErr) {
					logger.warn("Lecture Spotify playlist anonyme échouée, fallback HTTP:", partnerErr.message);
					try {
						const json = await getSpotifyPathfinderJson(`playlist/${playlistId}`, "playlistV2");
						data = normalizePathfinderPlaylist(json.data.playlistV2);
					} catch (httpErr) {
						logger.warn("Lecture Spotify playlist HTTP échouée:", httpErr.message);
						throw partnerErr;
					}
				}
				if (!data) {
					const json = await getSpotifyPathfinderJson(`playlist/${playlistId}`, "playlistV2");
					data = normalizePathfinderPlaylist(json.data.playlistV2);
				}
			}
			else if (action === "playlist_tracks") {
				const playlistId = getSpotifyResourceId(req.body.id || req.body.url, "playlist");
				const limit = clampSpotifyLimit(req.body.limit, 50, 100);
				const offset = Math.max(0, Number(req.body.offset) || 0);
				const token = await getSpotifyAnonymousToken(`playlist/${playlistId}`);
				const page = await getSpotifyPlaylistTracksPage(token, playlistId, { offset, limit });
				data = {
					items: page.items.map((track) => ({ track })),
					total: page.total,
					limit: page.limit,
					offset: page.offset,
					next: page.next
				};
			}
			else if (action === "me_playlists") {
				let accessToken = await spotifyAccessTokenForUser(req.session?.userId);
				try {
					data = await fetchSpotifyCurrentUserPlaylists(accessToken);
				} catch (err) {
					if (err?.spotifyStatus !== 401) throw err;
					accessToken = await spotifyAccessTokenForUser(req.session?.userId, { forceRefresh: true });
					data = await fetchSpotifyCurrentUserPlaylists(accessToken);
				}
			}
			else if (action === "album") {
				const albumId = getSpotifyResourceId(req.body.id || req.body.url, "album");
				data = await spotifyAlbumForUser(req.session?.userId, albumId);
				if (!data) {
					data = await spotifyAlbumFromAnonymousWebToken(albumId);
				}
				if (!data) {
					const json = await getSpotifyPathfinderJson(`album/${albumId}`, "albumUnion");
					data = normalizePathfinderAlbumDetail(json.data.albumUnion);
				}
			}
			else if (action === "artist") {
				const artistId = getSpotifyResourceId(req.body.id || req.body.url, "artist");
				const json = await spotifyPartnerJson({
					variables: { uri: `spotify:artist:${artistId}`, locale: "", preReleaseV2: false },
					operationName: "queryArtistOverview",
					extensions: { persistedQuery: { version: 1, sha256Hash: SPOTIFY_ARTIST_OVERVIEW_HASH } }
				}, `artist/${artistId}`);
				if (json.errors?.length || !json.data?.artistUnion) {
					throw new Error("Informations artiste Spotify indisponibles");
				}
				data = normalizePathfinderArtistDetail(json.data.artistUnion);
				if (data.artist.id !== artistId || !data.artist.name) {
					throw new Error("Informations artiste Spotify invalides");
				}
			}
			else if (action === "track") {
				return res.status(410).json({ error: "Action remplacee par les donnees Pathfinder deja affichees" });
			}
			else {
				return res.status(400).json({ error: "Action spotify_test inconnue" });
			}

			res.json({
				action,
				data
			});
		} catch (err) {
			logger.error("Erreur spotify_test:", err);
			sendJsonError(res, err, "Erreur Spotify", 400);
		}
	});

	app.get("/spotify_login_sandbox_api/status", requireAuth, (_req, res) => {
		res.json(spotifyLoginSandboxStatus());
	});

	app.post("/spotify_login_sandbox_api/probe", requireAuth, async (req, res) => {
		try {
			const result = await runSpotifyLoginSandboxProbe({
				mode: req.body?.mode,
				source: req.body?.source,
				timeoutMs: req.body?.timeoutMs
			});
			res.status(result.ok ? 200 : 400).json(result);
		} catch (err) {
			logger.error("Erreur spotify_login_sandbox probe:", err);
			res.status(400).json({ ok: false, error: err.message });
		}
	});

}
