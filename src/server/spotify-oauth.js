const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_SEARCH_URL = "https://api.spotify.com/v1/search";
const SPOTIFY_ALBUMS_URL = "https://api.spotify.com/v1/albums";

function tokenBody(params) {
	return new URLSearchParams(params);
}

function spotifyBasicAuth(config) {
	return Buffer.from(`${config.spotifyClientId}:${config.spotifyClientSecret}`).toString("base64");
}

export function spotifyOAuthConfigured(config) {
	return Boolean(config.spotifyClientId && config.spotifyClientSecret && config.spotifyRedirectUri);
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
