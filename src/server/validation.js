import path from "path";
import { getYoutubeId } from "./media-utils.js";
import { normalizePlaylistName, normalizePseudo, normalizeRole } from "./stores/store-utils.js";

export class RequestValidationError extends Error {
	constructor(message, statusCode = 400) {
		super(message);
		this.name = "RequestValidationError";
		this.statusCode = statusCode;
	}
}

export function validatePassword(password, fieldName = "Mot de passe") {
	if (typeof password !== "string" || password.length < 8) {
		throw new RequestValidationError(`${fieldName} invalide: 8 caracteres minimum`);
	}
	return password;
}

export function validateCreateUserPayload(body = {}) {
	const pseudo = normalizePseudo(body.pseudo || body.email);
	if (!pseudo) {
		throw new RequestValidationError("Pseudo requis");
	}
	return {
		pseudo,
		password: validatePassword(body.password),
		role: normalizeRole(body.role),
		displayName: String(body.displayName || body.display_name || "").trim()
	};
}

export function validateOwnPasswordChangePayload(body = {}) {
	return {
		currentPassword: validatePassword(body.currentPassword, "Mot de passe actuel"),
		newPassword: validatePassword(body.newPassword, "Nouveau mot de passe")
	};
}

export function validateAdminPasswordResetPayload(body = {}) {
	return {
		newPassword: validatePassword(body.newPassword, "Nouveau mot de passe")
	};
}

export function safeStoredFileName(value) {
	const name = String(value || "").trim();
	if (
		!name
		|| name === "."
		|| name === ".."
		|| path.basename(name) !== name
		|| /[\\/\x00-\x1F]/.test(name)
	) {
		throw new RequestValidationError("Nom de fichier local invalide");
	}
	return name;
}

export function resolveStoredFile(rootDir, value) {
	const safeName = safeStoredFileName(value);
	const root = path.resolve(rootDir);
	const resolved = path.resolve(root, safeName);
	if (resolved !== root && resolved.startsWith(`${root}${path.sep}`)) {
		return resolved;
	}
	throw new RequestValidationError("Chemin de fichier local invalide");
}

