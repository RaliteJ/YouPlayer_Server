import * as spotifyOAuth from './spotify-oauth.js';
import { getSpotifyAnonymousToken as defaultAnonymousToken } from './spotify.js';
import { logger as defaultLogger } from './logger.js';

export function createSpotifyCatalog({
	config, store, logger = defaultLogger,
	oauthEnabled = spotifyOAuth.spotifyOAuthConfigured(config),
	decryptSpotifyToken = spotifyOAuth.decryptSpotifyToken,
	refreshSpotifyAccessToken = spotifyOAuth.refreshSpotifyAccessToken,
	spotifyTokenUpdateFromRefresh = spotifyOAuth.spotifyTokenUpdateFromRefresh,
	fetchSpotifyClientCredentialsToken = spotifyOAuth.fetchSpotifyClientCredentialsToken,
	fetchSpotifyCatalogSearch = spotifyOAuth.fetchSpotifyCatalogSearch,
	fetchSpotifyAlbum = spotifyOAuth.fetchSpotifyAlbum,
	getSpotifyAnonymousToken = defaultAnonymousToken
}) {
	let spotifyApplicationTokenCache = { value: "", expiresAt: 0 };
	let spotifyApplicationTokenPromise = null;

	async function refreshSpotifyTokenForUser(userId, connection) {
		const encryptedRefreshToken = connection?.refreshTokenEncrypted || "";
		if (!encryptedRefreshToken) {
			const error = new Error("Reconnecte ton compte Spotify pour renouveler l'autorisation");
			error.statusCode = 409;
			throw error;
		}

		const refreshToken = decryptSpotifyToken(encryptedRefreshToken, config.spotifyTokenSecret);
		let tokenData;
		try {
			tokenData = await refreshSpotifyAccessToken(config, refreshToken);
		} catch (err) {
			if (err?.oauthCode === "invalid_grant") {
				await store.removeSpotifyConnection(userId);
				const expired = new Error("Autorisation Spotify expiree, reconnecte ton compte");
				expired.statusCode = 409;
				throw expired;
			}
			throw err;
		}
		const tokenUpdate = spotifyTokenUpdateFromRefresh(tokenData, connection, config);
		await store.updateSpotifyTokens(userId, tokenUpdate);
		return decryptSpotifyToken(tokenUpdate.accessTokenEncrypted, config.spotifyTokenSecret);
	}

	async function spotifyAccessTokenForUser(userId, { forceRefresh = false } = {}) {
		if (!userId) {
			const error = new Error("Compte YouPlayer requis");
			error.statusCode = 401;
			throw error;
		}
		const connection = await store.getSpotifyConnection(userId, { includeTokens: true });
		if (!connection) {
			const error = new Error("Connecte d'abord ton compte Spotify");
			error.statusCode = 409;
			throw error;
		}

		const expiresAt = Date.parse(connection.expiresAt || "");
		const accessToken = connection.accessTokenEncrypted
			? decryptSpotifyToken(connection.accessTokenEncrypted, config.spotifyTokenSecret)
			: "";
		const stillValid = !Number.isFinite(expiresAt) || expiresAt > Date.now() + 60_000;
		if (!forceRefresh && accessToken && stillValid) {
			return accessToken;
		}
		return refreshSpotifyTokenForUser(userId, connection);
	}

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
		const connection = await store.getSpotifyConnection(userId);
		if (connection) {
			return {
				accessToken: await spotifyAccessTokenForUser(userId, { forceRefresh }),
				source: "user"
			};
		}
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

	return { spotifyAccessTokenForUser, spotifySearchForUser, spotifyAlbumForUser, spotifyAlbumFromAnonymousWebToken };
}
