import { LIKED_PLAYLIST, trackLikeKey, formatTrackTitle as formatTrackTitleValue, getTrackArtwork as getTrackArtworkValue, playlistEntries as playlistEntriesValue } from '../src/client-utils.js';
import { bindQueueSwipe } from '../src/track-gestures.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { publicErrorMessage } from '../src/client-utils.js';

const source = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
const controllerSource = (await readFile(new URL('../src/player-controller.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export function', 'function');
const discoverySource = (await readFile(new URL('../src/discovery-view.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export function', 'function');
const playerViewSource = (await readFile(new URL('../src/player-view.js', import.meta.url), 'utf8')).replace('export const', 'const');
const accountSource = (await readFile(new URL('../src/account-view.js', import.meta.url), 'utf8')).replace(/^import .*;\n/m, '').replace('export function', 'function');
const diagnosticSource = (await readFile(new URL('../src/audio-diagnostics.js', import.meta.url), 'utf8')).replace('export const', 'const');
const playlistSource = (await readFile(new URL('../src/playlist-view.js', import.meta.url), 'utf8')).replace(/^import[\s\S]*?;\n/, '').replace('export const', 'const');
const librarySource = (await readFile(new URL('../src/library-view.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replace('export const', 'const');
function harness(fetch) {
    const notices = [];
    const context = vm.createContext({
        bindQueueSwipe, LIKED_PLAYLIST, trackLikeKey, formatTrackTitleValue, getTrackArtworkValue, playlistEntriesValue,
        publicErrorMessage, fetch, URLSearchParams,
        console: { error() {} },
        window: { location: { origin: 'https://player.test' } }
    });
    vm.runInContext(controllerSource + '\n' + discoverySource + '\n' + playerViewSource + '\n' + accountSource + '\n' + playlistSource + '\n' + librarySource + '\n' + diagnosticSource + '\n' + source.slice(source.indexOf('const API_URL'), source.indexOf('export { App }')) + '\nglobalThis.app = App;', context);
    const app = context.app;
    app.showNotice = message => notices.push(message);
    app.showAuth = message => notices.push(message);
    return { app, notices };
}

test('API failures never display JSON diagnostics or a proxy HTML page', async () => {
    for (const json of [true, false]) {
        const raw = '<html>Internal stack /private/example TOKEN_EXAMPLE</html>';
        const { app, notices } = harness(async () => ({
            status: 502, ok: false,
            headers: { get: () => json ? 'application/json' : 'text/html' },
            json: async () => ({ error: raw }), text: async () => raw
        }));
        assert.equal(await app.apiFetch('/example'), null);
        assert.equal(notices.length, 1);
        assert.equal(notices[0], publicErrorMessage(502));
        assert.doesNotMatch(app.apiErrorMessage('Réessaie.'), /TOKEN_EXAMPLE|private|html/);
        assert.equal(await app.responseErrorMessage({ status: 502 }, 'Envoi indisponible.'), 'Envoi indisponible.');
    }
});

test('network failures are handled and rate limits provide a retry instruction', async () => {
    const { app, notices } = harness(async () => { throw new Error('TECHNICAL_DETAIL'); });
    assert.equal(await app.apiFetch('/example'), null);
    assert.equal(notices[0], publicErrorMessage(0));
    assert.match(publicErrorMessage(429), /Patiente/);
});

test('HTTP errors retain their status even when their JSON body is broken', async () => {
    for (const status of [429, 503]) {
        const { app, notices } = harness(async () => ({
            status, ok: false,
            headers: { get: () => 'application/json' },
            json: async () => { throw new SyntaxError('PRIVATE_RESPONSE_FRAGMENT'); }
        }));
        assert.equal(await app.apiFetch('/example'), null);
        assert.equal(app.lastApiError.status, status);
        assert.deepEqual(notices, [publicErrorMessage(status)]);
    }
});

test('login handles network failures and distinguishes unavailable service from invalid credentials', async () => {
    for (const status of [0, 401, 503]) {
        const { app, notices } = harness(async () => {
            if (!status) throw new Error('TECHNICAL_DETAIL');
            return { status, ok: false };
        });
        app.loginPassword = { value: 'synthetic' };
        await app.handleLogin({ preventDefault() {} });
        assert.equal(notices.length, 1);
        assert.doesNotMatch(notices[0], /TECHNICAL_DETAIL/);
        assert.equal(notices[0].includes('Identifiants invalides'), status === 401);
    }
});

test('authentication expiry still opens login and successful API data is preserved', async () => {
    const { app, notices } = harness(async () => ({ status: 401 }));
    app.currentUser = { id: 'synthetic' };
    assert.equal(await app.apiFetch('/example'), null);
    assert.equal(app.currentUser, null);
    assert.equal(notices.length, 1);
    const success = harness(async () => ({
        status: 200, ok: true, headers: { get: () => 'application/json' },
        json: async () => ({ saved: true })
    }));
    assert.equal((await success.app.apiFetch('/example')).saved, true);
    assert.equal(success.notices.length, 0);
});

test('native player diagnostics never reach visible notices or API error messages', async () => {
    const nativeSource = await readFile(new URL('../src/android-player.js', import.meta.url), 'utf8');
    const notices = [];
    const listeners = {};
    const host = {
        setTimeout: () => 1, clearTimeout() {},
        addEventListener: (type, handler) => { listeners[type] = handler; },
        YouPlayerNative: {
            postMessage(raw) {
                const { id } = JSON.parse(raw);
                host.YouPlayerNative.onmessage({ data: JSON.stringify({
                    id, response: { status: 503, data: 'PRIVATE_NATIVE_DIAGNOSTIC' }
                }) });
            }
        }
    };
    host.top = host;
    const app = {
        playerState: {}, showNotice: message => notices.push(message),
        updatePlaybackUi() {}, updatePlayerProgress() {},
        apiFetch() {}, showAuth() {}, bindEvents() {}, loadView() {}
    };
    const context = vm.createContext({ publicErrorMessage, document: { getElementById: () => null } });
    vm.runInContext(nativeSource.replace(/^import .*;\n/m, '').replace('export function', 'function'), context);
    assert.equal(context.installAndroidPlayer(app, host), true);
    listeners['youplayer-native-state']({ detail: { native: true, error: 'PRIVATE_NATIVE_DIAGNOSTIC' } });
    assert.equal(await app.togglePlayback(), null);
    assert.equal(await app.apiFetch('/playlist'), null);
    assert.equal(app.lastApiError.status, 503);
    assert.equal(notices.length, 2);
    assert.doesNotMatch(notices.join(' ') + app.lastApiError.message, /PRIVATE_NATIVE_DIAGNOSTIC/);
});
