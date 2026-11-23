import path from "path";
import { promises as fs } from "fs";

export function normalizePseudo(pseudo) {
	return String(pseudo || "").trim().toLowerCase();
}

export function normalizeRole(role) {
	return role === "admin" ? "admin" : "user";
}

export function normalizePlaylistName(playlistName) {
	const name = String(playlistName || "").trim();
	const finalName = name.endsWith(".json") ? name : `${name}.json`;
	if (!name || path.basename(finalName) !== finalName || !finalName.endsWith(".json")) {
		throw new Error("Nom de playlist invalide");
	}
	return finalName;
}

export function playlistTitle(name) {
	return normalizePlaylistName(name).replace(/\.json$/i, "");
}

export function normalizePlaylistTitle(value) {
	if (typeof value !== 'string' || !value.trim() || value.trim().length > 100 || /[\\/\x00-\x1f\x7f]/.test(value)) {
		throw Object.assign(new Error('Nom de playlist invalide (100 caractères maximum)'), { statusCode: 400 });
	}
	return value.trim();
}

export function playlistImage(items = []) {
	for (const item of items) {
		const image = item?.albumCoverURL || item?.thumbnail || item?.image || item?.cover;
		if (typeof image === "string" && image.trim()) {
			return image;
		}
	}
	return "";
}

export function publicUser(user) {
	if (!user) return null;
	const spotify = { connected: false };
	return {
		id: String(user.id),
		pseudo: user.pseudo,
		displayName: user.displayName || user.display_name || "",
		role: user.role,
		authVersion: Number(user.authVersion ?? user.auth_version) || 0,
		authLevel: spotify.connected ? "spotify" : "local",
		spotify
	};
}

export function requestContext(req) {
	return {
		ip: req.ip || req.socket?.remoteAddress || "",
		userAgent: req.get?.("user-agent") || req.headers?.["user-agent"] || ""
	};
}

export async function readPlaylistFile(filePath) {
	const txt = await fs.readFile(filePath, "utf8");
	const obj = JSON.parse(txt);
	return Array.isArray(obj.items) ? obj.items : [];
}
