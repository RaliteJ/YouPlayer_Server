import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appSource = (await readFile(new URL('../src/app.js', import.meta.url), 'utf8'))
	+ (await readFile(new URL('../src/audio-diagnostics.js', import.meta.url), 'utf8'))
	+ (await readFile(new URL('../src/library-view.js', import.meta.url), 'utf8'))
	+ (await readFile(new URL('../src/playlist-view.js', import.meta.url), 'utf8'))
	+ (await readFile(new URL('../src/account-view.js', import.meta.url), 'utf8'))
	+ (await readFile(new URL('../src/player-controller.js', import.meta.url), 'utf8'))
	+ (await readFile(new URL('../src/player-view.js', import.meta.url), 'utf8'))
	+ (await readFile(new URL('../src/discovery-view.js', import.meta.url), 'utf8'));
const indexSource = await readFile(new URL('../src/index.html', import.meta.url), 'utf8');
const nginxSource = await readFile(new URL('../nginx.conf', import.meta.url), 'utf8');

test('Nginx forwards account checkpoint and resume requests to the authenticated backend', () => {
	const expression = nginxSource.match(/location ~ (\^\/\(auth\|[^\s]+) \{/)[1];
	const apiRoutes = new RegExp(expression);
	for (const route of ['/account_playback', '/account_playback/restore', '/resume_playback', '/sponsorblock']) {
		assert.equal(apiRoutes.test(route), true, route);
	}
	for (const route of ['/server/server.js', '/playlists/private.json', '/account_playback_other']) {
		assert.equal(apiRoutes.test(route), false, route);
	}
});

test('background advancement uses one native ended listener and no duration fallback timer', () => {
	assert.equal((appSource.match(/this\.lecteur\.addEventListener\('ended'/g) || []).length, 1);
	assert.match(appSource, /addEventListener\('ended',[\s\S]*advanceToNextSong\('ended'\)/);
	assert.doesNotMatch(appSource, /scheduleNextFallback|nextFallbackTimer/);
});

test('the persistent player preflights readiness without a detached audio preloader', () => {
	assert.match(indexSource, /<audio id="lecteur" class="audio-engine" preload="auto">/);
	assert.equal((indexSource.match(/<audio\b/g) || []).length, 1);
	assert.doesNotMatch(indexSource, /id="special-player"/);
	assert.match(appSource, /this\.specialPlayer = this\.lecteur/);
	assert.doesNotMatch(indexSource, /<audio id="lecteur"[^>]*controls/);
	assert.match(indexSource, /id="miniPlayPause"[\s\S]*id="now-playing-overlay"[\s\S]*id="playerSeek"/);
	assert.doesNotMatch(appSource, /new Audio\(\)/);
	assert.match(appSource, /strategy: 'readiness-only'/);
	assert.match(appSource, /loadAndPlayMainSource/);
	assert.match(appSource, /'SOURCE_RETRY'/);
	assert.match(appSource, /audio_debug=1/);
	assert.match(appSource, /'AUDIO_ERROR_DEFERRED_TO_TRANSITION'/);
	assert.match(appSource, /\[PAUSE_DIAG\]/);
	assert.match(appSource, /'UNEXPECTED_BACKGROUND_PAUSE_CONFIRMED'/);
	assert.doesNotMatch(appSource, /'RECOVER_UNEXPECTED_BACKGROUND_PAUSE'/);
	assert.doesNotMatch(appSource, /'BACKGROUND_PAUSE_RECOVERY_RESULT'/);
	assert.match(appSource, /audio\.currentTime < 0\.5/);
	assert.match(appSource, /ageMs < 2000/);
	assert.equal((appSource.match(/\.pause\(\)/g) || []).length, 1);
	assert.match(appSource, /mediaSession\.setPositionState/);
	assert.match(appSource, /previoustrack:[\s\S]*nexttrack:[\s\S]*pause:[\s\S]*play:/);
	assert.match(nginxSource, /location \^~ \/play\/ \{[\s\S]*proxy_read_timeout 2h;/);
});

test('background audio diagnostics are opt-in and cover the transition chain', () => {
	const diagnosticEvents = appSource.match(/const AUDIO_DIAGNOSTIC_EVENTS = \[([\s\S]*?)\];/)?.[1] || '';
	for (const eventName of [
		'loadstart', 'loadedmetadata', 'loadeddata', 'canplay', 'canplaythrough',
		'play', 'playing', 'pause', 'waiting', 'stalled', 'suspend', 'emptied',
		'ended', 'error', 'abort'
	]) {
		assert.match(diagnosticEvents, new RegExp(`['"]${eventName}['"]`));
	}
	assert.doesNotMatch(diagnosticEvents, /timeupdate/);
	assert.match(appSource, /get\('audioDebug'\)/);
	assert.match(appSource, /\[AUDIO_DIAG\]/);
	assert.match(appSource, /\[NEXT_DIAG\] \$\{eventName\}/);
	assert.match(appSource, /\[PAGE_DIAG\]/);
	assert.match(appSource, /\[JS_HEARTBEAT\]/);
	assert.match(appSource, /\[PLAYER_INSTANCE\]/);
	assert.match(appSource, /\[MEDIA_SESSION\] \$\{action\}/);
	assert.match(appSource, /'REQUEST_START'/);
	assert.match(appSource, /'REQUEST_SUCCESS'/);
	assert.match(appSource, /'REQUEST_ERROR'/);
	assert.match(appSource, /'SET_SRC'/);
	assert.match(appSource, /'CALL_LOAD'/);
	assert.match(appSource, /'CALL_PLAY'/);
	assert.match(appSource, /'PLAY_RESOLVED'/);
	assert.match(appSource, /'PLAY_REJECTED'/);
});

const { sponsorBlockView } = await import('../src/sponsorblock.js');
function sponsorFixture() {
    const audio = { currentTime: 2, duration: 10, currentSrc: 'http://test/play/0', src: 'http://test/play/0',
        seekable: { length: 1, start: () => 0, end: () => 10 }, paused: false, ended: false, seeking: false };
    return { ...sponsorBlockView, currentId: 0, sponsorBlockEnabled: true,
        sponsorBlockSegments: [{ start: 1, end: 4, duration: 10 }, { start: 3, end: 5, duration: 10 }],
        activeAudioPlayer: () => audio, seekPlayer(target) { audio.currentTime = target; },
        savePlaybackPosition() { this.saved = audio.currentTime; }, audio };
}

test('non-music skipping merges overlaps, saves original timestamps and leaves ending to the audio element', () => {
    const app = sponsorFixture();
    assert.equal(app.skipNonMusic(), true);
    assert.equal(app.audio.currentTime, 5);
    assert.equal(app.saved, 5);
    assert.equal(app.skipNonMusic(), false);
    app.sponsorBlockSegments = [{ start: 5, end: 10, duration: 10 }];
    assert.equal(app.skipNonMusic(), true);
    assert.equal(app.audio.currentTime, 10);
});

test('non-music skipping leaves paused, disabled, transitioning, mismatched and non-seekable audio untouched', () => {
    for (const change of [
        app => { app.sponsorBlockEnabled = false; }, app => { app.sponsorBlockTrackDisabled = true; },
        app => { app.audio.paused = true; }, app => { app.audio.seeking = true; },
        app => { app.nextSongLoading = true; }, app => { app.restoringPlayback = true; },
        app => { app.queueEditPromise = Promise.resolve(); }, app => { app.currentId = 1; },
        app => { app.audio.src = 'http://test/play/1'; }, app => { app.audio.duration = 20; },
        app => { app.audio.duration = Infinity; }, app => { app.audio.seekable.length = 0; },
        app => { app.audio.seekable.end = () => 3; }
    ]) {
        const app = sponsorFixture(); change(app);
        assert.equal(app.skipNonMusic(), false);
        assert.equal(app.audio.currentTime, 2);
        assert.equal(app.saved, undefined);
    }
});

test('non-music skipping accounts for a resumed stream offset', () => {
    const app = sponsorFixture();
    app.currentSpecialStream = { startPosition: 2, audioUrl: '/audio/stream' };
    app.audio.src = app.audio.currentSrc = 'http://test/audio/stream';
    app.audio.currentTime = 0;
    app.audio.duration = 8;
    app.seekPlayer = target => { app.audio.currentTime = target - 2; };
    assert.equal(app.skipNonMusic(), true);
    assert.equal(app.audio.currentTime, 3);
});

test('SponsorBlock makes no requests when disabled and ignores a response after the track changes', async () => {
    let resolve, calls = 0;
    const app = { ...sponsorBlockView, sponsorBlockUser: 'user1', currentId: 0,
        playerState: { currentTrack: { id: 'abcdefghijk', type: 'youtube' } },
        apiFetch: () => { calls++; return new Promise(done => { resolve = done; }); } };
    await app.refreshSponsorBlock();
    assert.equal(calls, 0);
    app.sponsorBlockEnabled = true;
    const pending = app.refreshSponsorBlock();
    assert.equal(calls, 1);
    app.currentId = 1;
    app.playerState.currentTrack = { type: 'local', url: 'test.mp3' };
    await app.refreshSponsorBlock();
    resolve({ available: true, key: 'youtube:abcdefghijk', segments: [{ start: 0, end: 5, duration: 10 }] });
    await pending;
    assert.deepEqual(app.sponsorBlockSegments, []);
});

test('SponsorBlock accepts numeric and DOM string track IDs and rejects missing or invalid IDs', async () => {
    for (const currentId of [0, '0', 42, '42', null, undefined, '', -1, 'invalid', 1.5]) {
        const requests = [];
        const app = { ...sponsorBlockView, sponsorBlockUser: 'user1', sponsorBlockEnabled: true, currentId,
            playerState: { currentTrack: { id: 'abcdefghijk', type: 'youtube' } },
            apiFetch: async endpoint => { requests.push(endpoint); return { available: true, key: 'youtube:abcdefghijk', segments: [] }; } };
        await app.refreshSponsorBlock();
        const eligible = [0, '0', 42, '42'].includes(currentId);
        assert.equal(requests.length, eligible ? 1 : 0, `track ID ${String(currentId)}`);
        if (eligible) assert.equal(requests[0], `/sponsorblock?trackId=${currentId}&key=youtube%3Aabcdefghijk`);
    }
});
