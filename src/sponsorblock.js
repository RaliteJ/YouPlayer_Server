import { trackLikeKey } from './client-utils.js';

export const sponsorBlockView = {
    initSponsorBlock() {
        this.sponsorBlockToggle = document.getElementById('sponsorblock-enabled');
        this.sponsorBlockTrackControl = document.getElementById('sponsorblock-track-control');
        this.sponsorBlockTrackToggle = document.getElementById('sponsorblock-track-enabled');
        this.sponsorBlockStatus = document.getElementById('sponsorblock-status');
        this.sponsorBlockToggle?.addEventListener('change', () => {
            this.sponsorBlockEnabled = this.sponsorBlockToggle.checked;
            try { window.localStorage.setItem(`sponsorblock:${this.sponsorBlockUser}`, String(this.sponsorBlockEnabled)); } catch {}
            this.sponsorBlockRequest = null;
            void this.refreshSponsorBlock();
        });
        this.sponsorBlockTrackToggle?.addEventListener('change', () => {
            this.sponsorBlockTrackDisabled = !this.sponsorBlockTrackToggle.checked;
            this.renderSponsorBlockStatus();
        });
    },

    loadSponsorBlockPreference() {
        const user = this.currentUser?.id ?? 'local';
        if (this.sponsorBlockUser === user) return;
        this.sponsorBlockUser = user;
        this.sponsorBlockEnabled = false;
        const supported = !(window.YouPlayerNative?.postMessage && window.top === window);
        if (supported && this.currentUser?.role !== 'admin') {
            try { this.sponsorBlockEnabled = window.localStorage.getItem(`sponsorblock:${user}`) === 'true'; } catch {}
        }
        if (this.sponsorBlockToggle) {
            this.sponsorBlockToggle.checked = this.sponsorBlockEnabled;
            this.sponsorBlockToggle.disabled = !supported || this.currentUser?.role === 'admin';
        }
        this.sponsorBlockRequest = null;
        void this.refreshSponsorBlock();
    },

    async refreshSponsorBlock() {
        const track = this.playerState.currentTrack;
        const key = trackLikeKey(track);
        const identity = `${this.sponsorBlockUser}:${this.currentId}:${key}`;
        if (identity !== this.sponsorBlockIdentity) {
            this.sponsorBlockIdentity = identity;
            this.sponsorBlockTrackDisabled = false;
            if (this.sponsorBlockTrackToggle) this.sponsorBlockTrackToggle.checked = true;
            this.sponsorBlockRequest = null;
        }
        const eligible = this.sponsorBlockEnabled && track?.type === 'youtube' && /^\d+$/.test(this.currentId);
        if (this.sponsorBlockTrackControl) this.sponsorBlockTrackControl.hidden = !eligible;
        if (this.sponsorBlockRequest) return;
        this.sponsorBlockSegments = [];
        this.sponsorBlockAvailable = null;
        if (!eligible) return;
        const request = this.sponsorBlockRequest = {};
        this.renderSponsorBlockStatus();
        let response;
        try {
            response = await this.apiFetch(`/sponsorblock?trackId=${this.currentId}&key=${encodeURIComponent(key)}`);
        } catch {}
        if (this.sponsorBlockRequest !== request || !this.sponsorBlockEnabled) return;
        this.sponsorBlockAvailable = response?.available === true && response.key === key;
        this.sponsorBlockSegments = this.sponsorBlockAvailable && Array.isArray(response.segments) ? response.segments : [];
        this.renderSponsorBlockStatus();
    },

    renderSponsorBlockStatus(message) {
        if (!this.sponsorBlockStatus) return;
        this.sponsorBlockStatus.textContent = message || (this.sponsorBlockTrackDisabled ? 'Sauts désactivés pour ce titre.'
            : this.sponsorBlockAvailable === null ? 'Recherche des passages non musicaux…'
            : !this.sponsorBlockAvailable ? 'SponsorBlock indisponible. Lecture intégrale.'
            : !this.sponsorBlockSegments?.length ? 'Aucun passage signalé pour ce titre.'
            : 'Passages non musicaux signalés : sauts activés.');
    },

    skipNonMusic() {
        const audio = this.activeAudioPlayer();
        if (!this.sponsorBlockEnabled || this.sponsorBlockTrackDisabled || !this.sponsorBlockSegments?.length
            || !audio || audio.paused || audio.ended || audio.seeking || this.nextSongLoading
            || this.queueEditPromise || this.restoringPlayback) return false;
        // Never apply a new track's markers to the source still being replaced.
        const expected = this.currentSpecialStream?.audioUrl || `/play/${this.currentId}`;
        try {
            if (new URL(audio.currentSrc).pathname !== expected || audio.currentSrc !== audio.src) return false;
        } catch { return false; }
        const offset = this.currentSpecialStream?.startPosition || 0;
        const duration = audio.duration + offset;
        if (!Number.isFinite(duration) || !audio.seekable?.length) {
            this.renderSponsorBlockStatus('Ce flux ne permet pas encore les sauts. Lecture intégrale.');
            return false;
        }
        const segments = this.sponsorBlockSegments.filter(segment =>
            Number.isFinite(segment.start) && Number.isFinite(segment.end) && Number.isFinite(segment.duration)
            && segment.start >= 0 && segment.end > segment.start && segment.end <= segment.duration
            && Math.abs(segment.duration - duration) <= 2);
        if (!segments.length) {
            this.renderSponsorBlockStatus('Durée différente des repères : lecture intégrale.');
            return false;
        }
        const position = audio.currentTime + offset;
        let target = position;
        for (const segment of segments) {
            if (target >= segment.start && target < segment.end) target = segment.end;
        }
        if (target === position) return false;
        const seek = Math.min(target - offset, audio.duration);
        const reachable = Array.from({ length: audio.seekable.length }, (_, i) => i)
            .some(i => seek >= audio.seekable.start(i) && seek <= audio.seekable.end(i) + 0.05);
        if (!reachable) {
            this.renderSponsorBlockStatus('Passage suivant encore en chargement.');
            return false;
        }
        try {
            this.seekPlayer(target);
            this.savePlaybackPosition(true);
            this.renderSponsorBlockStatus('Passage non musical sauté. Décoche pour écouter ce titre en entier.');
            return true;
        } catch { return false; }
    }
};
