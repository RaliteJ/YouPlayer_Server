import { logger } from "./logger.js";

export function getYoutubeId(url) {
	try {
		const parsed = new URL(url);
		if (parsed.hostname.includes("youtu.be")) {
			return parsed.pathname.split("/").filter(Boolean)[0] || "";
		}
		return parsed.searchParams.get("v") || "";
	} catch {
		return "";
	}
}

export function cleanYoutubeTitle(title = "") {
	return title
		.replace(/\[[^\]]*\]/g, " ")
		.replace(/\([^)]*(official|audio|video|lyrics?|clip|visualizer|remaster|hd|4k)[^)]*\)/gi, " ")
		.replace(/\b(official|music|video|audio|lyrics?|clip|visualizer|remaster(ed)?|hd|4k)\b/gi, " ")
		.replace(/\s+/g, " ")
		.trim();
}

export function safePlaylistFileName(name) {
	return decodeHtmlEntities(String(name || "youtube-playlist"))
		.replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120) || "youtube-playlist";
}

export function decodeHtmlEntities(value = "") {
	return String(value)
		.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
		.replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");
}

export function clampSpotifyLimit(value, fallback = 24, max = 50) {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) {
		return fallback;
	}
	return Math.min(parsed, max);
}

export function getSpotifyResourceId(value, expectedType) {
	const raw = String(value || "").trim();
	if (!raw) {
		throw new Error(`Identifiant Spotify ${expectedType} manquant`);
	}

	try {
		const parsed = new URL(raw);
		if (!parsed.hostname.includes("spotify.com")) {
			throw new Error();
		}
		const parts = parsed.pathname.split("/").filter(Boolean);
		const typeIndex = parts.indexOf(expectedType);
		if (typeIndex !== -1 && parts[typeIndex + 1]) {
			return parts[typeIndex + 1];
		}
	} catch {
		// The caller may also send a Spotify URI or a direct id.
	}

	const id = raw.split("?")[0].split("/").filter(Boolean).pop()?.split(":").pop() || raw;
	if (!/^[A-Za-z0-9]{8,}$/.test(id)) {
		throw new Error(`Identifiant Spotify ${expectedType} invalide`);
	}
	return id;
}

export function spotifyIdFromUri(uri = "") {
	return typeof uri === "string" ? uri.split(":").pop() || "" : "";
}

export function spotifyExternalUrl(type, id) {
	return id ? { spotify: `https://open.spotify.com/${type}/${id}` } : {};
}

export function pathfinderData(item) {
	return item?.item?.data || item?.itemV2?.data || item?.data || item?.featured?.data || item || {};
}

export function imageSourcesFrom(...candidates) {
	for (const candidate of candidates) {
		if (!candidate) continue;
		if (Array.isArray(candidate) && candidate.length) {
			if (candidate[0]?.url) {
				return candidate.map((source) => ({
					url: source.url,
					height: source.height || null,
					width: source.width || null
				}));
			}
			const nested = candidate.flatMap((item) => item?.sources || item?.data?.sources || []);
			if (nested[0]?.url) {
				return nested.map((source) => ({
					url: source.url,
					height: source.height || null,
					width: source.width || null
				}));
			}
		}
		if (candidate.sources?.[0]?.url) {
			return imageSourcesFrom(candidate.sources);
		}
		if (candidate.items?.length) {
			return imageSourcesFrom(candidate.items);
		}
		if (candidate.url) {
			return [{ url: candidate.url, height: candidate.height || null, width: candidate.width || null }];
		}
	}
	return [];
}

export function normalizePathfinderArtist(item) {
	const data = pathfinderData(item);
	const id = spotifyIdFromUri(data.uri) || data.id || "";
	return {
		id,
		name: data.profile?.name || data.name || "",
		uri: data.uri || (id ? `spotify:artist:${id}` : ""),
		images: imageSourcesFrom(data.visuals?.avatarImage, data.avatarImage, data.images),
		followers: {
			total: data.stats?.followers || data.followers?.total || 0
		},
		genres: data.genres || [],
		external_urls: spotifyExternalUrl("artist", id)
	};
}

export function normalizePathfinderArtists(artists) {
	const items = artists?.items || artists || [];
	if (!Array.isArray(items)) return [];
	return items
		.map((item) => normalizePathfinderArtist(item))
		.filter((artist) => artist.name || artist.id);
}

