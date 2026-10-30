import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioCrossfade } from '../src/audio-crossfade.js';
import { createPlayerController } from '../src/player-controller.js';

class Audio extends EventTarget {
    constructor() {
        super();
        Object.assign(this, { id: 'lecteur', duration: 30, currentTime: 28, readyState: 4,
            paused: false, ended: false, volume: 0.6, muted: false, playbackRate: 1, loads: 0, plays: 0 });
    }
    cloneNode() { const audio = new Audio(); audio.paused = true; audio.currentTime = 0; return audio; }
    after() {}
    removeAttribute(name) { delete this[name]; }
    load() { this.loads++; }
    play() { this.plays++; this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
}

function fixture() {
    const audio = new Audio();
    const fade = new AudioCrossfade(audio);
    const node = () => ({
        gain: { value: 1, ramps: [], cancelScheduledValues() {},
            setValueAtTime(v) { this.value = v; },
            linearRampToValueAtTime(v, t) { this.ramps.push([v, t]); } }
    });
    fade.context = { currentTime: 10, state: 'running' };
    fade.mainSource = {};
    fade.nextSource = {};
    fade.mainGain = node();
    fade.nextGain = node();
    fade.prepare({ path: '/play/1' });
    return { audio, fade, next: fade.nextAudio };
}

async function overlap(fade) {
    fade.tick(true, '/play/1');
    await Promise.resolve();
}

test('opposite ramps start only after the streaming player actually plays', async () => {
    const { fade, audio, next } = fixture();
    let resolve;
    next.play = () => new Promise(r => { resolve = r; });
    fade.tick(true, '/play/1');
    assert.equal(fade.mainGain.gain.ramps.length, 0);
    assert.equal(fade.nextGain.gain.value, 0);
    resolve();
    await Promise.resolve();
    assert.deepEqual(fade.mainGain.gain.ramps, [[0, 12]]);
    assert.deepEqual(fade.nextGain.gain.ramps, [[1, 12]]);
    assert.equal(audio.currentTime, 28);
});

test('promotion keeps the second player and its position, then alternates back', async () => {
    const { fade, audio, next } = fixture();
    await overlap(fade);
    next.currentTime = 2;
    const loads = next.loads;
    assert.equal(fade.take('/play/1'), next);
    assert.equal(next.currentTime, 2);
    assert.equal(next.loads, loads);
    assert.equal(next.plays, 1);
    assert.equal(audio.paused, true);
    assert.equal(audio.src, undefined);
    assert.equal(next.id, 'lecteur');
    assert.equal(audio.id, 'lecteur-next');
    fade.prepare({ path: '/play/2' });
    next.currentTime = 28;
    fade.tick(true, '/play/2');
    await Promise.resolve();
    audio.currentTime = 2;
    assert.equal(fade.take('/play/2'), audio);
    assert.equal(audio.currentTime, 2);
});

for (const event of ['pause', 'seeking', 'waiting', 'error']) {
    test(`${event} stops the overlap and restores the current track`, async () => {
        const { fade, audio, next } = fixture();
        await overlap(fade);
        audio.dispatchEvent(new Event(event));
        assert.equal(next.paused, true);
        assert.equal(next.currentTime, 0);
        assert.equal(fade.preview, null);
        assert.equal(fade.mainGain.gain.value, 1);
    });
}

test('natural end does not stop the already playing next track', async () => {
    const { fade, audio, next } = fixture();
    await overlap(fade);
    audio.ended = true;
    audio.dispatchEvent(new Event('pause'));
    assert.equal(next.paused, false);
    assert.equal(fade.take('/play/1'), next);
});

test('missing, unready, disabled and suspended playback keep the current track', async () => {
    for (const change of [f => { f.setDuration(0); }, f => { f.prepared = null; },
        f => { f.context.state = 'suspended'; }, f => { f.nextAudio.readyState = 2; }]) {
        const { fade, next } = fixture();
        change(fade);
        await overlap(fade);
        assert.equal(next.plays, 0);
        assert.ok(!fade.preview);
    }
});

test('queue replacement cancels an unresolved play without a stale fade', async () => {
    const { fade, next } = fixture();
    let resolve;
    next.play = () => new Promise(r => { resolve = r; });
    fade.tick(true, '/play/1');
    fade.prepare({ path: '/play/2' });
    resolve();
    await Promise.resolve();
    assert.equal(fade.preview, null);
    assert.equal(next.src, '/play/2');
    assert.equal(fade.mainGain.gain.ramps.length, 0);
});

test('volume and mute follow the active player before and after promotion', async () => {
    const { fade, audio, next } = fixture();
    await overlap(fade);
    audio.muted = true;
    audio.dispatchEvent(new Event('volumechange'));
    assert.equal(next.muted, true);
    assert.equal(next.volume, audio.volume);
    fade.take('/play/1');
    next.muted = false;
    next.volume = 0.2;
    next.dispatchEvent(new Event('volumechange'));
    assert.equal(audio.muted, false);
    assert.equal(audio.volume, 0.2);
});

test('autoplay rejection and a stalled next track restore ordinary playback', async () => {
    const { fade, next } = fixture();
    next.play = () => Promise.reject(new Error('NotAllowedError'));
    await overlap(fade);
    await Promise.resolve();
    assert.equal(fade.preview, null);
    assert.equal(fade.mainGain.gain.value, 1);
    next.play = Audio.prototype.play;
    await overlap(fade);
    next.dispatchEvent(new Event('waiting'));
    assert.equal(fade.take('/play/1'), null);
    assert.equal(fade.mainGain.gain.value, 1);
});

test('only events from the active element update the controller and advance the queue', () => {
    const { audio, next } = fixture();
    let advances = 0;
    const app = Object.assign(createPlayerController({ apiUrl: '' }), {
        lecteur: audio, playerState: {}, renderPlayerTransport() {}, updateMediaPlaybackState() {},
        advanceToNextSong() { advances++; }
    });
    app.bindAudioEvents(audio);
    app.bindAudioEvents(next);
    app.bindAudioEvents(next);
    next.dispatchEvent(new Event('ended'));
    next.dispatchEvent(new Event('loadstart'));
    assert.equal(advances, 0);
    assert.equal(app.playerState.loading, undefined);
    audio.dispatchEvent(new Event('ended'));
    assert.equal(advances, 1);
    app.lecteur = next;
    audio.dispatchEvent(new Event('ended'));
    assert.equal(advances, 1);
    next.dispatchEvent(new Event('ended'));
    assert.equal(advances, 2);
});

test('the existing duration setting controls the overlap boundary', async () => {
    for (const seconds of [1, 5, 10]) {
        const { fade, audio } = fixture();
        fade.setDuration(seconds);
        fade.prepare({ path: '/play/1' });
        audio.currentTime = 30 - seconds - 0.2;
        await overlap(fade);
        assert.equal(fade.preview, null);
        audio.currentTime = 30 - seconds + 0.1;
        await overlap(fade);
        assert.equal(fade.preview.started, true);
    }
});

test('the controller adopts the streaming player without calling load or play again', async () => {
    const { fade, audio, next } = fixture();
    await overlap(fade);
    next.currentTime = 2;
    const loads = next.loads;
    let snapshots = 0;
    const app = Object.assign(createPlayerController({ apiUrl: '' }), {
        lecteur: audio, specialPlayer: audio, crossfade: fade, playerState: {},
        updateMediaPlaybackState() {}, markRecentBackgroundAutoStart() {},
        syncStateFromAudio() { assert.equal(this.lecteur.currentTime, 2); snapshots++; }
    });
    assert.equal(await app.loadAndPlayMainSource('/play/1', { crossfadeHandoff: true }), true);
    assert.equal(app.lecteur, next);
    assert.equal(app.specialPlayer, next);
    assert.equal(next.loads, loads);
    assert.equal(next.plays, 1);
    assert.equal(snapshots, 1);
});

test('a short next track or an unexpected next-track end cannot silence the current one', async () => {
    const { fade, next } = fixture();
    next.duration = 1;
    await overlap(fade);
    assert.equal(next.plays, 0);
    next.duration = 30;
    await overlap(fade);
    next.dispatchEvent(new Event('ended'));
    assert.equal(fade.preview, null);
    assert.equal(fade.mainGain.gain.value, 1);
});
