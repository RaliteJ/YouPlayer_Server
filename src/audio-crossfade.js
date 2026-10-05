// Only the persistent media element advances the queue (native `ended`).
// A decoded preview overlaps its tail, then hands playback back to that element.
export class AudioCrossfade {
    constructor(audio) {
        this.audio = audio;
        this.enabled = true;
        this.duration = 3;
        this.generation = 0;
        audio.addEventListener('pause', () => {
            if (!audio.ended && !this.handoff) this.cancel();
        });
        audio.addEventListener('seeking', () => {
            if (!this.handoff) this.cancel();
        });
        audio.addEventListener('waiting', () => {
            if (!this.handoff) this.cancel();
        });
        audio.addEventListener('volumechange', () => this.updateVolume());
        audio.addEventListener('loadedmetadata', () => {
            if (this.handoff && this.preview) {
                this.handoffTargetTime = Math.min(this.elapsed(), Math.max(0, audio.duration - 0.1));
                audio.currentTime = this.handoffTargetTime;
                this.silenceMainForHandoff();
            }
        });
        audio.addEventListener('playing', () => {
            if (this.handoff) {
                this.handoffPlayingAt = audio.currentTime;
                this.silenceMainForHandoff();
                this.scheduleHandoffCheck();
            }
        });
        audio.addEventListener('timeupdate', () => this.completeHandoffWhenStable());
        audio.addEventListener('error', () => this.cancel());
    }

