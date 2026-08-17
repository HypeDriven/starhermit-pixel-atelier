// audio.js — original procedural audio: short event transients, layered
// material impacts, quiet ambience, adaptive generative music. Buses:
// music / effects / ambience / voice, each with its own volume.
// Variant pitch is derived from the caller (seeded) for replay consistency.

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buses = {};
    this.volumes = { music: 0.6, effects: 0.9, ambience: 0.5, voice: 0.8 };
    this.muted = false;
    this.onCaption = null;
    this._ambience = null;
    this._music = null;
    this._noiseBuf = null;
    this.hapticsEnabled = true;
  }

  // Must be called from a user gesture at least once.
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return true;
    }
    const AC = typeof AudioContext !== 'undefined' ? AudioContext : globalThis.webkitAudioContext;
    if (!AC) return false;
    try {
      this.ctx = new AC();
    } catch { return false; }
    const master = this.ctx.createGain();
    master.gain.value = this.muted ? 0 : 1;
    master.connect(this.ctx.destination);
    this.master = master;
    for (const name of ['music', 'effects', 'ambience', 'voice']) {
      const g = this.ctx.createGain();
      g.gain.value = this.volumes[name] ?? 0.8;
      g.connect(master);
      this.buses[name] = g;
    }
    // Shared noise buffer for impacts/ambience.
    const len = this.ctx.sampleRate * 1.5;
    this._noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const data = this._noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return true;
  }

  get ready() { return !!this.ctx; }

  setVolume(bus, v) {
    this.volumes[bus] = v;
    if (this.buses[bus]) this.buses[bus].gain.setTargetAtTime(v, this.ctx.currentTime, 0.03);
  }

  setMuted(muted) {
    this.muted = muted;
    if (this.master) this.master.gain.setTargetAtTime(muted ? 0 : 1, this.ctx.currentTime, 0.02);
  }

  suspend() { if (this.ctx?.state === 'running') this.ctx.suspend().catch(() => {}); }
  resume() { if (this.ctx?.state === 'suspended') this.ctx.resume().catch(() => {}); }

  caption(text) { if (this.onCaption) this.onCaption(text); }

  haptic(pattern = 12) {
    if (this.hapticsEnabled && typeof navigator !== 'undefined' && navigator.vibrate) {
      try { navigator.vibrate(pattern); } catch { /* unsupported */ }
    }
  }

  // ------------------------------------------------------------------
  // Event sounds — original short transients tied to logical events.
  // ------------------------------------------------------------------
  play(event, opts = {}) {
    if (!this.ctx || this.muted) return;
    const t = this.ctx.currentTime;
    const v = opts.variant ?? 0.5; // 0..1 seeded variant → ±5% pitch
    const bend = 1 + (v - 0.5) * 0.1;
    switch (event) {
      case 'ui.tap': this._blip('effects', 660 * bend, 0.05, 'square', 0.12); break;
      case 'ui.back': this._blip('effects', 440 * bend, 0.06, 'square', 0.1); break;
      case 'ui.open': this._blip('effects', 520 * bend, 0.07, 'triangle', 0.12); break;
      case 'select': this._blip('effects', 880 * bend, 0.04, 'sine', 0.14); break;
      case 'fill.brush':
        this._thock(190 * bend, 0.16);
        this._noiseBurst(900, 0.05, 0.08);
        break;
      case 'fill.drag':
        this._thock(160 * bend, 0.12);
        this._noiseBurst(700, 0.04, 0.06);
        break;
      case 'fill.region':
        this._sweep('effects', 1400, 300, 0.22, 0.14);
        this._thock(140, 0.2);
        break;
      case 'error':
        this._blip('effects', 110, 0.14, 'sawtooth', 0.16);
        this._blip('effects', 104, 0.16, 'sawtooth', 0.12, 0.02);
        this.caption('That cell does not take this color.');
        this.haptic([20, 30, 20]);
        break;
      case 'invalid': this._blip('effects', 220, 0.07, 'square', 0.1); break;
      case 'combo': {
        const tier = Math.min(4, opts.tier ?? 1);
        this._chime([523, 659, 784, 1047].slice(0, 2 + tier), 0.05, 0.1);
        if (tier >= 3) this.caption(`Combo ${opts.combo ?? ''}`.trim());
        break;
      }
      case 'undo': this._sweep('effects', 600, 240, 0.12, 0.1); break;
      case 'hint': this._chime([1175, 1568], 0.07, 0.08); break;
      case 'pause': this._blip('effects', 330, 0.09, 'triangle', 0.12); break;
      case 'resume': this._blip('effects', 494, 0.09, 'triangle', 0.12); break;
      case 'lesson.step': this._chime([784, 988], 0.06, 0.12, 'voice'); break;
      case 'complete':
        this._chime([523, 659, 784, 1047, 1319], 0.12, 0.16);
        this._noiseBurst(4000, 0.5, 0.05, 0.15);
        this.caption('Canvas complete!');
        this.haptic([30, 40, 30, 40, 60]);
        break;
      case 'failed':
        this._chime([392, 330, 262], 0.16, 0.14);
        this.caption('Round over.');
        break;
      default: break;
    }
  }

  _env(gain, t, attack, decay, peak) {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  _blip(bus, freq, dur, type = 'sine', vol = 0.15, delay = 0) {
    const t = this.ctx.currentTime + delay;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type; osc.frequency.value = freq;
    this._env(g, t, 0.005, dur, vol);
    osc.connect(g).connect(this.buses[bus]);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  _thock(freq, vol) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * 2.2, t);
    osc.frequency.exponentialRampToValueAtTime(freq, t + 0.06);
    this._env(g, t, 0.004, 0.12, vol);
    osc.connect(g).connect(this.buses.effects);
    osc.start(t); osc.stop(t + 0.2);
  }

  _noiseBurst(center, dur, vol, delay = 0) {
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass'; f.frequency.value = center; f.Q.value = 1.2;
    const g = this.ctx.createGain();
    this._env(g, t, 0.004, dur, vol);
    src.connect(f).connect(g).connect(this.buses.effects);
    src.start(t); src.stop(t + dur + 0.1);
  }

  _sweep(bus, from, to, dur, vol) {
    const t = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur);
    this._env(g, t, 0.01, dur, vol);
    osc.connect(g).connect(this.buses[bus]);
    osc.start(t); osc.stop(t + dur + 0.05);
  }

  _chime(freqs, step, vol, bus = 'effects') {
    freqs.forEach((f, i) => {
      const t = this.ctx.currentTime + i * step;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine'; osc.frequency.value = f;
      this._env(g, t, 0.008, 0.35, vol);
      osc.connect(g).connect(this.buses[bus]);
      osc.start(t); osc.stop(t + 0.5);
    });
  }

  // ------------------------------------------------------------------
  // Ambience — quiet, per-theme, never carrying gameplay information.
  // ------------------------------------------------------------------
  startAmbience(kind = 'hum') {
    if (!this.ctx) return;
    this.stopAmbience();
    const src = this.ctx.createBufferSource();
    src.buffer = this._noiseBuf; src.loop = true;
    const f = this.ctx.createBiquadFilter();
    const g = this.ctx.createGain();
    g.gain.value = 0.05;
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    if (kind === 'wind') {
      f.type = 'bandpass'; f.frequency.value = 400; f.Q.value = 0.6;
      lfo.frequency.value = 0.07; lfoGain.gain.value = 250;
    } else if (kind === 'fire') {
      f.type = 'bandpass'; f.frequency.value = 900; f.Q.value = 0.4;
      lfo.frequency.value = 0.9; lfoGain.gain.value = 120;
      g.gain.value = 0.035;
    } else if (kind === 'chime') {
      f.type = 'highpass'; f.frequency.value = 2000;
      lfo.frequency.value = 0.05; lfoGain.gain.value = 800;
      g.gain.value = 0.02;
    } else { // hum
      f.type = 'lowpass'; f.frequency.value = 220;
      lfo.frequency.value = 0.1; lfoGain.gain.value = 60;
    }
    lfo.connect(lfoGain).connect(f.frequency);
    src.connect(f).connect(g).connect(this.buses.ambience);
    src.start(); lfo.start();
    this._ambience = { src, lfo };
  }

  stopAmbience() {
    if (!this._ambience) return;
    try { this._ambience.src.stop(); this._ambience.lfo.stop(); } catch { /* already stopped */ }
    this._ambience = null;
  }

  // ------------------------------------------------------------------
  // Adaptive music — seeded chord loop; intensity adds a pluck layer.
  // ------------------------------------------------------------------
  startMusic(seedStr = 'pixel-atelier') {
    if (!this.ctx || this._music) return;
    let h = 0;
    for (const ch of seedStr) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const roots = [0, -4, 3, -2].map((s) => 220 * 2 ** (s / 12)); // i VI III VII-ish
    const progression = [0, 1, 2, 3].map((i) => roots[(h + i) % roots.length]);
    const state = { step: 0, intensity: 0, timer: null, nextAt: this.ctx.currentTime + 0.1 };
    const CHORD_DUR = 3.2;
    const scheduleAhead = () => {
      if (!this._music) return;
      while (state.nextAt < this.ctx.currentTime + 0.6) {
        const t = state.nextAt;
        const root = progression[state.step % progression.length];
        // Pad: root + fifth + octave, detuned triangles, slow attack.
        for (const [ratio, vol] of [[1, 0.05], [1.5, 0.035], [2, 0.025]]) {
          const osc = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          osc.type = 'triangle';
          osc.frequency.value = root * ratio;
          osc.detune.value = (state.step % 2 ? -4 : 4);
          g.gain.setValueAtTime(0.0001, t);
          g.gain.exponentialRampToValueAtTime(vol, t + CHORD_DUR * 0.4);
          g.gain.exponentialRampToValueAtTime(0.0001, t + CHORD_DUR * 1.05);
          osc.connect(g).connect(this.buses.music);
          osc.start(t); osc.stop(t + CHORD_DUR * 1.1);
        }
        // Pluck layer when intensity is up (near completion).
        if (state.intensity > 0.35) {
          const notes = [1, 1.5, 2, 3];
          for (let k = 0; k < 4; k++) {
            if ((h >> ((state.step + k) % 8)) & 1) {
              const nt = t + k * (CHORD_DUR / 4);
              const osc = this.ctx.createOscillator();
              const g = this.ctx.createGain();
              osc.type = 'sine';
              osc.frequency.value = root * 2 * notes[(h + state.step + k) % notes.length];
              g.gain.setValueAtTime(0.0001, nt);
              g.gain.exponentialRampToValueAtTime(0.05 * state.intensity, nt + 0.01);
              g.gain.exponentialRampToValueAtTime(0.0001, nt + 0.4);
              osc.connect(g).connect(this.buses.music);
              osc.start(nt); osc.stop(nt + 0.5);
            }
          }
        }
        state.step++;
        state.nextAt += CHORD_DUR;
      }
      state.timer = setTimeout(scheduleAhead, 200);
    };
    scheduleAhead();
    this._music = state;
  }

  setMusicIntensity(v) {
    if (this._music) this._music.intensity = Math.max(0, Math.min(1, v));
  }

  stopMusic() {
    if (this._music?.timer) clearTimeout(this._music.timer);
    this._music = null;
  }
}
