import test from 'node:test';
import assert from 'node:assert/strict';
import { createPlayerController } from '../src/player-controller.js';

function harness(fetchImpl = async () => ({ ok: true, status: 204 })) {
    const storage = new Map();
    globalThis.window = { localStorage: {
        getItem: key => storage.get(key) ?? null,
        setItem: (key, value) => storage.set(key, value),
        removeItem: key => storage.delete(key)
    } };
    const listeners = new Map();
    const audio = { currentTime: 42.5, duration: 180, paused: false, ended: false,
        currentSrc: 'https://player.test/play/0', src: 'https://player.test/play/0', readyState: 1,
        addEventListener: (name, callback) => listeners.set(name, callback) };
    const requests = [];
    const state = { currentId: 0, current: { type: 'local', url: 'synthetic.mp3' }, queue: [{ id: 1 }] };
    const app = Object.assign(createPlayerController({ apiUrl: 'https://player.test', fetchImpl }), {
        currentUser: { id: 'alice', role: 'user' }, authEnabled: true,
        currentId: 0, lecteur: audio, playerState: { currentTrack: state.current },
        activeAudioPlayer: () => audio,
        apiFetch: async (path, method, body) => {
            requests.push({ path, method, body });
            return path === '/account_playback/restore' ? '' : state;
        },
        waitForTrackReady: async () => '/play/0',
        updatePlaybackUi: value => { app.restoredState = value; },
        setRepeatMode: value => { app.repeatTrack = value; },
        setMainAudioSource: path => { audio.src = `https://player.test${path}`; },
        syncStateFromAudio: () => {}, prefetchUpcomingTrack: () => {},
        playAudioWithDiagnostics: async () => { app.playCalls = (app.playCalls || 0) + 1; return true; }
    });
    const close = () => { app.savePlaybackPosition(true); audio.currentSrc = ''; audio.currentTime = 0; };
    return { app, audio, storage, requests, state, listeners, close };
}

test('reopening restores the position, repeat and queue without consuming next', async () => {
    const h = harness();
    h.app.repeatTrack = true;
    h.close();
    await h.app.restorePlaybackPosition();
    assert.equal(h.audio.currentTime, 42.5);
    assert.equal(h.app.playCalls, 1);
    assert.equal(h.app.repeatTrack, true);
    assert.equal(h.app.restoredState, h.state);
    assert.deepEqual(h.requests.map(r => r.path), ['/account_playback/restore', '/playback_state', '/resume_playback']);
});

test('a paused track stays paused and delayed metadata restores the seek', async () => {
    const h = harness();
    h.audio.paused = true;
    h.close();
    h.audio.readyState = 0;
    await h.app.restorePlaybackPosition();
    assert.equal(h.app.playCalls, undefined);
    assert.equal(h.audio.currentTime, 0);
    h.audio.currentSrc = h.audio.src;
    h.app.savePlaybackPosition(true);
    assert.equal(JSON.parse(h.storage.get('playbackResume:alice')).position, 42.5);
    h.listeners.get('loadedmetadata')();
    assert.equal(h.audio.currentTime, 42.5);
});

test('restored track is visible while its audio loads, without selecting next or previous', async () => {
    const h = harness();
    h.close();
    let ready;
    h.app.waitForTrackReady = () => new Promise(resolve => { ready = resolve; });
    const pending = h.app.restorePlaybackPosition();
    while (!ready) await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.app.restoredState, h.state);
    assert.equal(h.app.playerState.currentTime, 42.5);
    assert.equal(h.app.playerState.loading, true);
    assert.equal(h.app.playCalls, undefined);
    ready('/play/0');
    await pending;
    assert.equal(h.audio.currentTime, 42.5);
    assert.equal(h.app.playCalls, 1);
    assert.equal(h.requests.some(r => /next_song|previous_song/.test(r.path)), false);
});

test('an unavailable restored track stays visible and leaves loading state', async () => {
    const h = harness();
    h.close();
    h.app.waitForTrackReady = async () => null;
    await h.app.restorePlaybackPosition();
    assert.equal(h.app.restoredState, h.state);
    assert.equal(h.app.playerState.loading, false);
    assert.equal(h.app.playCalls, undefined);
});

test('switching to a private stream cancels a pending restore and saves the new track', async () => {
    const writes = [];
    const h = harness(async (_url, options) => {
        writes.push(JSON.parse(options.body));
        return { ok: true, status: 204 };
    });
    h.close();
    let ready;
    h.app.waitForTrackReady = () => new Promise(resolve => { ready = resolve; });
    const restoring = h.app.restorePlaybackPosition();
    while (!ready) await new Promise(resolve => setImmediate(resolve));
    Object.assign(h.app, {
        specialPlayer: h.audio, clearMainAudio: () => {},
        logNextDiagnostic: () => {}, diagnosticInstanceId: () => 'synthetic', requestWakeLock: () => {}
    });
    await h.app.startSpecialPlayback({ stream_id: 'synthetic', audio_url: '/audio/synthetic', queue: [] });
    h.app.currentId = 1;
    h.app.playerState.currentTrack = { type: 'local', url: 'second.mp3' };
    h.audio.currentSrc = h.audio.src;
    h.audio.currentTime = 7;
    await h.app.savePlaybackPosition(true);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].trackKey, 'local:second.mp3');
    ready('/play/0');
    await restoring;
    assert.equal(h.audio.src, 'https://player.test/audio/synthetic');
});

