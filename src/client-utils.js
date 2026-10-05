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
