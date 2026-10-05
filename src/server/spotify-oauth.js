import { createCipheriv, createDecipheriv, createHash, randomBytes } from "crypto";

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_CURRENT_USER_URL = "https://api.spotify.com/v1/me";
const SPOTIFY_CURRENT_USER_PLAYLISTS_URL = "https://api.spotify.com/v1/me/playlists";
const SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search";
const SPOTIFY_ALBUMS_URL = "https://api.spotify.com/v1/albums";

function tokenSecretKey(secret) {
	if (!secret || String(secret).length < 16) {
		throw new Error("Secret de chiffrement Spotify trop court");
	}
	return createHash("sha256").update(String(secret)).digest();
}

function tokenBody(params) {
	return new URLSearchParams(params);
}

function spotifyBasicAuth(config) {
	return Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString("base64");
}

function tokenExpiresAt(expiresInSeconds) {
	const ttl = Math.max(1, Number(expiresInSeconds) || 3600);
	return new Date(Date.now() + ttl * 1000).toISOString();
}

export function spotifyOAuthConfigured(config) {
	return Boolean(config.spotifyClientId && config.spotifyClientSecret && config.spotifyRedirectUri);
}

export function createSpotifyOAuthState() {
	return randomBytes(24).toString("base64url");
}

export function createSpotifyPkce() {
	const verifier = randomBytes(48).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	return { verifier, challenge };
}

export function createSpotifyAuthorizationUrl(config, state, { codeChallenge = "" } = {}) {
	const url = new URL(SPOTIFY_AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", config.spotifyClientId);
	url.searchParams.set("redirect_uri", config.spotifyRedirectUri);
	url.searchParams.set("scope", config.spotifyScopes.join(" "));
	url.searchParams.set("state", state);
	if (codeChallenge) {
		url.searchParams.set("code_challenge_method", "S256");
		url.searchParams.set("code_challenge", codeChallenge);
	}
	return url.toString();
}

async function spotifyTokenError(response, operation) {
	let oauthCode = "";
	try {
		const body = await response.json();
		oauthCode = String(body?.error || "");
	} catch {
		// Do not expose the response body: OAuth responses may contain sensitive details.
	}
	const error = new Error(`Spotify OAuth ${operation} refuse (${response.status})`);
	error.spotifyStatus = response.status;
	error.oauthCode = oauthCode;
	return error;
}

export async function exchangeSpotifyAuthorizationCode(config, code, { codeVerifier = "", fetchImpl = fetch } = {}) {
	const body = {
		grant_type: "authorization_code",
		code,
		redirect_uri: config.spotifyRedirectUri
	};
	if (codeVerifier) body.code_verifier = codeVerifier;
	const response = await fetchImpl(SPOTIFY_TOKEN_URL, {
		method: "POST",
		headers: {
			Authorization: `Basic ${spotifyBasicAuth(config)}`,
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json"
		},
		body: tokenBody(body)
	});
	if (!response.ok) {
		throw await spotifyTokenError(response, "token");
	}
	return response.json();
}

export async function refreshSpotifyAccessToken(config, refreshToken, fetchImpl = fetch) {
	const response = await fetchImpl(SPOTIFY_TOKEN_URL, {
		method: "POST",
		headers: {
			Authorization: `Basic ${spotifyBasicAuth(config)}`,
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json"
		},
		body: tokenBody({
			grant_type: "refresh_token",
			refresh_token: refreshToken
		})
	});
	if (!response.ok) {
		throw await spotifyTokenError(response, "refresh");
	}
	return response.json();
}

export async function fetchSpotifyClientCredentialsToken(config, fetchImpl = fetch) {
	const response = await fetchImpl(SPOTIFY_TOKEN_URL, {
		method: "POST",
		headers: {
			Authorization: `Basic ${spotifyBasicAuth(config)}`,
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json"
		},
		body: tokenBody({ grant_type: "client_credentials" })
	});
	if (!response.ok) {
		throw await spotifyTokenError(response, "client_credentials");
	}
	return response.json();
}

export async function fetchSpotifyCurrentUserProfile(accessToken, fetchImpl = fetch) {
	const response = await fetchImpl(SPOTIFY_CURRENT_USER_URL, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json"
		}
	});
	if (!response.ok) {
		throw new SpotifyWebApiError(response.status);
	}
	const profile = await response.json();
	if (!profile?.account_id) {
		throw new Error("Identifiant stable du compte Spotify absent");
	}
	return profile;
}

export class SpotifyWebApiError extends Error {
	constructor(status, operation = "playlists") {
		const target = {
			search: "recherche Spotify",
			album: "lecture de l'album Spotify",
			playlists: "lecture des playlists Spotify"
		}[operation] || "requete Spotify";
		const message = status === 403
			? `Compte Spotify non autorise pour cette application ou ${target} refusee`
			: status === 429
				? "Limite de requetes Spotify atteinte, reessaie dans un instant"
				: `${target} impossible`;
		super(message);
		this.name = "SpotifyWebApiError";
		this.spotifyStatus = status;
		this.statusCode = status === 403 || status === 429 ? status : 502;
	}
}

