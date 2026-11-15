import { escapeHtml, spotifyArtists, musicTrackIdentity } from './client-utils.js';

export function artistLinksMarkup(track = {}) {
    track ||= {};
    const identities = spotifyArtists(track.spotifyArtists);
    const { title, artist: name } = musicTrackIdentity(track);
    const artists = identities.length ? identities : [{ name }];
    return artists.filter(artist => artist.name).map(artist =>
        `<button type="button" class="track-artist-link" data-track-artist="${escapeHtml(artist.name)}" data-artist-id="${escapeHtml(artist.id || '')}" data-artist-track="${escapeHtml(title)}" aria-label="Voir ${escapeHtml(artist.name)} sur Spotify">${escapeHtml(artist.name)}</button>`
    ).join(', ');
}

export const artistView = {
    initArtistLinks() {
        // Capture before row/mini-player handlers so navigation never starts playback.
        document.addEventListener('click', event => {
            const button = event.target.closest('[data-track-artist]');
            if (!button) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (this.currentUser?.role === 'admin') return;
            const user = this.currentUser?.id;
            this.closeNowPlaying();
            this.closeQueueDrawer();
            this.loadView('add_spotify', { activateSpotify: false });
            void this.spotifyExplorer?.openTrackArtist({
                name: button.dataset.trackArtist,
                id: button.dataset.artistId,
                title: button.dataset.artistTrack
            }).catch(() => {
                if (this.currentUser?.id === user) this.showNotice('Artiste Spotify indisponible. Réessaie dans un instant.', true);
            });
        }, true);
    }
};
