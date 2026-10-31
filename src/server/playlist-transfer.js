import { sanitizeTrackInput, RequestValidationError } from './validation.js';

export const PLAYLIST_ARCHIVE_FORMAT = 'youplayer-playlists';

export function validatePlaylistArchive(value) {
    if (value?.format !== PLAYLIST_ARCHIVE_FORMAT || value.version !== 1
        || !Array.isArray(value.playlists) || value.playlists.length > 100) {
        throw new RequestValidationError('Fichier de playlists YouPlayer invalide (version 1 attendue)');
    }
    let count = 0;
    return value.playlists.map(playlist => {
        if (!playlist || typeof playlist.name !== 'string' || !playlist.name.trim()
            || playlist.name.length > 160 || /[\\/\x00-\x1f]/.test(playlist.name)
            || !Array.isArray(playlist.items) || (count += playlist.items.length) > 10000) {
            throw new RequestValidationError('Playlist invalide ou limite de 10 000 titres dépassée');
        }
        return { name: playlist.name.trim().replace(/\.json$/i, ''),
            items: playlist.items.map(item => sanitizeTrackInput(item, { allowLocal: false })) };
    });
}
