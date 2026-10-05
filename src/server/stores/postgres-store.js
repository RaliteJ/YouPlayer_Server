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
	playlistTitle,
	publicUser,
	readPlaylistFile
} from "./store-utils.js";

function mapUser(row) {
	if (!row) return null;
	return {
		id: String(row.id),
		pseudo: row.pseudo || row.email,
		displayName: row.display_name || "",
		role: row.role,
		passwordHash: row.password_hash,
		spotifyConnection: (row.spotify_account_id || row.spotify_access_token_encrypted || row.spotify_refresh_token_encrypted || row.spotify_scopes) ? {
			accountId: row.spotify_account_id || "",
			displayName: row.spotify_display_name || "",
			scopes: Array.isArray(row.spotify_scopes) ? row.spotify_scopes : [],
			expiresAt: row.spotify_expires_at || null,
			accessTokenEncrypted: row.spotify_access_token_encrypted || "",
			refreshTokenEncrypted: row.spotify_refresh_token_encrypted || ""
		} : null,
		createdAt: row.created_at
	};
}

function mapPublicUser(row) {
	return publicUser(mapUser(row));
}

export class PostgresYouplayerStore {
	constructor({ connectionString }) {
		if (!connectionString) {
			throw new Error("DATABASE_URL est requis pour le store PostgreSQL");
		}
		this.connectionString = connectionString;
		this.pool = null;
	}

	async init() {
		const { Pool } = await import("pg");
		this.pool = new Pool({
			connectionString: this.connectionString,
			ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : undefined
		});
		await this.migrate();
		await this.bootstrapAdmin();
	}

	async close() {
		await this.pool?.end();
	}

	async query(sql, params = []) {
		return this.pool.query(sql, params);
	}

	async migrate() {
		await this.query(`
			CREATE TABLE IF NOT EXISTS yp_users (
				id BIGSERIAL PRIMARY KEY,
					pseudo TEXT NOT NULL UNIQUE,
					display_name TEXT NOT NULL DEFAULT '',
					role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
					password_hash TEXT NOT NULL,
					created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);

			ALTER TABLE yp_users ADD COLUMN IF NOT EXISTS library_preferences JSONB NOT NULL DEFAULT '{}'::jsonb;

			CREATE TABLE IF NOT EXISTS yp_playlists (
				id BIGSERIAL PRIMARY KEY,
				user_id BIGINT NOT NULL REFERENCES yp_users(id) ON DELETE CASCADE,
				name TEXT NOT NULL,
				title TEXT NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				UNIQUE (user_id, name)
			);

			CREATE TABLE IF NOT EXISTS yp_playlist_items (
				id BIGSERIAL PRIMARY KEY,
				playlist_id BIGINT NOT NULL REFERENCES yp_playlists(id) ON DELETE CASCADE,
				position INTEGER NOT NULL,
				data JSONB NOT NULL,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				UNIQUE (playlist_id, position)
			);

			CREATE INDEX IF NOT EXISTS yp_playlist_items_playlist_position_idx
				ON yp_playlist_items (playlist_id, position);

			CREATE TABLE IF NOT EXISTS yp_login_events (
				id BIGSERIAL PRIMARY KEY,
				user_id BIGINT REFERENCES yp_users(id) ON DELETE SET NULL,
				pseudo TEXT NOT NULL,
				success BOOLEAN NOT NULL,
				ip TEXT NOT NULL DEFAULT '',
				user_agent TEXT NOT NULL DEFAULT '',
				created_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);

			CREATE TABLE IF NOT EXISTS yp_audit_logs (
				id BIGSERIAL PRIMARY KEY,
				user_id BIGINT REFERENCES yp_users(id) ON DELETE SET NULL,
				action TEXT NOT NULL,
				resource_type TEXT NOT NULL DEFAULT '',
				resource_id TEXT NOT NULL DEFAULT '',
				details JSONB NOT NULL DEFAULT '{}'::jsonb,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);

			CREATE TABLE IF NOT EXISTS yp_spotify_connections (
				user_id BIGINT PRIMARY KEY REFERENCES yp_users(id) ON DELETE CASCADE,
				account_id TEXT NOT NULL DEFAULT '',
				display_name TEXT NOT NULL DEFAULT '',
				email TEXT NOT NULL DEFAULT '',
				country TEXT NOT NULL DEFAULT '',
				product TEXT NOT NULL DEFAULT '',
				scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
				access_token_encrypted TEXT NOT NULL,
				refresh_token_encrypted TEXT NOT NULL DEFAULT '',
				expires_at TIMESTAMPTZ,
				created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
			);
		`);
		await this.query(`
			ALTER TABLE yp_spotify_connections
			ADD COLUMN IF NOT EXISTS account_id TEXT NOT NULL DEFAULT '';

			CREATE UNIQUE INDEX IF NOT EXISTS yp_spotify_connections_account_unique
			ON yp_spotify_connections (account_id)
			WHERE account_id <> '';

				ALTER TABLE yp_users
				ADD COLUMN IF NOT EXISTS pseudo TEXT;

				DO $$
			BEGIN
				IF EXISTS (
					SELECT 1
					FROM information_schema.columns
					WHERE table_schema = 'public'
						AND table_name = 'yp_users'
						AND column_name = 'email'
				) THEN
					UPDATE yp_users
					SET pseudo = email
					WHERE pseudo IS NULL OR pseudo = '';
				END IF;
			END $$;

			ALTER TABLE yp_users
			ALTER COLUMN pseudo SET NOT NULL;

			CREATE UNIQUE INDEX IF NOT EXISTS yp_users_pseudo_unique
			ON yp_users (pseudo);

			ALTER TABLE yp_login_events
			ADD COLUMN IF NOT EXISTS pseudo TEXT;

			DO $$
			BEGIN
				IF EXISTS (
					SELECT 1
					FROM information_schema.columns
					WHERE table_schema = 'public'
						AND table_name = 'yp_login_events'
						AND column_name = 'email'
				) THEN
					UPDATE yp_login_events
					SET pseudo = email
					WHERE pseudo IS NULL OR pseudo = '';
				END IF;
			END $$;

			ALTER TABLE yp_login_events
			ALTER COLUMN pseudo SET NOT NULL;
		`);
	}

