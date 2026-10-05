import { LIKED_PLAYLIST } from '../../client-utils.js';
import { updateLikedTracks } from '../liked-tracks.js';
import path from "path";
import { promises as fs } from "fs";
import { hashPassword, verifyPassword } from "../passwords.js";
import { libraryPreferences, updateLibraryPreferences } from "../library-preferences.js";
import {
	normalizePseudo,
	normalizePlaylistName,
	normalizeRole,
	playlistImage,
	playlistTitle,
	publicUser,
	readPlaylistFile
} from "./store-utils.js";

export class MemoryYouplayerStore {
	constructor({ spotifyConnectionsFile = "" } = {}) {
		this.users = new Map();
		this.usersByPseudo = new Map();
		this.playlists = new Map();
		this.loginEvents = [];
		this.auditLogs = [];
		this.nextUserId = 1;
		this.nextPlaylistId = 1;
		this.nextEventId = 1;
		this.nextAuditId = 1;
		this.spotifyConnectionsFile = spotifyConnectionsFile;
		this.persistedSpotifyConnections = new Map();
	}

	async init() {
		if (!this.spotifyConnectionsFile) return;
		try {
			const data = JSON.parse(await fs.readFile(this.spotifyConnectionsFile, "utf8"));
			const accountIds = new Set();
			for (const [pseudo, connection] of Object.entries(data?.accounts || {})) {
				if (!connection?.accountId || accountIds.has(connection.accountId)) {
					throw new Error("Registre des connexions Spotify invalide");
				}
				accountIds.add(connection.accountId);
				this.persistedSpotifyConnections.set(normalizePseudo(pseudo), { ...connection });
			}
		} catch (err) {
			if (err?.code !== "ENOENT") throw err;
		}
	}

	async close() {}

	async createUser({ pseudo, email, password, role = "user", displayName = "" }) {
		const normalizedPseudo = normalizePseudo(pseudo || email);
		if (!normalizedPseudo) {
			throw new Error("Pseudo requis");
		}
		if (this.usersByPseudo.has(normalizedPseudo)) {
			throw new Error("Un utilisateur existe deja avec ce pseudo");
		}

		const user = {
			id: String(this.nextUserId++),
			pseudo: normalizedPseudo,
			displayName: displayName || normalizedPseudo,
			role: normalizeRole(role),
			passwordHash: await hashPassword(password),
			spotifyConnection: this.persistedSpotifyConnections.get(normalizedPseudo) || null,
			createdAt: new Date().toISOString()
		};
		this.users.set(user.id, user);
		this.usersByPseudo.set(user.pseudo, user.id);
		return publicUser(user);
	}

	async persistSpotifyConnections() {
		if (!this.spotifyConnectionsFile) return;
		const accounts = {};
		for (const user of this.users.values()) {
			if (user.spotifyConnection) accounts[user.pseudo] = user.spotifyConnection;
		}
		const dir = path.dirname(this.spotifyConnectionsFile);
		const temporary = `${this.spotifyConnectionsFile}.tmp-${process.pid}`;
		await fs.mkdir(dir, { recursive: true, mode: 0o700 });
		await fs.writeFile(temporary, JSON.stringify({ version: 1, accounts }, null, 2), { mode: 0o600 });
		await fs.chmod(temporary, 0o600);
		await fs.rename(temporary, this.spotifyConnectionsFile);
	}

	async findUserByPseudo(pseudo) {
		const userId = this.usersByPseudo.get(normalizePseudo(pseudo));
		return userId ? this.users.get(userId) : null;
	}

	async findUserById(userId) {
		return this.users.get(String(userId)) || null;
	}

	async authenticate(pseudo, password) {
		const user = await this.findUserByPseudo(pseudo);
		if (!user) return null;
		const ok = await verifyPassword(password, user.passwordHash);
		return ok ? publicUser(user) : null;
	}

	async changePassword(userId, currentPassword, newPassword) {
		const user = await this.findUserById(userId);
		if (!user) {
			throw new Error("Utilisateur introuvable");
		}
		const ok = await verifyPassword(currentPassword, user.passwordHash);
		if (!ok) {
			throw new Error("Mot de passe actuel invalide");
		}
		user.passwordHash = await hashPassword(newPassword);
		return publicUser(user);
	}

	async setUserPassword(userId, newPassword) {
		const user = await this.findUserById(userId);
		if (!user) {
			throw new Error("Utilisateur introuvable");
		}
		user.passwordHash = await hashPassword(newPassword);
		return publicUser(user);
	}

