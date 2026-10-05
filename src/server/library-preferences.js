export function libraryPreferences(value = {}) {
	const names = (items, limit) => [...new Set((Array.isArray(items) ? items : [])
		.filter((item) => typeof item === 'string'))].slice(0, limit);
	return { pinned: names(value?.pinned, 20), recent: names(value?.recent, 12) };
}

export function updateLibraryPreferences(previous, { action, playlist, enabled } = {}, available = null) {
	const value = libraryPreferences(previous);
	if (available) {
		const names = new Set(available);
		value.pinned = value.pinned.filter((name) => names.has(name));
		value.recent = value.recent.filter((name) => names.has(name));
	}
	if (action === 'clear_recent') return { ...value, recent: [] };
	if (!['pin', 'visit'].includes(action) || typeof playlist !== 'string' || !playlist
		|| (action === 'pin' && typeof enabled !== 'boolean')) {
		const error = new Error('Preference de bibliotheque invalide');
		error.statusCode = 400;
		throw error;
	}
	if (action === 'visit') value.recent = [playlist, ...value.recent.filter((name) => name !== playlist)].slice(0, 12);
	if (action === 'pin') {
		value.pinned = value.pinned.filter((name) => name !== playlist);
		if (enabled) {
			if (value.pinned.length >= 20) {
				const error = new Error('20 playlists epinglees maximum');
				error.statusCode = 400;
				throw error;
			}
			value.pinned.unshift(playlist);
		}
	}
	return value;
}