	async bootstrapAdmin() {
		const pseudo = normalizePseudo(process.env.YOUPLAYER_ADMIN_PSEUDO || process.env.YOUPLAYER_ADMIN_EMAIL);
		const password = process.env.YOUPLAYER_ADMIN_PASSWORD;
		if (!pseudo || !password) return;

		const existing = await this.findUserByPseudo(pseudo);
		if (existing) return;

		await this.createUser({
			pseudo,
			password,
			role: "admin",
			displayName: process.env.YOUPLAYER_ADMIN_NAME || "Admin"
		});
	}

	async getLibraryPreferences(userId) {
		const result = await this.query('SELECT library_preferences FROM yp_users WHERE id = $1', [userId]);
		if (!result.rows[0]) throw new Error("Utilisateur introuvable");
		return libraryPreferences(result.rows[0].library_preferences);
	}

	async updateLibraryPreferences(userId, change) {
		const client = await this.pool.connect();
		try {
			await client.query('BEGIN');
			const result = await client.query('SELECT library_preferences FROM yp_users WHERE id = $1 FOR UPDATE', [userId]);
			if (!result.rows[0]) throw new Error("Utilisateur introuvable");
			const playlists = await client.query('SELECT name FROM yp_playlists WHERE user_id = $1', [userId]);
			const value = updateLibraryPreferences(result.rows[0].library_preferences, change, [...playlists.rows.map((row) => row.name), LIKED_PLAYLIST]);
			await client.query('UPDATE yp_users SET library_preferences = $2::jsonb WHERE id = $1', [userId, JSON.stringify(value)]);
			await client.query('COMMIT');
			return value;
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		} finally {
			client.release();
		}
	}

	async createUser({ pseudo, email, password, role = "user", displayName = "" }) {
		const normalizedPseudo = normalizePseudo(pseudo || email);
		if (!normalizedPseudo) {
			throw new Error("Pseudo requis");
		}
		const passwordHash = await hashPassword(password);
		const result = await this.query(`
			INSERT INTO yp_users (pseudo, display_name, role, password_hash)
			VALUES ($1, $2, $3, $4)
			RETURNING id, pseudo, display_name, role, created_at
		`, [normalizedPseudo, displayName || normalizedPseudo, normalizeRole(role), passwordHash]);
		return mapPublicUser(result.rows[0]);
	}

