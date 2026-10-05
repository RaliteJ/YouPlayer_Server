import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
	createFirstTrackStreamManager,
	FIRST_TRACK_STREAM_STATES
} from "../../src/server/first-track-streams.js";

class FakeChild extends EventEmitter {
	constructor({ hasInput = false } = {}) {
		super();
		this.pid = 0;
		this.exitCode = null;
		this.signalCode = null;
		this.stdin = hasInput ? new PassThrough() : null;
		this.stdout = new PassThrough();
		this.stderr = new PassThrough();
		this.signals = [];
	}

	kill(signal) {
		this.signals.push(signal);
		this.signalCode = signal;
		return true;
	}
}

function createHarness(resolveSource = async () => "youtube-id", overrides = {}) {
	const children = [];
	const manager = createFirstTrackStreamManager({
		resolveSource,
		createId: (() => {
			let id = 0;
			return () => `stream-${++id}`;
		})(),
		spawnProcess(command, args, options) {
			const child = new FakeChild({ hasInput: command === "ffmpeg" });
			children.push({ command, args, options, child });
			return child;
		},
		logger: { debug() {}, error() {} },
		startTimeoutMs: 60_000,
		maxDurationMs: 60_000,
		killGraceMs: 5,
		...overrides
	});
	return { manager, children };
}

test("a first-track stream is owned by the authenticated user, not only by its id", () => {
	const { manager } = createHarness();
	const stream = manager.createStream({
		owner: { userId: "user-a", sessionId: "session-a" },
		track: { id: "youtube-id" }
	});

	assert.equal(stream.state, FIRST_TRACK_STREAM_STATES.STARTING);
	assert.equal(manager.isOwner(stream, { userId: "user-a", sessionId: "session-a" }), true);
	assert.equal(manager.isOwner(stream, { userId: "user-a", sessionId: "other-session" }), false);
	assert.equal(manager.isOwner(stream, { userId: "user-b", sessionId: "session-a" }), false);
	manager.stopAll("test_cleanup");
});

test("creating a new first stream in the same session invalidates the previous one", () => {
	const { manager } = createHarness();
	const first = manager.createStream({
		owner: { userId: "user-a", sessionId: "session-a" },
		track: { id: "first" }
	});
	const second = manager.createStream({
		owner: { userId: "user-a", sessionId: "session-a" },
		track: { id: "second" }
	});

	assert.equal(first.state, FIRST_TRACK_STREAM_STATES.STOPPED);
	assert.equal(manager.getStream(first.id), null);
	assert.equal(manager.getStream(second.id), second);
	manager.stopAll("test_cleanup");
});

test("opening a stream transitions to playing and natural ffmpeg completion removes it", async () => {
	const { manager, children } = createHarness();
	const stream = manager.createStream({
		owner: { userId: "user-a", sessionId: "session-a" },
		track: { id: "youtube-id" }
	});
	const response = new PassThrough();

	await manager.openStream(stream.id, { userId: "user-a", sessionId: "session-a" }, response);
	assert.deepEqual(children.map(({ command }) => command), ["yt-dlp", "ffmpeg"]);
	assert.deepEqual(children[0].args.slice(-4), ["--output", "-", "--", "youtube-id"]);
	assert.equal(children[0].args.includes("--extract-audio"), false);
	assert.deepEqual(children[1].args.slice(-3), ["-f", "mp3", "pipe:1"]);
	children[1].child.stdout.write(Buffer.from("audio"));
	assert.equal(stream.state, FIRST_TRACK_STREAM_STATES.PLAYING);

	children[1].child.exitCode = 0;
	children[1].child.emit("close", 0, null);
	assert.equal(stream.state, FIRST_TRACK_STREAM_STATES.FINISHED);
	assert.equal(manager.getStream(stream.id), null);
	assert.deepEqual(children.map(({ child }) => child.signals), [["SIGTERM"], []]);
});

