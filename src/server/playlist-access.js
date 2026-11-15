import fs from 'node:fs';
import { promises as fs_promises } from 'node:fs';
import { createHash } from 'node:crypto';
import { LIKED_PLAYLIST, trackLikeKey } from '../client-utils.js';
import { updateLikedTracks } from './liked-tracks.js';
import { getPlaylistSummary, listPlaylistFiles, PLAYLISTS_DIR, playlistPath as filePath, updateJsonFile } from './playlist-files.js';
import { normalizePlaylistName, normalizePlaylistTitle } from './stores/store-utils.js';
import { RequestValidationError } from './validation.js';

export function createPlaylistAccess({ authEnabled, store, playlistsDir = PLAYLISTS_DIR }) {
	const playlistPath = name => filePath(name, playlistsDir);
	async function playlistFilesForRequest(req) {
		if (authEnabled) {
			return store.listPlaylistFiles(req.session.userId);
		}
		return listPlaylistFiles(playlistsDir);
	}

	async function playlistSummariesForRequest(req) {
		const summaries = authEnabled
			? await store.getPlaylistSummaries(req.session.userId)
			: await Promise.all((await listPlaylistFiles(playlistsDir)).map(file => getPlaylistSummary(file, playlistsDir)));
		if (!summaries.some(item => item.name === LIKED_PLAYLIST)) {
			summaries.push({ name: LIKED_PLAYLIST, title: 'liked Youplayer', image: '', count: 0 });
		}
		return summaries;
	}

	async function playlistItemsForRequest(req, playlist) {
		if (playlist === LIKED_PLAYLIST && !(await playlistFilesForRequest(req)).includes(playlist)) return [];
		if (authEnabled) {
			return store.getPlaylistItems(req.session.userId, playlist);
		}
		const data = await fs_promises.readFile(playlistPath(playlist), "utf8");
		const obj = JSON.parse(data);
		return Array.isArray(obj.items) ? obj.items : [];
	}

	async function appendPlaylistItemsForRequest(req, playlist, items) {
		if (normalizePlaylistName(playlist) === LIKED_PLAYLIST) throw new RequestValidationError('Utilise le bouton cœur pour modifier cette playlist', 400);
		if (authEnabled) {
			return store.appendPlaylistItems(req.session.userId, playlist, items);
		}
		const filePath = playlistPath(playlist);
		if (!fs.existsSync(filePath)) {
			await fs_promises.writeFile(filePath, JSON.stringify({ items: [] }, null, 2), "utf8");
		}
		await updateJsonFile(filePath, items);
		return {
			playlist,
			added: Array.isArray(items) ? items.length : 1
		};
	}

	async function renamePlaylistForRequest(req, playlist, title) {
		playlist = normalizePlaylistName(playlist);
		title = normalizePlaylistTitle(title);
		if (playlist === LIKED_PLAYLIST) throw new RequestValidationError('Cette playlist automatique ne peut pas être renommée');
		if (authEnabled) {
			if (!await store.setPlaylistTitle(req.session.userId, playlist, title)) throw new RequestValidationError('Playlist introuvable', 404);
		} else {
			const target = playlistPath(playlist);
			let data;
			try { data = JSON.parse(await fs_promises.readFile(target, 'utf8')); }
			catch (error) {
				if (error.code === 'ENOENT') throw new RequestValidationError('Playlist introuvable', 404);
				throw error;
			}
			data.title = title;
			data.updatedAt = new Date().toISOString();
			await fs_promises.writeFile(target, JSON.stringify(data, null, 2), 'utf8');
		}
		return { name: playlist, title };
	}

	async function deletePlaylistForRequest(req, playlist) {
		if (normalizePlaylistName(playlist) === LIKED_PLAYLIST) throw new RequestValidationError('Utilise le bouton cœur pour modifier cette playlist', 400);
		if (authEnabled) {
			return store.deletePlaylist(req.session.userId, playlist);
		}
		await fs_promises.rm(playlistPath(playlist), { force: true });
		return true;
	}

	async function deletePlaylistItemForRequest(req, playlist, index) {
		if (normalizePlaylistName(playlist) === LIKED_PLAYLIST) throw new RequestValidationError('Utilise le bouton cœur pour modifier cette playlist', 400);
		if (authEnabled) {
			return store.deletePlaylistItem(req.session.userId, playlist, index);
		}

		const filePath = playlistPath(playlist);
		const txt = await fs_promises.readFile(filePath, "utf8");
		const obj = JSON.parse(txt);
		if (!Array.isArray(obj.items) || !obj.items[index]) {
			return null;
		}

		const removed = obj.items.splice(index, 1)[0];
		obj.updatedAt = new Date().toISOString();
		await fs_promises.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
		return removed;
	}

	async function playlistTracksForRequest(req, playlist) {
		const items = await playlistItemsForRequest(req, playlist);
		return items.map((item, index) => ({
			...item,
			__playlist: playlist,
			__playlistIndex: index,
			...(playlist === LIKED_PLAYLIST ? { __queueId: `liked-${createHash('sha256').update(trackLikeKey(item)).digest('hex')}` } : {})
		}));
	}

	// Serialize local read/modify/write operations; a failed write must not block the next one.
	let localLikeWrite = Promise.resolve();
	async function setTrackLikedForRequest(req, track, liked) {
		if (authEnabled) return store.setTrackLiked(req.session.userId, track, liked);
		const operation = localLikeWrite.then(async () => {
			const value = updateLikedTracks(await playlistItemsForRequest(req, LIKED_PLAYLIST), track, liked);
			const target = playlistPath(LIKED_PLAYLIST);
			await fs_promises.writeFile(target + '.tmp', JSON.stringify({ items: value }), { mode: 0o600 });
			await fs_promises.rename(target + '.tmp', target);
			return value;
		});
		localLikeWrite = operation.catch(() => {});
		return operation;
	}
	return { playlistFilesForRequest, playlistSummariesForRequest, playlistItemsForRequest,
		appendPlaylistItemsForRequest, deletePlaylistForRequest, deletePlaylistItemForRequest,
		playlistTracksForRequest, setTrackLikedForRequest, renamePlaylistForRequest };
}
