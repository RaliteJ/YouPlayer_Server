export const playerView = {
    setCurrentHighlight(currentId) {
        if (!this.playlistContainer) return;

        this.playlistContainer.querySelectorAll('.is-current').forEach((item) => {
            item.classList.remove('is-current');
            item.removeAttribute('aria-current');
        });

        if (currentId === null || currentId === undefined) {
            this.currentId = null;
            return;
        }

        this.currentId = String(currentId);
        const currentEl = document.getElementById(this.currentId);
        if (currentEl) {
            currentEl.classList.add('is-current');
            currentEl.setAttribute('aria-current', 'true');
        }
    },

    renderedTrackTitle(currentId) {
        if (currentId === null || currentId === undefined) return '';
        const currentEl = document.getElementById(String(currentId));
        return currentEl?.querySelector('.song-title')?.innerText || currentEl?.innerText?.replace('⚙️', '').trim() || '';
    },

    renderUpcomingQueue(queue = []) {
        const containers = this.upcomingContainers?.length
            ? this.upcomingContainers
            : [this.upcomingContainer].filter(Boolean);
        if (containers.length === 0) return;

        const safeQueue = Array.isArray(queue) ? queue : [];
        const countLabel = `${safeQueue.length} titre${safeQueue.length > 1 ? 's' : ''}`;
        this.upcomingCounts?.forEach((count) => {
            count.innerText = countLabel;
        });

        if (safeQueue.length === 0) {
            containers.forEach((container) => {
                container.innerHTML = '<li class="queue-empty">Aucune musique à suivre</li>';
            });
            return;
        }

        const markup = safeQueue.map((track, index) => {
            const title = this.escapeHtml(track.title || track.name || 'Titre inconnu');
            const metaParts = [track.artist, track.album].filter(Boolean);
            const meta = this.escapeHtml(metaParts.join(' • ') || track.type || '');
            const cover = this.escapeHtml(track.albumCoverURL || track.thumbnail || '');
            const trackIndex = track.__sessionIndex ?? track.id ?? '';
            const coverMarkup = cover
                ? `<img class="queue-cover" src="${cover}" alt="" width="42" height="42" loading="lazy">`
                : '<div class="queue-cover queue-cover-placeholder"></div>';

            return `
                <li class="queue-track" data-track-id="${this.escapeHtml(trackIndex)}">
                    <span class="queue-position">${index + 1}</span>
                    ${coverMarkup}
                    <div class="queue-text">
                        <span class="queue-title">${title}</span>
                        <span class="queue-meta">${meta || '&nbsp;'}</span>
                    </div>
                </li>
            `;
        }).join('');

        containers.forEach((container) => {
            container.innerHTML = markup;
        });
    },

    async toggleQueueDrawer() {
        if (this.queueDrawerOpen) {
            this.closeQueueDrawer();
            return;
        }
        await this.openQueueDrawer();
    },

    async openQueueDrawer() {
        if (!this.queueDrawer || !this.queueOverlay) return;

        this.queueDrawer.hidden = false;
        this.queueOverlay.hidden = false;
        this.queueDrawer.classList.add('is-open');
        this.queueOverlay.classList.add('is-open');
        this.queueDrawer.setAttribute('aria-hidden', 'false');
        this.queueToggleButton?.setAttribute('aria-expanded', 'true');
        this.queueDrawerOpen = true;
        await this.refreshPlaybackState();
    },

    closeQueueDrawer() {
        if (!this.queueDrawer || !this.queueOverlay) return;

        if (this.queueDrawer.contains(document.activeElement)) {
            this.queueToggleButton?.focus();
        }
        this.queueDrawer.classList.remove('is-open');
        this.queueOverlay.classList.remove('is-open');
        this.queueDrawer.setAttribute('aria-hidden', 'true');
        this.queueToggleButton?.setAttribute('aria-expanded', 'false');
        this.queueDrawer.hidden = true;
        this.queueOverlay.hidden = true;
        this.queueDrawerOpen = false;
    },

    updateShuffleUi(enabled) {
        const checkbox = document.getElementById('shuffle-mode');
        if (checkbox) checkbox.checked = enabled;
        const button = document.getElementById('overlayShuffle');
        button?.setAttribute('aria-pressed', String(enabled));
        button?.setAttribute('title', enabled ? 'Désactiver la lecture aléatoire' : 'Activer la lecture aléatoire');
    },

    async setShuffleMode(enabled) {
        this.updateShuffleUi(enabled);
        const hasActiveQueue = this.selectedPlaylists.length > 0
            || this.lastPlaybackState?.currentId != null
            || (this.lastPlaybackState?.queue?.length || 0) > 0;
        if (!hasActiveQueue) return;
        const controls = ['shuffle-mode', 'overlayShuffle'].map(id => document.getElementById(id)).filter(Boolean);
        controls.forEach(control => { control.disabled = true; });
        try {
            const state = await this.apiFetch('/random', 'POST', { enabled });
            if (state) {
                this.updatePlaybackUi(state);
                this.clearNextTrackPrefetch();
                this.prefetchUpcomingTrack(state.queue || []);
            }
            else this.updateShuffleUi(this.lastPlaybackState?.random === true);
        } finally {
            controls.forEach(control => { control.disabled = false; });
        }
    },

    updatePlaybackUi(state = {}) {
        this.lastPlaybackState = state;
        const currentId = state.currentId ?? state.current?.id ?? null;
        this.currentId = currentId;
        this.playerState.currentTrack = currentId == null
            ? null
            : (state.current || this.playerState.currentTrack);
        this.playerState.queue = Array.isArray(state.queue) ? state.queue : [];
        this.playerState.currentIndex = currentId;
        this.playerState.nextTrack = this.playerState.queue[0] || null;
        this.setCurrentHighlight(currentId);
        this.renderUpcomingQueue(state.queue || []);
        if (typeof state.random === 'boolean') this.updateShuffleUi(state.random);

        if (currentId !== null && currentId !== undefined) {
            this.showPlayer();
            const track = state.current || this.playerState.currentTrack;
            const fallbackTitle = this.renderedTrackTitle(currentId);
            this.updatePlayerDetails(track, fallbackTitle);
            this.updatePlayerArtwork(track);
        }
        this.renderPlayerTransport();
    },

    updatePlayerDetails(track, fallbackTitle = '') {
        const title = track?.title || track?.name || fallbackTitle || 'Titre inconnu';
        const artist = track?.artist || track?.channelTitle || 'Artiste inconnu';
        const context = track?.album
            || String(track?.__playlist || '').replace(/\.json$/i, '')
            || 'YouPlayer';

        if (this.songTitle) this.songTitle.innerText = title;
        if (this.songArtist) this.songArtist.innerText = artist;
        if (this.overlayTitle) this.overlayTitle.innerText = title;
        if (this.overlayArtist) this.overlayArtist.innerText = artist;
        if (this.overlayContext) this.overlayContext.innerText = context;
        this.updateMediaMetadata(track, title);
        this.renderLikeButtons();
    },

    updatePlayerArtwork(track) {
        const artwork = this.getTrackArtwork(track);
        [this.playerArtwork, this.overlayArtwork].filter(Boolean).forEach((container) => {
            container.classList.toggle('player-artwork-placeholder', !artwork);
            container.innerHTML = artwork
                ? `<img src="${this.escapeHtml(artwork)}" alt="">`
                : '<span>♫</span>';
        });
    },

    openNowPlaying() {
        if (!this.nowPlayingOverlay || !this.playerBar?.classList.contains('visible')) return;
        this.nowPlayingOverlay.hidden = false;
        this.nowPlayingOverlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('now-playing-open');
        this.nowPlayingOpen = true;
        this.updatePlayerProgress();
        this.renderPlayerTransport();
        this.nowPlayingClose?.focus();
    },

    closeNowPlaying() {
        if (!this.nowPlayingOverlay || !this.nowPlayingOpen) return;
        if (this.nowPlayingOverlay.contains(document.activeElement)) {
            this.miniPlayerOpen?.focus();
        }
        this.nowPlayingOverlay.hidden = true;
        this.nowPlayingOverlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('now-playing-open');
        this.nowPlayingOpen = false;
    },

    bindNowPlayingSwipeToClose() {
        if (!this.nowPlayingOverlay) return;
        let startX = 0;
        let startY = 0;
        this.nowPlayingOverlay.addEventListener('touchstart', (event) => {
            const touch = event.changedTouches[0];
            if (!touch) return;
            startX = touch.clientX;
            startY = touch.clientY;
        }, { passive: true });
        this.nowPlayingOverlay.addEventListener('touchend', (event) => {
            const touch = event.changedTouches[0];
            if (!touch || !this.nowPlayingOpen) return;
            const deltaX = touch.clientX - startX;
            const deltaY = touch.clientY - startY;
            if (deltaX > 90 && deltaX > Math.abs(deltaY) * 1.2) this.closeNowPlaying();
        }, { passive: true });
    },

    togglePlayback() {
        const player = this.activeAudioPlayer();
        if (!player?.currentSrc) return;
        if (player.paused || player.ended) {
            void this.playAudioWithDiagnostics(player, { trigger: 'play-pause-control' });
        } else {
            this.pauseAudioWithDiagnostics(player, 'play-pause-control');
        }
    },

    seekPlayer(position) {
        this.crossfade?.cancel();
        const player = this.activeAudioPlayer();
        if (!player || !Number.isFinite(player.duration)) return;
        player.currentTime = Math.max(0, Math.min(position, player.duration));
        this.syncStateFromAudio(true);
    },

    formatPlayerTime(seconds) {
        if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = Math.floor(seconds % 60).toString().padStart(2, '0');
        return `${minutes}:${remainingSeconds}`;
    },

    updatePlayerProgress() {
        const currentTime = this.playerState.currentTime || 0;
        const duration = this.playerState.duration || 0;
        const progress = duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0;
        if (this.miniPlayerProgress) {
            this.miniPlayerProgress.style.setProperty('--mini-player-progress', `${progress}%`);
            this.miniPlayerProgress.setAttribute('aria-valuenow', String(Math.round(progress)));
        }
        if (this.playerSeek) {
            this.playerSeek.max = String(duration || 100);
            this.playerSeek.value = String(Math.min(currentTime, duration || 100));
            this.playerSeek.disabled = duration <= 0;
            this.playerSeek.style.setProperty('--player-progress', `${progress}%`);
        }
        if (this.playerCurrentTime) this.playerCurrentTime.innerText = this.formatPlayerTime(currentTime);
        if (this.playerDuration) this.playerDuration.innerText = this.formatPlayerTime(duration);
    },

    renderPlayerTransport() {
        const player = this.activeAudioPlayer();
        const playing = Boolean(player?.currentSrc && !player.paused && !player.ended);
        const label = playing ? 'Pause' : 'Lecture';
        const symbol = playing ? '❚❚' : '▶';
        [this.miniPlayPause, this.overlayPlayPause].filter(Boolean).forEach((button) => {
            button.setAttribute('aria-label', label);
            button.classList.toggle('is-playing', playing);
            button.classList.toggle('is-loading', this.playerState.loading && !playing);
            const icon = button.querySelector('[aria-hidden="true"]');
            if (icon) icon.textContent = symbol;
        });
    },

};
