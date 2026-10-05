import fs from 'fs';
import { promises as fs_promises } from 'fs';
import { resolveMusicTrack } from './music-resolver.js';
import { execFile } from "child_process";
import path from "path";
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { downloadQueue } from './download-queue.js';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = dirname(__dirname);
const PLAYLISTS_DIR = path.join(ROOT_DIR, "playlists");
const MUSIQ_DIR = process.env.YOUPLAYER_MUSIQ_DIR || "/var/www/html/musiq";

function downloadFailedPath(sessionID, id) {
	return path.join(MUSIQ_DIR, String(sessionID), `${id}.failed`);
}

function downloadInProgressPath(sessionID, id) {
	return path.join(MUSIQ_DIR, String(sessionID), `${id}.downloading`);
}

async function markDownloadFailed(sessionID, id, err) {
	await fs_promises.writeFile(downloadFailedPath(sessionID, id), err?.message || String(err), "utf8");
}

async function clearDownloadFailed(sessionID, id) {
	await fs_promises.rm(downloadFailedPath(sessionID, id), { force: true });
}

async function markDownloadInProgress(sessionID, id) {
	await fs_promises.writeFile(downloadInProgressPath(sessionID, id), String(Date.now()), { flag: "wx" });
}

async function clearDownloadInProgress(sessionID, id) {
	await fs_promises.rm(downloadInProgressPath(sessionID, id), { force: true });
}

function playlistPath(playlistName) {
	if (!playlistName || path.basename(playlistName) !== playlistName || !playlistName.endsWith(".json")) {
		throw new Error("Nom de playlist invalide");
	}
	return path.join(PLAYLISTS_DIR, playlistName);
}

function getYoutubeUrlFromSpotifyTrack(trackData) {
	const candidate = trackData?.id || trackData?.youtubeId || trackData?.youtube_id || trackData?.url || trackData?.youtubeUrl;
	if (typeof candidate !== "string" || candidate.trim() === "") {
		return null;
	}
	return candidate.trim();
}

function canonicalYoutubeSource(value) {
	const source = String(value || "").trim();
	if (!source) return null;
	if (/^https?:\/\//i.test(source)) {
		try {
			const hostname = new URL(source).hostname.toLowerCase();
			return hostname === "youtu.be" || hostname === "youtube.com" || hostname.endsWith(".youtube.com")
				? source
				: null;
		} catch {
			return null;
		}
	}
	return /^[A-Za-z0-9_-]{6,}$/.test(source)
		? `https://www.youtube.com/watch?v=${source}`
		: null;
}

function toStoredTrack(trackData, fallbackTitle) {
	return {
		title: trackData?.title || fallbackTitle || "",
		artist: trackData?.artist || "",
		album: trackData?.album || "",
		id: getYoutubeUrlFromSpotifyTrack(trackData) || "",
		albumCoverURL: trackData?.albumCoverURL || "",
		trackNumber: trackData?.trackNumber || 0,
		...(Number(trackData?.duration_ms) > 0 ? { duration_ms: trackData.duration_ms } : {}),
		...(trackData?.type === "spotify" ? { type: "spotify", url: trackData.url } : {})
	};
}

async function updatePlaylistTrack(song, trackData) {
	if (!song.__playlist || !Number.isInteger(song.__playlistIndex)) {
		return;
	}

	const filePath = playlistPath(song.__playlist);
	const txt = await fs_promises.readFile(filePath, "utf8");
	const playlist = JSON.parse(txt);
	if (!Array.isArray(playlist.items) || !playlist.items[song.__playlistIndex]) {
		return;
	}

	playlist.items[song.__playlistIndex] = toStoredTrack(trackData, song.title);
	playlist.updatedAt = new Date().toISOString();
	await fs_promises.writeFile(filePath, JSON.stringify(playlist, null, 2), "utf8");
	logger.debug("Playlist mise à jour avec l'ID YouTube:", song.__playlist, song.__playlistIndex);
}

async function getYoutubeTrackFromSearch(song) {
	return resolveMusicTrack(song);
}

export function youtubeDownloadArgs(source, sessionID, id, { nodeBinary = process.execPath } = {}) {
	return [
		'--js-runtimes', `node:${nodeBinary}`,
		'--remote-components', 'ejs:github',
		'--extract-audio', '--audio-format', 'mp3',
		'--no-playlist', '--no-cookies', '--no-cache-dir',
		'--output', path.join(MUSIQ_DIR, String(sessionID), `${String(id)}.%(ext)s`),
		'--', String(source)
	];
}

export async function resolveYoutubeStreamSource(song = {}, { resolveTrack = resolveMusicTrack } = {}) {
	if (song.type === "spotify") {
		const track = await resolveTrack(song);
		return canonicalYoutubeSource(track.id);
	}

	const directId = getYoutubeUrlFromSpotifyTrack({
		id: song.id || song.youtubeId || song.youtube_id
	});
	if (directId) {
		return canonicalYoutubeSource(directId);
	}

	if (song.type === "youtube" && typeof song.url === "string" && song.url.trim()) {
		return canonicalYoutubeSource(song.url);
	}

	const searchedTrack = await getYoutubeTrackFromSearch(song);
	return canonicalYoutubeSource(getYoutubeUrlFromSpotifyTrack(searchedTrack));
}

