export type FruitSound = 'apple' | 'orange' | 'lime' | 'watermelon' | 'strawberry' | 'kiwi';

const BASE_PITCH: Record<FruitSound, number> = {
  apple: 520,
  orange: 430,
  lime: 610,
  watermelon: 590,
  strawberry: 660,
  kiwi: 480,
};

export class GameAudio {
  private context: AudioContext | undefined;
  private master: GainNode | undefined;
  private sfx: GainNode | undefined;
  private noise: AudioBuffer | undefined;
  private activeVoices = 0;
  private muted = false;

  async unlock(): Promise<void> {
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 0.72;
      const compressor = this.context.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 12;
      compressor.ratio.value = 5;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.2;
      this.sfx = this.context.createGain();
      this.sfx.gain.value = 0.9;
      this.sfx.connect(compressor).connect(this.master).connect(this.context.destination);
      this.noise = this.createNoise(this.context);
    }
    if (this.context.state === 'suspended') await this.context.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.context) this.master.gain.setTargetAtTime(muted ? 0 : 0.72, this.context.currentTime, 0.015);
  }

  get enabled(): boolean {
    return !!this.context && this.context.state === 'running' && !this.muted;
  }

  playSlice(kind: FruitSound): void {
    const context = this.ready();
    if (!context || !this.noise || !this.sfx || this.activeVoices >= 8) return;
    const now = context.currentTime + 0.002;
    const pitch = BASE_PITCH[kind] * (0.94 + Math.random() * 0.12);
    const stopAt = now + 0.15;

    const noise = context.createBufferSource();
    noise.buffer = this.noise;
    noise.playbackRate.value = 0.92 + Math.random() * 0.16;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.Q.value = 0.65;
    filter.frequency.setValueAtTime(900 + Math.random() * 450, now);
    filter.frequency.exponentialRampToValueAtTime(2800, stopAt);
    const noiseGain = context.createGain();
    noiseGain.gain.setValueAtTime(0.0001, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.15, now + 0.009);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
    noise.connect(filter).connect(noiseGain).connect(this.sfx);

    const tone = context.createOscillator();
    tone.type = 'triangle';
    tone.frequency.setValueAtTime(pitch, now);
    tone.frequency.exponentialRampToValueAtTime(pitch * 0.42, now + 0.1);
    const toneGain = context.createGain();
    toneGain.gain.setValueAtTime(0.045, now);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
    tone.connect(toneGain).connect(this.sfx);

    this.trackVoice(noise);
    this.trackVoice(tone);
    noise.start(now);
    tone.start(now);
    noise.stop(stopAt);
    tone.stop(stopAt);
  }

  playBomb(): void {
    const context = this.ready();
    if (!context || !this.noise || !this.sfx || this.activeVoices >= 12) return;
    const now = context.currentTime + 0.002;
    const stopAt = now + 0.62;

    const impact = context.createOscillator();
    impact.type = 'sine';
    impact.frequency.setValueAtTime(115, now);
    impact.frequency.exponentialRampToValueAtTime(28, now + 0.34);
    const impactGain = context.createGain();
    impactGain.gain.setValueAtTime(0.34, now);
    impactGain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
    impact.connect(impactGain).connect(this.sfx);

    const blast = context.createBufferSource();
    blast.buffer = this.noise;
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.setValueAtTime(1800, now);
    lowpass.frequency.exponentialRampToValueAtTime(160, stopAt);
    const blastGain = context.createGain();
    blastGain.gain.setValueAtTime(0.0001, now);
    blastGain.gain.exponentialRampToValueAtTime(0.42, now + 0.012);
    blastGain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
    blast.connect(lowpass).connect(blastGain).connect(this.sfx);

    this.trackVoice(impact);
    this.trackVoice(blast);
    impact.start(now);
    blast.start(now);
    impact.stop(stopAt);
    blast.stop(stopAt);
  }

  playFlow(): void {
    const context = this.ready();
    if (!context || !this.sfx || this.activeVoices >= 9) return;
    const now = context.currentTime + 0.002;
    const notes = [523.25, 659.25, 783.99, 1046.5];
    notes.forEach((frequency, index) => {
      const oscillator = context.createOscillator();
      oscillator.type = index === notes.length - 1 ? 'sine' : 'triangle';
      oscillator.frequency.setValueAtTime(frequency, now + index * 0.045);
      const gain = context.createGain();
      const start = now + index * 0.045;
      const end = start + 0.42;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.035, start + 0.018);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      oscillator.connect(gain).connect(this.sfx!);
      this.trackVoice(oscillator);
      oscillator.start(start);
      oscillator.stop(end);
    });
  }

  playCue(cue: 'combo' | 'special' | 'countdown'): void {
    const context = this.ready();
    if (!context || !this.sfx || this.activeVoices >= 12) return;
    const start = context.currentTime + 0.004;
    const end = start + 0.14;
    const oscillator = context.createOscillator();
    oscillator.type = 'sine';
    const pitch = { combo: 740, special: 660, countdown: 440 }[cue];
    oscillator.frequency.setValueAtTime(pitch, start);
    if (cue !== 'countdown') oscillator.frequency.setValueAtTime(pitch * 1.5, start + 0.045);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.075, start + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain).connect(this.sfx);
    this.trackVoice(oscillator);
    oscillator.start(start);
    oscillator.stop(end);
  }

  private ready(): AudioContext | undefined {
    if (!this.context || !this.enabled) return undefined;
    return this.context;
  }

  private trackVoice(node: AudioScheduledSourceNode): void {
    this.activeVoices += 1;
    node.addEventListener('ended', () => { this.activeVoices = Math.max(0, this.activeVoices - 1); }, { once: true });
  }

  private createNoise(context: AudioContext): AudioBuffer {
    const frames = Math.floor(context.sampleRate * 0.8);
    const buffer = context.createBuffer(1, frames, context.sampleRate);
    const data = buffer.getChannelData(0);
    let value = 0;
    for (let i = 0; i < frames; i++) {
      value = value * 0.72 + (Math.random() * 2 - 1) * 0.28;
      data[i] = value;
    }
    return buffer;
  }
}
