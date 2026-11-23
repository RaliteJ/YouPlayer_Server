import { randomUUID } from 'node:crypto';
import { trackLikeKey } from '../client-utils.js';

export function shuffleArray(array, random = Math.random) {
	for (let i = array.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[array[i], array[j]] = [array[j], array[i]];
	}
	return array;
}

export function order_playlist(list, random = Math.random) {
	return shuffleArray(list, random);
}

export function buildInitialQueue(length, randomEnabled, random = Math.random) {
	const queue = [];
	for (let i = length - 1; i >= 0; i--) {
		queue.push(i);
	}
	return randomEnabled === true ? order_playlist(queue, random) : queue;
}

// Playback consumes the queue from the end. Rotate the source order around
// the selected occurrence, leaving the previous current track out of the wrap.
export function buildControlledQueue(ids, selectedId, previousId = null) {
	const position = ids.indexOf(selectedId);
	if (position < 0) throw new RangeError('Titre absent de la collection');
	const upcoming = [...ids.slice(position + 1), ...ids.slice(0, position)]
		.filter(id => id !== previousId && id !== selectedId);
	return [selectedId, ...upcoming].reverse();
}

function validListenNextRange(req) {
	const range = req.session.listen_next_range;
	const length = Array.isArray(req.session.list_order) ? req.session.list_order.length : 0;
	if (range && Number.isInteger(range.start) && Number.isInteger(range.count)
		&& range.start >= 0 && range.count > 0 && range.start + range.count <= length) {
		return range;
	}
	return null;
}

// "Lire ensuite" occurrences are tracked as a contiguous range of list_order
// positions [start, start + count). Playback pops list_order from the end, so
// the first-arrived occurrence sits at the end of the range. Positions, not
// track ids, keep duplicate occurrences independent from each other.
export function insertListenNextTrack(req, id) {
	const list = req.session.list_order;
	const range = validListenNextRange(req);
	if (!range) {
		list.push(id);
		req.session.listen_next_range = { start: list.length - 1, count: 1 };
		return;
	}
	list.splice(range.start, 0, id);
	range.count += 1;
}

// Shared queue consumption: a popped position inside the pending range
// releases exactly one tracked occurrence, anything else leaves it intact.
export function popPlaybackQueueTrack(req) {
	const list = req.session.list_order;
	const id = list.pop();
	const range = req.session.listen_next_range;
	if (id !== undefined && range && Number.isInteger(range.start) && range.count > 0) {
		const position = list.length;
		if (position >= range.start && position < range.start + range.count) {
			range.count -= 1;
			if (range.count <= 0) req.session.listen_next_range = null;
		}
	}
	return id;
}

// Rebuild the pending range after entries are dropped from list_order: kept
// occurrences compact, so the tracked block stays contiguous. Call before the
// filter runs, while list_order still holds the entries about to be removed.
export function refreshListenNextRange(req, keepInQueue) {
	const range = req.session.listen_next_range;
	const list = req.session.list_order;
	if (!range || !Array.isArray(list)) return;
	let nextPosition = 0;
	let start = -1;
	let count = 0;
	for (const [position, id] of list.entries()) {
		if (!keepInQueue(id)) continue;
		if (position >= range.start && position < range.start + range.count) {
			if (start === -1) start = nextPosition;
			count += 1;
		}
		nextPosition += 1;
	}
	req.session.listen_next_range = count > 0 ? { start, count } : null;
}

// Reorder the normal queue while keeping the pending "Lire ensuite" block on
// top of the upcoming list, in its arrival order.
export function preserveListenNextOrder(req, reorderRest) {
	const list = req.session.list_order;
	const range = validListenNextRange(req);
	if (!range) {
		req.session.list_order = reorderRest(list);
		return;
	}
	const block = list.slice(range.start, range.start + range.count);
	const reorderedRest = reorderRest([...list.slice(0, range.start), ...list.slice(range.start + range.count)]);
	req.session.list_order = [...reorderedRest, ...block];
	req.session.listen_next_range = { start: reorderedRest.length, count: block.length };
}

export function sessionTrackKey(item) {
	if (item?.__removed) return item.__removed;
	if (item?.__queueId) return `queue:${item.__queueId}`;
	if (item?.__sessionKey) return item.__sessionKey;
	return `${item?.__playlist}:${item?.__playlistIndex}`;
}

