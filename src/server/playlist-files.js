import path from "path";
import { promises as fs } from "fs";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { logger } from "./logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT_DIR = dirname(__dirname);

export const PLAYLISTS_DIR = path.join(ROOT_DIR, "playlists");

export function playlistPath(playlistName, playlistsDir = PLAYLISTS_DIR) {
	if (!playlistName || path.basename(playlistName) !== playlistName || !playlistName.endsWith(".json")) {
		throw new Error("Nom de playlist invalide");
	}
	return path.join(playlistsDir, playlistName);
}

export async function updateJsonFile(filePath, newItem) {
	const txt = await fs.readFile(filePath, "utf8");
	let obj;
	try {
		obj = JSON.parse(txt);
	} catch (err) {
		logger.error("Erreur de parsing JSON :", err);
		throw err;
	}

	if (!Array.isArray(obj.items)) {
		obj.items = [];
	}
	if (Array.isArray(newItem)) {
		for (const item of newItem) {
			obj.items.push(item);
		}
	} else {
		obj.items.push(newItem);
	}
	obj.updatedAt = new Date().toISOString();

	await fs.writeFile(filePath, JSON.stringify(obj, null, 2), "utf8");
	logger.debug("Fichier mis a jour :", filePath, Array.isArray(newItem) ? newItem.length : 1);
}

export async function listPlaylistFiles(playlistsDir = PLAYLISTS_DIR) {
	const files = await fs.readdir(playlistsDir);
	return files
		.filter((file) => file.endsWith(".json"))
		.sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
}

export function playlistImageFromItems(items = []) {
	for (const item of items) {
		const image = item?.albumCoverURL || item?.thumbnail || item?.image || item?.cover;
		if (typeof image === "string" && image.trim()) {
			return image;
		}
	}
	return "";
}

export async function getPlaylistSummary(file, playlistsDir = PLAYLISTS_DIR) {
	try {
		const txt = await fs.readFile(playlistPath(file, playlistsDir), "utf8");
		const obj = JSON.parse(txt);
		const items = Array.isArray(obj.items) ? obj.items : [];
		const image = obj.image || obj.coverImage || obj.coverUrl || playlistImageFromItems(items);

		return {
			name: file,
			title: file.replace(/\.json$/i, ""),
			image,
			count: items.length,
			updatedAt: obj.updatedAt || null
		};
	} catch (err) {
		logger.error("Erreur resume playlist:", file, err.message);
		return {
			name: file,
			title: file.replace(/\.json$/i, ""),
			image: "",
			count: 0,
			updatedAt: null
		};
	}
}
