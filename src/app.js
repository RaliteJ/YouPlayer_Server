import { createDiscoveryView } from './discovery-view.js';
import { createPlayerController } from './player-controller.js';
import { playerView } from './player-view.js';
import { createAccountView } from './account-view.js';
import { playlistView } from './playlist-view.js';
import { libraryView } from './library-view.js';
import { bindQueueSwipe } from './track-gestures.js';
import {
	publicErrorMessage,
	LIKED_PLAYLIST,
	trackLikeKey,
	escapeHtml as escapeHtmlValue
} from './client-utils.js';
import { createSpotifyExplorer } from './spotify-explorer.js';
import { installAndroidPlayer } from './android-player.js';
import { audioDiagnostics } from './audio-diagnostics.js';
import { AudioCrossfade } from './audio-crossfade.js';
import { rediscoverPlaylist, SleepTimer } from './library-tools.js';

const API_URL = window.location.origin;

const AUDIO_BACKGROUND_DEBUG = (() => {
    const queryValue = new URLSearchParams(window.location.search).get('audioDebug');
    if (queryValue !== null) return ['1', 'true', 'on'].includes(queryValue.toLowerCase());
    try {
        return window.localStorage.getItem('audioBackgroundDebug') === '1';
    } catch {
        return false;
    }
})();