// Preserve numeric playback URLs and in-flight download destinations across selections.
export function stablePlaylistTracks(previousItems, tracks) {
	const items = previousItems.map(item => ({ ...item, __retained: true }));
	const sourceKey = item => item.__queueId || item.__removed ? sessionTrackKey(item)
		: trackLikeKey(item) ? JSON.stringify([item.__playlist, trackLikeKey(item)])
			: `${item.__playlist}:${item.__playlistIndex}`;
	const indices = new Map();
	// Match duplicate occurrences in source order, independently of session/cache IDs.
	for (const { item, index } of items.map((item, index) => ({ item, index }))
		.sort((a, b) => (a.item.__playlistIndex ?? a.index) - (b.item.__playlistIndex ?? b.index))) {
		const key = sourceKey(item);
		if (!indices.has(key)) indices.set(key, []);
		indices.get(key).push(index);
	}
	for (const [selectionIndex, track] of tracks.entries()) {
		const index = indices.get(sourceKey(track))?.shift();
		if (index === undefined) {
			items.push({ ...track, __sessionKey: `playlist:${randomUUID()}`, __retained: false, __selectionIndex: selectionIndex });
		} else items[index] = { ...track, __sessionKey: sessionTrackKey(items[index]), __retained: false, __selectionIndex: selectionIndex };
	}
	return items;
}

export function syncSessionQueue(req, tracks) {
	const previousItems = Array.isArray(req.session.items) ? req.session.items : [];
	const newIndexByTrackKey = new Map(tracks.map((item, index) => [
		sessionTrackKey(item),
		index
	]));
	req.session.items = tracks;

	if (req.session.queue_initialized !== true || !Array.isArray(req.session.list_order)) {
		req.session.list_order = buildInitialQueue(tracks.length, req.session.random);
		req.session.queue_initialized = true;
		req.session.listen_next_range = null;
		return;
	}

	const keepInQueue = (id) => Number.isInteger(id) && id >= 0 && id < tracks.length && !tracks[id].__retained;
	req.session.list_order = req.session.list_order
		.map((id) => {
			if (!Number.isInteger(id)) return null;
			const previousItem = previousItems[id];
			if (previousItem) {
				return newIndexByTrackKey.get(sessionTrackKey(previousItem));
			}
			return id;
		});
	refreshListenNextRange(req, keepInQueue);
	req.session.list_order = req.session.list_order.filter(keepInQueue);

	req.session.playback_history = (req.session.playback_history || [])
		.map(id => newIndexByTrackKey.get(sessionTrackKey(previousItems[id])))
		.filter(id => Number.isInteger(id));

	if (Number.isInteger(req.session.ecoute_actuelle)) {
		const previousCurrent = previousItems[req.session.ecoute_actuelle];
		if (previousCurrent) {
			req.session.ecoute_actuelle = newIndexByTrackKey.get(sessionTrackKey(previousCurrent)) ?? null;
		}
	}

	if (!Number.isInteger(req.session.ecoute_actuelle) || !tracks[req.session.ecoute_actuelle]) {
		req.session.ecoute_actuelle = null;
	}

	const knownTrackKeys = new Set(previousItems.filter(item => !item.__retained).map((item) =>
		sessionTrackKey(item)
	));
	const queuedTrackIds = new Set(req.session.list_order);
	const newTrackIds = tracks
		.map((item, index) => ({ item, index }))
		.filter(({ item, index }) =>
			!item.__retained
			&& !knownTrackKeys.has(sessionTrackKey(item))
			&& !queuedTrackIds.has(index)
			&& req.session.ecoute_actuelle !== index
		)
		.map(({ index }) => index);

	if (newTrackIds.length > 0) {
		const idsToAppendLater = req.session.random === true
			? order_playlist(newTrackIds)
			: newTrackIds.slice().reverse();
		req.session.list_order = [...idsToAppendLater, ...req.session.list_order];
		if (req.session.listen_next_range) {
			req.session.listen_next_range.start += idsToAppendLater.length;
		}
	}
}

export function getUpcomingQueue(req, limit = 20) {
	const items = Array.isArray(req.session.items) ? req.session.items : [];
	const list_order = Array.isArray(req.session.list_order) ? req.session.list_order : [];

	return list_order
		.slice()
		.reverse()
		.filter((id) => Number.isInteger(id) && items[id])
		.slice(0, limit)
		.map((id) => ({
			...items[id],
			__sessionIndex: id
		}));
}

export function playbackState(req) {
	const items = Array.isArray(req.session.items) ? req.session.items : [];
	const currentId = Number.isInteger(req.session.ecoute_actuelle) && items[req.session.ecoute_actuelle]
		? req.session.ecoute_actuelle
		: null;

	return {
		currentId,
		current: currentId === null ? null : items[currentId],
		previousId: (req.session.playback_history || []).filter(id => Number.isInteger(id) && items[id]).at(-1) ?? null,
		queue: getUpcomingQueue(req),
		random: req.session.random === true
	};
}

