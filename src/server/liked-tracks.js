import { trackLikeKey } from '../client-utils.js';

export function updateLikedTracks(items, track, liked) {
    const key = trackLikeKey(track);
    if (!key || typeof liked !== 'boolean') throw new Error('Like invalide');
    const remaining = items.filter(item => trackLikeKey(item) !== key);
    if (!liked) return remaining;
    if (remaining.length !== items.length) return items;
    // Session queue metadata must never become persistent playlist metadata.
    const stored = Object.fromEntries(Object.entries(track).filter(([name]) => !name.startsWith('__')));
    return [...remaining, stored];
}
