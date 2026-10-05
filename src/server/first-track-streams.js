import { randomUUID } from "crypto";
import { spawn } from "child_process";

export const FIRST_TRACK_STREAM_STATES = Object.freeze({
	STARTING: "starting",
	PLAYING: "playing",
	STOPPED: "stopped",
	FINISHED: "finished",
	ERROR: "error"
});

function clearTimer(timer) {
	if (timer) clearTimeout(timer);
}

function normalizePrincipal(principal = {}) {
	return {
		userId: principal.userId === undefined || principal.userId === null
			? null
			: String(principal.userId),
		sessionId: String(principal.sessionId || "")
	};
}

export function createFirstTrackStreamManager({
	resolveSource,
	logger,
	spawnProcess = spawn,
	createId = randomUUID,
	ytDlpCommand = "yt-dlp",
	ffmpegCommand = "ffmpeg",
	startTimeoutMs = 30_000,
	maxDurationMs = 2 * 60 * 60 * 1000,
	killGraceMs = 1_500
} = {}) {
	if (typeof resolveSource !== "function") {
		throw new TypeError("resolveSource est requis");
	}

	const streams = new Map();
	const streamBySession = new Map();

	function transition(record, state, reason = "") {
		record.state = state;
		record.reason = reason;
		record.updatedAt = Date.now();
		logger?.debug?.("Flux spécial premier titre:", {
			streamId: record.id,
			state,
			reason
		});
	}

	function signalChild(child, signal) {
		if (!child || child.exitCode !== null || child.signalCode) return;
		try {
			if (child.pid && process.platform !== "win32") {
				process.kill(-child.pid, signal);
			} else {
				child.kill(signal);
			}
		} catch {
			try {
				child.kill(signal);
			} catch {
				// Le processus est déjà terminé.
			}
		}
	}

	function terminateChildren(record) {
		for (const child of record.children) {
			signalChild(child, "SIGTERM");
		}
		const forceTimer = setTimeout(() => {
			for (const child of record.children) {
				signalChild(child, "SIGKILL");
			}
		}, killGraceMs);
		forceTimer.unref?.();
	}

	function removeRecord(record) {
		clearTimer(record.startTimer);
		clearTimer(record.maxTimer);
		streams.delete(record.id);
		if (streamBySession.get(record.owner.sessionId) === record.id) {
			streamBySession.delete(record.owner.sessionId);
		}
	}

	function finalize(record, state, reason, { terminate = true, destroyResponse = false } = {}) {
		if (!record || !streams.has(record.id)) return false;
		transition(record, state, reason);
		removeRecord(record);
		if (terminate) terminateChildren(record);
		if (record.response && !record.response.writableEnded && !record.response.destroyed) {
			if (destroyResponse) record.response.destroy();
			else record.response.end();
		}
		return true;
	}

	function isOwner(record, principal) {
		if (!record) return false;
		const normalized = normalizePrincipal(principal);
		if (record.owner.userId !== null) {
			return normalized.userId !== null
				&& record.owner.userId === normalized.userId
				&& Boolean(normalized.sessionId)
				&& record.owner.sessionId === normalized.sessionId;
		}
		return Boolean(normalized.sessionId) && record.owner.sessionId === normalized.sessionId;
	}

	function stopStream(streamId, reason = "stopped") {
		return finalize(streams.get(streamId), FIRST_TRACK_STREAM_STATES.STOPPED, reason, {
			terminate: true,
			destroyResponse: true
		});
	}

	function finishStream(streamId, reason = "natural_end") {
		return finalize(streams.get(streamId), FIRST_TRACK_STREAM_STATES.FINISHED, reason, {
			terminate: true,
			destroyResponse: false
		});
	}

	function failStream(streamId, reason = "client_error") {
		return finalize(streams.get(streamId), FIRST_TRACK_STREAM_STATES.ERROR, reason, {
			terminate: true,
			destroyResponse: true
		});
	}

	function stopForSession(sessionId, reason = "replaced") {
		const streamId = streamBySession.get(String(sessionId || ""));
		return streamId ? stopStream(streamId, reason) : false;
	}

	function createStream({ owner, track, nextEnabled = true }) {
		const normalizedOwner = normalizePrincipal(owner);
		if (!normalizedOwner.sessionId) {
			throw new TypeError("sessionId est requis pour un flux spécial");
		}
		stopForSession(normalizedOwner.sessionId, "replaced");

		const id = createId();
		const record = {
			id,
			owner: normalizedOwner,
			track,
			state: FIRST_TRACK_STREAM_STATES.STARTING,
			reason: "",
			createdAt: Date.now(),
			updatedAt: Date.now(),
			children: [],
			response: null,
			nextEnabled: nextEnabled !== false,
			startTimer: null,
			maxTimer: null
		};
		record.startTimer = setTimeout(() => stopStream(id, "start_timeout"), startTimeoutMs);
		record.startTimer.unref?.();
		streams.set(id, record);
		streamBySession.set(normalizedOwner.sessionId, id);
		transition(record, FIRST_TRACK_STREAM_STATES.STARTING, "created");
		return record;
	}

	async function openStream(streamId, principal, response) {
		const record = streams.get(streamId);
		if (!record) {
			const error = new Error("Flux introuvable ou expiré");
			error.statusCode = 404;
			throw error;
		}
		if (!isOwner(record, principal)) {
			const error = new Error("Ce flux appartient à un autre utilisateur");
			error.statusCode = 403;
			throw error;
		}
		if (record.response || record.state !== FIRST_TRACK_STREAM_STATES.STARTING) {
			const error = new Error("Ce flux est déjà utilisé");
			error.statusCode = 409;
			throw error;
		}

		let source = "";
		try {
			source = String(await resolveSource(record.track) || "").trim();
		} catch (cause) {
			finalize(record, FIRST_TRACK_STREAM_STATES.ERROR, "source_error");
			const error = new Error("Source audio YouTube introuvable", { cause });
			error.statusCode = 502;
			throw error;
		}
		if (!source) {
			finalize(record, FIRST_TRACK_STREAM_STATES.ERROR, "source_unavailable");
			const error = new Error("Source audio YouTube introuvable");
			error.statusCode = 502;
			throw error;
		}
		if (!streams.has(streamId)) {
			const error = new Error("Flux annulé");
			error.statusCode = 410;
			throw error;
		}

		clearTimer(record.startTimer);
		record.startTimer = null;
		const commonOptions = {
			detached: process.platform !== "win32",
			stdio: ["ignore", "pipe", "pipe"]
		};
		const nodeBinary = process.execPath || "node";
		let ytDlp;
		let ffmpeg;
		try {
			ytDlp = spawnProcess(ytDlpCommand, [
				"--js-runtimes", `node:${nodeBinary}`,
				"--remote-components", "ejs:github",
				"--format", "bestaudio",
				"--no-playlist",
				"--no-cookies",
				"--no-cache-dir",
				"--no-progress",
				"--output", "-",
				"--",
				source
			], commonOptions);
			record.children.push(ytDlp);
			ffmpeg = spawnProcess(ffmpegCommand, [
				"-hide_banner",
				"-loglevel", "error",
				"-i", "pipe:0",
				"-map", "0:a:0",
				"-vn",
				"-c:a", "libmp3lame",
				"-b:a", "192k",
				"-f", "mp3",
				"pipe:1"
			], {
				...commonOptions,
				stdio: ["pipe", "pipe", "pipe"]
			});
			record.children.push(ffmpeg);
		} catch (cause) {
			finalize(record, FIRST_TRACK_STREAM_STATES.ERROR, "spawn_error");
			const error = new Error("Démarrage du flux audio impossible", { cause });
			error.statusCode = 502;
			throw error;
		}
		record.response = response;
		record.maxTimer = setTimeout(() => stopStream(streamId, "max_duration"), maxDurationMs);
		record.maxTimer.unref?.();

		const fail = (component, error) => {
			logger?.error?.(`Erreur flux spécial ${component}:`, error?.message || "processus interrompu");
			finalize(record, FIRST_TRACK_STREAM_STATES.ERROR, `${component}_error`, {
				terminate: true,
				destroyResponse: true
			});
		};

		ytDlp.on("error", (error) => fail("yt-dlp", error));
		ffmpeg.on("error", (error) => fail("ffmpeg", error));
		ytDlp.stdin?.on?.("error", () => {});
		ffmpeg.stdin?.on?.("error", () => {});
		ytDlp.stderr?.resume?.();
		ffmpeg.stderr?.resume?.();

		ytDlp.on("close", (code, signal) => {
			if (!streams.has(streamId)) return;
			if (code !== 0) fail("yt-dlp", new Error(`sortie ${code ?? signal ?? "inconnue"}`));
		});
		ffmpeg.on("close", (code, signal) => {
			if (!streams.has(streamId)) return;
			if (code === 0) {
				finalize(record, FIRST_TRACK_STREAM_STATES.FINISHED, "natural_end", {
					terminate: true,
					destroyResponse: false
				});
				return;
			}
			fail("ffmpeg", new Error(`sortie ${code ?? signal ?? "inconnue"}`));
		});
		ffmpeg.stdout.once("data", () => {
			if (streams.has(streamId)) transition(record, FIRST_TRACK_STREAM_STATES.PLAYING, "audio_started");
		});

		response.once("close", () => {
			if (!response.writableFinished) stopStream(streamId, "client_disconnected");
		});
		ytDlp.stdout.pipe(ffmpeg.stdin);
		ffmpeg.stdout.pipe(response);
		return record;
	}

	function stopAll(reason = "shutdown") {
		for (const streamId of Array.from(streams.keys())) {
			stopStream(streamId, reason);
		}
	}

	return {
		createStream,
		findForSession(sessionId) {
			const streamId = streamBySession.get(String(sessionId || ""));
			return streamId ? streams.get(streamId) || null : null;
		},
		getStream(streamId) {
			return streams.get(streamId) || null;
		},
		isOwner,
		openStream,
		stopStream,
		finishStream,
		failStream,
		stopForSession,
		stopAll
	};
}
