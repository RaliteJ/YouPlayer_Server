// Only the active element's native `ended` advances the queue.
export class AudioCrossfade {
    constructor(audio) {
        this.audio = audio;
        this.nextAudio = audio.cloneNode(false);
        this.nextAudio.id = 'lecteur-next';
        this.nextAudio.removeAttribute('src');
        audio.after(this.nextAudio);
        this.enabled = true;
        this.duration = 5;
        for (const element of [audio, this.nextAudio]) {
            for (const event of ['pause', 'seeking', 'waiting', 'error', 'ended']) {
                element.addEventListener(event, () => {
                    if (element === this.audio) {
                        if (event !== 'ended' && (event !== 'pause' || !element.ended)) this.cancel();
                    } else if (event === 'error' || event === 'waiting' || event === 'ended') {
                        this.cancel();
                        if (event === 'error') this.prepared = null;
                    }
                });
            }
            element.addEventListener('volumechange', () => {
                if (element === this.audio) this.updateVolume();
            });
        }
    }

    setDuration(value) {
        const seconds = Number(value);
        const duration = Number.isFinite(seconds) ? Math.max(0, Math.min(10, Math.round(seconds))) : 5;
        if (duration !== this.duration || this.enabled !== (duration > 0)) this.clear();
        this.duration = duration;
        this.enabled = duration > 0;
    }

    async unlock() {
        if (!this.enabled) return;
        const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Context) return;
        try {
            this.context ||= new Context();
            await this.context.resume();
            if (this.context.state !== 'running' || this.mainSource) return;
            this.mainGain = this.context.createGain();
            this.nextGain = this.context.createGain();
            this.mainSource = this.context.createMediaElementSource(this.audio);
            this.nextSource = this.context.createMediaElementSource(this.nextAudio);
            this.mainSource.connect(this.mainGain).connect(this.context.destination);
            this.nextSource.connect(this.nextGain).connect(this.context.destination);
            this.nextGain.gain.setValueAtTime(0, this.context.currentTime);
        } catch {
            // Unsupported browsers keep ordinary media playback.
        }
    }

    prepare(track) {
        if (!this.enabled || !this.nextSource || !track?.path || this.prepared?.path === track.path) return;
        this.clear();
        this.prepared = { path: track.path };
        this.nextAudio.preload = 'auto';
        this.nextAudio.src = track.path;
        this.nextAudio.load();
    }

    tick(allowed, path) {
        const audio = this.audio;
        if (!allowed || !this.enabled) { this.cancel(); return; }
        if (this.preview && this.preview.path !== path) this.cancel();
        if (this.preview || this.prepared?.path !== path
            || !this.prepared || this.context?.state !== 'running' || audio.paused || audio.seeking
            || this.nextAudio.readyState < 3 || this.nextAudio.error) return;
        const remaining = audio.duration - audio.currentTime;
        if (!Number.isFinite(remaining) || audio.duration <= this.duration + 1
            || remaining > this.duration || remaining < 0.3
            || !Number.isFinite(this.nextAudio.duration) || this.nextAudio.duration <= remaining + 0.5) return;
        this.updateVolume();
        this.nextAudio.playbackRate = audio.playbackRate;
        const preview = this.preview = { path, source: this.nextAudio, gain: this.nextGain, started: false };
        void this.nextAudio.play().then(() => {
            if (this.preview !== preview) return;
            const left = audio.duration - audio.currentTime;
            if (audio.paused || audio.seeking || left < 0.1) { this.cancel(); return; }
            preview.started = true;
            const now = this.context.currentTime;
            this.mainGain.gain.cancelScheduledValues(now);
            this.mainGain.gain.setValueAtTime(1, now);
            this.mainGain.gain.linearRampToValueAtTime(0, now + left / audio.playbackRate);
            this.nextGain.gain.setValueAtTime(0, now);
            this.nextGain.gain.linearRampToValueAtTime(1, now + left / audio.playbackRate);
        }).catch(() => {
            if (this.preview === preview) this.cancel();
        });
    }

    updateVolume() {
        this.nextAudio.volume = this.audio.volume;
        this.nextAudio.muted = this.audio.muted;
    }

    take(path) {
        if (!this.preview?.started || this.preview.path !== path || this.nextAudio.paused
            || this.nextAudio.ended || this.nextAudio.error || this.nextAudio.readyState < 3) {
            this.cancel();
            return null;
        }
        [this.audio, this.nextAudio] = [this.nextAudio, this.audio];
        [this.mainGain, this.nextGain] = [this.nextGain, this.mainGain];
        [this.mainSource, this.nextSource] = [this.nextSource, this.mainSource];
        this.nextAudio.id = 'lecteur-next';
        this.audio.id = 'lecteur';
        this.preview = null;
        this.prepared = null;
        this.clear();
        return this.audio;
    }

    cancel() {
        const hadPreview = !!this.preview;
        this.preview = null;
        this.nextAudio.pause();
        if (hadPreview && this.nextAudio.readyState >= 1) this.nextAudio.currentTime = 0;
        if (this.context && this.mainGain && this.nextGain) {
            const now = this.context.currentTime;
            this.mainGain.gain.cancelScheduledValues(now);
            this.mainGain.gain.setValueAtTime(1, now);
            this.nextGain.gain.cancelScheduledValues(now);
            this.nextGain.gain.setValueAtTime(0, now);
        }
    }

    clear() {
        this.cancel();
        this.prepared = null;
        this.nextAudio.removeAttribute('src');
        this.nextAudio.load();
    }
}