	async listUsers() {
		return Array.from(this.users.values())
			.map(publicUser)
			.sort((a, b) => a.pseudo.localeCompare(b.pseudo));
	}

	async getLibraryPreferences(userId) {
		const user = await this.findUserById(userId);
		if (!user) throw new Error("Utilisateur introuvable");
		return libraryPreferences(user.libraryPreferences);
	}

	async updateLibraryPreferences(userId, change) {
		const user = await this.findUserById(userId);
		if (!user) throw new Error("Utilisateur introuvable");
		const available = [...new Set([...(await this.listPlaylistFiles(userId)), LIKED_PLAYLIST])];
		user.libraryPreferences = updateLibraryPreferences(user.libraryPreferences, change, available);
		return libraryPreferences(user.libraryPreferences);
	}

	async attachSpotifyConnection(userId, connection) {
		const user = await this.findUserById(userId);
		if (!user) {
			throw new Error("Utilisateur introuvable");
		}
		if (!connection.accountId) {
			throw new Error("Identifiant Spotify requis");
		}
		for (const otherUser of this.users.values()) {
			if (otherUser.id !== user.id && otherUser.spotifyConnection?.accountId === connection.accountId) {
				const error = new Error("Ce compte Spotify est deja lie a un autre compte YouPlayer");
				error.statusCode = 409;
				throw error;
			}
		}
		const previous = user.spotifyConnection;
		user.spotifyConnection = {
			accountId: connection.accountId,
			displayName: connection.displayName || "",
			scopes: Array.isArray(connection.scopes) ? connection.scopes : [],
			accessTokenEncrypted: connection.accessTokenEncrypted || "",
			refreshTokenEncrypted: connection.refreshTokenEncrypted || "",
			expiresAt: connection.expiresAt || null,
			updatedAt: new Date().toISOString()
		};
		try {
			await this.persistSpotifyConnections();
		} catch (err) {
			user.spotifyConnection = previous;
			throw err;
		}
		return publicUser(user);
	}

	async updateSpotifyTokens(userId, tokenUpdate) {
		const user = await this.findUserById(userId);
		if (!user?.spotifyConnection) {
			throw new Error("Connexion Spotify introuvable");
		}
		const previous = user.spotifyConnection;
		user.spotifyConnection = {
			...user.spotifyConnection,
			accessTokenEncrypted: tokenUpdate.accessTokenEncrypted || user.spotifyConnection.accessTokenEncrypted,
			refreshTokenEncrypted: tokenUpdate.refreshTokenEncrypted || user.spotifyConnection.refreshTokenEncrypted,
			expiresAt: tokenUpdate.expiresAt || user.spotifyConnection.expiresAt,
			scopes: Array.isArray(tokenUpdate.scopes) && tokenUpdate.scopes.length > 0
				? tokenUpdate.scopes
				: user.spotifyConnection.scopes,
			updatedAt: new Date().toISOString()
		};
		try {
			await this.persistSpotifyConnections();
		} catch (err) {
			user.spotifyConnection = previous;
			throw err;
		}
		return publicUser(user);
	}

	async getSpotifyConnection(userId, { includeTokens = false } = {}) {
		const user = await this.findUserById(userId);
		if (!user?.spotifyConnection) return null;
		const connection = { ...user.spotifyConnection };
		if (!includeTokens) {
			delete connection.accessTokenEncrypted;
			delete connection.refreshTokenEncrypted;
		}
		return connection;
	}

	async removeSpotifyConnection(userId) {
		const user = await this.findUserById(userId);
		if (!user) {
			throw new Error("Utilisateur introuvable");
		}
		const previous = user.spotifyConnection;
		user.spotifyConnection = null;
		try {
			await this.persistSpotifyConnections();
		} catch (err) {
			user.spotifyConnection = previous;
			throw err;
		}
		return publicUser(user);
	}

	async mergeUserInto(sourceUserId, targetUserId) {
		const sourceId = String(sourceUserId);
		const targetId = String(targetUserId);
		if (sourceId === targetId) {
			return false;
		}
		const source = await this.findUserById(sourceId);
		const target = await this.findUserById(targetId);
		if (!source || !target) {
			throw new Error("Utilisateur introuvable");
		}

		const sourcePlaylists = Array.from(this.playlists.values())
			.filter((playlist) => playlist.userId === sourceId)
			.map((playlist) => ({ ...playlist, items: playlist.items.map((item) => ({ ...item })) }));

		for (const playlist of sourcePlaylists) {
			await this.appendPlaylistItems(targetId, playlist.name, playlist.items);
			this.playlists.delete(this.playlistKey(sourceId, playlist.name));
		}

		for (const event of this.loginEvents) {
			if (event.userId === sourceId) event.userId = targetId;
		}
		for (const log of this.auditLogs) {
			if (log.userId === sourceId) log.userId = targetId;
		}

		this.users.delete(sourceId);
		this.usersByPseudo.delete(source.pseudo);
		return true;
	}

