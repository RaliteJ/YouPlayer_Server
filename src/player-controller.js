export function createPlayerController({ apiUrl: API_URL, fetchImpl = (...args) => fetch(...args) }) {
    return {
    bindAudioEvents() {
        if (!this.lecteur || this.audioEventsBound) return;
        this.audioEventsBound = true;

        const eventsSuppressed = () => this.suppressMainPlayerEvents || this.suppressSpecialPlayerEvents;
        const playerRole = () => this.currentSpecialStream ? 'special-stream-player' : 'main-player';

        this.lecteur.addEventListener('loadstart', () => {
            if (eventsSuppressed()) return;
            this.playerState.loading = true;
            this.renderPlayerTransport();
            console.debug('[Player] loading', this.currentId);
        });
        this.lecteur.addEventListener('loadedmetadata', () => this.syncStateFromAudio(true));
        this.lecteur.addEventListener('canplay', () => {
            this.playerState.loading = false;
            this.syncStateFromAudio(true);
        });
        this.lecteur.addEventListener('playing', () => {
            if (eventsSuppressed()) return;
            if (this.sleepTimer?.check()) {
                this.crossfade?.cancel();
                this.pauseAudioWithDiagnostics(this.lecteur, 'sleep-timer');
                this.userPausedAudio = true;
                return;
            }
            this.userPausedAudio = false;
            this.consecutivePlaybackErrors = 0;
            this.handledPlaybackErrorKey = null;
            this.playerState.playing = true;
            this.playerState.loading = false;
            this.updateMediaPlaybackState('playing');
            this.syncStateFromAudio(true);
            console.debug('[Player] playing', this.currentId);
        });
        this.lecteur.addEventListener('pause', () => {
            const pauseDiagnostic = this.logObservedPause(this.lecteur, playerRole());
            if (eventsSuppressed()) return;
            this.playerState.playing = false;
            this.updateMediaPlaybackState(this.lecteur.ended ? 'none' : 'paused');
            if (!this.currentSpecialStream && this.isUnexpectedBackgroundPause(this.lecteur, pauseDiagnostic)) {
                this.logUnexpectedBackgroundPause(this.lecteur);
            }
            if (!this.lecteur.ended && !this.nextSongLoading) {
                this.userPausedAudio = true;
            }
            this.renderPlayerTransport();
        });
        this.lecteur.addEventListener('ended', () => {
            if (eventsSuppressed()) return;
            this.playerState.playing = false;
            this.updateMediaPlaybackState('none');
            this.renderPlayerTransport();
            console.debug('[Player] ended', this.currentId);
            if (this.currentSpecialStream) {
                void this.handleSpecialStreamEnded();
            } else {
                void this.advanceToNextSong('ended');
            }
        });
        this.lecteur.addEventListener('error', () => {
            if (eventsSuppressed()) return;
            if (this.currentSpecialStream) {
                void this.handleSpecialStreamError();
            } else {
                void this.handleMainAudioError();
            }
        });
        this.lecteur.addEventListener('timeupdate', () => {
            this.sleepTimer?.check();
            this.syncStateFromAudio();
            this.crossfade?.tick(!this.repeatTrack && !this.currentSpecialStream
                && !this.nextSongLoading && !this.queueEditPromise, this.nextTrackPrefetch?.path);
        });
        this.lecteur.addEventListener('waiting', () => {
            if (!eventsSuppressed()) {
                this.playerState.loading = true;
                this.renderPlayerTransport();
            }
        });
        this.lecteur.addEventListener('seeked', () => this.syncStateFromAudio(true));
    },

    syncStateFromAudio(forcePositionUpdate = false) {
        const player = this.activeAudioPlayer();
        if (!player) return;
        this.playerState.currentTime = Number.isFinite(player.currentTime) ? player.currentTime : 0;
        this.playerState.duration = Number.isFinite(player.duration) ? player.duration : 0;
        this.playerState.playing = !player.paused && !player.ended;
        this.updatePlayerProgress();
        this.renderPlayerTransport();
        this.updateMediaPositionState(player, forcePositionUpdate);
    },

    async handleMainAudioError() {
        if (!this.lecteur?.currentSrc || this.currentId == null) return;
        if (this.nextSongLoading) {
            this.logNextDiagnostic('AUDIO_ERROR_DEFERRED_TO_TRANSITION', {
                trackId: this.currentId,
                code: this.lecteur.error?.code || null,
                src: this.lecteur.currentSrc
            }, true);
            return;
        }
        const errorKey = `${this.currentId}:${this.lecteur.currentSrc}`;
        if (this.handledPlaybackErrorKey === errorKey) return;
        this.handledPlaybackErrorKey = errorKey;
        this.consecutivePlaybackErrors += 1;
        console.error('[Player] media error', {
            trackId: this.currentId,
            code: this.lecteur.error?.code || null
        });

        if (this.consecutivePlaybackErrors >= 3) {
            this.showNotice('Plusieurs musiques sont indisponibles. Lecture arrêtée.', true);
            return;
        }
        this.showNotice('Musique indisponible. Passage à la suivante.', true);
        await this.advanceToNextSong('error');
    },

    setRepeatMode(enabled) {
        this.crossfade?.cancel();
        this.repeatTrack = enabled;
        // Private live streams must switch to the downloaded file at their end.
        if (this.lecteur) this.lecteur.loop = enabled && !this.currentSpecialStream;
        const button = document.getElementById('reloadBtn');
        button?.setAttribute('aria-pressed', String(enabled));
        button?.setAttribute('title', enabled ? 'Désactiver la répétition du morceau' : 'Activer la répétition du morceau');
    },

    async repeatCurrentTrack() {
        if (!this.currentSpecialStream) {
            this.restartCurrentTrack();
            return;
        }
        const trackId = this.currentId;
        this.nextSongLoading = true;
        try {
            await this.stopSpecialPlayback('finished', { preserveAudio: true });
            const path = await this.waitForTrackReady(trackId);
            if (!path || this.currentId !== trackId) return;
            await this.loadAndPlayMainSource(path, { trigger: 'repeat-current-track', nextTrackId: trackId });
        } finally {
            this.nextSongLoading = false;
        }
    },

    async previousTrack() {
        if (this.nextSongLoading || this.previousSongLoading) return;
        const time = this.activeAudioPlayer()?.currentTime ?? this.playerState.currentTime;
        if (time >= 4) return this.restartCurrentTrack();
        this.previousSongLoading = true;
        try {
            await this.queueEditPromise;
            await this.syncPrefetchedTransitions();
            if (this.pendingPrefetchedTransitions.length > 0) return;
            const state = await this.apiFetch('/playback_state');
            if (!state) return;
            if (state.previousId == null) return this.restartCurrentTrack();
            await this.nextSong('previous');
        } finally {
            this.previousSongLoading = false;
        }
    },

    restartCurrentTrack() {
        this.crossfade?.cancel();
        const player = this.activeAudioPlayer();
        if (!player) return;
        player.currentTime = 0;
        void this.playAudioWithDiagnostics(player, { trigger: 'restart-current-track' });
    },

    async playAudioWithDiagnostics(audio, context = {}, { reportRejection = true } = {}) {
        if (!audio) return false;
        if (['play-pause-control', 'media-session-play', 'restart-current-track'].includes(context.trigger)) this.sleepTimer?.resume();
        // A transition may resolve after the timer. Its source can be prepared,
        // but leave it paused without treating the user's pause as a play failure.
        if (this.sleepTimer?.check()) {
            this.crossfade?.cancel();
            this.pauseAudioWithDiagnostics(audio, 'sleep-timer');
            return true;
        }
        this.lastPlayRejection = null;
        this.logNextDiagnostic('BEFORE_PLAY', {
            ...this.audioDiagnosticSnapshot(audio),
            ...context
        });

        try {
            this.logNextDiagnostic('CALL_PLAY', {
                playerInstanceId: this.diagnosticInstanceId(audio),
                src: audio.currentSrc || audio.src,
                paused: audio.paused,
                ...context
            });
            const result = audio.play();
            const returnedPromise = Boolean(result && typeof result.then === 'function');
            this.logNextDiagnostic('PLAY_RETURNED', {
                playerInstanceId: this.diagnosticInstanceId(audio),
                returnedPromise,
                ...context
            });
            if (returnedPromise) await result;
            this.logNextDiagnostic('PLAY_RESOLVED', {
                playerInstanceId: this.diagnosticInstanceId(audio),
                paused: audio.paused,
                ended: audio.ended,
                currentTime: audio.currentTime,
                readyState: audio.readyState,
                ...context
            });
            return true;
        } catch (error) {
            this.lastPlayRejection = error;
            this.logNextDiagnostic('PLAY_REJECTED', {
                playerInstanceId: this.diagnosticInstanceId(audio),
                name: error?.name || 'Error',
                message: error?.message || String(error),
                stack: error?.stack || '',
                ...context
            }, true);
            if (reportRejection) this.handlePlayRejection(error);
            return false;
        }
    },

    handlePlayRejection(err) {
        console.error('[Player] play rejected', err);
        const blocked = err?.name === 'NotAllowedError';
        this.showNotice(
            blocked
                ? 'Touchez Lecture pour autoriser le navigateur à démarrer le son.'
                : 'La lecture audio n’a pas pu démarrer.',
            true
        );
    },

    clearMainAudio() {
        this.crossfade?.clear();
        if (!this.lecteur) return;
        this.suppressMainPlayerEvents = true;
        try {
            this.pauseAudioWithDiagnostics(this.lecteur, 'clear-main-audio');
            this.logNextDiagnostic('REMOVE_SRC', {
                operation: 'clear-main-audio',
                playerInstanceId: this.diagnosticInstanceId(this.lecteur)
            });
            this.lecteur.removeAttribute('src');
            this.logNextDiagnostic('CALL_LOAD', {
                operation: 'clear-main-audio',
                playerInstanceId: this.diagnosticInstanceId(this.lecteur)
            });
            this.lecteur.load();
        } finally {
            this.suppressMainPlayerEvents = false;
        }
        this.playerState.playing = false;
        this.playerState.loading = false;
        this.playerState.currentTime = 0;
        this.playerState.duration = 0;
    },

    setMainAudioSource(path, context = {}) {
        if (context.crossfadeHandoff) this.crossfade?.beginHandoff(path);
        else this.crossfade?.cancel();
        this.handledPlaybackErrorKey = null;
        this.lastPositionStateSecond = -1;
        this.playerState.loading = true;
        const nextUrl = `${API_URL}${path}`;
        if (this.audioBackgroundDebug) {
            const payload = {
                event: 'active',
                timestamp: this.diagnosticTimestamp(),
                role: 'main-player',
                playerInstanceId: this.diagnosticInstanceId(this.lecteur),
                elementId: this.lecteur?.id || null,
                nextTrackId: context.nextTrackId ?? null
            };
            this.recordAudioDiagnostic('[PLAYER_INSTANCE]', 'active', payload);
            console.log('[PLAYER_INSTANCE]', payload);
        }
        this.logNextDiagnostic('SET_SRC', {
            playerInstanceId: this.diagnosticInstanceId(this.lecteur),
            nextUrl,
            ...context
        });
        this.lecteur.loop = this.repeatTrack;
        this.lecteur.src = nextUrl;
        this.logNextDiagnostic('CALL_LOAD', {
            playerInstanceId: this.diagnosticInstanceId(this.lecteur),
            src: this.lecteur.src,
            ...context
        });
        this.lecteur.load();
    },

    mediaPathForRetry(path, attempt) {
        const diagnosticParameter = this.audioBackgroundDebug ? 'audio_debug=1' : '';
        const retryParameter = attempt > 0 ? `youplayer_retry=${Date.now()}-${attempt}` : '';
        const parameters = [diagnosticParameter, retryParameter].filter(Boolean);
        if (parameters.length === 0) return path;
        const separator = String(path).includes('?') ? '&' : '?';
        return `${path}${separator}${parameters.join('&')}`;
    },

    async loadAndPlayMainSource(path, context = {}, maxAttempts = 2) {
        for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
            const candidatePath = this.mediaPathForRetry(path, attempt);
            this.setMainAudioSource(candidatePath, {
                ...context,
                sourceAttempt: attempt + 1,
                maxSourceAttempts: maxAttempts
            });
            const playResolved = await this.playAudioWithDiagnostics(this.lecteur, {
                ...context,
                sourceAttempt: attempt + 1,
                maxSourceAttempts: maxAttempts
            }, {
                reportRejection: attempt === maxAttempts - 1
            });
            if (playResolved) {
                this.markRecentBackgroundAutoStart(this.lecteur, context);
                return true;
            }

            const errorName = this.lastPlayRejection?.name || 'Error';
            if (errorName === 'NotAllowedError') {
                this.handlePlayRejection(this.lastPlayRejection);
                this.logNextDiagnostic('SOURCE_RETRY_CANCELLED_AUTOPLAY_BLOCKED', {
                    ...context,
                    sourceAttempt: attempt + 1
                }, true);
                return false;
            }
            if (attempt < maxAttempts - 1) {
                this.logNextDiagnostic('SOURCE_RETRY', {
                    ...context,
                    failedAttempt: attempt + 1,
                    nextAttempt: attempt + 2,
                    name: errorName,
                    message: this.lastPlayRejection?.message || ''
                }, true);
            }
        }
        return false;
    },


    async revealCurrentTrack() {
        if (this.currentId === null || this.currentId === undefined) return;
        await this.loadView('playlist');
        const current = document.getElementById(String(this.currentId));
        current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        current?.focus?.({ preventScroll: true });
    },

    async reconcilePlaybackAfterWake() {
        this.logNextDiagnostic('WAKE_RECONCILE_START', {
            pendingTransitions: this.pendingPrefetchedTransitions.length,
            mainAudioEnded: this.lecteur?.ended ?? null
        });
        await this.syncPrefetchedTransitions();
        if (this.pendingPrefetchedTransitions.length === 0) await this.refreshPlaybackState();
        await this.recoverEndedPlayback();
        this.logNextDiagnostic('WAKE_RECONCILE_COMPLETE', {
            pendingTransitions: this.pendingPrefetchedTransitions.length,
            mainAudioEnded: this.lecteur?.ended ?? null
        });
    },

    async refreshPlaybackState(state = null) {
        if (!state && this.pendingPrefetchedTransitions.length > 0) {
            await this.syncPrefetchedTransitions();
            if (this.pendingPrefetchedTransitions.length > 0) return this.lastPlaybackState;
        }
        const data = state || await this.apiFetch('/playback_state');
        if (!data || typeof data !== 'object') return null;
        this.updatePlaybackUi(data);
        if (data.first_track_special_pending === true) {
            this.clearNextTrackPrefetch();
        } else {
            this.prefetchUpcomingTrack(data.queue || []);
        }
        return data;
    },

    clearNextTrackPrefetch({ preserveHandoff = false } = {}) {
        this.crossfade?.clear({ preserveHandoff });
        this.prefetchGeneration += 1;
        this.nextTrackPrefetch = null;
        this.nextTrackPrefetchPromise = null;
    },

    async prefetchUpcomingTrack(queue = []) {
        const nextTrack = Array.isArray(queue) ? queue[0] : null;
        const nextTrackId = nextTrack?.__sessionIndex;
        if (!Number.isInteger(nextTrackId)) {
            this.clearNextTrackPrefetch({ preserveHandoff: true });
            return null;
        }

        if (this.nextTrackPrefetch?.trackId === nextTrackId && this.nextTrackPrefetch?.path) {
            return this.nextTrackPrefetch;
        }

        if (this.nextTrackPrefetchPromise?.trackId === nextTrackId) {
            return this.nextTrackPrefetchPromise.promise;
        }

        this.clearNextTrackPrefetch({ preserveHandoff: true });
        const generation = this.prefetchGeneration;
        const promise = (async () => {
            const readyPath = await this.waitForTrackReady(nextTrackId, 120000, { silent: true });
            if (generation !== this.prefetchGeneration) return null;
            if (!readyPath) {
                if (this.nextTrackPrefetchPromise?.trackId === nextTrackId) {
                    this.nextTrackPrefetchPromise = null;
                }
                return null;
            }

            const prefetched = {
                trackId: nextTrackId,
                path: readyPath,
                track: nextTrack
            };
            this.nextTrackPrefetch = prefetched;
            void this.crossfade?.prepare(prefetched);
            this.logNextDiagnostic('PREFETCH_READY', {
                trackId: nextTrackId,
                path: readyPath,
                strategy: 'readiness-only'
            });
            console.debug('[Player] loading next', nextTrackId);
            if (this.nextTrackPrefetchPromise?.trackId === nextTrackId) {
                this.nextTrackPrefetchPromise = null;
            }
            return prefetched;
        })();

        this.nextTrackPrefetchPromise = {
            trackId: nextTrackId,
            promise
        };
        return promise;
    },

    async recoverEndedPlayback() {
        if (!this.lecteur || this.userPausedAudio || this.nextSongLoading) return;
        if (this.lecteur.ended) {
            this.logNextDiagnostic('ENDED_DETECTED_AFTER_WAKE', {
                playerInstanceId: this.diagnosticInstanceId(this.lecteur)
            });
            await this.advanceToNextSong('ended-after-wake');
        }
    },

    async advanceToNextSong(reason = 'auto') {
        if (['manual', 'media-session'].includes(reason)) this.sleepTimer?.resume();
        if (this.sleepTimer?.check()) return;
        if (this.queueEditPromise) await this.queueEditPromise;
        if (this.nextSongLoading) return;
        if (this.repeatTrack && (reason === 'ended' || reason === 'ended-after-wake')) {
            await this.repeatCurrentTrack();
            return;
        }
        this.logNextDiagnostic('START', {
            reason,
            hasSpecialStream: Boolean(this.currentSpecialStream),
            hasPrefetchedTrack: Boolean(this.nextTrackPrefetch?.path),
            nextSongLoading: this.nextSongLoading
        });
        try {
            if (this.currentSpecialStream) {
                const naturalEnd = reason === 'ended' || reason === 'ended-after-wake';
                if (!this.currentSpecialStream.nextEnabled && !naturalEnd && reason !== 'error') {
                    this.logNextDiagnostic('SKIP_SPECIAL_NEXT_DISABLED', { reason });
                    return;
                }
                // Keep the media element active and start the prepared track in
                // this event turn, even if the background network is suspended.
                const stopReason = naturalEnd
                    ? 'finished' : reason === 'error' ? 'error' : 'next';
                void this.stopSpecialPlayback(stopReason, { preserveAudio: true });
            }
            const prefetched = this.nextTrackPrefetch;
            if (prefetched?.path && Number.isInteger(prefetched.trackId)) {
                this.logNextDiagnostic('USE_PREFETCHED_TRACK', {
                    reason,
                    nextTrackId: prefetched.trackId,
                    path: prefetched.path
                });
                await this.playPrefetchedNextTrack(prefetched, reason);
                return;
            }
            this.logNextDiagnostic('USE_NETWORK_NEXT_TRACK', { reason });
            await this.nextSong(reason);
        } catch (error) {
            this.logNextDiagnostic('ERROR', {
                reason,
                name: error?.name || 'Error',
                message: error?.message || String(error),
                stack: error?.stack || ''
            }, true);
        }
    },

    activeAudioPlayer() {
        return this.currentSpecialStream ? this.specialPlayer : this.lecteur;
    },

    async startSpecialPlayback(data) {
        if (!this.specialPlayer || !data?.stream_id || !data?.audio_url) {
            throw new Error('Lecteur spécial indisponible');
        }
        if (this.currentSpecialStream) {
            await this.stopSpecialPlayback('replaced');
        }

        this.clearMainAudio();
        this.currentSpecialStream = {
            id: data.stream_id,
            audioUrl: data.audio_url,
            nextEnabled: data.first_track_next_enabled !== false
        };
        if (this.audioBackgroundDebug) {
            const payload = {
                event: 'active',
                timestamp: this.diagnosticTimestamp(),
                role: 'special-stream-player',
                playerInstanceId: this.diagnosticInstanceId(this.specialPlayer),
                elementId: this.specialPlayer?.id || null,
                streamId: data.stream_id
            };
            this.recordAudioDiagnostic('[PLAYER_INSTANCE]', 'active', payload);
            console.log('[PLAYER_INSTANCE]', payload);
        }
        this.userPausedAudio = false;
        this.lastPositionStateSecond = -1;
        this.playerState.loading = true;
        const nextUrl = `${API_URL}${data.audio_url}`;
        this.logNextDiagnostic('SET_SRC', {
            playerRole: 'special-stream-player',
            playerInstanceId: this.diagnosticInstanceId(this.specialPlayer),
            nextUrl
        });
        this.specialPlayer.loop = false;
        this.specialPlayer.src = nextUrl;
        const playResolved = await this.playAudioWithDiagnostics(this.specialPlayer, {
            trigger: 'start-special-playback',
            streamId: data.stream_id
        });
        this.logNextDiagnostic('SPECIAL_STREAM_PLAY_RESULT', {
            streamId: data.stream_id,
            playResolved
        }, !playResolved);
        this.requestWakeLock();
        this.prefetchUpcomingTrack(data.queue || []);
    },

    async stopSpecialPlayback(reason = 'stop', { notifyBackend = true, preserveAudio = false } = {}) {
        const stream = this.currentSpecialStream;
        if (!stream) return;
        this.suppressSpecialPlayerEvents = true;
        this.suppressMainPlayerEvents = true;
        try {
            if (!preserveAudio) {
                this.pauseAudioWithDiagnostics(this.specialPlayer, 'stop-special-player', { reason });
                this.logNextDiagnostic('REMOVE_SRC', {
                    operation: 'stop-special-player',
                    reason,
                    playerInstanceId: this.diagnosticInstanceId(this.specialPlayer)
                });
                this.specialPlayer?.removeAttribute('src');
                this.logNextDiagnostic('CALL_LOAD', {
                    operation: 'stop-special-player',
                    reason,
                    playerInstanceId: this.diagnosticInstanceId(this.specialPlayer)
                });
                this.specialPlayer?.load();
            }
        } finally {
            this.currentSpecialStream = null;
            this.suppressSpecialPlayerEvents = false;
            this.suppressMainPlayerEvents = false;
        }

        if (notifyBackend) {
            const endpoint = `/audio/${encodeURIComponent(stream.id)}/stop`;
            const requestId = `audio-${++this.audioDiagnosticRequestSequence}`;
            const startedAt = Date.now();
            this.logNextDiagnostic('REQUEST_START', { requestId, endpoint, method: 'POST', reason });
            try {
                const response = await fetchImpl(`${API_URL}${endpoint}`, {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ reason }),
                    keepalive: true
                });
                const details = {
                    requestId,
                    endpoint,
                    method: 'POST',
                    status: response.status,
                    elapsedMs: Date.now() - startedAt
                };
                this.logNextDiagnostic(
                    response.ok ? 'REQUEST_SUCCESS' : 'REQUEST_ERROR',
                    details,
                    !response.ok
                );
            } catch (error) {
                this.logNextDiagnostic('REQUEST_ERROR', {
                    requestId,
                    endpoint,
                    method: 'POST',
                    elapsedMs: Date.now() - startedAt,
                    name: error?.name || 'Error',
                    message: error?.message || String(error)
                }, true);
            }
        }
    },

    async handleSpecialStreamEnded() {
        if (!this.currentSpecialStream || this.suppressSpecialPlayerEvents) return;
        this.logNextDiagnostic('SPECIAL_ENDED_HANDLER_START', {
            streamId: this.currentSpecialStream.id
        });
        this.logNextDiagnostic('SPECIAL_ENDED_BEFORE_ADVANCE');
        await this.advanceToNextSong('ended');
    },

    async handleSpecialStreamError() {
        if (!this.currentSpecialStream || this.suppressSpecialPlayerEvents) return;
        this.logNextDiagnostic('SPECIAL_ERROR_HANDLER_START', {
            streamId: this.currentSpecialStream.id
        }, true);
        this.showNotice('Le flux du premier titre a échoué. Passage au titre suivant.', true);
        await this.advanceToNextSong('error');
    },

    async prepareCrossfade() {
        if (!this.crossfade) return;
        await this.crossfade.unlock();
        await this.crossfade.prepare(this.nextTrackPrefetch);
    },

    async playPrefetchedNextTrack(prefetched, reason = 'auto') {
        if (this.nextSongLoading) {
            this.logNextDiagnostic('SKIP_ALREADY_LOADING', { reason, path: 'prefetched' });
            return;
        }
        this.nextSongLoading = true;
        let failedTransition = false;
        let autoplayBlocked = false;

        try {
            const previousTrackId = this.currentId === null ? null : Number(this.currentId);
            const transition = {
                id: globalThis.crypto?.randomUUID?.()
                    || `prefetch-${Date.now()}-${Math.random().toString(16).slice(2)}`,
                previousTrackId,
                expectedTrackId: prefetched.trackId
            };
            this.pendingPrefetchedTransitions.push(transition);
            this.showPlayer();
            this.currentId = prefetched.trackId;
            this.userPausedAudio = false;
            const remainingQueue = (this.lastPlaybackState?.queue || []).slice(1);
            this.updatePlaybackUi({
                currentId: prefetched.trackId,
                current: prefetched.track,
                queue: remainingQueue,
                random: this.lastPlaybackState?.random
            });

            const playResolved = await this.loadAndPlayMainSource(prefetched.path, {
                trigger: 'prefetched-next-track',
                crossfadeHandoff: reason === 'ended' || reason === 'ended-after-wake',
                reason,
                nextTrackId: prefetched.trackId,
                path: 'prefetched'
            });
            this.clearNextTrackPrefetch({ preserveHandoff: playResolved });
            if (!playResolved) {
                autoplayBlocked = this.lastPlayRejection?.name === 'NotAllowedError';
                failedTransition = !autoplayBlocked;
                if (failedTransition) this.consecutivePlaybackErrors += 1;
                this.logNextDiagnostic(
                    autoplayBlocked ? 'ADVANCE_WAITING_FOR_USER_PLAY' : 'ADVANCE_PLAY_FAILED',
                    {
                        reason,
                        trackId: prefetched.trackId,
                        path: 'prefetched',
                        name: this.lastPlayRejection?.name || 'Error',
                        message: this.lastPlayRejection?.message || ''
                    },
                    true
                );
            } else {
                void this.requestWakeLock();
                void this.prefetchUpcomingTrack(remainingQueue);
                void this.syncPrefetchedTransitions();
                this.logNextDiagnostic('COMPLETE', {
                    reason,
                    trackId: prefetched.trackId,
                    path: 'prefetched',
                    playResolved: true
                });
                console.debug('[Player] advanced', { reason, trackId: prefetched.trackId });
            }
        } finally {
            this.nextSongLoading = false;
        }

        if (failedTransition || autoplayBlocked) {
            await this.syncPrefetchedTransitions();
        }
        if (failedTransition) {
            if (this.consecutivePlaybackErrors >= 3) {
                this.showNotice('Plusieurs musiques sont indisponibles. Lecture arrêtée.', true);
                return;
            }
            this.showNotice('Connexion audio interrompue. Passage au titre suivant.', true);
            this.logNextDiagnostic('RECOVER_AFTER_PLAY_FAILURE', {
                failedTrackId: prefetched.trackId,
                consecutivePlaybackErrors: this.consecutivePlaybackErrors
            });
            await this.advanceToNextSong('play-rejected');
        }
    },

    async syncPrefetchedTransitions() {
        if (this.prefetchedTransitionSyncPromise) return this.prefetchedTransitionSyncPromise;

        this.prefetchedTransitionSyncPromise = (async () => {
            while (this.pendingPrefetchedTransitions.length > 0) {
                const transition = this.pendingPrefetchedTransitions[0];
                const data = await this.apiFetch('/prefetched_next', 'POST', {
                    transitionId: transition.id,
                    previousTrackId: transition.previousTrackId,
                    expectedTrackId: transition.expectedTrackId
                });
                if (!data) break;
                this.pendingPrefetchedTransitions.shift();

                const newId = data.currentId ?? data[0];
                if (Number(this.currentId) === Number(newId)) {
                    const serverState = {
                        currentId: newId,
                        current: data.current,
                        queue: data.queue || [],
                        random: data.random
                    };
                    this.updatePlaybackUi(serverState);
                    void this.prefetchUpcomingTrack(serverState.queue);
                }
            }
        })().finally(() => {
            this.prefetchedTransitionSyncPromise = null;
        });

        return this.prefetchedTransitionSyncPromise;
    },


    enqueueNextSong(trackId, { playNow = false, collection, collectionIndex = 0 } = {}) {
        if (playNow) this.sleepTimer?.resume();
        let startPlayback = false;
        const previous = this.queueEditPromise || Promise.resolve();
        const task = previous.catch(() => {}).then(async () => {
            if (this.nextSongLoading) {
                this.showNotice('Changement de morceau en cours. Réessayez dans un instant.');
                return;
            }
            await this.syncPrefetchedTransitions();
            if (this.pendingPrefetchedTransitions.length > 0) return;
            const body = typeof trackId === 'object'
                ? (trackId.previewPlaylist
                    ? { playlist: trackId.previewPlaylist, index: trackId.previewIndex, key: trackId.key }
                    : { song: trackId })
                : { arg: Number(trackId) };
            if (playNow && this.controlledPlayback) body.controlled = true;
            if (playNow && collection) {
                body.collection = collection;
                body.collectionIndex = collectionIndex;
            }
            const response = await this.apiFetch('/add_song_ecoute', 'POST', body);
            if (!response?.queue) return;
            startPlayback = playNow || response.currentId === null || this.activeAudioPlayer()?.ended === true;
            this.updatePlaybackUi({ ...this.lastPlaybackState, ...response });
            this.clearNextTrackPrefetch();
            if (!response.first_track_special_pending && !startPlayback) void this.prefetchUpcomingTrack(response.queue);
            if (!playNow) this.showNotice(startPlayback ? 'Musique ajoutée à la file de lecture.' : 'Musique ajoutée juste après le morceau en cours.');
        }).finally(() => {
            if (this.queueEditPromise === task) this.queueEditPromise = null;
        });
        this.queueEditPromise = task;
        return task.then(() => {
            // Start outside the queue edit: nextSong waits for that edit to finish.
            if (startPlayback) return this.nextSong(playNow ? 'select' : 'auto');
        });
    },

    selectLibraryPlaylists(selectedFiles) {
        const previous = this.queueEditPromise || Promise.resolve();
        const task = previous.catch(() => {}).then(() => this.applyLibraryPlaylists(selectedFiles)).finally(() => {
            if (this.queueEditPromise === task) this.queueEditPromise = null;
        });
        this.queueEditPromise = task;
        return task;
    },

    async applyLibraryPlaylists(selectedFiles) {
        if (selectedFiles.length === 0) {
            this.showNotice("Veuillez sélectionner au moins une playlist.");
            return;
        }

        this.sleepTimer?.resume();

        const shuffleEnabled = document.getElementById('shuffle-mode').checked;
        if (this.nextSongLoading) {
            this.showNotice('Changement de morceau en cours. Réessaie dans un instant.');
            return false;
        }
        await this.syncPrefetchedTransitions();
        if (this.pendingPrefetchedTransitions.length > 0) return false;
        this.clearNextTrackPrefetch({ preserveHandoff: true });
        const success = await this.apiFetch("/playlist_used", "POST", {
            arg: selectedFiles,
            preservePlayback: true,
            random: shuffleEnabled
        });

        if (success) {
            this.pendingPrefetchedTransitions = [];
            if (success.preserved) {
                this.updatePlaybackUi(success);
                void this.prefetchUpcomingTrack(success.queue || []);
            } else {
                await this.stopSpecialPlayback('playlist_replaced');
                this.clearMainAudio();
                this.currentId = null;
                this.lastPlaybackState = null;
                this.renderUpcomingQueue([]);
                if (this.playerBar) this.playerBar.classList.remove('visible');
                this.closeNowPlaying();
            }

            const msg = document.getElementById('selection-message');
            msg.style.display = 'block';
            setTimeout(() => msg.style.display = 'none', 3000);

            this.selectedPlaylists = selectedFiles;
            this.draftPlaylists = new Set(selectedFiles);
            for (const playlist of [...selectedFiles].reverse()) {
                await this.changeLibraryPreference({ action: 'visit', playlist });
            }
        }
        return Boolean(success);
    },

    async waitForTrackReady(trackId, timeoutMs = 90000, { silent = false } = {}) {
        const startedAt = Date.now();
        let notified = false;

        while (Date.now() - startedAt < timeoutMs) {
            const status = await this.apiFetch(`/play_status/${encodeURIComponent(trackId)}`);
            if (!status) return null;
            if (status.status === 'ready') {
                return status.path || `/play/${trackId}`;
            }
            if (status.status !== 'pending') {
                if (!silent) {
                    this.showNotice('Ce titre ne peut pas être lu pour le moment. Essaie un autre morceau.', true);
                }
                return null;
            }
            if (!silent && !notified) {
                this.showNotice('Téléchargement en cours...');
                notified = true;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }

        if (!silent) {
            this.showNotice('Le téléchargement de la musique a expiré.', true);
        }
        return null;
    },

    async nextSong(reason = 'auto') {
        if (['select', 'previous'].includes(reason)) this.sleepTimer?.resume();
        if (this.sleepTimer?.check()) return;
        if (this.queueEditPromise) await this.queueEditPromise;
        if (this.nextSongLoading) {
            this.logNextDiagnostic('SKIP_ALREADY_LOADING', { reason, path: 'network' });
            return;
        }
        if (this.pendingPrefetchedTransitions.length > 0) {
            this.logNextDiagnostic('SYNC_PENDING_TRANSITIONS', {
                reason,
                count: this.pendingPrefetchedTransitions.length
            });
            await this.syncPrefetchedTransitions();
            if (this.pendingPrefetchedTransitions.length > 0) {
                this.logNextDiagnostic('SKIP_PENDING_TRANSITIONS', {
                    reason,
                    count: this.pendingPrefetchedTransitions.length
                });
                return;
            }
        }
        if (this.currentSpecialStream) {
            if (!this.currentSpecialStream.nextEnabled && !['previous', 'select'].includes(reason)) return;
            void this.stopSpecialPlayback('next', { preserveAudio: true });
        }
        this.nextSongLoading = true;
        this.clearNextTrackPrefetch();

        try {
            for (let attempt = 0; attempt < (reason === 'previous' ? 1 : 3); attempt += 1) {
                this.logNextDiagnostic('NEXT_REQUEST_ATTEMPT', { reason, attempt: attempt + 1 });
                const data = reason === 'previous'
                    ? await this.apiFetch('/previous_song', 'POST')
                    : await this.apiFetch(reason === 'select' ? '/next_song?reason=select' : '/next_song');
                if (!data) {
                    this.logNextDiagnostic('NEXT_REQUEST_NO_DATA', { reason, attempt: attempt + 1 }, true);
                    return;
                }

                this.showPlayer();
                const newId = data.currentId ?? data[0];
                const path = data.path ?? data[1];
                this.currentId = newId;
                this.userPausedAudio = false;
                this.playerState.loading = true;
                this.updatePlaybackUi({
                    currentId: newId,
                    current: data.current,
                    queue: data.queue || [],
                    random: data.random
                });

                if (data.mode === 'special_stream') {
                    this.logNextDiagnostic('SPECIAL_STREAM_SELECTED', {
                        reason,
                        nextTrackId: newId,
                        streamId: data.stream_id
                    });
                    await this.startSpecialPlayback(data);
                    return;
                }

                this.logNextDiagnostic('WAIT_FOR_TRACK_READY', {
                    reason,
                    nextTrackId: newId,
                    candidatePath: path
                });
                const readyPath = await this.waitForTrackReady(newId);
                if (!readyPath) {
                    this.consecutivePlaybackErrors += 1;
                    this.logNextDiagnostic('TRACK_NOT_READY', {
                        reason,
                        nextTrackId: newId,
                        attempt: attempt + 1
                    }, true);
                    console.error('[Player] unavailable', newId);
                    continue;
                }
                const playResolved = await this.loadAndPlayMainSource(readyPath || path, {
                    trigger: 'network-next-track',
                    reason,
                    nextTrackId: newId,
                    path: 'network'
                });
                if (!playResolved) {
                    if (this.lastPlayRejection?.name === 'NotAllowedError') {
                        this.logNextDiagnostic('ADVANCE_WAITING_FOR_USER_PLAY', {
                            reason,
                            trackId: newId,
                            path: 'network'
                        }, true);
                        return;
                    }
                    this.consecutivePlaybackErrors += 1;
                    this.logNextDiagnostic('ADVANCE_PLAY_FAILED', {
                        reason,
                        trackId: newId,
                        path: 'network',
                        attempt: attempt + 1,
                        name: this.lastPlayRejection?.name || 'Error',
                        message: this.lastPlayRejection?.message || ''
                    }, true);
                    continue;
                }
                void this.requestWakeLock();
                void this.prefetchUpcomingTrack(data.queue || []);
                this.logNextDiagnostic('COMPLETE', {
                    reason,
                    trackId: newId,
                    path: 'network',
                    playResolved: true
                });
                return;
            }
            this.logNextDiagnostic('ERROR', {
                reason,
                message: 'Three consecutive tracks were unavailable'
            }, true);
            this.showNotice(reason === 'previous'
                ? 'Le morceau précédent est indisponible.'
                : 'Plusieurs musiques sont indisponibles. Lecture arrêtée.', true);
        } finally {
            this.nextSongLoading = false;
        }

    },

    // --- ASTUCE ANTI-VEILLE (WAKE LOCK) ---
    async requestWakeLock() {
        if (document.hidden) {
            this.logNextDiagnostic('WAKE_LOCK_SKIPPED_HIDDEN');
            return;
        }
        if ('wakeLock' in navigator) {
            try {
                this.wakeLock = await navigator.wakeLock.request('screen');

                this.wakeLock.addEventListener('release', () => {
                    this.wakeLock = null;
                });
            } catch (err) {
                console.error(`Erreur Wake Lock : ${err.name}, ${err.message}`);
            }
        } else {
            this.wakeLock = null;
        }
    },


	    showPlayer() {
        if (this.playerBar && !this.playerBar.classList.contains('visible')) {

            this.playerBar.classList.add('visible');
            this.initMediaSession();
        }
    },

    async add_song_playlist(key) {
        return this.enqueueNextSong(Number(key), { playNow: true });
    },

    initMediaSession() {
        if (!('mediaSession' in navigator) || this.mediaSessionInitialized) return;
        this.mediaSessionInitialized = true;

        const withDiagnosticLog = (action, handler) => (details) => {
            if (this.audioBackgroundDebug) {
                const payload = {
                    timestamp: this.diagnosticTimestamp(),
                    hidden: document.hidden,
                    visibilityState: document.visibilityState,
                    playerInstanceId: this.diagnosticInstanceId(this.activeAudioPlayer()),
                    details: details || null
                };
                this.recordAudioDiagnostic('[MEDIA_SESSION]', action, payload);
                console.log(`[MEDIA_SESSION] ${action}`, payload);
            }
            return handler(details);
        };
        const handlers = {
            previoustrack: withDiagnosticLog('previoustrack', () => this.previousTrack()),
            nexttrack: withDiagnosticLog('nexttrack', () => this.advanceToNextSong('media-session')),
            pause: withDiagnosticLog('pause', () => this.pauseAudioWithDiagnostics(
                this.activeAudioPlayer(),
                'media-session-pause'
            )),
            play: withDiagnosticLog('play', () => this.playAudioWithDiagnostics(
                this.activeAudioPlayer(),
                { trigger: 'media-session-play' }
            )),
            seekto: withDiagnosticLog('seekto', (details) => {
                const player = this.activeAudioPlayer();
                if (!player || !Number.isFinite(details.seekTime)) return;
                player.currentTime = Math.max(0, Math.min(details.seekTime, player.duration || details.seekTime));
            }),
            stop: withDiagnosticLog('stop', () => {
                if (this.currentSpecialStream) {
                    void this.stopSpecialPlayback('stop');
                } else {
                    this.pauseAudioWithDiagnostics(this.lecteur, 'media-session-stop');
                }
            })
        };
        for (const [action, handler] of Object.entries(handlers)) {
            try {
                navigator.mediaSession.setActionHandler(action, handler);
            } catch {
                // Les actions disponibles varient selon le navigateur.
            }
        }
    },

    updateMediaPlaybackState(state) {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.playbackState = state;
        }
    },

    updateMediaPositionState(player, force = false) {
        if (!('mediaSession' in navigator)
            || typeof navigator.mediaSession.setPositionState !== 'function') return;
        const duration = player?.duration;
        const position = player?.currentTime;
        if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(position)) return;

        const positionSecond = Math.floor(position);
        if (!force && positionSecond === this.lastPositionStateSecond) return;
        this.lastPositionStateSecond = positionSecond;
        try {
            navigator.mediaSession.setPositionState({
                duration,
                playbackRate: player.playbackRate || 1,
                position: Math.max(0, Math.min(position, duration))
            });
        } catch {
            // Certains navigateurs refusent les flux sans durée exploitable.
        }
    },

    updateMediaMetadata(track, fallbackTitle = '') {
        if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') {
            return;
        }

        const title = track?.title || track?.name || fallbackTitle || 'Titre inconnu';
        const artist = track?.artist || track?.channelTitle || '';
        const album = track?.album || '';
        const artworkSrc = this.getTrackArtwork(track);
        const metadata = {
            title,
            artist: artist || 'Artiste inconnu',
            album: album || 'YouPlayer'
        };

        if (artworkSrc) {
            metadata.artwork = [
                { src: artworkSrc, sizes: '512x512' }
            ];
        }

        navigator.mediaSession.metadata = new MediaMetadata(metadata);
    }
    };
}