export function validateLocalArtwork(value, { allowRemote = false } = {}) {
	if (value === undefined || value === '') return '';
	if (typeof value !== 'string') throw new RequestValidationError('Image invalide');
	if (allowRemote && /^https?:\/\//i.test(value)) return validateUrl(value, 'Image');
	const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
	if (!match || match[2].length % 4 !== 0) throw new RequestValidationError('Image invalide');
	const bytes = Buffer.from(match[2], 'base64');
	if (bytes.length === 0 || bytes.length > 128 * 1024) throw new RequestValidationError('Image trop volumineuse');
	const valid = match[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
		: match[1] === 'jpeg' ? bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
		: bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
	if (!valid) throw new RequestValidationError('Image invalide');
	return value;
}

export function validateLocalUploadMetadata(fields = {}, originalName = '') {
	const fallback = path.basename(originalName).replace(/\.[^/.]+$/, '');
	const rawTitle = fields.title === undefined ? fallback : fields.title;
	if (typeof rawTitle !== 'string' || !rawTitle.trim() || rawTitle.trim().length > 200) {
		throw new RequestValidationError('Titre invalide');
	}
	if (fields.artist !== undefined && (typeof fields.artist !== 'string' || fields.artist.trim().length > 120)) {
		throw new RequestValidationError('Artiste invalide');
	}
	return {
		title: rawTitle.trim(),
		artist: String(fields.artist || '').trim(),
		albumCoverURL: validateLocalArtwork(fields.albumCoverURL)
	};
}

function cleanOptionalString(value, maxLength = 500) {
	return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function validateUrl(value, label) {
	const raw = cleanOptionalString(value, 2000);
	try {
		const parsed = new URL(raw);
		if (!["http:", "https:"].includes(parsed.protocol)) {
			throw new Error();
		}
		return parsed.toString();
	} catch {
		throw new RequestValidationError(`${label} invalide`);
	}
}

function youtubeIdFromInput(song) {
	const fromUrl = getYoutubeId(song.url);
	if (fromUrl) return fromUrl;
	const id = cleanOptionalString(song.id || song.youtubeId, 128);
	return /^[A-Za-z0-9_-]{6,}$/.test(id) ? id : "";
}

export function sanitizeTrackInput(song, { allowLocal = true } = {}) {
	if (!song || typeof song !== "object" || Array.isArray(song)) {
		throw new RequestValidationError("Musique invalide");
	}

	const type = cleanOptionalString(song.type || "youtube", 32).toLowerCase();
	const baseTrack = {
		title: cleanOptionalString(song.title || song.name || "Titre inconnu"),
		artist: cleanOptionalString(song.artist || song.channelTitle),
		album: cleanOptionalString(song.album),
		albumCoverURL: cleanOptionalString(song.albumCoverURL || song.thumbnail || song.image || song.cover, 2000),
		trackNumber: Number.isInteger(Number(song.trackNumber)) ? Number(song.trackNumber) : 0
	};

	if (type === "local") {
		if (!allowLocal) {
			throw new RequestValidationError("Ajout local direct interdit");
		}
		return {
			...baseTrack,
			albumCoverURL: validateLocalArtwork(song.albumCoverURL || song.thumbnail || song.image || song.cover, { allowRemote: true }),
			type: "local",
			url: safeStoredFileName(song.url)
		};
	}

	if (type === "youtube") {
		const id = youtubeIdFromInput(song);
		if (!id) {
			throw new RequestValidationError("Lien YouTube invalide");
		}
		return {
			...baseTrack,
			type: "youtube",
			id,
			url: `https://www.youtube.com/watch?v=${id}`,
			thumbnail: cleanOptionalString(song.thumbnail || song.albumCoverURL, 2000)
		};
	}

	if (type === "spotify") {
		const url = validateUrl(song.url, "Lien Spotify");
		const parsed = new URL(url);
		const match = /^\/track\/([A-Za-z0-9]{6,})\/?$/.exec(parsed.pathname);
		if (parsed.hostname !== 'open.spotify.com' || !match || parsed.protocol !== 'https:') {
			throw new RequestValidationError("Lien Spotify invalide");
		}
		return {
			...baseTrack,
			type: "spotify",
			url: `https://open.spotify.com/track/${match[1]}`,
			...(Number.isFinite(Number(song.duration_ms)) && Number(song.duration_ms) > 0
				&& Number(song.duration_ms) <= 86400000 ? { duration_ms: Math.round(Number(song.duration_ms)) } : {}),
			id: ''
		};
	}

	throw new RequestValidationError("Type de musique invalide");
}

export function validatePlaylistSelectionPayload(body = {}) {
	const playlists = Array.isArray(body.arg)
		? body.arg.map((playlist) => normalizePlaylistName(playlist))
		: [];
	return {
		playlists,
		random: typeof body.random === "boolean" ? body.random : undefined
	};
}

export function validatePlaybackCollection(items, index) {
	if (!Array.isArray(items) || items.length === 0 || items.length > 5000
		|| !Number.isInteger(index) || index < 0 || index >= items.length) {
		throw new RequestValidationError('Collection de lecture invalide');
	}
	return items.map(song => sanitizeTrackInput(song, { allowLocal: false }));
}

export function validatePlaylistMutationPayload(body = {}) {
	const arg = body.arg || {};
	return {
		playlist: normalizePlaylistName(arg.playlist),
		song: sanitizeTrackInput(arg.song)
	};
}

export function requireYoutubeApiKey(apiKey) {
	if (!apiKey) {
		throw new RequestValidationError("Cle API YouTube non configuree", 503);
	}
	return apiKey;
}