export function normalizePathfinderAlbum(item) {
	const data = pathfinderData(item);
	const id = spotifyIdFromUri(data.uri) || data.id || "";
	return {
		id,
		name: data.name || "",
		uri: data.uri || (id ? `spotify:album:${id}` : ""),
		artists: normalizePathfinderArtists(data.artists),
		images: imageSourcesFrom(data.coverArt, data.visualIdentity?.squareCoverImage, data.images),
		release_date: data.date?.isoString || (data.date?.year ? String(data.date.year) : ""),
		total_tracks: data.tracks?.totalCount || data.tracksV2?.totalCount || data.totalTracks || 0,
		external_urls: spotifyExternalUrl("album", id)
	};
}

export function normalizePathfinderTrack(item) {
	const data = pathfinderData(item);
	const id = spotifyIdFromUri(data.uri) || data.id || "";
	const album = normalizePathfinderAlbum(data.albumOfTrack || data.album || {});
	return {
		id,
		name: data.name || data.title || "",
		uri: data.uri || (id ? `spotify:track:${id}` : ""),
		artists: normalizePathfinderArtists(data.artists),
		album,
		track_number: data.trackNumber || data.track_number || 0,
		duration_ms: data.duration?.totalMilliseconds || data.duration_ms || data.trackDuration?.totalMilliseconds || 0,
		explicit: Boolean(data.contentRating?.label === "EXPLICIT" || data.explicit),
		popularity: data.popularity || 0,
		preview_url: data.preview_url || null,
		external_urls: spotifyExternalUrl("track", id)
	};
}

export function normalizePathfinderPlaylist(item) {
	const data = pathfinderData(item);
	const id = spotifyIdFromUri(data.uri) || data.id || "";
	const contentItems = data.content?.items || data.tracks?.items || [];
	const tracks = contentItems
		.map((trackItem) => normalizePathfinderTrack(trackItem))
		.filter((track) => track.name || track.id);

	return {
		id,
		name: data.name || "",
		description: data.description || data.descriptionText || "",
		uri: data.uri || (id ? `spotify:playlist:${id}` : ""),
		images: imageSourcesFrom(data.images, data.coverArt, data.visualIdentity?.image),
		owner: {
			display_name: data.ownerV2?.data?.name || data.owner?.displayName || data.owner?.name || data.ownerName || ""
		},
		followers: {
			total: data.followers?.total || data.followersCount || 0
		},
		tracks: {
			total: data.content?.totalCount || tracks.length,
			items: tracks.map((track) => ({ track })),
			next: tracks.length < (data.content?.totalCount || tracks.length) ? true : null
		},
		external_urls: spotifyExternalUrl("playlist", id)
	};
}

export function normalizePathfinderSearch(searchV2 = {}) {
	const tracks = (searchV2.tracksV2?.items || [])
		.map((item) => normalizePathfinderTrack(item))
		.filter((track) => track.name || track.id);
	const playlists = (searchV2.playlists?.items || [])
		.map((item) => normalizePathfinderPlaylist(item))
		.filter((playlist) => playlist.name || playlist.id);
	const albums = (searchV2.albumsV2?.items || [])
		.map((item) => normalizePathfinderAlbum(item))
		.filter((album) => album.name || album.id);
	const artists = (searchV2.artists?.items || [])
		.map((item) => normalizePathfinderArtist(item))
		.filter((artist) => artist.name || artist.id);

	return {
		tracks: {
			items: tracks,
			total: searchV2.tracksV2?.totalCount || tracks.length
		},
		playlists: {
			items: playlists,
			total: searchV2.playlists?.totalCount || playlists.length
		},
		albums: {
			items: albums,
			total: searchV2.albumsV2?.totalCount || albums.length
		},
		artists: {
			items: artists,
			total: searchV2.artists?.totalCount || artists.length
		}
	};
}

function pathfinderTrackItems(container = {}) {
	const direct = container?.tracks?.items || container?.tracksV2?.items || container?.items || [];
	const discs = container?.discs?.items || [];
	return [
		...(Array.isArray(direct) ? direct : []),
		...discs.flatMap((disc) => disc?.tracks?.items || [])
	];
}

export function normalizePathfinderAlbumDetail(albumUnion = {}) {
	const album = normalizePathfinderAlbum(albumUnion);
	const data = pathfinderData(albumUnion);
	const tracks = pathfinderTrackItems(data)
		.map((item) => normalizePathfinderTrack(item?.track || item))
		.filter((track) => track.name || track.id)
		.map((track) => ({
			...track,
			album: {
				id: album.id,
				name: album.name,
				images: album.images,
				external_urls: album.external_urls
			}
		}));
	return {
		...album,
		total_tracks: album.total_tracks || tracks.length,
		tracks: { items: tracks, total: tracks.length }
	};
}