	async recordLoginEvent({ userId = null, pseudo, email, success, ip = "", userAgent = "" }) {
		const event = {
			id: String(this.nextEventId++),
			userId: userId ? String(userId) : null,
			pseudo: normalizePseudo(pseudo || email),
			success: Boolean(success),
			ip,
			userAgent,
			createdAt: new Date().toISOString()
		};
		this.loginEvents.unshift(event);
		return event;
	}

	async recordAuditLog({ userId = null, action, resourceType = "", resourceId = "", details = {} }) {
		const log = {
			id: String(this.nextAuditId++),
			userId: userId ? String(userId) : null,
			action,
			resourceType,
			resourceId: resourceId ? String(resourceId) : "",
			details,
			createdAt: new Date().toISOString()
		};
		this.auditLogs.unshift(log);
		return log;
	}

	async listLoginEvents({ limit = 100 } = {}) {
		return this.loginEvents.slice(0, limit);
	}

	async listAuditLogs({ limit = 100 } = {}) {
		return this.auditLogs.slice(0, limit);
	}

	playlistKey(userId, playlistName) {
		return `${String(userId)}:${normalizePlaylistName(playlistName)}`;
	}

	async ensurePlaylist(userId, playlistName) {
		const name = normalizePlaylistName(playlistName);
		const key = this.playlistKey(userId, name);
		let playlist = this.playlists.get(key);
		if (!playlist) {
			playlist = {
				id: String(this.nextPlaylistId++),
				userId: String(userId),
				name,
				title: playlistTitle(name),
				items: [],
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString()
			};
			this.playlists.set(key, playlist);
		}
		return playlist;
	}

	async appendPlaylistItems(userId, playlistName, newItems) {
		const playlist = await this.ensurePlaylist(userId, playlistName);
		const items = Array.isArray(newItems) ? newItems : [newItems];
		playlist.items.push(...items);
		playlist.updatedAt = new Date().toISOString();
		return {
			playlist: playlist.name,
			count: playlist.items.length,
			added: items.length
		};
	}

	async setTrackLiked(userId, track, liked) {
		const playlist = await this.ensurePlaylist(userId, LIKED_PLAYLIST);
		playlist.items = updateLikedTracks(playlist.items, track, liked);
		playlist.updatedAt = new Date().toISOString();
		return playlist.items.map(item => ({ ...item }));
	}

	async listPlaylistFiles(userId) {
		return Array.from(this.playlists.values())
			.filter((playlist) => playlist.userId === String(userId))
			.map((playlist) => playlist.name)
			.sort((a, b) => a.localeCompare(b, "fr", { sensitivity: "base" }));
	}

	async getPlaylistItems(userId, playlistName) {
		const playlist = this.playlists.get(this.playlistKey(userId, playlistName));
		if (!playlist) {
			throw new Error("Playlist introuvable");
		}
		return playlist.items.map((item) => ({ ...item }));
	}

	async getPlaylistSummaries(userId) {
		const names = await this.listPlaylistFiles(userId);
		return names.map((name) => {
			const playlist = this.playlists.get(this.playlistKey(userId, name));
			return {
				name,
				title: playlist.title,
				image: playlistImage(playlist.items),
				count: playlist.items.length,
				updatedAt: playlist.updatedAt
			};
		});
	}

	async deletePlaylist(userId, playlistName) {
		return this.playlists.delete(this.playlistKey(userId, playlistName));
	}

	async deletePlaylistItem(userId, playlistName, index) {
		const playlist = this.playlists.get(this.playlistKey(userId, playlistName));
		if (!playlist) {
			throw new Error("Playlist introuvable");
		}
		if (!Number.isInteger(index) || index < 0 || !playlist.items[index]) {
			return null;
		}
		const [removed] = playlist.items.splice(index, 1);
		playlist.updatedAt = new Date().toISOString();
		return removed;
	}

	async importPlaylistsFromDirectory(userId, playlistsDir) {
		const files = await fs.readdir(playlistsDir).catch(() => []);
		for (const file of files.filter((name) => name.endsWith(".json"))) {
			const filePath = path.join(playlistsDir, file);
			const items = await readPlaylistFile(filePath);
			const playlist = await this.ensurePlaylist(userId, file);
			playlist.items = items;
			playlist.updatedAt = new Date().toISOString();
		}
	}
}
