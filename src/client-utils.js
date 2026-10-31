export function escapeHtml(value) {
	return String(value ?? '').replace(/[&<>"']/g, (char) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;'
	})[char]);
}

export function formatTrackTitle(track) {
	if (!track) return 'Titre inconnu';
	return [track.artist, track.title || track.name || 'Titre inconnu'].filter(Boolean).join(' - ');
}

// Keep stable Spotify identities alongside the display name, without bearer data.
export function spotifyArtists(artists = []) {
	const items = Array.isArray(artists) ? artists : Array.isArray(artists?.items) ? artists.items : [];
	return items.slice(0, 20).map(item => {
		const artist = item?.data || item;
		const id = artist?.id || artist?.uri?.split(':').pop() || '';
		const name = String(artist?.name || artist?.profile?.name || '').trim().slice(0, 120);
		return typeof id === 'string' && /^[A-Za-z0-9]{22}$/.test(id) && name ? { id, name } : null;
	}).filter(Boolean);
}

export function normalizeMusicText(value = '') {
	return String(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
		.replace(/[^\p{L}\p{N}]/gu, '');
}

export function matchSpotifyArtist({ name, title }, tracks = [], artists = []) {
	if (!normalizeMusicText(name)) return null;
	const matches = new Map();
	for (const track of tracks) {
		if (normalizeMusicText(track.name) !== normalizeMusicText(title)) continue;
		for (const artist of spotifyArtists(track.artists)) {
			if (normalizeMusicText(artist.name) === normalizeMusicText(name)) matches.set(artist.id, artist);
		}
	}
	if (!matches.size) {
		for (const artist of spotifyArtists(artists)) {
			if (normalizeMusicText(artist.name) === normalizeMusicText(name)) matches.set(artist.id, artist);
		}
	}
	return matches.size === 1 ? [...matches.values()][0] : null;
}

export function getTrackArtwork(track, origin) {
	const artwork = track?.albumCoverURL || track?.thumbnail || '';
	if (!artwork) return '';

	try {
		const baseOrigin = origin || globalThis.window?.location?.origin || 'http://localhost';
		return new URL(artwork, baseOrigin).href;
	} catch {
		return '';
	}
}

export function playlistEntries(playlists) {
	return Object.values(playlists || {})
		.map((playlist) => {
			if (typeof playlist === 'string') {
				return {
					name: playlist,
					title: playlist.replace(/\.json$/i, ''),
					image: '',
					count: null
				};
			}

			const name = playlist?.name || playlist?.filename || '';
			return {
				name,
				title: playlist?.title || name.replace(/\.json$/i, ''),
				image: playlist?.image || playlist?.coverImage || playlist?.coverUrl || '',
				count: Number.isInteger(playlist?.count) ? playlist.count : null
			};
		})
		.filter((playlist) => playlist.name);
}

// Only locally authored messages reach the UI; response bodies may contain diagnostics.
export function publicErrorMessage(status, fallback = 'Cette action est momentanément indisponible. Réessaie dans un instant.') {
	switch (Number(status)) {
		case 0: return 'Connexion interrompue. Vérifie ta connexion puis réessaie.';
		case 401: return 'Ta session a expiré. Reconnecte-toi.';
		case 403: return 'Cette action n’est pas autorisée pour ton compte.';
		case 404: return 'Ce contenu n’est plus disponible.';
		case 409: return 'Cette action ne peut pas être effectuée pour le moment. Actualise puis réessaie.';
		case 413: return 'Ce fichier est trop volumineux. Choisis un fichier plus petit.';
		case 429: return 'Patiente un instant avant de réessayer.';
		default: return fallback;
	}
}

export const LIKED_PLAYLIST = 'liked Youplayer.json';

export function trackLikeKey(track) {
    if (!track) return '';
    if (track.type === 'local') return track.url ? `local:${track.url}` : '';
    const source = String(track.id || track.youtubeId || track.url || '');
    try {
        const url = new URL(source);
        if (url.hostname === 'youtu.be') return `youtube:${url.pathname.slice(1)}`;
        if (url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com')) {
            return `youtube:${url.searchParams.get('v') || url.pathname.split('/').at(-1)}`;
        }
        if (url.hostname === 'open.spotify.com') return `spotify:${url.pathname.split('/').filter(Boolean).slice(-2).join('/')}`;
    } catch {}
    return source ? `${track.type || 'youtube'}:${source}` : '';
}
