import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioCrossfade } from '../src/audio-crossfade.js';

function fixture() {
    const audio = new EventTarget();
    Object.assign(audio, { duration: 30, currentTime: 28, paused: false, ended: false, volume: 0.6, muted: false });
    const nodes = [];
    const node = () => {
        const value = {
            gain: { value: 1, ramps: [], cancelScheduledValues() {},
                setValueAtTime(v) { this.value = v; },
                linearRampToValueAtTime(v, t) { this.ramps.push([v, t]); } },
            connect() { return this; }, disconnect() {},
            start(...args) { this.started = args; }, stop() { this.stopped = true; }
        };
        nodes.push(value);
        return value;
    };
    const fade = new AudioCrossfade(audio);
    fade.context = { currentTime: 10, state: 'running', createGain: node, createBufferSource: node };
    fade.mainGain = node();
    fade.prepared = { path: '/play/1', buffer: { duration: 60 } };
    return { audio, fade, nodes };
}

test('overlap schedules opposite ramps without changing the current source', () => {
    const { fade, audio } = fixture();
    fade.tick(true, '/play/1');
    assert.deepEqual(fade.mainGain.gain.ramps, [[0, 12]]);
    assert.deepEqual(fade.preview.gain.gain.ramps, [[0.6, 12]]);
    assert.deepEqual(fade.preview.source.started, [0, 0, 4]);
    assert.equal(audio.currentTime, 28);
    const preview = fade.preview;
    fade.tick(true, '/play/1');
    assert.equal(fade.preview, preview);
});

test('configured duration controls overlap onset from zero to ten seconds', () => {
    for (const seconds of [0, 1, 5, 10]) {
        const { fade, audio } = fixture();
        fade.setDuration(seconds);
        fade.prepared = { path: '/play/1', buffer: { duration: 60 } };
        audio.currentTime = 30 - seconds - 0.2;
        fade.tick(true, '/play/1');
        assert.ok(!fade.preview);
        audio.currentTime = 30 - Math.max(0.5, seconds - 0.1);
        fade.tick(true, '/play/1');
        assert.equal(!!fade.preview, seconds > 0);
        if (seconds > 0) assert.ok(Math.abs(fade.preview.source.started[2] - (seconds + 1.9)) < 0.001);
    }
});

for (const event of ['pause', 'seeking', 'waiting', 'error']) {
    test(`${event} stops preview and restores main gain`, () => {
        const { fade, audio } = fixture();
        fade.tick(true, '/play/1');
        const source = fade.preview.source;
        audio.dispatchEvent(new Event(event));
        assert.equal(source.stopped, true);
        assert.equal(fade.preview, null);
        assert.equal(fade.mainGain.gain.value, 1);
    });
}

test('repeat, missing next track, disabled option and suspended context keep ordinary playback', () => {
    for (const change of [f => { f.enabled = false; }, f => { f.prepared = null; }, f => { f.context.state = 'suspended'; }]) {
        const { fade } = fixture();
        change(fade);
        fade.tick(true, '/play/1');
        assert.equal(fade.preview, undefined);
    }
    const { fade } = fixture();
    fade.tick(false, '/play/1');
    assert.ok(!fade.preview);
});

test('handoff keeps the preview until the persistent player really advances', () => {
    const { fade, audio } = fixture();
    fade.tick(true, '/play/1');
    fade.context.currentTime = 12.1;
    fade.beginHandoff('/play/1');
    fade.tick(false, '/play/1');
    audio.dispatchEvent(new Event('loadedmetadata'));
    assert.ok(Math.abs(audio.currentTime - 2.1) < 0.001);
    audio.dispatchEvent(new Event('seeking'));
    assert.ok(fade.preview);
    audio.dispatchEvent(new Event('playing'));
    assert.ok(fade.preview);
    assert.equal(fade.mainGain.gain.value, 0);
    audio.currentTime += 0.04;
    audio.dispatchEvent(new Event('timeupdate'));
    assert.equal(fade.handoffFinishing, false);
    audio.currentTime += 0.05;
    fade.context.currentTime += 0.09;
    audio.dispatchEvent(new Event('timeupdate'));
    assert.equal(fade.handoffFinishing, true);
    assert.deepEqual(fade.mainGain.gain.ramps.at(-1), [1, fade.context.currentTime + 0.06]);
    assert.deepEqual(fade.preview.gain.gain.ramps.at(-1), [0, fade.context.currentTime + 0.06]);
    fade.preview.source.onended();
    assert.equal(fade.preview, null);
    assert.equal(fade.mainGain.gain.value, 1);
});