function pathfinderReleaseItems(section = {}) {
	const items = section?.items || [];
	return items.flatMap((item) => item?.releases?.items || item?.items || [item]);
}

export function normalizePathfinderArtistDetail(artistUnion = {}) {
	const data = pathfinderData(artistUnion);
	const artist = normalizePathfinderArtist(data);
	const discography = data.discography || {};
	const releaseSections = [
		discography.popularReleasesAlbums,
		discography.albums,
		discography.singles,
		discography.compilations
	];
	const albumsById = new Map();
	for (const release of releaseSections.flatMap(pathfinderReleaseItems)) {
		const album = normalizePathfinderAlbum(release?.data || release);
		if (album.id && !albumsById.has(album.id)) albumsById.set(album.id, album);
	}
	const topTrackItems = discography.topTracks?.items || data.topTracks?.items || [];
	const top_tracks = topTrackItems
		.map((item) => normalizePathfinderTrack(item?.track || item))
		.filter((track) => track.name || track.id);
	const relatedItems = data.relatedContent?.relatedArtists?.items || data.relatedArtists?.items || [];
	return {
		artist,
		albums: [...albumsById.values()],
		top_tracks,
		related_artists: relatedItems
			.map((item) => normalizePathfinderArtist(item))
			.filter((related) => related.name || related.id)
	};
}

export function parseArtistAndTitle(title = "") {
	const cleaned = cleanYoutubeTitle(title);
	const parts = cleaned.split(/\s+-\s+|\s+–\s+|\s+—\s+/);
	if (parts.length >= 2) {
		return {
			artist: parts[0].trim(),
			title: parts.slice(1).join(" - ").trim()
		};
	}
	return { artist: "", title: cleaned };
}

function normalizeMusicIdentity(value = "") {
	return decodeHtmlEntities(value)
		.toLowerCase()
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.replace(/œ/g, "oe")
		.replace(/[^\p{L}\p{N}]/gu, "");
}

export async function enrichYoutubeTrack(song, fetchImpl = fetch) {
	if (!song || song.type !== "youtube") {
		return song;
	}

	const id = getYoutubeId(song.url);
	const parsed = parseArtistAndTitle(song.title);
	const sourceArtist = parsed.artist || song.artist || song.channelTitle || "";
	const expectedArtist = normalizeMusicIdentity(sourceArtist.replace(/\s+-\s+Topic$/i, ""));
	const expectedTitle = normalizeMusicIdentity(parsed.title);
	const matchesSource = (title, artist) => Boolean(expectedTitle && expectedArtist)
		&& normalizeMusicIdentity(title) === expectedTitle
		&& normalizeMusicIdentity(artist) === expectedArtist;
	const searchTerm = [sourceArtist, parsed.title].filter(Boolean).join(" ") || song.title;

	let deezerMatch = null;
	let itunesMatch = null;
	try {
		const url = `https://api.deezer.com/search?q=${encodeURIComponent(searchTerm)}&limit=1`;
		const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
		if (response.ok) {
			const data = await response.json();
			const candidate = Array.isArray(data.data) ? data.data[0] : null;
			if (candidate && matchesSource(candidate.title, candidate.artist?.name)) {
				deezerMatch = candidate;
			}
		}
	} catch (err) {
		logger.error("Erreur enrichissement YouTube Deezer:", err.message);
	}

	if (!deezerMatch) {
		try {
			const url = `https://itunes.apple.com/search?media=music&entity=song&limit=1&term=${encodeURIComponent(searchTerm)}`;
			const response = await fetchImpl(url, { signal: AbortSignal.timeout(5000) });
			if (response.ok) {
				const data = await response.json();
				const candidate = Array.isArray(data.results) ? data.results[0] : null;
				if (candidate && matchesSource(candidate.trackName, candidate.artistName)) {
					itunesMatch = candidate;
				}
			}
		} catch (err) {
			logger.error("Erreur enrichissement YouTube iTunes:", err.message);
		}
	}

	return {
		title: deezerMatch?.title || itunesMatch?.trackName || parsed.title || song.title || "",
		artist: deezerMatch?.artist?.name || itunesMatch?.artistName || sourceArtist,
		album: deezerMatch?.album?.title || itunesMatch?.collectionName || song.album || "",
		id,
		albumCoverURL: deezerMatch?.album?.cover_big || itunesMatch?.artworkUrl100?.replace("100x100bb", "600x600bb") || song.albumCoverURL || song.thumbnail || "",
		trackNumber: deezerMatch?.track_position || itunesMatch?.trackNumber || song.trackNumber || 0
	};
}
