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
	assert.equal(stream.source, 'youtube-id');
	assert.deepEqual(children.map(({ command }) => command), ["yt-dlp", "ffmpeg"]);
	assert.deepEqual(children[0].args.slice(-4), ["--output", "-", "--", "youtube-id"]);
	assert.equal(children[0].args[children[0].args.indexOf('--extractor-args') + 1], 'youtube:player_client=visionos');
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

test('a rejected fast client falls back once without closing FFmpeg or changing stream ownership', async () => {
	const { manager, children } = createHarness();
	const owner = { userId: 'user-a', sessionId: 'session-a' };
	const stream = manager.createStream({ owner, track: { id: 'youtube-id' }, startPosition: 42 });
	try {
		await manager.openStream(stream.id, owner, new PassThrough());
		const first = children[0].child;
		first.stdout.end();
		first.exitCode = 1;
		first.emit('close', 1, null);
		assert.equal(children.length, 3);
		assert.equal(children[2].command, 'yt-dlp');
		assert.equal(children[2].args.includes('--extractor-args'), false);
		assert.deepEqual(children[2].args.slice(-4), ['--output', '-', '--', 'youtube-id']);
		assert.equal(children[1].child.stdin.writableEnded, false);
		assert.equal(stream.startPosition, 42);
		assert.equal(manager.isOwner(stream, owner), true);
		assert.equal(manager.isOwner(stream, { ...owner, userId: 'user-b' }), false);
		const received = [];
		children[1].child.stdin.on('data', chunk => received.push(chunk));
		children[2].child.stdout.end(Buffer.from('fallback audio'));
		children[2].child.exitCode = 0;
		children[2].child.emit('close', 0, null);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(Buffer.concat(received).toString(), 'fallback audio');
		assert.equal(children[1].child.stdin.writableEnded, true);
		children[1].child.stdout.write(Buffer.from('mp3'));
		children[1].child.exitCode = 0;
		children[1].child.emit('close', 0, null);
		assert.equal(stream.state, FIRST_TRACK_STREAM_STATES.FINISHED);
	} finally { manager.stopAll('test_cleanup'); }
});

test('downloader failure cannot retry after audio starts or retry the default client twice', async t => {
	for (const audioStarted of [true, false]) {
		await t.test(audioStarted ? 'after audio starts' : 'after fallback fails', async () => {
			const { manager, children } = createHarness();
			const owner = { userId: 'user-a', sessionId: 'session-a' };
			const stream = manager.createStream({ owner, track: { id: 'youtube-id' } });
			await manager.openStream(stream.id, owner, new PassThrough());
			if (audioStarted) children[0].child.stdout.write(Buffer.from('audio'));
			children[0].child.exitCode = 1;
			children[0].child.emit('close', 1, null);
			if (!audioStarted) {
				children[2].child.exitCode = 1;
				children[2].child.emit('close', 1, null);
			}
			assert.equal(children.length, audioStarted ? 2 : 3);
			assert.equal(stream.state, FIRST_TRACK_STREAM_STATES.ERROR);
			assert.equal(stream.reason, 'yt-dlp_error');
			assert.equal(manager.getStream(stream.id), null);
			assert.deepEqual(children[1].child.signals, ['SIGTERM']);
		});
	}
});

test('disconnect during fallback terminates both active processes and prevents late retries', async () => {
	const { manager, children } = createHarness();
	const owner = { userId: 'user-a', sessionId: 'session-a' };
	const stream = manager.createStream({ owner, track: { id: 'youtube-id' } });
	const response = new PassThrough();
	await manager.openStream(stream.id, owner, response);
	children[0].child.exitCode = 1;
	children[0].child.emit('close', 1, null);
	response.destroy();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(stream.state, FIRST_TRACK_STREAM_STATES.STOPPED);
	assert.deepEqual(children.slice(1).map(({ child }) => child.signals), [['SIGTERM'], ['SIGTERM']]);
	children[2].child.emit('close', 1, null);
	assert.equal(children.length, 3);
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

test('resumed streams trim audio at the saved position without changing process ownership', async () => {
    const { manager, children } = createHarness();
    const owner = { userId: 'user-a', sessionId: 'session-a' };
    const stream = manager.createStream({ owner, track: { id: 'youtube-id' }, startPosition: 42.5 });
    try {
        await manager.openStream(stream.id, owner, new PassThrough());
        const args = children[1].args;
        assert.deepEqual(args.slice(args.indexOf('-ss'), args.indexOf('-ss') + 2), ['-ss', '42.5']);
        assert.ok(args.indexOf('-ss') > args.indexOf('-i'));
        for (const startPosition of [-1, Infinity, NaN, '12', 86401]) {
            assert.throws(() => manager.createStream({ owner, track: {}, startPosition }), /Position/);
            assert.equal(manager.getStream(stream.id), stream);
        }
    } finally {
        manager.stopAll('test_cleanup');
    }
});
