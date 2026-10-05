import { LIKED_PLAYLIST, trackLikeKey, formatTrackTitle as formatTrackTitleValue,
    getTrackArtwork as getTrackArtworkValue, playlistEntries as playlistEntriesValue } from './client-utils.js';

// Keep App as the receiver for paging, gestures and playback actions.
export const playlistView = {
    playlistItemMarkup(item) {
        const title = this.escapeHtml(item.title || 'Titre inconnu');
        const artist = this.escapeHtml(item.artist || '');
        const album = this.escapeHtml(item.album || '');
        const cover = this.escapeHtml(item.albumCoverURL || item.thumbnail || '');

        if (!this.richPlaylistDisplay) {
            return `
                <span class="song-title">${title}</span>
                ${this.likeButtonMarkup(item)}
                <button type="button" class="song-options" title="Options">⚙️</button>
            `;
        }

        const metaParts = [artist, album].filter(Boolean).map(value => `<span>${value}</span>`).join('<span class="meta-separator">•</span>');
        const coverMarkup = cover
            ? `<img class="song-cover" src="${cover}" alt="" width="48" height="48" loading="lazy" decoding="async">`
            : `<div class="song-cover song-cover-placeholder"></div>`;

        return `
            <div class="song-main">
                ${coverMarkup}
                <div class="song-text">
                    <span class="song-title">${title}</span>
                    <span class="song-meta">${metaParts || '&nbsp;'}</span>
                </div>
            </div>
            ${this.likeButtonMarkup(item)}
                <button type="button" class="song-options" title="Options">⚙️</button>
        `;
    },

    formatTrackTitle(track) {
        return formatTrackTitleValue(track);
    },

    getTrackArtwork(track) {
        return getTrackArtworkValue(track, window.location.origin);
    },

    playlistEntries(playlists) {
        return playlistEntriesValue(playlists);
    },

    playlistCoverMarkup(playlist) {
        const image = playlist?.image || '';
        if (!image) {
            return '<div class="playlist-cover playlist-cover-placeholder"></div>';
        }

        return `<img class="playlist-cover" src="${this.escapeHtml(image)}" alt="">`;
    },

    playlistOptionMarkup(playlist) {
        return `<option value="${this.escapeHtml(playlist.name)}">${this.escapeHtml(playlist.title)}</option>`;
    },

    playlistPickerButtonMarkup(playlist) {
        return `<button type="button" data-playlist="${this.escapeHtml(playlist.name)}">${this.escapeHtml(playlist.title)}</button>`;
    },

    playlistPreviewTrackMarkup(item, index) {
        const title = this.escapeHtml(item.title || item.name || 'Titre inconnu');
        const metaParts = [item.artist, item.album].filter(Boolean);
        const meta = this.escapeHtml(metaParts.join(' • ') || item.type || '');
        const cover = this.escapeHtml(item.albumCoverURL || item.thumbnail || '');
        const coverMarkup = cover
            ? `<img class="queue-cover" src="${cover}" alt="" width="42" height="42" loading="lazy">`
            : '<div class="queue-cover queue-cover-placeholder"></div>';

        return `
            <li class="playlist-preview-track" data-preview-index="${index}" tabindex="0" aria-label="Lire ${title}">
                ${coverMarkup}
                <div class="queue-text">
                    <span class="queue-title">${title}</span>
                    <span class="queue-meta">${meta || '&nbsp;'}</span>
                </div>
                <div class="playlist-preview-actions">
                    ${this.likeButtonMarkup(item)}
                    <button type="button" class="song-options" aria-label="Options pour ${title}" title="Options">⚙️</button>
                </div>
            </li>
        `;
    },

    renderPlaylistPreview(playlist, tracks = []) {
        if (!this.playlistPreviewList) return;

        const title = playlist?.title || String(playlist?.name || '').replace(/\.json$/i, '') || 'Aperçu';
        const safeTracks = Array.isArray(tracks) ? tracks : [];
        const countLabel = `${safeTracks.length} titre${safeTracks.length > 1 ? 's' : ''}`;

        if (this.playlistPreviewTitle) this.playlistPreviewTitle.innerText = title;
        if (this.playlistPreviewCount) this.playlistPreviewCount.innerText = countLabel;

        if (!safeTracks.length) {
            this.clearTrackPageScrolling(this.playlistPreviewList);
            this.playlistPreviewList.innerHTML = '<li class="playlist-preview-empty">Playlist vide</li>';
            return;
        }
        this.renderTrackPages(this.playlistPreviewList, safeTracks, (track, index) => {
            const template = document.createElement('template');
            template.innerHTML = this.playlistPreviewTrackMarkup(track, index);
            const row = template.content.firstElementChild;
            const previewRequest = {
                previewPlaylist: playlist.name, previewIndex: track.__playlistIndex, key: trackLikeKey(track)
            };
            this.bindQueueSwipe(row, previewRequest);
            row.addEventListener('click', event => {
                if (event.target.closest('button')) return;
                void this.enqueueNextSong(previewRequest, { playNow: true });
            });
            row.addEventListener('keydown', event => {
                if (event.target !== row || !['Enter', ' '].includes(event.key)) return;
                event.preventDefault();
                void this.enqueueNextSong(previewRequest, { playNow: true });
            });
            row.querySelector('.song-like')?.addEventListener('click', event => {
                event.stopPropagation();
                void this.togglePreviewLike(playlist.name, track);
            });
            row.querySelector('.song-options')?.addEventListener('click', event => {
                event.stopPropagation();
                this.openSongActionMenu(event.currentTarget, track, { previewPlaylist: playlist });
            });
            return row;
        });
    },

    clearTrackPageScrolling(container) {
        this.trackPageCleanups?.get(container)?.();
        this.trackPageCleanups?.delete(container);
    },

    renderTrackPages(container, tracks, renderRow) {
        this.clearTrackPageScrolling(container);
        container.innerHTML = '';
        let offset = 0;
        const appendPage = () => {
            container.querySelector('.track-list-more')?.remove();
            const fragment = document.createDocumentFragment();
            const end = Math.min(offset + 60, tracks.length);
            for (; offset < end; offset++) fragment.appendChild(renderRow(tracks[offset], offset));
            if (offset < tracks.length) {
                const more = document.createElement('li');
                more.className = 'track-list-more';
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'btn-small';
                button.textContent = `Afficher la suite (${offset} / ${tracks.length})`;
                button.addEventListener('click', appendPage);
                more.appendChild(button);
                fragment.appendChild(more);
            }
            container.appendChild(fragment);
            if (offset >= tracks.length) this.clearTrackPageScrolling(container);
            if (container === this.playlistContainer) this.setCurrentHighlight(this.currentId);
        };
        appendPage();
        if (offset >= tracks.length) return;

        const page = container.ownerDocument;
        const loadAtBottom = () => {
            if (!container.isConnected || !container.getClientRects().length || offset >= tracks.length) return;
            const more = container.querySelector('.track-list-more');
            if (!more) return;
            // Sur mobile, la vue parente defile ; sur ordinateur, l'apercu peut defiler seul.
            let scroller = container;
            while (scroller && !(scroller.clientHeight > 0 && scroller.scrollHeight > scroller.clientHeight + 1
                && /auto|scroll/.test(page.defaultView.getComputedStyle(scroller).overflowY))) {
                scroller = scroller.parentElement;
            }
            if (!scroller) return;
            const bottom = Math.min(scroller.getBoundingClientRect().bottom, page.defaultView.innerHeight);
            if (more.getBoundingClientRect().top <= bottom + 80) appendPage();
        };
        const positions = new WeakMap();
        for (let element = container; element; element = element.parentElement) {
            positions.set(element, element.scrollTop);
        }
        const onScroll = event => {
            const scroller = event.target === page ? page.scrollingElement : event.target;
            if (scroller !== container && !scroller?.contains?.(container)) return;
            const previous = positions.get(scroller) ?? 0;
            positions.set(scroller, scroller.scrollTop);
            if (scroller.scrollTop > previous) loadAtBottom();
        };
        const onWheel = event => { if (event.deltaY > 0) loadAtBottom(); };
        let touchY = null;
        const onTouchStart = event => { touchY = event.touches[0]?.clientY ?? null; };
        const onTouchMove = event => {
            const nextY = event.touches[0]?.clientY ?? null;
            if (touchY !== null && nextY !== null && nextY < touchY) loadAtBottom();
            touchY = nextY;
        };
        page.addEventListener('scroll', onScroll, { capture: true, passive: true });
        container.addEventListener('wheel', onWheel, { passive: true });
        container.addEventListener('touchstart', onTouchStart, { passive: true });
        container.addEventListener('touchmove', onTouchMove, { passive: true });
        this.trackPageCleanups ??= new WeakMap();
        this.trackPageCleanups.set(container, () => {
            page.removeEventListener('scroll', onScroll, true);
            container.removeEventListener('wheel', onWheel);
            container.removeEventListener('touchstart', onTouchStart);
            container.removeEventListener('touchmove', onTouchMove);
        });
    },

    async togglePreviewLike(playlistName, track, liked = !this.likedKeys.has(trackLikeKey(track))) {
        const key = trackLikeKey(track);
        if (!key || this.likeBusy || !Number.isInteger(track.__playlistIndex)) return;
        const userId = this.currentUser?.id;
        this.likeBusy = true;
        this.likesRevision++;
        this.renderLikeButtons();
        try {
            const data = await this.apiFetch('/liked_tracks', 'POST', {
                playlist: playlistName, index: track.__playlistIndex, key, liked
            });
            if (!data?.items || userId !== this.currentUser?.id) return;
            this.likedKeys = new Set(data.items.map(trackLikeKey));
            if (this.previewedPlaylist === LIKED_PLAYLIST) {
                await this.openPlaylistPreview({ name: LIKED_PLAYLIST, title: 'liked Youplayer' });
            }
        } finally {
            this.likeBusy = false;
            this.renderLikeButtons();
        }
    },

    async deletePreviewSong(playlist, track) {
        if (!Number.isInteger(track.__playlistIndex)) return;
        if (playlist.name === LIKED_PLAYLIST) {
            await this.togglePreviewLike(playlist.name, track, false);
            return;
        }
        if (!confirm(`Supprimer "${track.title || 'cette musique'}" de la playlist ?`)) return;
        const result = await this.apiFetch('/delete_from_playlist', 'POST', {
            playlist: playlist.name, index: track.__playlistIndex, key: trackLikeKey(track)
        });
        if (!result) return;
        if (this.previewedPlaylist === playlist.name) await this.openPlaylistPreview(playlist);
        await this.fetchAvailablePlaylists();
    },

    resetPlaylistPreview(countLabel = 'Aucune playlist ouverte') {
        this.previewedPlaylist = null;
        if (this.playlistPreviewTitle) this.playlistPreviewTitle.innerText = 'Aperçu';
        if (this.playlistPreviewCount) this.playlistPreviewCount.innerText = countLabel;
        if (this.playlistPreviewList) {
            this.clearTrackPageScrolling(this.playlistPreviewList);
            this.playlistPreviewList.innerHTML = '<li class="playlist-preview-empty">Aucune musique à afficher</li>';
        }
        this.markPreviewedPlaylist('');
    },

    markPreviewedPlaylist(playlistName) {
        const container = document.getElementById('playlists-container');
        if (!container) return;

        container.querySelectorAll('.playlist-selection-item').forEach((item) => {
            item.classList.toggle('is-previewed', item.dataset.playlist === playlistName);
        });
    },

    async openPlaylistPreview(playlist) {
        if (!playlist?.name || !this.playlistPreviewList) return;

        this.previewedPlaylist = playlist.name;
        const title = playlist.title || playlist.name.replace(/\.json$/i, '');
        if (this.playlistPreviewTitle) this.playlistPreviewTitle.innerText = title;
        if (this.playlistPreviewCount) this.playlistPreviewCount.innerText = 'Chargement...';
        this.clearTrackPageScrolling(this.playlistPreviewList);
        this.playlistPreviewList.innerHTML = '<li class="playlist-preview-empty">Chargement...</li>';
        this.markPreviewedPlaylist(playlist.name);

        const tracks = await this.apiFetch(`/playlist_preview?playlist=${encodeURIComponent(playlist.name)}`);
        if (this.previewedPlaylist !== playlist.name) return;
        if (!Array.isArray(tracks)) {
            if (this.playlistPreviewCount) this.playlistPreviewCount.innerText = 'Erreur';
            this.playlistPreviewList.innerHTML = '<li class="playlist-preview-empty">Impossible de charger cette playlist</li>';
            return;
        }

        if (this.previewedPlaylist === playlist.name) {
            if (playlist.name === LIKED_PLAYLIST && !this.likeBusy) {
                this.likesRevision++;
                this.likedKeys = new Set(tracks.map(trackLikeKey));
                this.renderLikeButtons();
            }
            this.renderPlaylistPreview(playlist, tracks);
            if (playlist.name !== LIKED_PLAYLIST) void this.refreshLikes();
        }
    },

    // --- AFFICHAGE DE LA PLAYLIST AVEC LA ROUE (⚙️) ---
    async fetchPlaylist() {
        const revision = ++this.playlistLoadRevision;
        this.playlistTracks = [];
        this.clearTrackPageScrolling(this.playlistContainer);
        this.playlistContainer.innerHTML = "Chargement de la playlist...";

        const data = await this.apiFetch("/playlist");
        if (revision !== this.playlistLoadRevision) return;

        if (!data || !Array.isArray(data)) {
            this.playlistContainer.innerHTML = "Erreur de chargement ou playlist vide.";
            return;
        }

        this.playlistTracks = data.map((item, position) => ({ ...item, __sessionIndex: item.__sessionIndex ?? position }));
        const onlyLikes = this.selectedPlaylists.length === 1 && this.selectedPlaylists[0] === LIKED_PLAYLIST;
        if (onlyLikes && !this.likeBusy) {
            this.likesRevision++;
            this.likedKeys = new Set(data.map(trackLikeKey));
            this.renderLikeButtons();
        }
        this.renderPlaylistTracks();
        if (!onlyLikes) void this.refreshLikes();
        await this.refreshPlaybackState();
        if (revision !== this.playlistLoadRevision) return;
        if (data.length && !this.playerBar.classList.contains('visible')) {
            await this.nextSong();
        }
    },

    renderPlaylistTracks() {
        const search = (this.playlistSearchInput?.value || '').toLowerCase();
        const tracks = this.playlistTracks.filter(item => !search || [item.title, item.artist, item.album]
            .filter(Boolean).join(' ').toLowerCase().includes(search));
        this.renderTrackPages(this.playlistContainer, tracks, item => {
            const index = item.__sessionIndex;
            const li = document.createElement('li');
            li.id = index;
            li.dataset.trackId = index;

            li.className = this.richPlaylistDisplay ? 'playlist-item playlist-item-rich' : 'playlist-item';
            li.dataset.search = [item.title, item.artist, item.album].filter(Boolean).join(' ');
            li.innerHTML = this.playlistItemMarkup(item);
            this.bindQueueSwipe(li, index);
            li.querySelector('.song-like')?.addEventListener('click', event => {
                event.stopPropagation();
                void this.toggleTrackLike({ ...item, __sessionIndex: index });
            });

            // 1. Clic sur le texte => Lance la musique
            const mainArea = li.querySelector('.song-main');
            if (mainArea) {
                mainArea.addEventListener('click', () => this.add_song_playlist(index));
            } else {
                li.querySelector('.song-title').addEventListener('click', () => {
                    this.add_song_playlist(index);
                });
            }

            // 2. Clic sur la roue => Ouvre la popup
            li.querySelector('.song-options').addEventListener('click', (e) => {
                e.stopPropagation(); // Empêche de lancer la musique en cliquant sur la roue
                this.openSongActionMenu(e.currentTarget, {
                    title: item.title,
                    url: item.url,
                    type: item.type,
                    artist: item.artist,
                    album: item.album,
                    id: item.id,
                    albumCoverURL: item.albumCoverURL,
                    trackNumber: item.trackNumber,
                    __playlist: item.__playlist,
                    __playlistIndex: item.__playlistIndex,
                    __queueId: item.__queueId,
                    __sessionIndex: index
                });
            });

            return li;
        });
    },

    async deleteSong(songData) {
        if (!songData.__playlist || !Number.isInteger(songData.__playlistIndex)) {
            this.showNotice("Impossible de supprimer cette musique.");
            return;
        }

        const title = songData.title || "cette musique";
        if (!confirm(`Supprimer "${title}" de la playlist ?`)) {
            return;
        }

        const success = await this.apiFetch("/delete_from_playlist", "POST", {
            playlist: songData.__playlist,
            index: songData.__playlistIndex
        });

        if (!success) {
            this.showNotice("Erreur lors de la suppression.");
            return;
        }

        if (this.currentId === String(songData.__sessionIndex) || this.currentId === songData.__sessionIndex) {
            this.currentId = null;
        }
        await this.fetchPlaylist();
    },

};
