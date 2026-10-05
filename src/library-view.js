import { LIKED_PLAYLIST } from './client-utils.js';
import { orderLibrary } from './library-tools.js';

// Methods share the App receiver so library actions retain the persistent player and queue.
export const libraryView = {
    async fetchAvailablePlaylists() {
        const container = document.getElementById('playlists-container');
        container.innerHTML = 'Chargement des playlists...';
        const userId = this.currentUser?.id;
        this.libraryLoading = true;
        try {
            const [playlistsObject, preferences] = await Promise.all([
                this.apiFetch('/playlist_summaries'), this.apiFetch('/playlist_preferences')
            ]);
            if (userId !== this.currentUser?.id) return;
            if (!playlistsObject) throw new Error('Bibliothèque indisponible');
            this.availablePlaylists = this.playlistEntries(playlistsObject);
            this.libraryPreferences = preferences || { pinned: [], recent: [] };
            const available = new Set(this.availablePlaylists.map((playlist) => playlist.name));
            this.draftPlaylists = new Set([...(this.draftPlaylists || this.selectedPlaylists)].filter((name) => available.has(name)));
            this.renderLibrary();
        } catch {
            container.textContent = 'Impossible de charger les playlists. Réouvre Accueil pour réessayer.';
        } finally {
            this.libraryLoading = false;
        }
    },

    renderLibrary() {
        const container = document.getElementById('playlists-container');
        if (!container) return;
        try {
            this.renderRecentPlaylists();
            const playlists = orderLibrary(this.availablePlaylists, {
                query: document.getElementById('library-search')?.value,
                sort: document.getElementById('library-sort')?.value,
                ...this.libraryPreferences
            });
            if (playlists.length === 0) {
                container.innerHTML = this.availablePlaylists.length
                    ? '<p class="muted">Aucune playlist ne correspond à cette recherche.</p>'
                    : '<p class="muted">Ta bibliothèque est vide. Ajoute des titres depuis YouTube, Spotify ou tes fichiers locaux pour commencer.</p>';
                if (!this.availablePlaylists.length) this.resetPlaylistPreview('Aucune playlist');
                return;
            }

            const ul = document.createElement('ul');

            playlists.forEach((playlist, index) => {
                const countLabel = Number.isInteger(playlist.count)
                    ? `${playlist.count} titre${playlist.count > 1 ? 's' : ''}`
                    : 'Playlist locale';
                const checked = (this.draftPlaylists || new Set(this.selectedPlaylists)).has(playlist.name) ? 'checked' : '';
                const pinned = this.libraryPreferences.pinned.includes(playlist.name);
                const li = document.createElement('li');
                li.className = `playlist-selection-item${checked ? ' is-selected' : ''}`;
                li.dataset.playlist = playlist.name;
                li.innerHTML = `
                    <button type="button" class="playlist-preview-button" data-playlist="${this.escapeHtml(playlist.name)}" aria-label="Voir ${this.escapeHtml(playlist.title)}">
                        ${this.playlistCoverMarkup(playlist)}
                        <span class="playlist-choice-text">
                            <span class="playlist-choice-title">${this.escapeHtml(playlist.title)}</span>
                            <span class="playlist-choice-meta">${this.escapeHtml(countLabel)}</span>
                        </span>
                    </button>
                    <div class="library-row-actions">
                    <button type="button" class="btn-small library-pin" data-playlist="${this.escapeHtml(playlist.name)}" aria-pressed="${pinned}" aria-label="${pinned ? 'Désépingler' : 'Épingler'} ${this.escapeHtml(playlist.title)}" title="${pinned ? 'Désépingler' : 'Épingler'}">${pinned ? '★' : '☆'}</button>
                    <button type="button" class="btn-small library-play" data-playlist="${this.escapeHtml(playlist.name)}" aria-label="Lire ${this.escapeHtml(playlist.title)}" ${playlist.count === 0 ? 'disabled' : ''}>▶</button>
                    <label class="playlist-active-toggle" for="playlist-${index}">
                        <input type="checkbox"
                               name="selectedPlaylists"
                               value="${this.escapeHtml(playlist.name)}"
                               id="playlist-${index}"
                               ${checked}>
                        <span class="playlist-active-label">À lire</span>
                    </label>
                    <button type="button"
                            class="btn-small btn-danger delete-playlist" ${playlist.name === LIKED_PLAYLIST ? 'hidden' : ''}
                            data-playlist="${this.escapeHtml(playlist.name)}"
                            aria-label="Supprimer ${this.escapeHtml(playlist.title)}"
                            title="Supprimer">
                        <span class="delete-playlist-label">Supprimer</span>
                        <span class="delete-playlist-icon" aria-hidden="true">×</span>
                    </button>
                    </div>
                `;
                ul.appendChild(li);
            });

            container.innerHTML = '';
            container.appendChild(ul);
            const playlistByName = new Map(playlists.map((playlist) => [playlist.name, playlist]));
            container.querySelectorAll('.playlist-preview-button').forEach(button => {
                button.addEventListener('click', (e) => {
                    e.preventDefault();
                    this.openPlaylistPreview(playlistByName.get(e.currentTarget.dataset.playlist));
                });
            });
            container.querySelectorAll('input[name="selectedPlaylists"]').forEach(input => {
                input.addEventListener('change', (e) => {
                    this.draftPlaylists ||= new Set(this.selectedPlaylists);
                    if (e.currentTarget.checked) this.draftPlaylists.add(e.currentTarget.value);
                    else this.draftPlaylists.delete(e.currentTarget.value);
                    e.currentTarget
                        .closest('.playlist-selection-item')
                        ?.classList.toggle('is-selected', e.currentTarget.checked);
                });
            });
            container.querySelectorAll('.library-pin').forEach(button => {
                button.onclick = async () => {
                    button.disabled = true;
                    await this.changeLibraryPreference({ action: 'pin', playlist: button.dataset.playlist, enabled: button.getAttribute('aria-pressed') !== 'true' });
                    button.disabled = false;
                };
            });
            container.querySelectorAll('.library-play').forEach(button => {
                button.onclick = () => this.playLibraryPlaylist(button.dataset.playlist);
            });
            container.querySelectorAll('.delete-playlist').forEach(button => {
                button.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this.deletePlaylist(e.currentTarget.dataset.playlist);
                });
            });
            if (this.previewedPlaylist && playlistByName.has(this.previewedPlaylist)) {
                this.markPreviewedPlaylist(this.previewedPlaylist);
            } else if (this.previewedPlaylist) {
                this.resetPlaylistPreview();
            }

        } catch (error) {
            console.error("Erreur playlists:", error);
            container.innerHTML = "Erreur de chargement.";
        }
    },

    renderRecentPlaylists() {
        const section = document.getElementById('library-recent-section');
        const list = document.getElementById('library-recent-list');
        if (!section || !list) return;
        list.replaceChildren();
        for (const name of this.libraryPreferences.recent) {
            const playlist = this.availablePlaylists.find((item) => item.name === name);
            if (!playlist) continue;
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'btn-small';
            button.textContent = `▶ ${playlist.title}`;
            button.setAttribute('aria-label', `Relancer ${playlist.title}`);
            button.disabled = playlist.count === 0;
            button.onclick = () => this.playLibraryPlaylist(name);
            list.appendChild(button);
        }
        section.hidden = !list.childElementCount;
    },

    async changeLibraryPreference(change) {
        const userId = this.currentUser?.id;
        const operation = (this.libraryWritePromise || Promise.resolve()).then(async () => {
            if (userId !== this.currentUser?.id) return;
            const result = await this.apiFetch('/playlist_preferences', 'POST', change);
            if (userId !== this.currentUser?.id) return;
            if (result) {
                this.libraryPreferences = result;
                this.renderLibrary();
            } else this.showNotice('Préférence non enregistrée. Réessaie.', true);
        });
        this.libraryWritePromise = operation.catch(() => {});
        await operation;
    },

    async playLibraryPlaylist(name) {
        if (this.libraryPlayLoading || this.libraryLoading) return;
        const playlist = this.availablePlaylists.find((item) => item.name === name);
        if (!playlist || playlist.count === 0) return;
        this.libraryPlayLoading = true;
        this.sleepTimer?.resume();
        try {
            if (await this.selectLibraryPlaylists([name])) await this.loadView('playlist');
        } finally {
            this.libraryPlayLoading = false;
        }
    },

    async deletePlaylist(playlistName) {
        if (!playlistName) return;
        if (!confirm(`Supprimer la playlist "${playlistName}" ?`)) {
            return;
        }

        const success = await this.apiFetch("/delete_playlist", "POST", { playlist: playlistName });
        if (!success) {
            this.showNotice("Erreur lors de la suppression de la playlist.");
            return;
        }

        if (this.selectedPlaylists.includes(playlistName)) {
            await this.stopSpecialPlayback('playlist_deleted');
            this.selectedPlaylists = this.selectedPlaylists.filter((item) => item !== playlistName);
            this.clearMainAudio();
            this.currentId = null;
            this.lastPlaybackState = null;
            this.renderUpcomingQueue([]);
            if (this.playerBar) this.playerBar.classList.remove('visible');
            this.closeNowPlaying();
        }

        await this.fetchAvailablePlaylists();
        if (document.getElementById('view-playlist').classList.contains('active')) {
            this.clearTrackPageScrolling(this.playlistContainer);
            this.playlistContainer.innerHTML = "Playlist supprimée.";
        }
    },

    async handlePlaylistSubmit(e) {
        e.preventDefault();
        const selectedFiles = this.draftPlaylists ? [...this.draftPlaylists]
            : Array.from(e.target.querySelectorAll('input[name="selectedPlaylists"]:checked')).map(cb => cb.value);
        await this.selectLibraryPlaylists(selectedFiles);
    },

};