const App = {
    ...audioDiagnostics,
    ...playerView,
    ...createPlayerController({ apiUrl: API_URL }),
    ...createDiscoveryView({ apiUrl: API_URL }),
    ...libraryView,
    ...playlistView,
    ...createAccountView({ apiUrl: API_URL }),
    currentId: null,
    selectedPlaylists: [],
    songPendingAdd: null, // Mémorise la musique à ajouter via la modale
    wakeLock: null,
    richPlaylistDisplay: false,
    controlledPlayback: false,
    controlledPlaybackUser: null,
    songActionMenu: null,
    spotifyActionMenu: null,
    lastPlaybackState: null,
    nextSongLoading: false,
    nextTrackPrefetch: null,
    nextTrackPrefetchPromise: null,
    prefetchGeneration: 0,
    pendingPrefetchedTransitions: [],
    prefetchedTransitionSyncPromise: null,
    userPausedAudio: false,
    queueDrawerOpen: false,
    nowPlayingOpen: false,
    previousSongLoading: false,
    queueEditPromise: null,
    repeatTrack: false,
    currentUser: null,
    availablePlaylists: [],
    libraryPreferences: { pinned: [], recent: [] },
    draftPlaylists: null,
    libraryWritePromise: null,
    libraryLoading: false,
    libraryPlayLoading: false,
    authEnabled: true,
    previewedPlaylist: null,
    playlistTracks: [],
    playlistLoadRevision: 0,
    lastApiError: null,
    likedKeys: new Set(),
    likeBusy: false,
    likesRevision: 0,
    noticeTimer: null,
    spotifyExplorer: null,
    spotifyOAuthEnabled: false,
    currentSpecialStream: null,
    suppressSpecialPlayerEvents: false,
    suppressMainPlayerEvents: false,
    audioEventsBound: false,
    mediaSessionInitialized: false,
    lastPositionStateSecond: -1,
    mobileHeaderCondensed: false,
    consecutivePlaybackErrors: 0,
    handledPlaybackErrorKey: null,
    audioBackgroundDebug: AUDIO_BACKGROUND_DEBUG,
    audioDiagnosticsBound: false,
    pageDiagnosticsBound: false,
    heartbeatTimer: null,
    audioDiagnosticRequestSequence: 0,
    audioDiagnosticEntries: [],
    lastPlayRejection: null,
    lastPauseRequest: null,
    recentBackgroundAutoStart: null,
    playerState: {
        currentTrack: null,
        queue: [],
        currentIndex: null,
        playing: false,
        loading: false,
        currentTime: 0,
        duration: 0,
        nextTrack: null
    },

    async init() {
        this.cacheDOM();
        this.initLibraryControls();
        this.initAudioDiagnostics();
        this.bindEvents();
        await this.refreshAuthProviders();
        const authenticated = await this.refreshAuth();
        if (authenticated) {
            const redirectView = this.handleSpotifyRedirectNotice();
            this.loadView(this.currentUser?.role === 'admin' ? 'admin' : redirectView || 'accueil');
        }
    },

    cacheDOM() {
        this.authScreen = document.getElementById('auth-screen');
        this.appNotice = document.getElementById('app-notice');
        this.loginForm = document.getElementById('login-form');
        this.loginPseudo = document.getElementById('login-pseudo') || document.getElementById('login-email');
        this.loginPassword = document.getElementById('login-password');
        this.loginError = document.getElementById('login-error');
        this.spotifyLoginButton = document.getElementById('spotify-login-button');
        this.sessionUser = document.getElementById('session-user');
        this.logoutButton = document.getElementById('logout-button');
        this.adminNav = document.querySelector('.nav-admin');
        this.adminCreateUserForm = document.getElementById('admin-create-user');
        this.adminUpdateStatus = document.getElementById('admin-update-status');
        this.adminUpdateVersions = document.getElementById('admin-update-versions');
        this.adminUpdateCheck = document.getElementById('admin-update-check');
        this.adminUpdateInstall = document.getElementById('admin-update-install');
        this.adminIntegrationCheck = document.getElementById('admin-integrations-check');
        this.passwordChangeForm = document.getElementById('password-change-form');
        this.passwordChangeMessage = document.getElementById('password-change-message');
        this.spotifySettingsStatus = document.getElementById('spotify-settings-status');
        this.spotifySettingsConnect = document.getElementById('spotify-settings-connect');
        this.spotifySettingsDisconnect = document.getElementById('spotify-settings-disconnect');
        this.spotifyConnectPanel = document.getElementById('spotify-connect-panel');
        this.spotifyConnectTitle = document.getElementById('spotify-connect-title');
        this.spotifyConnectCopy = document.getElementById('spotify-connect-copy');
        this.spotifyConnectStatus = document.getElementById('spotify-connect-status');
        this.spotifyConnectButton = document.getElementById('spotify-connect-button');
        this.spotifyDisconnectButton = document.getElementById('spotify-disconnect-button');
        this.spotifyExplorerRoot = document.getElementById('spotify-explorer');
        this.adminUsers = document.getElementById('admin-users');
        this.adminLoginEvents = document.getElementById('admin-login-events');
        this.adminAuditLogs = document.getElementById('admin-audit-logs');
        this.lecteur = document.getElementById('lecteur');
        // Le flux spécial et les fichiers suivants partagent volontairement le
        // même HTMLAudioElement afin de conserver une seule session média Android.
        this.specialPlayer = this.lecteur;
        if (!window.YouPlayerNative?.postMessage) {
            this.crossfade = new AudioCrossfade(this.lecteur);
            const setting = document.getElementById('crossfade-duration');
            const value = document.getElementById('crossfade-duration-value');
            try {
                const stored = localStorage.getItem('crossfade-duration');
                this.crossfade.setDuration(stored ?? (localStorage.getItem('crossfade-enabled') === 'false' ? 0 : 3));
            } catch {}
            const renderDuration = () => {
                setting.value = String(this.crossfade.duration);
                value.textContent = this.crossfade.duration === 0 ? 'Désactivé (0 s)' : `${this.crossfade.duration} s`;
                setting.setAttribute('aria-valuetext', value.textContent);
            };
            renderDuration();
            setting.addEventListener('input', () => {
                this.crossfade.setDuration(setting.value);
                renderDuration();
                try { localStorage.setItem('crossfade-duration', String(this.crossfade.duration)); } catch {}
            });
            setting.addEventListener('change', () => {
                void this.prepareCrossfade();
            });
            // AudioContext activation must follow a real user gesture.
            document.addEventListener('pointerdown', () => void this.prepareCrossfade());
            document.addEventListener('keydown', () => void this.prepareCrossfade());
        } else {
            document.getElementById('crossfade-setting').hidden = true;
        }
        this.songTitle = document.getElementById('actual_song');
        this.songArtist = document.getElementById('actual_artist');
        this.playerArtwork = document.getElementById('player-artwork');
        this.miniPlayerOpen = document.getElementById('miniPlayerOpen');
        this.miniPlayPause = document.getElementById('miniPlayPause');
        this.nowPlayingOverlay = document.getElementById('now-playing-overlay');
        this.nowPlayingClose = document.getElementById('nowPlayingClose');
        this.overlayArtwork = document.getElementById('overlay-artwork');
        this.overlayTitle = document.getElementById('overlay-title');
        this.overlayArtist = document.getElementById('overlay-artist');
        this.overlayContext = document.getElementById('overlay-context');
        this.overlayPlayPause = document.getElementById('overlayPlayPause');
        this.overlayLike = document.getElementById('overlayLike');
        this.playerSeek = document.getElementById('playerSeek');
        this.playerCurrentTime = document.getElementById('playerCurrentTime');
        this.playerDuration = document.getElementById('playerDuration');
        this.playlistContainer = document.getElementById('playlist-list');
        this.ytResults = document.getElementById('results-yt');
        this.views = document.querySelectorAll('.view');
        this.viewsContainer = document.querySelector('.views-container');
        this.navLinks = document.querySelectorAll('.nav-link');
        this.playerBar = document.querySelector('.player-controls');
        this.miniPlayerProgress = document.getElementById('miniPlayerProgress');
        this.fileInput = document.getElementById('fileInput');
        this.richPlaylistToggle = document.getElementById('rich-playlist-display');
        this.controlledPlaybackToggle = document.getElementById('controlled-playback');

        // --- Éléments de la popup (Modale) ---
        this.modal = document.getElementById('playlist-modal');
        this.modalSelect = document.getElementById('modal-playlist-select');
        this.modalInputNew = document.getElementById('modal-new-playlist');
        this.modalLocalMetadata = document.getElementById('modal-local-metadata');
        this.modalLocalTitle = document.getElementById('modal-local-title');
        this.modalLocalArtist = document.getElementById('modal-local-artist');
        this.modalLocalArtwork = document.getElementById('modal-local-artwork');
        this.playlistSearchInput = document.getElementById('playlist-search');
        this.playlistPreviewTitle = document.getElementById('playlist-preview-title');
        this.playlistPreviewCount = document.getElementById('playlist-preview-count');
        this.playlistPreviewList = document.getElementById('playlist-preview-list');
        this.upcomingContainer = document.getElementById('upcoming-list');
        this.upcomingCount = document.getElementById('upcoming-count');
        this.upcomingContainers = [
            document.getElementById('upcoming-list'),
            document.getElementById('queue-drawer-list')
        ].filter(Boolean);
        this.upcomingCounts = [
            document.getElementById('upcoming-count'),
            document.getElementById('queue-drawer-count')
        ].filter(Boolean);
        this.queueDrawer = document.getElementById('queue-drawer');
        this.queueOverlay = document.getElementById('queue-drawer-overlay');
        this.queueToggleButton = document.getElementById('queueToggleBtn');
        this.queueCloseButton = document.getElementById('queueCloseBtn');
    },

    initLibraryControls() {
        document.getElementById('library-search')?.addEventListener('input', () => this.renderLibrary());
        document.getElementById('library-sort')?.addEventListener('change', () => this.renderLibrary());
        document.getElementById('library-clear-recent')?.addEventListener('click', () => this.changeLibraryPreference({ action: 'clear_recent' }));
        document.getElementById('library-rediscover')?.addEventListener('click', () => {
            const playlist = rediscoverPlaylist(this.availablePlaylists, this.libraryPreferences.recent);
            if (playlist) void this.playLibraryPlaylist(playlist.name);
            else this.showNotice('Ajoute des titres à une playlist pour commencer.');
        });
        const timerControls = document.getElementById('sleep-timer-controls');
        if (window.YouPlayerNative?.postMessage) {
            if (timerControls) timerControls.hidden = true;
            return;
        }
        this.sleepTimer = new SleepTimer({
            onExpire: () => {
                this.crossfade?.cancel();
                this.pauseAudioWithDiagnostics(this.activeAudioPlayer(), 'sleep-timer');
                this.userPausedAudio = true;
                this.showNotice('Minuterie terminée. La lecture est en pause.');
            },
            onChange: () => {
                const status = document.getElementById('sleep-timer-status');
                if (status) status.textContent = this.sleepTimer?.deadline
                    ? `Arrêt à ${new Date(this.sleepTimer.deadline).toLocaleTimeString('fr', { hour: '2-digit', minute: '2-digit' })}`
                    : this.sleepTimer?.expired ? 'Lecture arrêtée' : '';
                if (!this.sleepTimer?.deadline) document.getElementById('sleep-timer').value = '0';
            }
        });
        document.getElementById('sleep-timer')?.addEventListener('change', (event) => {
            const minutes = Number(event.target.value);
            this.sleepTimer.set(minutes);
            event.target.value = String(minutes);
        });
    },

    bindEvents() {
        this.bindPageDiagnostics();
        this.bindAdminTabs();
        if (this.loginForm) {
            this.loginForm.onsubmit = (e) => this.handleLogin(e);
        }
        if (this.spotifyLoginButton) {
            this.spotifyLoginButton.onclick = () => this.connectSpotify();
        }
        if (this.logoutButton) {
            this.logoutButton.onclick = () => this.logout();
        }
        if (this.spotifySettingsConnect) {
            this.spotifySettingsConnect.onclick = () => this.connectSpotify();
        }
        if (this.spotifySettingsDisconnect) {
            this.spotifySettingsDisconnect.onclick = () => this.disconnectSpotify();
        }
        if (this.spotifyConnectButton) {
            this.spotifyConnectButton.onclick = () => this.connectSpotify();
        }
        if (this.spotifyDisconnectButton) {
            this.spotifyDisconnectButton.onclick = () => this.disconnectSpotify();
        }
        if (this.adminCreateUserForm) {
            this.adminCreateUserForm.onsubmit = (e) => this.createAdminUser(e);
        }
        if (this.adminUpdateCheck) this.adminUpdateCheck.onclick = () => this.startAppUpdate('check');
        if (this.adminUpdateInstall) this.adminUpdateInstall.onclick = () => this.startAppUpdate('install');
        if (this.adminIntegrationCheck) this.adminIntegrationCheck.onclick = () => this.checkIntegrations();
        if (this.passwordChangeForm) {
            this.passwordChangeForm.onsubmit = (e) => this.changeOwnPassword(e);
        }

        // Navigation
        this.navLinks.forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                this.loadView(link.dataset.view);
            });
        });

        if (this.viewsContainer) {
            this.viewsContainer.addEventListener('scroll', () => this.updateMobileHeader(), { passive: true });
            window.addEventListener('resize', () => this.updateMobileHeader());
        }

        // Contrôles Audio
        document.getElementById('next').onclick = () => this.advanceToNextSong('manual');
        document.getElementById('prev').onclick = () => this.previousTrack();
        document.getElementById('reloadBtn').onclick = () => this.setRepeatMode(!this.repeatTrack);
        this.miniPlayerOpen?.addEventListener('click', () => this.openNowPlaying());
        this.nowPlayingClose?.addEventListener('click', () => this.closeNowPlaying());
        this.bindNowPlayingSwipeToClose();
        this.miniPlayPause?.addEventListener('click', () => this.togglePlayback());
        this.overlayPlayPause?.addEventListener('click', () => this.togglePlayback());
        this.playerSeek?.addEventListener('input', (e) => this.seekPlayer(Number(e.target.value)));

        // Options
        document.getElementById('shuffle-mode').onchange = (e) => this.setShuffleMode(e.target.checked);
        this.overlayLike?.addEventListener('click', () => {
            const track = this.playerState.currentTrack;
            if (track) void this.toggleTrackLike({ ...track, __sessionIndex: Number(this.currentId) });
        });
        document.getElementById('overlayShuffle').onclick = () =>
            this.setShuffleMode(!document.getElementById('shuffle-mode').checked);

        if (this.queueToggleButton) {
            this.queueToggleButton.onclick = () => this.toggleQueueDrawer();
        }
        if (this.queueCloseButton) {
            this.queueCloseButton.onclick = () => this.closeQueueDrawer();
        }
        if (this.queueOverlay) {
            this.queueOverlay.onclick = () => this.closeQueueDrawer();
        }

        // Formulaire Playlists
        document.getElementById('playlist-selection-form').onsubmit = (e) => this.handlePlaylistSubmit(e);

        if (this.richPlaylistToggle) {
            const storedPreference = localStorage.getItem('richPlaylistDisplay');
            this.richPlaylistDisplay = storedPreference === null || storedPreference === 'true';
            this.richPlaylistToggle.checked = this.richPlaylistDisplay;
            this.richPlaylistToggle.onchange = (e) => {
                this.richPlaylistDisplay = e.target.checked;
                localStorage.setItem('richPlaylistDisplay', String(this.richPlaylistDisplay));
                if (document.getElementById('view-playlist').classList.contains('active')) {
                    this.fetchPlaylist();
                }
            };
        }

        if (this.controlledPlaybackToggle) {
            this.controlledPlaybackToggle.onchange = event => {
                this.controlledPlayback = event.target.checked;
                try {
                    window.localStorage.setItem(`controlledPlayback:${this.currentUser?.id ?? 'local'}`, String(this.controlledPlayback));
                } catch { /* The option still works for this session. */ }
            };
        }

        // Recherches
        document.getElementById('btn-search-yt').onclick = () => this.searchYoutube();
        const legacySpotifySearchButton = document.getElementById('btn-search-spotify');
        if (legacySpotifySearchButton) {
            legacySpotifySearchButton.onclick = () => this.searchSpotify();
        }
        const spotifyPlaylistActionsButton = document.getElementById('btn-spotify-playlist-actions');
        if (spotifyPlaylistActionsButton) {
            spotifyPlaylistActionsButton.onclick = (e) => {
                e.stopPropagation();
                this.openSpotifyActionMenu(e.currentTarget);
            };
        }
        if (this.spotifyExplorerRoot) {
            this.spotifyExplorer = createSpotifyExplorer({
                root: this.spotifyExplorerRoot,
                apiFetch: (endpoint, method, body) => this.apiFetch(endpoint, method, body),
                apiErrorMessage: (fallback) => this.apiErrorMessage(fallback),
                escapeHtml: (value) => this.escapeHtml(value),
                playlistEntries: (playlists) => this.playlistEntries(playlists),
                openAddModal: (track) => this.openAddModal(track),
                playTrack: (track, context = {}) => this.enqueueNextSong(track, { playNow: true, ...context }),
                playCollection: (collection, collectionIndex = 0) => this.enqueueNextSong(collection[collectionIndex], { playNow: true, collection, collectionIndex }),
                isControlledPlayback: () => this.controlledPlayback,
                queueTrack: (track) => this.enqueueNextSong(track),
                bindQueueSwipe: (row, track) => this.bindQueueSwipe(row, track),
                toggleLike: (track) => this.toggleDiscoveredTrackLike(track),
                likeButtonMarkup: (track) => this.likeButtonMarkup(track),
                renderLikeButtons: () => this.renderLikeButtons(),
                showNotice: (message, isError = false) => this.showNotice(message, isError),
                getCurrentUser: () => this.currentUser
            });
            this.spotifyExplorer.init();
        }
        this.bindAudioEvents();

        // Fichier local : au lieu d'uploader, on ouvre la modale avec le fichier en mémoire !
        if (this.fileInput) {
            this.fileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    const cleanTitle = file.name.replace(/\.[^/.]+$/, "");

                    this.openAddModal({
                        title: cleanTitle,
                        file: file, // ⬅️ On sauvegarde le VRAI fichier ici !
                        type: "local"
                    });
                }
            });
        }

        // --- Événements de la Popup ---
        if (this.modal) {
            // Bouton "Annuler"
            document.getElementById('btn-modal-close').onclick = () => {
                this.modal.style.display = 'none';
                this.songPendingAdd = null;
            };

            // Bouton "Ajouter à celle-ci"
            document.getElementById('btn-modal-add-existing').onclick = () => {
                const playlistName = this.modalSelect.value;
                if (playlistName) this.confirmAddSong(playlistName);
                else this.showNotice("Veuillez sélectionner une playlist.");
            };

            // Bouton "Créer & Ajouter"
            document.getElementById('btn-modal-create-add').onclick = () => {
                const newName = this.modalInputNew.value.trim();
                if (newName) this.confirmAddSong(newName);
                else this.showNotice("Veuillez entrer un nom.");
            };
        }
        if (this.playlistSearchInput) {
            this.playlistSearchInput.addEventListener('input', () => this.renderPlaylistTracks());
        }

        document.addEventListener('click', () => {
            this.closeSongActionMenu();
            this.closeSpotifyActionMenu();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                if (this.queueDrawerOpen) this.closeQueueDrawer();
                else this.closeNowPlaying();
            }
        });

        document.addEventListener('visibilitychange', () => {
            this.sleepTimer?.check();
            this.logPageDiagnostic('visibilitychange');
            console.debug('[Player] background:', document.hidden);
            if (!document.hidden) {
                void this.reconcilePlaybackAfterWake();
            }
        });

        window.addEventListener('focus', () => {
            this.logPageDiagnostic('focus');
            void this.reconcilePlaybackAfterWake();
        });
    },

    escapeHtml(value) {
        return escapeHtmlValue(value);
    },

    likeButtonMarkup(track) {
        const key = trackLikeKey(track);
        const liked = this.likedKeys.has(key);
        return `<button type="button" class="song-like" data-like-key="${this.escapeHtml(key)}"
            aria-pressed="${liked}" aria-label="${liked ? 'Retirer des likes' : 'Aimer ce morceau'}"
            title="${liked ? 'Retirer des likes' : 'Aimer ce morceau'}" ${!key ? 'disabled' : ''}>${liked ? '♥' : '♡'}</button>`;
    },

    renderLikeButtons() {
        if (this.overlayLike) this.overlayLike.dataset.likeKey = trackLikeKey(this.playerState.currentTrack);
        document.querySelectorAll?.('[data-like-key]').forEach(button => {
            const key = button.dataset.likeKey;
            const liked = this.likedKeys.has(key);
            button.textContent = liked ? '♥' : '♡';
            button.setAttribute('aria-pressed', String(liked));
            button.setAttribute('aria-label', liked ? 'Retirer des likes' : 'Aimer ce morceau');
            button.title = liked ? 'Retirer des likes' : 'Aimer ce morceau';
            button.disabled = !key || this.likeBusy;
        });
    },

    async refreshLikes() {
        const userId = this.currentUser?.id;
        const revision = this.likesRevision;
        try {
            const response = await fetch(`${API_URL}/liked_tracks`, {
                credentials: 'include', signal: globalThis.AbortSignal?.timeout?.(8000)
            });
            if (!response.ok) return;
            const data = await response.json();
            if (userId !== this.currentUser?.id || revision !== this.likesRevision || this.likeBusy) return;
            this.likedKeys = new Set((data.items || []).map(trackLikeKey));
            this.renderLikeButtons();
        } catch { /* Keep the last known state when disconnected. */ }
    },

    async toggleTrackLike(track) {
        const key = trackLikeKey(track);
        if (!key || this.likeBusy || !Number.isInteger(track.__sessionIndex)) return;
        const userId = this.currentUser?.id;
        this.likeBusy = true;
        this.likesRevision++;
        this.renderLikeButtons();
        try {
            const data = await this.apiFetch('/liked_tracks', 'POST', {
                trackId: track.__sessionIndex, key, liked: !this.likedKeys.has(key)
            });
            if (!data || userId !== this.currentUser?.id) return;
            this.likedKeys = new Set(data.items.map(trackLikeKey));
            const summary = this.availablePlaylists.find(item => item.name === LIKED_PLAYLIST);
            if (summary) summary.count = data.items.length;
            if (this.selectedPlaylists.includes(LIKED_PLAYLIST)
                && document.getElementById('view-playlist')?.classList.contains('active')) {
                await this.fetchPlaylist();
            }
        } finally {
            this.likeBusy = false;
            this.renderLikeButtons();
        }
    },

    async toggleDiscoveredTrackLike(track) {
        const key = trackLikeKey(track);
        if (!key || this.likeBusy) return;
        const userId = this.currentUser?.id;
        this.likeBusy = true;
        this.likesRevision++;
        this.renderLikeButtons();
        try {
            const data = await this.apiFetch('/liked_tracks', 'POST', {
                song: track, key, liked: !this.likedKeys.has(key)
            });
            if (!data?.items || userId !== this.currentUser?.id) return;
            this.likedKeys = new Set(data.items.map(trackLikeKey));
            const summary = this.availablePlaylists.find(item => item.name === LIKED_PLAYLIST);
            if (summary) summary.count = data.items.length;
        } finally {
            this.likeBusy = false;
            this.renderLikeButtons();
        }
    },

    showNotice(message, isError = false) {
        if (!this.appNotice || !message) return;
        clearTimeout(this.noticeTimer);
        this.appNotice.innerText = message;
        this.appNotice.classList.toggle('is-error', isError);
        this.appNotice.hidden = false;
        this.noticeTimer = setTimeout(() => {
            this.appNotice.hidden = true;
        }, isError ? 7000 : 3500);
    },

    apiErrorMessage(fallback = 'Action impossible.') {
        return publicErrorMessage(this.lastApiError?.status, fallback);
    },

    async responseErrorMessage(response, fallback = 'Action impossible.') {
        return publicErrorMessage(response.status, fallback);
    },

    updateMobileHeader(forceExpanded = false) {
        const isMobile = window.matchMedia('(max-width: 768px)').matches;
        const shouldCondense = !forceExpanded
            && isMobile
            && (this.viewsContainer?.scrollTop || 0) > 28;

        if (shouldCondense === this.mobileHeaderCondensed) return;
        this.mobileHeaderCondensed = shouldCondense;
        document.body.classList.toggle('mobile-header-condensed', shouldCondense);
    },

    loadView(viewName) {
        if (this.currentUser?.role === 'admin' && !['admin', 'parametres'].includes(viewName)) {
            viewName = 'admin';
        }
        if (viewName === 'admin' && this.currentUser?.role !== 'admin') {
            viewName = 'accueil';
        }

        this.views.forEach(v => v.classList.remove('active'));
        this.navLinks.forEach(l => l.classList.remove('active'));

        document.getElementById(`view-${viewName}`)?.classList.add('active');
        document.querySelector(`[data-view="${viewName}"]`)?.classList.add('active');

        if (this.viewsContainer) this.viewsContainer.scrollTop = 0;
        this.updateMobileHeader(true);

        if (viewName === 'playlist') return this.fetchPlaylist();
        if (viewName === 'accueil') this.fetchAvailablePlaylists();
        if (viewName === 'admin') this.fetchAdminData();
        if (viewName === 'add_spotify') this.spotifyExplorer?.activate();
		if (viewName === 'parametres' && this.currentUser?.role !== 'admin') this.spotifyExplorer?.refreshConnection();
    },

    // --- APPELS API ---
    async apiFetch(endpoint, method = 'GET', body = null) {
        this.lastApiError = null;
        const options = { method, credentials: 'include' };
        const diagnosticRequest = this.isPlaybackDiagnosticEndpoint(endpoint);
        const requestId = diagnosticRequest
            ? `audio-${++this.audioDiagnosticRequestSequence}`
            : null;
        const requestStartedAt = Date.now();
        if (body) {
            options.headers = { "Content-Type": "application/json" };
            options.body = JSON.stringify(body);
        }
        if (diagnosticRequest) {
            this.logNextDiagnostic('REQUEST_START', {
                requestId,
                endpoint,
                method
            });
        }

        try {
            const response = await fetch(`${API_URL}${endpoint}`, options);
            if (response.status === 401) {
                this.lastApiError = { status: 401 };
                if (diagnosticRequest) {
                    this.logNextDiagnostic('REQUEST_ERROR', {
                        requestId,
                        endpoint,
                        method,
                        status: response.status,
                        elapsedMs: Date.now() - requestStartedAt,
                        message: 'Authentication required'
                    }, true);
                }
                this.currentUser = null;
                this.showAuth();
                return null;
            }

            if (!response.ok) {
                const message = publicErrorMessage(response.status);
                if (diagnosticRequest) {
                    this.logNextDiagnostic('REQUEST_ERROR', {
                        requestId,
                        endpoint,
                        method,
                        status: response.status,
                        elapsedMs: Date.now() - requestStartedAt,
                        message
                    }, true);
                }
                this.lastApiError = { status: response.status, message };
                this.showNotice(message, true);
                return null;
            }

            const contentType = response.headers.get("content-type");
            const data = contentType && contentType.includes("application/json")
                ? await response.json()
                : await response.text();

            if (diagnosticRequest) {
                this.logNextDiagnostic('REQUEST_SUCCESS', {
                    requestId,
                    endpoint,
                    method,
                    status: response.status,
                    elapsedMs: Date.now() - requestStartedAt
                });
            }
            return data;
        } catch (error) {
            if (diagnosticRequest) {
                this.logNextDiagnostic('REQUEST_ERROR', {
                    requestId,
                    endpoint,
                    method,
                    elapsedMs: Date.now() - requestStartedAt,
                    name: error?.name || 'Error',
                    message: error?.message || String(error)
                }, true);
            }
            console.error(`Erreur réseau sur ${endpoint}:`, error);
            this.lastApiError = { status: 0 };
            this.showNotice(publicErrorMessage(0), true);
            return null;
        }
    },

    bindQueueSwipe,


};

export { App };

// Lancement
document.addEventListener('DOMContentLoaded', () => {
    installAndroidPlayer(App);
    void App.init();
});