	async findUserByPseudo(pseudo) {
		const result = await this.query(`
			SELECT
				users.id,
				users.pseudo,
				users.display_name,
				users.role,
				users.password_hash,
				users.created_at,
				spotify.account_id AS spotify_account_id,
				spotify.display_name AS spotify_display_name,
				spotify.scopes AS spotify_scopes,
				spotify.access_token_encrypted AS spotify_access_token_encrypted,
				spotify.refresh_token_encrypted AS spotify_refresh_token_encrypted,
				spotify.expires_at AS spotify_expires_at
			FROM yp_users users
			LEFT JOIN yp_spotify_connections spotify ON spotify.user_id = users.id
			WHERE users.pseudo = $1
		`, [normalizePseudo(pseudo)]);
		return mapUser(result.rows[0]);
	}

	async findUserById(userId) {
		const result = await this.query(`
			SELECT
				users.id,
				users.pseudo,
				users.display_name,
				users.role,
				users.password_hash,
				users.created_at,
				spotify.account_id AS spotify_account_id,
				spotify.display_name AS spotify_display_name,
				spotify.scopes AS spotify_scopes,
				spotify.access_token_encrypted AS spotify_access_token_encrypted,
				spotify.refresh_token_encrypted AS spotify_refresh_token_encrypted,
				spotify.expires_at AS spotify_expires_at
			FROM yp_users users
			LEFT JOIN yp_spotify_connections spotify ON spotify.user_id = users.id
			WHERE users.id = $1
		`, [userId]);
		return mapUser(result.rows[0]);
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
		const passwordHash = await hashPassword(newPassword);
		const result = await this.query(`
			UPDATE yp_users
			SET password_hash = $2, updated_at = now()
			WHERE id = $1
			RETURNING id, pseudo, display_name, role, created_at
		`, [userId, passwordHash]);
		return mapPublicUser(result.rows[0]);
	}

	async setUserPassword(userId, newPassword) {
		const user = await this.findUserById(userId);
		if (!user) {
			throw new Error("Utilisateur introuvable");
		}
		const passwordHash = await hashPassword(newPassword);
		const result = await this.query(`
			UPDATE yp_users
			SET password_hash = $2, updated_at = now()
			WHERE id = $1
			RETURNING id, pseudo, display_name, role, created_at
		`, [userId, passwordHash]);
		return mapPublicUser(result.rows[0]);
	}

	async listUsers() {
		const result = await this.query(`
			SELECT id, pseudo, display_name, role, created_at
			FROM yp_users
			ORDER BY pseudo ASC
		`);
		return result.rows.map(mapPublicUser);
	}

	async attachSpotifyConnection(userId, connection) {
		const user = await this.findUserById(userId);
		if (!user) {
			throw new Error("Utilisateur introuvable");
		}
		if (!connection.accountId) {
			throw new Error("Identifiant Spotify requis");
		}
		try {
			await this.query(`
			INSERT INTO yp_spotify_connections (
				user_id,
				account_id,
				display_name,
				scopes,
				access_token_encrypted,
				refresh_token_encrypted,
				expires_at
			)
			VALUES ($1, $2, $3, $4, $5, $6, $7)
			ON CONFLICT (user_id)
			DO UPDATE SET
				account_id = EXCLUDED.account_id,
				display_name = EXCLUDED.display_name,
				scopes = EXCLUDED.scopes,
				access_token_encrypted = EXCLUDED.access_token_encrypted,
				refresh_token_encrypted = EXCLUDED.refresh_token_encrypted,
				expires_at = EXCLUDED.expires_at,
				updated_at = now()
		`, [
			userId,
			connection.accountId,
			connection.displayName || "",
			Array.isArray(connection.scopes) ? connection.scopes : [],
			connection.accessTokenEncrypted || "",
			connection.refreshTokenEncrypted || "",
			connection.expiresAt || null
			]);
		} catch (err) {
			if (err?.code === "23505" && err?.constraint === "yp_spotify_connections_account_unique") {
				const conflict = new Error("Ce compte Spotify est deja lie a un autre compte YouPlayer");
				conflict.statusCode = 409;
				throw conflict;
			}
			throw err;
		}

		return publicUser(await this.findUserById(userId));
	}

	async updateSpotifyTokens(userId, tokenUpdate) {
		const existing = await this.getSpotifyConnection(userId, { includeTokens: true });
		if (!existing) {
			throw new Error("Connexion Spotify introuvable");
		}
		await this.query(`
			UPDATE yp_spotify_connections
			SET
				access_token_encrypted = $2,
				refresh_token_encrypted = $3,
				expires_at = $4,
				scopes = $5,
				updated_at = now()
			WHERE user_id = $1
		`, [
			userId,
			tokenUpdate.accessTokenEncrypted || existing.accessTokenEncrypted,
			tokenUpdate.refreshTokenEncrypted || existing.refreshTokenEncrypted,
			tokenUpdate.expiresAt || existing.expiresAt,
			Array.isArray(tokenUpdate.scopes) && tokenUpdate.scopes.length > 0
				? tokenUpdate.scopes
				: existing.scopes
		]);
		return publicUser(await this.findUserById(userId));
	}

