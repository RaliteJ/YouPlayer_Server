import path from "node:path";
import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { MemoryYouplayerStore } from "./memory-store.js";

const MAP_FIELDS = ["users", "usersByPseudo", "playlists"];
const ARRAY_FIELDS = ["loginEvents", "auditLogs"];
const COUNTER_FIELDS = ["nextUserId", "nextPlaylistId", "nextEventId", "nextAuditId"];

function snapshot(store) {
	return structuredClone({
		version: 1,
		...Object.fromEntries(MAP_FIELDS.map((key) => [key, [...store[key]]])),
		...Object.fromEntries([...ARRAY_FIELDS, ...COUNTER_FIELDS].map((key) => [key, store[key]]))
	});
}

function restore(store, data) {
	if (data?.version !== 1
		|| [...MAP_FIELDS, ...ARRAY_FIELDS].some((key) => !Array.isArray(data[key]))
		|| COUNTER_FIELDS.some((key) => !Number.isSafeInteger(data[key]) || data[key] < 1)) {
		throw new Error("Stockage YouPlayer invalide : restaurer une sauvegarde");
	}
	for (const key of MAP_FIELDS) store[key] = new Map(data[key]);
	for (const key of [...ARRAY_FIELDS, ...COUNTER_FIELDS]) store[key] = data[key];
}

// One backend process owns this file. Each mutation works on an isolated draft;
// readers only see it after the complete snapshot has been written and renamed.
export class FileYouplayerStore extends MemoryYouplayerStore {
	constructor({ filePath }) {
		super();
		if (!filePath || !path.isAbsolute(filePath)) throw new Error("Chemin absolu du stockage YouPlayer requis");
		this.filePath = filePath;
		this.pendingWrite = Promise.resolve();
	}

	async init() {
		let content;
		try {
			content = await fs.readFile(this.filePath, "utf8");
		} catch (err) {
			if (err.code === "ENOENT") return;
			throw err;
		}
		try {
			restore(this, JSON.parse(content));
		} catch {
			// JSON parse errors can include snippets of the private file.
			throw new Error("Stockage YouPlayer invalide : restaurer une sauvegarde");
		}
		await fs.chmod(this.filePath, 0o600);
	}

	async close() {
		await this.pendingWrite;
	}

	async writeSnapshot(data) {
		const directory = path.dirname(this.filePath);
		await fs.mkdir(directory, { recursive: true, mode: 0o700 });
		const temporary = `${this.filePath}.tmp-${randomUUID()}`;
		let handle;
		try {
			handle = await fs.open(temporary, "wx", 0o600);
			await handle.writeFile(JSON.stringify(data));
			await handle.sync();
			await handle.close();
			handle = null;
			await fs.rename(temporary, this.filePath);
		} finally {
			await handle?.close();
			await fs.rm(temporary, { force: true });
		}
	}

	mutate(method, args) {
		const operation = this.pendingWrite.then(async () => {
			const draft = new MemoryYouplayerStore();
			restore(draft, snapshot(this));
			const result = await draft[method](...args);
			const data = snapshot(draft);
			await this.writeSnapshot(data);
			restore(this, data);
			return structuredClone(result);
		});
		// A failed write must not prevent later requests from trying again.
		this.pendingWrite = operation.catch(() => {});
		return operation;
	}
}

for (const method of [
	"createUser", "changePassword", "setUserPassword", "attachSpotifyConnection",
	"updateSpotifyTokens", "removeSpotifyConnection", "mergeUserInto",
	"recordLoginEvent", "recordAuditLog", "ensurePlaylist", "appendPlaylistItems",
	"setTrackLiked", "deletePlaylist", "deletePlaylistItem", "importPlaylistsFromDirectory", "updateLibraryPreferences"
]) {
	Object.defineProperty(FileYouplayerStore.prototype, method, {
		value: function (...args) { return this.mutate(method, args); }
	});
}