test('switching to a private stream releases an unfinished restored seek', async () => {
    const h = harness();
    h.app.pendingPlaybackSeek = true;
    Object.assign(h.app, {
        specialPlayer: h.audio, clearMainAudio: () => {},
        logNextDiagnostic: () => {}, diagnosticInstanceId: () => 'synthetic', requestWakeLock: () => {}
    });
    await h.app.startSpecialPlayback({ stream_id: 'synthetic', audio_url: '/audio/synthetic', queue: [] });
    assert.equal(h.app.pendingPlaybackSeek, false);
});

test('autoplay refusal leaves the saved seek ready for a user gesture', async () => {
    const h = harness();
    h.close();
    h.app.playAudioWithDiagnostics = async () => false;
    await h.app.restorePlaybackPosition();
    assert.equal(h.audio.currentTime, 42.5);
    assert.equal(h.app.restoringPlayback, false);
});

test('positions never restore for another user, an admin or a changed track', async () => {
    for (const change of [
        h => { h.app.currentUser.id = 'bob'; },
        h => { h.app.currentUser.role = 'admin'; },
        h => { h.state.current = { type: 'local', url: 'different.mp3' }; },
        h => { h.state.currentId = 1; }
    ]) {
        const h = harness(); h.close(); change(h);
        await h.app.restorePlaybackPosition();
        assert.equal(h.app.restoredState, undefined);
        assert.equal(h.requests.some(r => r.path === '/resume_playback'), false);
    }
});

test('logout cancels a pending restore and removes the saved position', async () => {
    const h = harness(); h.close();
    let resolve;
    h.app.apiFetch = () => new Promise(done => { resolve = done; });
    const pending = h.app.restorePlaybackPosition();
    h.app.clearPlaybackPosition();
    h.app.currentUser = null;
    resolve(h.state);
    await pending;
    assert.equal(h.app.restoredState, undefined);
    assert.equal(h.storage.has('playbackResume:alice'), false);
});

test('unavailable or corrupt local storage does not break playback', async () => {
    const h = harness();
    h.storage.set('playbackResume:alice', '{broken');
    await h.app.restorePlaybackPosition();
    window.localStorage.setItem = () => { throw new Error('unavailable'); };
    assert.doesNotThrow(() => h.app.savePlaybackPosition(true));
});

test('a new device restores the account checkpoint without any local storage', async () => {
    const h = harness();
    h.audio.currentSrc = '';
    h.app.apiFetch = async path => {
        assert.equal(path, '/account_playback/restore');
        return { ...h.state, resume: { position: 73.25, playing: false, repeat: true } };
    };
    await h.app.restorePlaybackPosition();
    assert.equal(h.audio.currentTime, 73.25);
    assert.equal(h.app.playCalls, undefined);
    assert.equal(h.app.repeatTrack, true);
    assert.equal(h.app.accountPlaybackReady, true);
    assert.equal(h.storage.size, 0);
});

test('slow account writes are serialized and keep the latest seek', async () => {
    const writes = [];
    let finishFirst;
    const h = harness(async (_url, options) => {
        writes.push(JSON.parse(options.body));
        if (writes.length === 1) await new Promise(resolve => { finishFirst = resolve; });
        return { ok: true, status: 204 };
    });
    h.app.accountPlaybackReady = true;
    const pending = h.app.savePlaybackPosition(true);
    h.audio.currentTime = 60;
    h.app.savePlaybackPosition(true);
    h.audio.currentTime = 80;
    h.app.savePlaybackPosition(true);
    assert.equal(writes.length, 1);
    finishFirst();
    await pending;
    assert.deepEqual(writes.map(write => write.position), [42.5, 80]);
});

test('a transfer pauses the old player and blocks further account checkpoints', async () => {
    let writes = 0;
    const h = harness(async () => {
        writes++;
        return { ok: false, status: 409, json: async () => ({ transferred: true }) };
    });
    h.app.accountPlaybackReady = true;
    h.app.pauseAudioWithDiagnostics = audio => { audio.paused = true; };
    h.app.showNotice = () => {};
    await h.app.savePlaybackPosition(true);
    assert.equal(h.audio.paused, true);
    assert.equal(h.app.accountPlaybackBlocked, true);
    await h.app.savePlaybackPosition(true);
    assert.equal(writes, 1);
});

test('a failed account restore cannot publish a stale local checkpoint', async () => {
    const h = harness(); h.close();
    h.app.apiFetch = async () => null;
    await h.app.restorePlaybackPosition();
    assert.equal(h.app.accountPlaybackReady, undefined);
    assert.equal(h.app.restoredState, undefined);
});