	async getSpotifyConnection(userId, { includeTokens = false } = {}) {
		const result = await this.query(`
			SELECT
				account_id,
				display_name,
				scopes,
				access_token_encrypted,
				refresh_token_encrypted,
				expires_at,
				updated_at
			FROM yp_spotify_connections
			WHERE user_id = $1
		`, [userId]);
		const row = result.rows[0];
		if (!row) return null;
		const connection = {
			accountId: row.account_id || "",
			displayName: row.display_name || "",
			scopes: Array.isArray(row.scopes) ? row.scopes : [],
			expiresAt: row.expires_at || null,
			updatedAt: row.updated_at
		};
		if (includeTokens) {
			connection.accessTokenEncrypted = row.access_token_encrypted || "";
			connection.refreshTokenEncrypted = row.refresh_token_encrypted || "";
		}
		return connection;
	}

	async removeSpotifyConnection(userId) {
		const user = await this.findUserById(userId);
		if (!user) {
			throw new Error("Utilisateur introuvable");
		}
		await this.query("DELETE FROM yp_spotify_connections WHERE user_id = $1", [userId]);
		return publicUser(await this.findUserById(userId));
	}

	async mergeUserInto(sourceUserId, targetUserId) {
		if (String(sourceUserId) === String(targetUserId)) {
			return false;
		}
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const sourceResult = await client.query("SELECT id FROM yp_users WHERE id = $1 FOR UPDATE", [sourceUserId]);
			const targetResult = await client.query("SELECT id FROM yp_users WHERE id = $1 FOR UPDATE", [targetUserId]);
			if (sourceResult.rowCount === 0 || targetResult.rowCount === 0) {
				throw new Error("Utilisateur introuvable");
			}

			const playlistResult = await client.query(`
				SELECT id, name
				FROM yp_playlists
				WHERE user_id = $1
				ORDER BY id ASC
			`, [sourceUserId]);

			for (const sourcePlaylist of playlistResult.rows) {
				const targetPlaylist = await client.query(`
					INSERT INTO yp_playlists (user_id, name, title)
					VALUES ($1, $2, $3)
					ON CONFLICT (user_id, name)
					DO UPDATE SET updated_at = yp_playlists.updated_at
					RETURNING id
				`, [targetUserId, sourcePlaylist.name, playlistTitle(sourcePlaylist.name)]);
				const targetPlaylistId = targetPlaylist.rows[0].id;
				const maxResult = await client.query(`
					SELECT COALESCE(MAX(position), -1) AS max_position
					FROM yp_playlist_items
					WHERE playlist_id = $1
				`, [targetPlaylistId]);
				const offset = Number(maxResult.rows[0].max_position) + 1;
				await client.query(`
					INSERT INTO yp_playlist_items (playlist_id, position, data)
					SELECT $1, position + $3, data
					FROM yp_playlist_items
					WHERE playlist_id = $2
					ORDER BY position ASC
				`, [targetPlaylistId, sourcePlaylist.id, offset]);
				await client.query("UPDATE yp_playlists SET updated_at = now() WHERE id = $1", [targetPlaylistId]);
			}

			await client.query("UPDATE yp_login_events SET user_id = $2 WHERE user_id = $1", [sourceUserId, targetUserId]);
			await client.query("UPDATE yp_audit_logs SET user_id = $2 WHERE user_id = $1", [sourceUserId, targetUserId]);
			await client.query("DELETE FROM yp_users WHERE id = $1", [sourceUserId]);
			await client.query("COMMIT");
			return true;
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		} finally {
			client.release();
		}
	}

	async recordLoginEvent({ userId = null, pseudo, email, success, ip = "", userAgent = "" }) {
		const result = await this.query(`
			INSERT INTO yp_login_events (user_id, pseudo, success, ip, user_agent)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, user_id, pseudo, success, ip, user_agent, created_at
		`, [userId, normalizePseudo(pseudo || email), Boolean(success), ip, userAgent]);
		return this.mapLoginEvent(result.rows[0]);
	}

	mapLoginEvent(row) {
		return {
			id: String(row.id),
			userId: row.user_id ? String(row.user_id) : null,
			pseudo: row.pseudo || row.email,
			success: row.success,
			ip: row.ip,
			userAgent: row.user_agent,
			createdAt: row.created_at
		};
	}

	async recordAuditLog({ userId = null, action, resourceType = "", resourceId = "", details = {} }) {
		const result = await this.query(`
			INSERT INTO yp_audit_logs (user_id, action, resource_type, resource_id, details)
			VALUES ($1, $2, $3, $4, $5)
			RETURNING id, user_id, action, resource_type, resource_id, details, created_at
		`, [userId, action, resourceType, String(resourceId || ""), JSON.stringify(details || {})]);
		return this.mapAuditLog(result.rows[0]);
	}

	mapAuditLog(row) {
		return {
			id: String(row.id),
			userId: row.user_id ? String(row.user_id) : null,
			action: row.action,
			resourceType: row.resource_type,
			resourceId: row.resource_id,
			details: row.details || {},
			createdAt: row.created_at
		};
	}

	async listLoginEvents({ limit = 100 } = {}) {
		const result = await this.query(`
			SELECT id, user_id, pseudo, success, ip, user_agent, created_at
			FROM yp_login_events
			ORDER BY created_at DESC, id DESC
			LIMIT $1
		`, [limit]);
		return result.rows.map((row) => this.mapLoginEvent(row));
	}

	async listAuditLogs({ limit = 100 } = {}) {
		const result = await this.query(`
			SELECT id, user_id, action, resource_type, resource_id, details, created_at
			FROM yp_audit_logs
			ORDER BY created_at DESC, id DESC
			LIMIT $1
		`, [limit]);
		return result.rows.map((row) => this.mapAuditLog(row));
	}

	async ensurePlaylist(userId, playlistName) {
		const name = normalizePlaylistName(playlistName);
		const result = await this.query(`
			INSERT INTO yp_playlists (user_id, name, title)
			VALUES ($1, $2, $3)
			ON CONFLICT (user_id, name)
			DO UPDATE SET updated_at = yp_playlists.updated_at
			RETURNING id, user_id, name, title, updated_at
		`, [userId, name, playlistTitle(name)]);
		return result.rows[0];
	}

	async appendPlaylistItems(userId, playlistName, newItems) {
		const playlist = await this.ensurePlaylist(userId, playlistName);
		const items = Array.isArray(newItems) ? newItems : [newItems];
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			await client.query(`
				SELECT id
				FROM yp_playlists
				WHERE id = $1
				FOR UPDATE
			`, [playlist.id]);
			const maxResult = await client.query(`
				SELECT COALESCE(MAX(position), -1) AS max_position
				FROM yp_playlist_items
				WHERE playlist_id = $1
			`, [playlist.id]);
			let position = Number(maxResult.rows[0].max_position) + 1;
			for (const item of items) {
				await client.query(`
					INSERT INTO yp_playlist_items (playlist_id, position, data)
					VALUES ($1, $2, $3)
				`, [playlist.id, position++, JSON.stringify(item)]);
			}
			await client.query(`
				UPDATE yp_playlists SET updated_at = now()
				WHERE id = $1
			`, [playlist.id]);
			await client.query("COMMIT");
			return {
				playlist: playlist.name,
				count: position,
				added: items.length
			};
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		} finally {
			client.release();
		}
	}

	async setTrackLiked(userId, track, liked) {
		const playlist = await this.ensurePlaylist(userId, LIKED_PLAYLIST);
		const client = await this.pool.connect();
		try {
			await client.query('BEGIN');
			await client.query('SELECT id FROM yp_playlists WHERE id = $1 FOR UPDATE', [playlist.id]);
			const result = await client.query('SELECT data FROM yp_playlist_items WHERE playlist_id = $1 ORDER BY position', [playlist.id]);
			const items = updateLikedTracks(result.rows.map(row => row.data), track, liked);
			await client.query('DELETE FROM yp_playlist_items WHERE playlist_id = $1', [playlist.id]);
			for (const [position, item] of items.entries()) {
				await client.query('INSERT INTO yp_playlist_items (playlist_id, position, data) VALUES ($1, $2, $3)', [playlist.id, position, JSON.stringify(item)]);
			}
			await client.query('UPDATE yp_playlists SET updated_at = now() WHERE id = $1', [playlist.id]);
			await client.query('COMMIT');
			return items;
		} catch (error) {
			await client.query('ROLLBACK');
			throw error;
		} finally { client.release(); }
	}

	async listPlaylistFiles(userId) {
		const result = await this.query(`
			SELECT name
			FROM yp_playlists
			WHERE user_id = $1
			ORDER BY lower(name) ASC
		`, [userId]);
		return result.rows.map((row) => row.name);
	}

	async getPlaylistItems(userId, playlistName) {
		const name = normalizePlaylistName(playlistName);
		const result = await this.query(`
			SELECT item.data
			FROM yp_playlists playlist
			LEFT JOIN yp_playlist_items item ON item.playlist_id = playlist.id
			WHERE playlist.user_id = $1 AND playlist.name = $2
			ORDER BY item.position ASC
		`, [userId, name]);
		if (result.rowCount === 0) {
			throw new Error("Playlist introuvable");
		}
		return result.rows
			.map((row) => row.data)
			.filter(Boolean);
	}

	async getPlaylistSummaries(userId) {
		const result = await this.query(`
			SELECT
				playlist.name,
				playlist.title,
				playlist.updated_at,
				COUNT(item.id)::integer AS count,
				COALESCE((
					SELECT COALESCE(
						image_item.data->>'albumCoverURL',
						image_item.data->>'thumbnail',
						image_item.data->>'image',
						image_item.data->>'cover'
					)
					FROM yp_playlist_items image_item
					WHERE image_item.playlist_id = playlist.id
						AND COALESCE(
							image_item.data->>'albumCoverURL',
							image_item.data->>'thumbnail',
							image_item.data->>'image',
							image_item.data->>'cover',
							''
						) <> ''
					ORDER BY image_item.position ASC
					LIMIT 1
				), '') AS image
			FROM yp_playlists playlist
			LEFT JOIN yp_playlist_items item ON item.playlist_id = playlist.id
			WHERE playlist.user_id = $1
			GROUP BY playlist.id
			ORDER BY lower(playlist.name) ASC
		`, [userId]);
		return result.rows.map((row) => ({
			name: row.name,
			title: row.title,
			image: row.image || "",
			count: row.count,
			updatedAt: row.updated_at
		}));
	}

	async deletePlaylist(userId, playlistName) {
		const result = await this.query(`
			DELETE FROM yp_playlists
			WHERE user_id = $1 AND name = $2
		`, [userId, normalizePlaylistName(playlistName)]);
		return result.rowCount > 0;
	}

	async deletePlaylistItem(userId, playlistName, index) {
		const client = await this.pool.connect();
		try {
			await client.query("BEGIN");
			const playlistResult = await client.query(`
				SELECT id
				FROM yp_playlists
				WHERE user_id = $1 AND name = $2
				FOR UPDATE
			`, [userId, normalizePlaylistName(playlistName)]);
			if (playlistResult.rowCount === 0) {
				throw new Error("Playlist introuvable");
			}
			const playlistId = playlistResult.rows[0].id;
			const itemResult = await client.query(`
				DELETE FROM yp_playlist_items
				WHERE playlist_id = $1 AND position = $2
				RETURNING data
			`, [playlistId, index]);
			if (itemResult.rowCount === 0) {
				await client.query("ROLLBACK");
				return null;
			}
			await client.query(`
				UPDATE yp_playlist_items
				SET position = position - 1
				WHERE playlist_id = $1 AND position > $2
			`, [playlistId, index]);
			await client.query(`
				UPDATE yp_playlists SET updated_at = now()
				WHERE id = $1
			`, [playlistId]);
			await client.query("COMMIT");
			return itemResult.rows[0].data;
		} catch (err) {
			await client.query("ROLLBACK");
			throw err;
		} finally {
			client.release();
		}
	}

	async importPlaylistsFromDirectory(userId, playlistsDir) {
		const files = await fs.readdir(playlistsDir).catch(() => []);
		for (const file of files.filter((name) => name.endsWith(".json"))) {
			const items = await readPlaylistFile(path.join(playlistsDir, file));
			const playlist = await this.ensurePlaylist(userId, file);
			await this.query("DELETE FROM yp_playlist_items WHERE playlist_id = $1", [playlist.id]);
			for (let index = 0; index < items.length; index++) {
				await this.query(`
					INSERT INTO yp_playlist_items (playlist_id, position, data)
					VALUES ($1, $2, $3)
				`, [playlist.id, index, JSON.stringify(items[index])]);
			}
			await this.query("UPDATE yp_playlists SET updated_at = now() WHERE id = $1", [playlist.id]);
		}
	}
}