export function preloadUpcomingSongs(req, count = 1, isDownloadPendingOrDone = () => false, loadSong = () => {}) {
	const items = req.session.items;
	const list_order = req.session.list_order;
	if (!Array.isArray(items) || !Array.isArray(list_order) || list_order.length === 0) {
		return;
	}

	for (const id of list_order.slice(-count)) {
		if (items[id] && !isDownloadPendingOrDone(id, req.sessionID)) {
			loadSong(items[id], id, req.sessionID);
		}
	}
}

export function removeSongFromSessionQueue(req, playlist, playlistIndex, deleteTrack = () => {}) {
	if (!Array.isArray(req.session.items) || !Array.isArray(req.session.list_order)) {
		return;
	}

	const sessionIndex = req.session.items.findIndex((item) =>
		!item.__removed && item.__playlist === playlist && item.__playlistIndex === playlistIndex
	);
	if (sessionIndex === -1) {
		return;
	}

	const removedSessionItem = req.session.items[sessionIndex];
	if (removedSessionItem && removedSessionItem.type !== "local") {
		deleteTrack(sessionIndex, req.sessionID);
	}

	if (req.session.stable_playlist_indices) {
		req.session.items[sessionIndex] = { ...removedSessionItem, __removed: `removed:${sessionIndex}`, __retained: true };
		for (const item of req.session.items) {
			if (!item.__removed && item.__playlist === playlist && item.__playlistIndex > playlistIndex) item.__playlistIndex -= 1;
		}
		refreshListenNextRange(req, id => id !== sessionIndex);
		req.session.list_order = req.session.list_order.filter(id => id !== sessionIndex);
		req.session.playback_history = (req.session.playback_history || []).filter(id => id !== sessionIndex);
		if (req.session.ecoute_actuelle === sessionIndex) req.session.ecoute_actuelle = null;
		return;
	}

	req.session.items.splice(sessionIndex, 1);
	req.session.items.forEach((item) => {
		if (item.__playlist === playlist && item.__playlistIndex > playlistIndex) {
			item.__playlistIndex -= 1;
		}
	});

	refreshListenNextRange(req, id => id !== sessionIndex);
	req.session.list_order = req.session.list_order
		.filter((id) => id !== sessionIndex)
		.map((id) => id > sessionIndex ? id - 1 : id);
	req.session.playback_history = (req.session.playback_history || [])
		.filter(id => id !== sessionIndex)
		.map(id => id > sessionIndex ? id - 1 : id);

	if (req.session.ecoute_actuelle === sessionIndex) {
		req.session.ecoute_actuelle = null;
	} else if (req.session.ecoute_actuelle > sessionIndex) {
		req.session.ecoute_actuelle -= 1;
	}
}

export function rememberCurrentTrack(req) {
	const id = req.session.ecoute_actuelle;
	if (!Number.isInteger(id) || !req.session.items?.[id]) return;
	req.session.playback_history = [...(req.session.playback_history || []), id].slice(-50);
}

export function getPlaybackCacheEvictions(req) {
	const items = req.session.items || [];
	const current = req.session.ecoute_actuelle;
	const recent = [...new Set((req.session.playback_history || []).slice().reverse())]
		.filter(id => Number.isInteger(id) && items[id] && id !== current)
		.slice(0, 3);
	const keep = new Set([current, ...recent, ...(req.session.list_order || [])]);
	return items.flatMap((track, id) => track.type !== 'local' && !keep.has(id) ? [id] : []);
}

export function takePreviousTrack(req) {
	const history = (req.session.playback_history || []).filter(id => Number.isInteger(id) && req.session.items?.[id]);
	const id = history.pop();
	if (id === undefined) return null;
	req.session.playback_history = history;
	const current = req.session.ecoute_actuelle;
	if (Number.isInteger(current) && req.session.items[current]) req.session.list_order.push(current);
	return id;
}

export function gestion_ecoute(req, preload = preloadUpcomingSongs) {
	const list_order = req.session.list_order;
	preload(req, 5);
	const id = popPlaybackQueueTrack(req);
	req.session.list_order = list_order;
	preload(req, 1);
	return id;
}

export function listen_after(req, id, isDownloadPendingOrDone = () => false, loadSong = () => {}) {
	const items = req.session.items;
	if (items[id] && !isDownloadPendingOrDone(id, req.sessionID)) {
		loadSong(items[id], id, req.sessionID);
	}
}
