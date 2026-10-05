import { publicErrorMessage } from './client-utils.js';

// Native transport is installed before App.init; ordinary browsers keep their existing player.
export function installAndroidPlayer(app, host = window) {
    const bridge = host.YouPlayerNative;
    if (!bridge?.postMessage || host.top !== host) return false;
    let sequence = 0;
    let state = { token: '', playing: false, paused: true, currentId: null };
    let reportedError = '';
    const pending = new Map();
    const request = (payload) => new Promise((resolve, reject) => {
        const id = `web-${Date.now()}-${++sequence}`;
        const timeout = host.setTimeout(() => {
            pending.delete(id);
            reject(new Error('Le lecteur ne répond pas. Actualisez son état avant de réessayer.'));
        }, 95000);
        pending.set(id, { resolve, reject, timeout });
        bridge.postMessage(JSON.stringify({ id, payload }));
    });
    bridge.onmessage = event => {
        let envelope;
        try { envelope = JSON.parse(event.data); } catch { return; }
        const task = pending.get(envelope.id);
        if (!task) return;
        pending.delete(envelope.id); host.clearTimeout(task.timeout);
        task.resolve(envelope.response);
    };
    const apply = snapshot => {
        if (!snapshot?.native) return;
        state = snapshot;
        app.nextSongLoading = snapshot.loading === true;
        app.userPausedAudio = snapshot.paused === true;
        Object.assign(app.playerState, {
            currentTime: snapshot.currentTime || 0, duration: snapshot.duration || 0,
            playing: snapshot.playing === true, loading: snapshot.loading === true
        });
        app.updatePlaybackUi(snapshot);
        app.updatePlayerProgress();
        if (app.playerSeek) app.playerSeek.disabled = !snapshot.seekable;
        const next = document.getElementById('next');
        if (next) next.disabled = snapshot.nextEnabled === false;
        if (snapshot.currentId == null) app.playerBar?.classList.remove('visible');
        if (snapshot.error && snapshot.error !== reportedError) app.showNotice('Ce titre ne peut pas être lu pour le moment. Essaie un autre morceau.', true);
        reportedError = snapshot.error || '';
        if (snapshot.authenticationRequired) { app.currentUser = null; originalShowAuth('Session expirée. Reconnectez-vous.'); }
    };
    const command = async (name, args = {}) => {
        try {
            const response = await request({ command: name, ...args });
            if (response.status >= 400) throw new Error(typeof response.data === 'string' ? response.data : 'Commande refusée.');
            apply(response.data);
            return response.data;
        } catch (error) { app.showNotice('Le lecteur est momentanément indisponible. Réessaie dans un instant.', true); return null; }
    };
    host.addEventListener('youplayer-native-state', event => apply(event.detail));
    host.addEventListener('pagehide', () => {
        for (const task of pending.values()) { host.clearTimeout(task.timeout); task.resolve({ status: 409 }); }
        pending.clear();
    });
    // No HTML audio, JS chaining, screen wake lock or competing browser media session.
    for (const method of ['bindAudioEvents', 'initAudioDiagnostics', 'syncStateFromAudio',
        'prefetchUpcomingTrack', 'syncPrefetchedTransitions', 'recoverEndedPlayback',
        'initMediaSession', 'updateMediaMetadata', 'updateMediaPlaybackState', 'updateMediaPositionState',
        'requestWakeLock', 'clearMainAudio', 'startSpecialPlayback', 'loadAndPlayMainSource']) {
        app[method] = () => undefined;
    }
    app.activeAudioPlayer = () => null;
    app.renderPlayerTransport = () => {
        for (const button of [app.miniPlayPause, app.overlayPlayPause].filter(Boolean)) {
            button.setAttribute('aria-label', state.playing ? 'Pause' : 'Lecture');
            button.classList.toggle('is-playing', state.playing === true);
            button.classList.toggle('is-loading', state.loading === true);
            const icon = button.querySelector('[aria-hidden="true"]');
            if (icon) icon.textContent = state.playing ? '❚❚' : '▶';
        }
    };
    app.togglePlayback = () => command(state.paused === false ? 'pause' : 'play');
    app.restartCurrentTrack = () => command('restart');
    // The current native service owns transport but has no previous-track command.
    app.previousTrack = app.restartCurrentTrack;
    app.seekPlayer = position => command('seek', { position });
    app.add_song_playlist = index => command('select', { index: Number(index) });
    app.nextSong = app.advanceToNextSong = () => command('next', { token: state.token });
    app.stopSpecialPlayback = () => command('stop');
    app.reconcilePlaybackAfterWake = app.refreshPlaybackState = () => command('snapshot');
    // These endpoints share the service's serialized request queue.
    const routes = new Set(['/playlist', '/playback_state', '/playlist_used', '/random',
        '/delete_playlist', '/delete_from_playlist', '/add_song_ecoute']);
    const originalApi = app.apiFetch.bind(app);
    app.apiFetch = async (path, method = 'GET', body = null) => {
        if (!routes.has(path)) return originalApi(path, method, body);
        app.lastApiError = null;
        const response = await request({ command: 'api', path, method, body }).catch(() => ({ status: 503 }));
        if (response.status >= 400) {
            app.lastApiError = { status: response.status, message: publicErrorMessage(response.status) };
            if (response.status === 401) app.showAuth();
            return null;
        }
        return response.data;
    };
    const originalShowAuth = app.showAuth.bind(app);
    app.showAuth = (...args) => { void command('stop'); originalShowAuth(...args); };
    app.logout = async () => {
        await command('logout');
        app.currentUser = null; app.selectedPlaylists = [];
        app.renderUpcomingQueue([]); app.closeNowPlaying(); app.showAuth();
    };
    const originalBind = app.bindEvents.bind(app);
    app.bindEvents = () => {
        originalBind();
        const previous = document.getElementById('prev');
        previous?.setAttribute('aria-label', 'Revenir au début');
        previous?.setAttribute('title', 'Revenir au début (historique indisponible dans cette version Android)');
        const reload = document.getElementById('reloadBtn');
        if (reload) {
            // The native bridge currently exposes restart, but no repeat mode.
            reload.onclick = null;
            reload.disabled = true;
            reload.title = 'Répétition indisponible dans cette version du lecteur Android';
        }
        void command('snapshot');
    };
    const originalView = app.loadView.bind(app);
    app.loadView = async name => {
        const value = await originalView(name);
        if (name === 'add_spotify') app.showNotice('L’extension Spotify du navigateur ne fonctionne pas dans cette application. La recherche et les imports proposés par le serveur restent disponibles.');
        return value;
    };
    return true;
}
