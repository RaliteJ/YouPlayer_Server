const AUDIO_DIAGNOSTIC_EVENTS = [
    'loadstart',
    'loadedmetadata',
    'loadeddata',
    'canplay',
    'canplaythrough',
    'play',
    'playing',
    'pause',
    'waiting',
    'stalled',
    'suspend',
    'emptied',
    'ended',
    'error',
    'abort'
];

export const audioDiagnostics = {
    diagnosticTimestamp() {
        return new Date().toISOString();
    },

    diagnosticInstanceId(audio) {
        if (!audio) return null;
        if (!audio.__youPlayerDiagnosticInstanceId) {
            Object.defineProperty(audio, '__youPlayerDiagnosticInstanceId', {
                configurable: false,
                enumerable: false,
                writable: false,
                value: globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)
            });
        }
        return audio.__youPlayerDiagnosticInstanceId;
    },

    audioDiagnosticSnapshot(audio, extra = {}) {
        return {
            timestamp: this.diagnosticTimestamp(),
            visibilityState: document.visibilityState,
            hidden: document.hidden,
            playerInstanceId: this.diagnosticInstanceId(audio),
            elementId: audio?.id || null,
            src: audio?.currentSrc || audio?.src || '',
            currentTime: audio?.currentTime ?? null,
            duration: audio?.duration ?? null,
            paused: audio?.paused ?? null,
            ended: audio?.ended ?? null,
            readyState: audio?.readyState ?? null,
            networkState: audio?.networkState ?? null,
            mediaError: audio?.error ? {
                code: audio.error.code,
                message: audio.error.message || ''
            } : null,
            currentTrackId: this.currentId,
            ...extra
        };
    },

    recordAudioDiagnostic(channel, event, payload) {
        if (!this.audioBackgroundDebug) return;
        const entry = { channel, event, ...payload };
        this.audioDiagnosticEntries.push(entry);
        if (this.audioDiagnosticEntries.length > 2000) {
            this.audioDiagnosticEntries.splice(0, this.audioDiagnosticEntries.length - 2000);
        }
        window.__YOUPLAYER_AUDIO_DIAGNOSTICS__ = this.audioDiagnosticEntries;
    },

    logAudioEvent(eventName, audio, extra = {}) {
        if (!this.audioBackgroundDebug) return;
        const payload = {
            event: eventName,
            ...this.audioDiagnosticSnapshot(audio, extra)
        };
        this.recordAudioDiagnostic('[AUDIO_DIAG]', eventName, payload);
        console.log('[AUDIO_DIAG]', payload);
    },

    logNextDiagnostic(eventName, extra = {}, error = false) {
        if (!this.audioBackgroundDebug) return;
        const logger = error ? console.error : console.log;
        const payload = {
            timestamp: this.diagnosticTimestamp(),
            hidden: document.hidden,
            visibilityState: document.visibilityState,
            currentTrackId: this.currentId,
            nextTrackId: this.nextTrackPrefetch?.trackId
                ?? this.playerState.nextTrack?.__sessionIndex
                ?? null,
            activePlayerInstanceId: this.diagnosticInstanceId(this.activeAudioPlayer()),
            ...extra
        };
        this.recordAudioDiagnostic('[NEXT_DIAG]', eventName, payload);
        logger(`[NEXT_DIAG] ${eventName}`, payload);
    },

    logPageDiagnostic(eventName, event = null) {
        if (!this.audioBackgroundDebug) return;
        const audio = this.activeAudioPlayer();
        const payload = {
            event: eventName,
            timestamp: this.diagnosticTimestamp(),
            hidden: document.hidden,
            visibilityState: document.visibilityState,
            persisted: typeof event?.persisted === 'boolean' ? event.persisted : null,
            audioPaused: audio?.paused ?? null,
            audioEnded: audio?.ended ?? null,
            audioCurrentTime: audio?.currentTime ?? null,
            playerInstanceId: this.diagnosticInstanceId(audio)
        };
        this.recordAudioDiagnostic('[PAGE_DIAG]', eventName, payload);
        console.log('[PAGE_DIAG]', payload);
    },

    pauseAudioWithDiagnostics(audio, trigger, extra = {}) {
        if (!audio) return;
        this.crossfade?.cancel();
        const payload = {
            timestamp: this.diagnosticTimestamp(),
            trigger,
            playerInstanceId: this.diagnosticInstanceId(audio),
            src: audio.currentSrc || audio.src || '',
            currentTime: audio.currentTime,
            hidden: document.hidden,
            ...extra
        };
        this.lastPauseRequest = {
            requestedAt: Date.now(),
            trigger,
            playerInstanceId: payload.playerInstanceId,
            src: payload.src
        };
        this.logNextDiagnostic('CALL_PAUSE', payload);
        audio.pause();
    },

    logObservedPause(audio, role) {
        if (!audio) return null;
        const now = Date.now();
        const playerInstanceId = this.diagnosticInstanceId(audio);
        const request = this.lastPauseRequest;
        const requestAgeMs = request ? now - request.requestedAt : null;
        const initiatedByApp = Boolean(
            request
            && request.playerInstanceId === playerInstanceId
            && request.src === (audio.currentSrc || audio.src || '')
            && requestAgeMs >= 0
            && requestAgeMs < 2000
        );
        const payload = {
            event: 'pause-origin',
            timestamp: new Date(now).toISOString(),
            role,
            origin: initiatedByApp ? 'application' : 'browser-or-os',
            trigger: initiatedByApp ? request.trigger : null,
            requestAgeMs: initiatedByApp ? requestAgeMs : null,
            playerInstanceId,
            src: audio.currentSrc || audio.src || '',
            currentTime: audio.currentTime,
            duration: audio.duration,
            ended: audio.ended,
            hidden: document.hidden,
            visibilityState: document.visibilityState
        };
        if (initiatedByApp) this.lastPauseRequest = null;
        if (this.audioBackgroundDebug) {
            this.recordAudioDiagnostic('[PAUSE_DIAG]', 'pause-origin', payload);
            console.log('[PAUSE_DIAG]', payload);
        }
        return payload;
    },

    markRecentBackgroundAutoStart(audio, context = {}) {
        if (!document.hidden || !audio) {
            this.recentBackgroundAutoStart = null;
            return;
        }
        this.recentBackgroundAutoStart = {
            startedAt: Date.now(),
            playerInstanceId: this.diagnosticInstanceId(audio),
            src: audio.currentSrc || audio.src || '',
            trackId: context.nextTrackId ?? this.currentId,
            pauseObserved: false
        };
    },

    isUnexpectedBackgroundPause(audio, pauseDiagnostic) {
        const recentStart = this.recentBackgroundAutoStart;
        if (!audio || !pauseDiagnostic || !recentStart) return false;
        const ageMs = Date.now() - recentStart.startedAt;
        return pauseDiagnostic.origin === 'browser-or-os'
            && document.hidden
            && !audio.ended
            && audio.currentTime >= 0
            && audio.currentTime < 0.5
            && ageMs >= 0
            && ageMs < 2000
            && recentStart.playerInstanceId === this.diagnosticInstanceId(audio)
            && recentStart.src === (audio.currentSrc || audio.src || '')
            && recentStart.pauseObserved === false;
    },

    logUnexpectedBackgroundPause(audio) {
        const recentStart = this.recentBackgroundAutoStart;
        if (!recentStart || recentStart.pauseObserved) return;
        recentStart.pauseObserved = true;
        this.logNextDiagnostic('UNEXPECTED_BACKGROUND_PAUSE_CONFIRMED', {
            trackId: recentStart.trackId,
            src: recentStart.src,
            currentTime: audio.currentTime,
            paused: audio.paused,
            startedAgoMs: Date.now() - recentStart.startedAt,
            origin: 'browser-or-os',
            recoveryAttempted: false
        }, true);
    },

    bindAudioDiagnosticElement(audio, role) {
        if (!this.audioBackgroundDebug || !audio) return;
        const playerInstanceId = this.diagnosticInstanceId(audio);
        const payload = {
            event: 'bound',
            timestamp: this.diagnosticTimestamp(),
            role,
            playerInstanceId,
            elementId: audio.id || null,
            connected: audio.isConnected
        };
        this.recordAudioDiagnostic('[PLAYER_INSTANCE]', 'bound', payload);
        console.log('[PLAYER_INSTANCE]', payload);
        for (const eventName of AUDIO_DIAGNOSTIC_EVENTS) {
            audio.addEventListener(eventName, () => {
                const activeRole = audio === this.lecteur && this.currentSpecialStream
                    ? 'special-stream-player'
                    : role;
                this.logAudioEvent(eventName, audio, { role: activeRole, playerInstanceId });
            });
        }
    },

    initAudioDiagnostics() {
        if (!this.audioBackgroundDebug || this.audioDiagnosticsBound) return;
        this.audioDiagnosticsBound = true;
        this.bindAudioDiagnosticElement(this.lecteur, 'main-player');
        const activePlayerPayload = {
            event: 'active',
            timestamp: this.diagnosticTimestamp(),
            role: 'main-player',
            playerInstanceId: this.diagnosticInstanceId(this.lecteur),
            elementId: this.lecteur?.id || null
        };
        this.recordAudioDiagnostic('[PLAYER_INSTANCE]', 'active', activePlayerPayload);
        console.log('[PLAYER_INSTANCE]', activePlayerPayload);

        const enabledPayload = {
            event: 'diagnostics-enabled',
            timestamp: this.diagnosticTimestamp(),
            activation: 'Disable with ?audioDebug=0 or localStorage.removeItem("audioBackgroundDebug")'
        };
        this.recordAudioDiagnostic('[AUDIO_DIAG]', 'diagnostics-enabled', enabledPayload);
        console.log('[AUDIO_DIAG]', enabledPayload);

        let lastHeartbeat = Date.now();
        this.heartbeatTimer = window.setInterval(() => {
            const now = Date.now();
            const payload = {
                timestamp: new Date(now).toISOString(),
                drift: now - lastHeartbeat,
                hidden: document.hidden,
                visibilityState: document.visibilityState
            };
            this.recordAudioDiagnostic('[JS_HEARTBEAT]', 'heartbeat', payload);
            console.log('[JS_HEARTBEAT]', payload);
            lastHeartbeat = now;
        }, 5000);
    },

    bindPageDiagnostics() {
        if (this.pageDiagnosticsBound) return;
        this.pageDiagnosticsBound = true;
        window.addEventListener('pagehide', (event) => this.logPageDiagnostic('pagehide', event));
        window.addEventListener('pageshow', (event) => this.logPageDiagnostic('pageshow', event));
        document.addEventListener('freeze', (event) => this.logPageDiagnostic('freeze', event));
        document.addEventListener('resume', (event) => this.logPageDiagnostic('resume', event));
    },

    isPlaybackDiagnosticEndpoint(endpoint) {
        return /^\/(next_song|play_status\/|prefetched_next|playback_state)/.test(endpoint)
            || /^\/audio\/[^/]+\/stop$/.test(endpoint);
    },

};