async function downloadTrackWithSearchFallback(song, id, sessionID) {
	const firstId = song.id || song.url;
	try {
		return await download_youtube([firstId, id], sessionID);
	} catch (err) {
		logger.warn(`Téléchargement initial échoué pour ${id}, fallback recherche YouTube:`, err.message);
		const fallbackTrack = await getYoutubeTrackFromSearch(song);
		if (!fallbackTrack?.id || fallbackTrack.id === firstId) {
			throw err;
		}
		const result = await download_youtube([fallbackTrack.id, id], sessionID);
		try {
			await updatePlaylistTrack(song, fallbackTrack);
		} catch (updateErr) {
			logger.error("Téléchargement fallback OK, mais mise à jour playlist échouée:", updateErr.message);
		}
		return result;
	}
}

export async function download_spotify(arg, sessionID, song = {}, {
	resolveTrack = resolveMusicTrack, downloadYoutube = download_youtube
} = {}){
	logger.debug("Argument recu: download_spotify", arg[1]);
	const data1 = await resolveTrack(song);
	const finalYoutubeUrl = getYoutubeUrlFromSpotifyTrack(data1);
	logger.debug("URL YouTube récupérée pour Spotify");
	const result = await downloadYoutube([finalYoutubeUrl, arg[1]], sessionID);
	try {
		await updatePlaylistTrack(song, data1);
	} catch (err) {
		logger.error("Téléchargement OK, mais mise à jour playlist échouée:", err.message);
	}
	return result;
}

export async function download_youtube(arg, sessionID) {
	logger.debug("Argument reçu download_youtube:", arg[1]);
	if (typeof arg[0] !== "string" || arg[0].trim() === "" || arg[0] === "undefined") {
		throw new Error(`URL YouTube invalide: ${arg[0]}`);
	}
		fs.mkdirSync(path.join(MUSIQ_DIR, String(sessionID)), { recursive: true });
	await clearDownloadFailed(sessionID, arg[1]);
	try {
		await markDownloadInProgress(sessionID, arg[1]);
	} catch (err) {
		if (err?.code === "EEXIST") {
			logger.debug("Téléchargement déjà en cours:", sessionID, arg[1]);
			return;
		}
		throw err;
	}

	try {
		return await new Promise((resolve, reject) => {
			execFile('yt-dlp', youtubeDownloadArgs(arg[0], sessionID, arg[1]), (error, stdout, stderr) => {
				if (stdout) logger.debug(stdout);
				if (stderr) logger.debug(stderr);
				if (error) {
					logger.error("Erreur yt-dlp:", error);
					reject(error);
					return;
				}
				resolve(stdout);
			});
		});
	} finally {
		await clearDownloadInProgress(sessionID, arg[1]);
	}
};

export async function deleteDownloadedTrack(id, sessionID, { musiqDir = MUSIQ_DIR } = {}) {
	const root = path.resolve(musiqDir);
	const sessionRoot = path.resolve(root, String(sessionID));
	const target = path.resolve(sessionRoot, `${String(id)}.mp3`);
	if (path.basename(String(sessionID)) !== String(sessionID)
		|| path.basename(String(id)) !== String(id)
		|| path.dirname(sessionRoot) !== root || path.dirname(target) !== sessionRoot) {
		throw new Error('Chemin de cache audio invalide');
	}
	await fs_promises.rm(target, { force: true });
}


export function check_downloaded(id, sessionID) {
	if (
		fs.existsSync(path.join(MUSIQ_DIR, String(sessionID), `${id}.mp3`))
		|| fs.existsSync(downloadInProgressPath(sessionID, id))
	) {
		return true
	}
	else {
		return false
	}
}

export function chargement_video(song, id, sessionID) {
	const enqueueDownload = (task) => {
		downloadQueue.enqueue(task).catch((err) => {
			logger.error(`Téléchargement échoué pour ${id}:`, err.message);
			markDownloadFailed(sessionID, id, err).catch((writeErr) => logger.error(writeErr));
		});
	};

	if (song.type === "spotify") {
		logger.debug("Téléchargement Spotify:", id);
		enqueueDownload(() => download_spotify([song.url, id], sessionID, song));
	}
	else if (song.id) {
		logger.debug("Téléchargement depuis l'ID YouTube enregistré");
		enqueueDownload(() => downloadTrackWithSearchFallback(song, id, sessionID));
	}
	else if (song.type == "youtube") {
		logger.debug("Téléchargement YouTube");
		enqueueDownload(() => downloadTrackWithSearchFallback(song, id, sessionID));

	}
}
