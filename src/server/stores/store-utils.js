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

export function playlistImage(items = []) {
	for (const item of items) {
		const image = item?.albumCoverURL || item?.thumbnail || item?.image || item?.cover;
		if (typeof image === "string" && image.trim()) {
			return image;
		}
	}
	return "";
}

function publicSpotifyConnection(user) {
	const spotify = user.spotify || user.spotifyConnection || {};
	if (!spotify || Object.keys(spotify).length === 0) {
		return { connected: false };
	}

	return {
		connected: true,
		displayName: spotify.displayName || spotify.display_name || "",
		scopes: Array.isArray(spotify.scopes) ? spotify.scopes : [],
		expiresAt: spotify.expiresAt || spotify.expires_at || null
	};
}

export function publicUser(user) {
	if (!user) return null;
	const spotify = publicSpotifyConnection(user);
	return {
		id: String(user.id),
		pseudo: user.pseudo,
		displayName: user.displayName || user.display_name || "",
		role: user.role,
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