test('foreground handoff can finish between timeupdate events and cancels its frame on stop', t => {
    const { fade, audio } = fixture();
    let frame;
    let cancelled = null;
    const originalRequest = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = callback => { frame = callback; return 7; };
    globalThis.cancelAnimationFrame = id => { cancelled = id; };
    t.after(() => {
        if (originalRequest) globalThis.requestAnimationFrame = originalRequest;
        else delete globalThis.requestAnimationFrame;
        if (originalCancel) globalThis.cancelAnimationFrame = originalCancel;
        else delete globalThis.cancelAnimationFrame;
    });
    fade.tick(true, '/play/1');
    fade.context.currentTime = 12;
    fade.beginHandoff('/play/1');
    audio.dispatchEvent(new Event('loadedmetadata'));
    audio.dispatchEvent(new Event('playing'));
    fade.context.currentTime = 12.03;
    audio.currentTime = 2.03;
    frame();
    assert.equal(fade.handoffFinishing, true);
    assert.equal(fade.handoffFrame, null);
    fade.cancel();
    // Explicit cancellation also removes a still-pending frame.
    fade.handoff = true;
    fade.handoffFinishing = false;
    fade.scheduleHandoffCheck();
    fade.cancel();
    assert.equal(cancelled, 7);
});

test('queue replacement cancels the old preview and decode generation', () => {
    const { fade } = fixture();
    fade.tick(true, '/play/1');
    const source = fade.preview.source;
    fade.clear();
    assert.equal(source.stopped, true);
    assert.equal(fade.prepared, null);
    assert.equal(fade.generation, 1);
    fade.beginHandoff('/play/2');
    assert.equal(fade.handoff, false);
});

test('prefetch cleanup preserves the audible handoff, but explicit clearing still stops it', () => {
    const { fade, audio } = fixture();
    fade.tick(true, '/play/1');
    fade.context.currentTime = 12;
    fade.beginHandoff('/play/1');
    audio.dispatchEvent(new Event('loadedmetadata'));
    audio.dispatchEvent(new Event('timeupdate'));
    assert.equal(fade.handoffFinishing, false, 'seek position alone is not playback');
    audio.dispatchEvent(new Event('playing'));
    const preview = fade.preview;
    fade.clear({ preserveHandoff: true });
    assert.equal(fade.prepared, null);
    assert.equal(fade.preview, preview);
    assert.equal(preview.source.stopped, undefined);
    audio.currentTime += 0.1;
    fade.context.currentTime += 0.1;
    audio.dispatchEvent(new Event('timeupdate'));
    assert.equal(fade.handoffFinishing, true);
    fade.clear({ preserveHandoff: true });
    assert.equal(fade.preview, preview);
    fade.clear();
    assert.equal(fade.preview, null);
    assert.equal(preview.source.stopped, true);
});

test('a delayed seek catches up silently before the handoff and restores playback speed', () => {
    const { fade, audio } = fixture();
    audio.playbackRate = 1;
    fade.tick(true, '/play/1');
    fade.context.currentTime = 12;
    fade.beginHandoff('/play/1');
    audio.dispatchEvent(new Event('loadedmetadata'));
    audio.dispatchEvent(new Event('playing'));
    fade.context.currentTime = 12.4;
    audio.currentTime = 2.1;
    audio.dispatchEvent(new Event('timeupdate'));
    assert.equal(fade.handoffFinishing, false);
    assert.equal(fade.mainGain.gain.value, 0);
    assert.equal(audio.playbackRate, 1.5);
    fade.context.currentTime = 13;
    audio.currentTime = 3;
    audio.dispatchEvent(new Event('timeupdate'));
    assert.equal(fade.handoffFinishing, true);
    assert.equal(audio.playbackRate, 1);
    fade.cancel();
    assert.equal(audio.playbackRate, 1);
});

test('muting also silences the overlapping source', () => {
    const { fade, audio } = fixture();
    fade.tick(true, '/play/1');
    audio.muted = true;
    audio.dispatchEvent(new Event('volumechange'));
    assert.equal(fade.preview.gain.gain.value, 0);
    assert.equal(fade.preview.gain.gain.ramps.at(-1)[0], 0);
});

test('a decoded response arriving after a queue change is discarded', async t => {
    const { fade } = fixture();
    fade.mainSource = {};
    let resolveDecode;
    let started;
    const decoding = new Promise(resolve => { started = resolve; });
    fade.context.decodeAudioData = () => {
        started();
        return new Promise(resolve => { resolveDecode = resolve; });
    };
    t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3])));
    const preparing = fade.prepare({ path: '/play/2' });
    await decoding;
    fade.clear();
    resolveDecode({ duration: 60 });
    await preparing;
    assert.equal(fade.prepared, null);
});

test('download and decode failures leave normal playback available', async t => {
    const { fade } = fixture();
    fade.mainSource = {};
    t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array([1, 2, 3])));
    fade.context.decodeAudioData = async () => { throw new Error('Invalid audio'); };
    await fade.prepare({ path: '/play/2' });
    fade.tick(true, '/play/2');
    assert.equal(fade.prepared, null);
    assert.equal(fade.mainGain.gain.value, 1);
    assert.ok(!fade.preview);
});