test("stopping a stream terminates both processes and invalidates the id", async () => {
	const { manager, children } = createHarness();
	const stream = manager.createStream({
		owner: { userId: "user-a", sessionId: "session-a" },
		track: { id: "youtube-id" }
	});
	const response = new PassThrough();

	await manager.openStream(stream.id, { userId: "user-a", sessionId: "session-a" }, response);
	assert.equal(manager.stopStream(stream.id, "next"), true);
	assert.equal(stream.state, FIRST_TRACK_STREAM_STATES.STOPPED);
	assert.equal(manager.getStream(stream.id), null);
	assert.deepEqual(children.map(({ child }) => child.signals), [["SIGTERM"], ["SIGTERM"]]);
});

test("a source resolution error cleans the starting stream", async () => {
	const { manager } = createHarness(async () => {
		throw new Error("resolution failed");
	});
	const stream = manager.createStream({
		owner: { userId: "user-a", sessionId: "session-a" },
		track: { id: "youtube-id" }
	});

	await assert.rejects(
		manager.openStream(stream.id, { userId: "user-a", sessionId: "session-a" }, new PassThrough()),
		/Source audio YouTube introuvable/
	);
	assert.equal(stream.state, FIRST_TRACK_STREAM_STATES.ERROR);
	assert.equal(manager.getStream(stream.id), null);
});

test("a browser disconnect stops the stream and both child processes", async () => {
	const { manager, children } = createHarness();
	const stream = manager.createStream({
		owner: { userId: "user-a", sessionId: "session-a" },
		track: { id: "youtube-id" }
	});
	const response = new PassThrough();

	await manager.openStream(stream.id, { userId: "user-a", sessionId: "session-a" }, response);
	response.destroy();
	await new Promise((resolve) => setImmediate(resolve));

	assert.equal(stream.state, FIRST_TRACK_STREAM_STATES.STOPPED);
	assert.equal(stream.reason, "client_disconnected");
	assert.equal(manager.getStream(stream.id), null);
	assert.deepEqual(children.map(({ child }) => child.signals), [["SIGTERM"], ["SIGTERM"]]);
});

test("yt-dlp and ffmpeg process errors invalidate the stream", async (t) => {
	for (const component of ["yt-dlp", "ffmpeg"]) {
		await t.test(component, async () => {
			const { manager, children } = createHarness();
			const stream = manager.createStream({
				owner: { userId: "user-a", sessionId: `session-${component}` },
				track: { id: "youtube-id" }
			});
			const response = new PassThrough();

			await manager.openStream(
				stream.id,
				{ userId: "user-a", sessionId: `session-${component}` },
				response
			);
			const child = children.find((entry) => entry.command === component).child;
			child.emit("error", new Error("process failed"));

			assert.equal(stream.state, FIRST_TRACK_STREAM_STATES.ERROR);
			assert.equal(stream.reason, `${component}_error`);
			assert.equal(manager.getStream(stream.id), null);
			assert.deepEqual(children.map((entry) => entry.child.signals), [["SIGTERM"], ["SIGTERM"]]);
		});
	}
});

test("an unopened stream expires and shutdown stops every active stream", async () => {
	const timeoutHarness = createHarness(async () => "youtube-id", { startTimeoutMs: 5 });
	const expiring = timeoutHarness.manager.createStream({
		owner: { userId: "user-a", sessionId: "session-timeout" },
		track: { id: "youtube-id" }
	});
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(expiring.state, FIRST_TRACK_STREAM_STATES.STOPPED);
	assert.equal(expiring.reason, "start_timeout");
	assert.equal(timeoutHarness.manager.getStream(expiring.id), null);

	const { manager } = createHarness();
	const first = manager.createStream({
		owner: { userId: "user-a", sessionId: "session-a" },
		track: { id: "first" }
	});
	const second = manager.createStream({
		owner: { userId: "user-b", sessionId: "session-b" },
		track: { id: "second" }
	});
	manager.stopAll("shutdown");
	assert.equal(first.state, FIRST_TRACK_STREAM_STATES.STOPPED);
	assert.equal(second.state, FIRST_TRACK_STREAM_STATES.STOPPED);
	assert.equal(manager.getStream(first.id), null);
	assert.equal(manager.getStream(second.id), null);
});