    setDuration(value) {
        const seconds = Number(value);
        const duration = Number.isFinite(seconds) ? Math.max(0, Math.min(10, Math.round(seconds))) : 3;
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
            this.mainSource = this.context.createMediaElementSource(this.audio);
            this.mainSource.connect(this.mainGain).connect(this.context.destination);
        } catch {
            // Unsupported browsers keep ordinary media playback.
        }
    }

    async prepare(track) {
        if (!this.enabled || !this.mainSource || !track?.path) return;
        if (this.prepared?.path === track.path || this.preparing === track.path) return;
        this.clear({ preserveHandoff: true });
        const generation = this.generation;
        this.preparing = track.path;
        this.abort = new AbortController();
        try {
            const response = await fetch(track.path, { signal: this.abort.signal, credentials: 'same-origin' });
            if (!response.ok) return;
            // Bound download size; do not retain decoded long recordings.
            const maxBytes = 24 * 1024 * 1024;
            if (Number(response.headers.get('content-length')) > maxBytes) return;
            const reader = response.body.getReader();
            const chunks = [];
            let size = 0;
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > maxBytes) { await reader.cancel(); return; }
                chunks.push(value);
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
            if (generation !== this.generation) return;
            const buffer = await this.context.decodeAudioData(bytes.buffer);
            if (generation === this.generation && buffer.duration > Math.max(6, this.duration + 2) && buffer.duration <= 900) {
                const intro = this.context.createBuffer(buffer.numberOfChannels,
                    Math.ceil(buffer.sampleRate * (this.duration + 2)), buffer.sampleRate);
                for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
                    intro.copyToChannel(buffer.getChannelData(channel).subarray(0, intro.length), channel);
                }
                this.prepared = { path: track.path, buffer: intro };
            }
        } catch {
            // Read/decode errors must never prevent sequential playback.
        } finally {
            if (generation === this.generation) {
                this.abort.abort();
                this.preparing = null;
            }
        }
    }

    tick(allowed, path) {
        const audio = this.audio;
        if (this.handoff) return;
        if (!allowed || !this.enabled) { this.cancel(); return; }
        if (this.preview && this.preview.path !== path) this.cancel();
        if (this.preview || !this.prepared || this.prepared.path !== path
            || this.context?.state !== 'running' || audio.paused || audio.seeking) return;
        const remaining = audio.duration - audio.currentTime;
        if (!Number.isFinite(remaining) || audio.duration <= Math.max(6, this.duration + 2)
            || remaining > this.duration || remaining < 0.3) return;
        const source = this.context.createBufferSource();
        const gain = this.context.createGain();
        source.buffer = this.prepared.buffer;
        source.connect(gain).connect(this.context.destination);
        const now = this.context.currentTime;
        this.preview = { source, gain, startedAt: now, path, end: now + remaining };
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(audio.muted ? 0 : audio.volume, now + remaining);
        this.mainGain.gain.cancelScheduledValues(now);
        this.mainGain.gain.setValueAtTime(1, now);
        this.mainGain.gain.linearRampToValueAtTime(0, now + remaining);
        source.onended = () => {
            if (this.preview?.source === source) this.cancel();
        };
        // A stalled handoff must not leave an independent track playing.
        source.start(0, 0, remaining + 2);
    }

    updateVolume() {
        if (!this.preview) return;
        const now = this.context.currentTime;
        const { gain, startedAt, end } = this.preview;
        const volume = this.audio.muted ? 0 : this.audio.volume;
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(volume * Math.min(1, (now - startedAt) / (end - startedAt)), now);
        if (now < end) gain.gain.linearRampToValueAtTime(volume, end);
    }

    elapsed() { return this.preview ? this.context.currentTime - this.preview.startedAt : 0; }

    beginHandoff(path) {
        if (this.preview?.path !== path || this.elapsed() >= this.preview.source.buffer.duration - 0.2) {
            this.cancel();
            return;
        }
        this.handoff = true;
        this.handoffTargetTime = this.elapsed();
        this.handoffPlayingAt = null;
        this.handoffFinishing = false;
        this.handoffPlaybackRate = this.audio.playbackRate ?? 1;
        this.silenceMainForHandoff();
    }

    silenceMainForHandoff() {
        if (!this.mainGain || !this.context || this.handoffFinishing) return;
        const now = this.context.currentTime;
        this.mainGain.gain.cancelScheduledValues(now);
        this.mainGain.gain.setValueAtTime(0, now);
    }

    scheduleHandoffCheck() {
        if (this.handoffFrame != null || !this.handoff || this.handoffFinishing
            || typeof globalThis.requestAnimationFrame !== 'function') return;
        this.handoffFrame = globalThis.requestAnimationFrame(() => {
            this.handoffFrame = null;
            this.completeHandoffWhenStable(true);
            this.scheduleHandoffCheck();
        });
    }

    completeHandoffWhenStable(frequentCheck = false) {
        if (!this.handoff || !this.preview || this.handoffFinishing || this.audio.paused) return;
        const startedAt = this.handoffPlayingAt;
        if (!Number.isFinite(startedAt) || this.audio.seeking || this.audio.currentTime < startedAt + 0.02) return;

        // Seeking takes time while the decoded introduction keeps advancing.
        // Catch up silently before mixing two copies of the same recording.
        const drift = this.elapsed() - this.audio.currentTime;
        if (Math.abs(drift) > 0.005) {
            // Keep the gentler correction for timeupdate when frames are suspended.
            const correctionWindow = frequentCheck ? 0.06 : 0.2;
            this.audio.playbackRate = Math.max(0.5, Math.min(1.5, 1 + drift / correctionWindow));
            return;
        }
        this.audio.playbackRate = this.handoffPlaybackRate;

        // `playing` can precede the first stable decoded frames after a source swap.
        // Keep the preview audible until the persistent element actually advances,
        // then cross it over briefly instead of cutting it at the event boundary.
        const now = this.context.currentTime;
        const end = now + 0.06;
        const volume = this.audio.muted ? 0 : this.audio.volume;
        this.handoffFinishing = true;
        this.mainGain.gain.cancelScheduledValues(now);
        this.mainGain.gain.setValueAtTime(0, now);
        this.mainGain.gain.linearRampToValueAtTime(1, end);
        this.preview.gain.gain.cancelScheduledValues(now);
        this.preview.gain.gain.setValueAtTime(volume, now);
        this.preview.gain.gain.linearRampToValueAtTime(0, end);
        try { this.preview.source.stop(end + 0.02); } catch {}
    }

    cancel() {
        if (this.handoffFrame != null) {
            globalThis.cancelAnimationFrame?.(this.handoffFrame);
            this.handoffFrame = null;
        }
        if (this.preview) {
            this.preview.source.stop();
            this.preview.source.disconnect();
            this.preview.gain.disconnect();
            this.preview = null;
        }
        this.handoff = false;
        this.handoffTargetTime = null;
        this.handoffPlayingAt = null;
        this.handoffFinishing = false;
        if (this.handoffPlaybackRate != null) {
            this.audio.playbackRate = this.handoffPlaybackRate;
            this.handoffPlaybackRate = null;
        }
        if (this.mainGain) {
            this.mainGain.gain.cancelScheduledValues(this.context.currentTime);
            this.mainGain.gain.setValueAtTime(1, this.context.currentTime);
        }
    }

    clear({ preserveHandoff = false } = {}) {
        if (!preserveHandoff || !this.handoff) this.cancel();
        this.generation += 1;
        this.abort?.abort();
        this.prepared = null;
        this.preparing = null;
    }
}