export async function fetchSpotifyCatalogSearch(accessToken, query, {
	fetchImpl = fetch,
	limit = 10,
	offset = 0
} = {}) {
	const url = new URL(SPOTIFY_SEARCH_URL);
	url.searchParams.set("q", String(query || "").trim());
	url.searchParams.set("type", "track,playlist,album,artist");
	url.searchParams.set("limit", String(Math.min(10, Math.max(1, Number(limit) || 10))));
	url.searchParams.set("offset", String(Math.max(0, Number(offset) || 0)));

	const response = await fetchImpl(url, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json"
		}
	});
	if (!response.ok) {
		throw new SpotifyWebApiError(response.status, "search");
	}

	const data = await response.json();
	const section = (value) => ({
		...(value || {}),
		items: Array.isArray(value?.items) ? value.items.filter(Boolean) : [],
		total: Number(value?.total) || 0
	});
	return {
		tracks: section(data?.tracks),
		playlists: section(data?.playlists),
		albums: section(data?.albums),
		artists: section(data?.artists)
	};
}

export async function fetchSpotifyAlbum(accessToken, albumId, fetchImpl = fetch) {
	const response = await fetchImpl(`${SPOTIFY_ALBUMS_URL}/${encodeURIComponent(String(albumId || ""))}`, {
		headers: {
			Authorization: `Bearer ${accessToken}`,
			Accept: "application/json"
		}
	});
	if (!response.ok) {
		throw new SpotifyWebApiError(response.status, "album");
	}
	return response.json();
}

export async function fetchSpotifyCurrentUserPlaylists(accessToken, {
	fetchImpl = fetch,
	pageSize = 50,
	maxPages = 200
} = {}) {
	const limit = Math.min(50, Math.max(1, Number(pageSize) || 50));
	const items = [];
	const visitedOffsets = new Set();
	let offset = 0;
	let total = 0;
	let href = SPOTIFY_CURRENT_USER_PLAYLISTS_URL;

	for (let page = 0; page < maxPages; page += 1) {
		if (visitedOffsets.has(offset)) break;
		visitedOffsets.add(offset);

		const url = new URL(SPOTIFY_CURRENT_USER_PLAYLISTS_URL);
		url.searchParams.set("limit", String(limit));
		url.searchParams.set("offset", String(offset));
		const response = await fetchImpl(url, {
			headers: {
				Authorization: `Bearer ${accessToken}`,
				Accept: "application/json"
			}
		});
		if (!response.ok) {
			throw new SpotifyWebApiError(response.status);
		}

		const data = await response.json();
		const pageItems = Array.isArray(data?.items) ? data.items.filter(Boolean) : [];
		items.push(...pageItems);
		href = data?.href || href;
		total = Math.max(total, Number(data?.total) || 0, items.length);

		if (!data?.next || pageItems.length === 0 || items.length >= total) break;
		try {
			const nextOffset = Number(new URL(data.next).searchParams.get("offset"));
			offset = Number.isInteger(nextOffset) && nextOffset >= 0
				? nextOffset
				: offset + pageItems.length;
		} catch {
			offset += pageItems.length;
		}
	}

	return {
		href,
		items,
		limit,
		offset: 0,
		total,
		next: null
	};
}

export function encryptSpotifyToken(value, secret) {
	const token = String(value || "");
	if (!token) return "";
	const iv = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", tokenSecretKey(secret), iv);
	const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return [
		"v1",
		iv.toString("base64url"),
		tag.toString("base64url"),
		encrypted.toString("base64url")
	].join(":");
}

export function decryptSpotifyToken(value, secret) {
	const encryptedToken = String(value || "");
	if (!encryptedToken) return "";
	const [version, ivRaw, tagRaw, encryptedRaw] = encryptedToken.split(":");
	if (version !== "v1" || !ivRaw || !tagRaw || !encryptedRaw) {
		throw new Error("Token Spotify chiffre invalide");
	}
	const decipher = createDecipheriv(
		"aes-256-gcm",
		tokenSecretKey(secret),
		Buffer.from(ivRaw, "base64url")
	);
	decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
	return Buffer.concat([
		decipher.update(Buffer.from(encryptedRaw, "base64url")),
		decipher.final()
	]).toString("utf8");
}

export function spotifyScopesFromToken(tokenData, fallbackScopes = []) {
	const scopes = String(tokenData?.scope || "")
		.split(/\s+/)
		.map((scope) => scope.trim())
		.filter(Boolean);
	return scopes.length > 0 ? scopes : fallbackScopes;
}

export function spotifyConnectionFromOAuth(tokenData, profile, config) {
	if (!profile?.account_id) {
		throw new Error("Identifiant stable du compte Spotify requis");
	}
	if (!tokenData?.access_token || !tokenData?.refresh_token) {
		throw new Error("Jetons Spotify incomplets, nouvelle autorisation requise");
	}
	return {
		accountId: String(profile.account_id),
		displayName: String(profile.display_name || ""),
		scopes: spotifyScopesFromToken(tokenData, config.spotifyScopes),
		accessTokenEncrypted: encryptSpotifyToken(tokenData.access_token, config.spotifyTokenSecret),
		refreshTokenEncrypted: encryptSpotifyToken(tokenData.refresh_token, config.spotifyTokenSecret),
		expiresAt: tokenExpiresAt(tokenData.expires_in)
	};
}

export function spotifyTokenUpdateFromRefresh(tokenData, existingConnection, config) {
	return {
		accessTokenEncrypted: encryptSpotifyToken(tokenData.access_token, config.spotifyTokenSecret),
		refreshTokenEncrypted: tokenData.refresh_token
			? encryptSpotifyToken(tokenData.refresh_token, config.spotifyTokenSecret)
			: existingConnection.refreshTokenEncrypted,
		scopes: spotifyScopesFromToken(tokenData, existingConnection.scopes || config.spotifyScopes),
		expiresAt: tokenExpiresAt(tokenData.expires_in)
	};
}
