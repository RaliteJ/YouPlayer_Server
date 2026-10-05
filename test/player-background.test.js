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
