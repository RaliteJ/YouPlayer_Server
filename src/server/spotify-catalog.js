import * as spotifyOAuth from './spotify-oauth.js';
import { getSpotifyAnonymousToken as defaultAnonymousToken } from './spotify.js';
import { logger as defaultLogger } from './logger.js';

export function createSpotifyCatalog({
	config, logger = defaultLogger,
	oauthEnabled = spotifyOAuth.spotifyOAuthConfigured(config),
	fetchSpotifyClientCredentialsToken = spotifyOAuth.fetchSpotifyClientCredentialsToken,
	fetchSpotifyCatalogSearch = spotifyOAuth.fetchSpotifyCatalogSearch,
	fetchSpotifyAlbum = spotifyOAuth.fetchSpotifyAlbum,
	getSpotifyAnonymousToken = defaultAnonymousToken
}) {
	let spotifyApplicationTokenCache = { value: "", expiresAt: 0 };
	let spotifyApplicationTokenPromise = null;

	async function spotifyApplicationAccessToken({ forceRefresh = false } = {}) {
		if (!oauthEnabled) return "";
		if (!forceRefresh && spotifyApplicationTokenCache.value
			&& spotifyApplicationTokenCache.expiresAt > Date.now() + 60_000) {
			return spotifyApplicationTokenCache.value;
		}
		if (!forceRefresh && spotifyApplicationTokenPromise) {
			return spotifyApplicationTokenPromise;
		}

		const loadToken = async () => {
			const tokenData = await fetchSpotifyClientCredentialsToken(config);
			const value = String(tokenData?.access_token || "");
			if (!value) throw new Error("Jeton applicatif Spotify absent");
			spotifyApplicationTokenCache = {
				value,
				expiresAt: Date.now() + Math.max(60, Number(tokenData?.expires_in) || 3600) * 1000
			};
			return value;
		};

		spotifyApplicationTokenPromise = loadToken();
		try {
			return await spotifyApplicationTokenPromise;
		} finally {
			spotifyApplicationTokenPromise = null;
		}
	}

	async function spotifyCatalogTokenForUser(userId, { forceRefresh = false } = {}) {
		const accessToken = await spotifyApplicationAccessToken({ forceRefresh });
		return accessToken ? { accessToken, source: "application" } : null;
	}

	async function spotifySearchForUser(userId, query, { limit, offset } = {}) {
		const startedAt = Date.now();
		try {
			let token = await spotifyCatalogTokenForUser(userId);
			if (!token) {
				logger.debug("Recherche Spotify: aucun jeton OAuth disponible, fallback anonyme");
				return null;
			}
			try {
				const result = await fetchSpotifyCatalogSearch(token.accessToken, query, { limit, offset });
				logger.debug("Recherche Spotify OAuth terminee", {
					tokenSource: token.source,
					durationMs: Date.now() - startedAt,
					tracks: result.tracks.items.length,
					playlists: result.playlists.items.length,
					albums: result.albums.items.length,
					artists: result.artists.items.length
				});
				return result;
			} catch (err) {
				if (err?.spotifyStatus !== 401) throw err;
				logger.debug("Recherche Spotify OAuth: jeton expire, renouvellement", { tokenSource: token.source });
				token = await spotifyCatalogTokenForUser(userId, { forceRefresh: true });
				const result = await fetchSpotifyCatalogSearch(token.accessToken, query, { limit, offset });
				logger.debug("Recherche Spotify OAuth terminee apres renouvellement", {
					tokenSource: token.source,
					durationMs: Date.now() - startedAt,
					tracks: result.tracks.items.length,
					playlists: result.playlists.items.length,
					albums: result.albums.items.length,
					artists: result.artists.items.length
				});
				return result;
			}
		} catch (err) {
			logger.warn("Recherche Spotify OAuth indisponible, fallback anonyme:", {
				durationMs: Date.now() - startedAt,
				spotifyStatus: err?.spotifyStatus || null,
				oauthCode: err?.oauthCode || null,
				message: err.message
			});
			return null;
		}
	}

	async function spotifyAlbumForUser(userId, albumId) {
		const startedAt = Date.now();
		let token = null;
		try {
			token = await spotifyCatalogTokenForUser(userId);
			if (!token) return null;
			try {
				const album = await fetchSpotifyAlbum(token.accessToken, albumId);
				logger.debug("Album Spotify OAuth charge", {
					tokenSource: token.source,
					durationMs: Date.now() - startedAt,
					tracks: album?.tracks?.items?.length || 0
				});
				return album;
			} catch (err) {
				if (err?.spotifyStatus !== 401) throw err;
				token = await spotifyCatalogTokenForUser(userId, { forceRefresh: true });
				return fetchSpotifyAlbum(token.accessToken, albumId);
			}
		} catch (err) {
			logger.warn("Album Spotify OAuth indisponible, fallback WebPlayer:", {
				durationMs: Date.now() - startedAt,
				tokenSource: token?.source || null,
				spotifyStatus: err?.spotifyStatus || null,
				message: err.message
			});
			return null;
		}
	}

	async function spotifyAlbumFromAnonymousWebToken(albumId) {
		const startedAt = Date.now();
		try {
			const accessToken = await getSpotifyAnonymousToken(`album/${albumId}`);
			const album = await fetchSpotifyAlbum(accessToken, albumId);
			logger.debug("Album Spotify charge avec le jeton WebPlayer anonyme", {
				durationMs: Date.now() - startedAt,
				tracks: album?.tracks?.items?.length || 0
			});
			return album;
		} catch (err) {
			logger.warn("Album Spotify via jeton WebPlayer refuse, fallback Pathfinder HTTP:", {
				durationMs: Date.now() - startedAt,
				spotifyStatus: err?.spotifyStatus || null,
				message: err.message
			});
			return null;
		}
	}

	return { spotifySearchForUser, spotifyAlbumForUser, spotifyAlbumFromAnonymousWebToken };
}
