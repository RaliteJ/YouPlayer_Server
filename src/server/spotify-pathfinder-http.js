import { getSpotifyAnonymousToken, clearSpotifyAnonymousToken } from './spotify-anonymous-token.js';
import { getSpotifyResourceId } from './media-utils.js';

const QUERY_URL = 'https://api-partner.spotify.com/pathfinder/v2/query';
const HASHES = {
	playlistV2: '8964e8eafb21aa992a7d951d256d83285c04be2105d209262901de70cb97584a',
	albumUnion: '6a74b456cd1735c9193d9e8ec8cc5184cad7ce13572210315229db3975964361',
	searchV2: '18173d759b3d18e057204db5f6feef97d44658dc3eb5c25c245f9a21e51970db'
};

export async function getSpotifyPathfinderJson(source, dataKey, {
	fetchImpl = (...args) => fetch(...args),
	getToken = getSpotifyAnonymousToken, clearToken = clearSpotifyAnonymousToken,
	pageSize = 50, offset = 0, limit = 10, timeoutMs = 12_000, completePlaylist = false
} = {}) {
	let operation, variables, resourceId;
	if (dataKey === 'albumUnion' || dataKey === 'playlistV2') {
		const type = dataKey === 'albumUnion' ? 'album' : 'playlist';
		resourceId = getSpotifyResourceId(source, type);
		operation = type === 'album' ? 'getAlbum' : 'fetchPlaylist';
		variables = { uri: `spotify:${type}:${resourceId}`, offset: 0,
			limit: Math.min(100, Math.max(1, Number(pageSize) || 50)),
			...(type === 'album' ? { locale: '' } : { enableWatchFeedEntrypoint: false }) };
	} else if (dataKey === 'searchV2' && String(source).startsWith('search/')) {
		const query = decodeURIComponent(String(source).slice(7)).trim();
		if (!query) throw new Error('Recherche Spotify vide');
		operation = 'searchDesktop';
		variables = { searchTerm: query, offset: Math.max(0, Number(offset) || 0),
			limit: Math.min(50, Math.max(1, Number(limit) || 10)), numberOfTopResults: 5,
			includeAudiobooks: true, includeArtistHasConcertsField: false,
			includePreReleases: true, includeAlbumPreReleases: false, includeAuthors: false,
			includeEpisodeContentRatingsV2: true, isPrefix: null, sectionFilters: ['GENERIC'] };
	} else {
		throw new Error('Requete Spotify HTTP invalide');
	}

	let token = await getToken(source);
	let refreshed = false;
	async function request(operationName, requestVariables) {
		const body = JSON.stringify({ variables: requestVariables, operationName,
			extensions: { persistedQuery: { version: 1, sha256Hash: HASHES[dataKey] } } });
		const send = () => fetchImpl(QUERY_URL, { method: 'POST',
			headers: { Authorization: `Bearer ${token}`, 'App-Platform': 'WebPlayer',
				'Content-Type': 'application/json;charset=UTF-8', Accept: 'application/json' },
			body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
		let response = await send();
		if (!refreshed && (response.status === 401 || response.status === 403)) {
			refreshed = true;
			clearToken();
			token = await getToken(source);
			response = await send();
		}
		if (!response.ok) throw new Error(`Spotify HTTP indisponible (${response.status})`);
		let json;
		try { json = await response.json(); } catch { throw new Error('Reponse Spotify HTTP illisible'); }
		if (!json || json.errors?.length || !json.data?.[dataKey]) throw new Error('Reponse Spotify HTTP invalide');
		return json;
	}

	const json = await request(operation, variables);
	const data = json.data[dataKey];
	if (resourceId && (data.uri !== variables.uri || !data.name)) throw new Error('Identite Spotify HTTP invalide');
	if (dataKey !== 'albumUnion' && !(dataKey === 'playlistV2' && completePlaylist)) return json;
	const contentKey = dataKey === 'albumUnion' ? 'tracksV2' : 'content';
	const total = data[contentKey]?.totalCount;
	const items = data[contentKey]?.items;
	if (!Number.isInteger(total) || total < 0 || !Array.isArray(items) || items.length > total) {
		throw new Error('Titres Spotify invalides');
	}
	const tracks = [...items];
	while (tracks.length < total) {
		const page = await request(dataKey === 'albumUnion' ? 'queryAlbumTracks' : 'fetchPlaylistContents',
			{ ...variables, offset: tracks.length });
		const content = page.data[dataKey][contentKey];
		if (content?.totalCount !== total || !Array.isArray(content?.items) || !content.items.length
			|| tracks.length + content.items.length > total) throw new Error('Collection Spotify incomplete');
		tracks.push(...content.items);
	}
	data[contentKey] = { ...data[contentKey], items: tracks };
	return json;
}
