import { MemoryYouplayerStore } from "./stores/memory-store.js";
import { FileYouplayerStore } from "./stores/file-store.js";
import { PostgresYouplayerStore } from "./stores/postgres-store.js";
import { readdir } from "fs/promises";

export async function createYouplayerStore() {
	const useMemory = process.env.NODE_ENV === "test"
		|| process.env.YOUPLAYER_STORE === "memory"
		|| process.env.YOUPLAYER_AUTH_ENABLED === "false";

	const store = !useMemory && process.env.YOUPLAYER_STORE === "file"
		? new FileYouplayerStore({ filePath: process.env.YOUPLAYER_DATA_FILE || "/var/lib/youplayer/store.json" })
		: useMemory
		? new MemoryYouplayerStore({
			spotifyConnectionsFile: process.env.YOUPLAYER_SPOTIFY_CONNECTIONS_FILE || ""
		})
		: new PostgresYouplayerStore({ connectionString: process.env.DATABASE_URL });

	await store.init();
	if (store instanceof FileYouplayerStore) {
		await bootstrapFileAdmin(store);
	}
	return store;
}

export async function bootstrapFileAdmin(store, env = process.env) {
	if ((await store.listUsers()).some((user) => user.role === "admin")) return;
	const pseudo = String(env.YOUPLAYER_ADMIN_PSEUDO || "").trim();
	const password = env.YOUPLAYER_ADMIN_PASSWORD;
	if (!pseudo || /^\$\{/.test(pseudo) || typeof password !== "string"
		|| password.length < 12 || /^\$\{/.test(password)) {
		throw new Error("Premier demarrage : definir YOUPLAYER_ADMIN_PSEUDO et YOUPLAYER_ADMIN_PASSWORD (12 caracteres minimum)");
	}
	if (await store.findUserByPseudo(pseudo)) {
		throw new Error("Le pseudo administrateur choisi appartient deja a un utilisateur");
	}
	await store.createUser({ pseudo, password, role: "admin" });
}

export async function seedTestStore(store, playlistsDir) {
	if (store instanceof FileYouplayerStore) {
		throw new Error("Les comptes de test sont interdits avec le stockage persistant");
	}
	async function ensureUser(userConfig) {
		const existing = await store.findUserByPseudo(userConfig.pseudo);
		return existing ? { id: existing.id } : store.createUser(userConfig);
	}

	const user = await ensureUser({
		pseudo: "user",
		password: "password123",
		role: "user",
		displayName: "Test User"
	});
	const second = await ensureUser({
		pseudo: "second",
		password: "password123",
		role: "user",
		displayName: "Second User"
	});
	const admin = await ensureUser({
		pseudo: "admin",
		password: "password123",
		role: "admin",
		displayName: "Admin User"
	});

	await store.importPlaylistsFromDirectory(user.id, playlistsDir);

	const seededPlaylistNames = (await readdir(playlistsDir).catch(() => []))
		.filter((name) => name.endsWith(".json"));
	for (const account of [second, admin]) {
		for (const playlistName of seededPlaylistNames) {
			await store.deletePlaylist(account.id, playlistName);
		}
	}
}
