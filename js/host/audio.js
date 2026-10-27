/* js/host/audio.js — 音频系统(§8):8 通道、音色三族、pattern/music 序列器、24kHz、8bit μ律输出
 * 帧驱动:每帧合成 400 样本(24k/60);内部 16bit 线性混音 → 软限幅 → μ律。
 * 音色三族(T13/T15):FC 系 8 波形(LFSR 白/粉噪、金属噪、S&H)、2op FM(环形调制)、模拟族(808/909/303)。
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};
  const SR = 24000, FRAME_N = 400;

  const midiHz = (n) => 440 * Math.pow(2, (n - 69) / 12);
  const DRUMS = { 36: 'kick', 38: 'snare', 42: 'hat', 46: 'ohat', 39: 'clap', 56: 'cowbell', 45: 'tom', 41: 'tom', 48: 'tom', 49: 'crash', 51: 'ride' };

  // ---------------- 包络 ----------------
  class Env {
    constructor() { this.reset(); }
    reset() { this.stage = 'idle'; this.t = 0; this.v = 0; this.a = 0.01; this.d = 0.05; this.s = 0.7; this.r = 0.1; }
    set(a, d, s, r) { this.a = Math.max(0.0005, a); this.d = Math.max(0.0005, d); this.s = s; this.r = Math.max(0.0005, r); }
    noteOn() { this.stage = 'atk'; this.t = 0; }
    noteOff() { if (this.stage !== 'idle') { this.stage = 'rel'; this.t = 0; this.v0 = this.v; } }
    next() {
      const dt = 1 / SR;
      switch (this.stage) {
        case 'atk': this.t += dt; this.v = Math.min(1, this.t / this.a); if (this.t >= this.a) { this.stage = 'dec'; this.t = 0; } break;
        case 'dec': this.t += dt; this.v = 1 + (this.s - 1) * Math.min(1, this.t / this.d); if (this.t >= this.d) this.stage = 'sus'; break;
        case 'sus': this.v = this.s; break;
        case 'rel': this.t += dt; this.v = this.v0 * Math.max(0, 1 - this.t / this.r); if (this.t >= this.r) { this.stage = 'idle'; this.v = 0; } break;
      }
      return this.v;
    }
  }

  // ---------------- 双二阶滤波器(Direct Form I) ----------------
  class Biquad {
    constructor() { this.setType('lp', 20000, 0.7); }
    setType(type, f, q) {
      this.type = type; this.qq = Math.max(0.1, q);
      const fc = Math.min(SR / 2 - 100, Math.max(20, f));
      const w = 2 * Math.PI * fc / SR, cw = Math.cos(w), sw = Math.sin(w), al = sw / (2 * this.qq);
      const a0 = 1 + al;
      if (type === 'hp') { this.b0 = (1 + cw) / 2 / a0; this.b1 = -(1 + cw) / a0; this.b2 = (1 + cw) / 2 / a0; }
      else if (type === 'bp') { this.b0 = al / a0; this.b1 = 0; this.b2 = -al / a0; }
      else { this.b0 = (1 - cw) / 2 / a0; this.b1 = (1 - cw) / a0; this.b2 = (1 - cw) / 2 / a0; }
      this.a1 = -2 * cw / a0; this.a2 = (1 - al) / a0;
      this.x1 = this.x2 = this.y1 = this.y2 = 0;
    }
    next(x) {
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
      return y;
    }
  }

  // ---------------- 噪声源 ----------------
  function mkNoise(kind) {
    let s = 0x1234;
    const step32 = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
    if (kind === 'white') {
      return () => (step32() / 4294967295) * 2 - 1;
    }
    if (kind === 'pink') {
      // Paul Kellet 3 滤波近似 −3dB/oct
      let b0 = 0, b1 = 0, b2 = 0;
      return () => {
        const w = (step32() / 4294967295) * 2 - 1;
        b0 = 0.99765 * b0 + w * 0.0990460;
        b1 = 0.96300 * b1 + w * 0.2965164;
        b2 = 0.57000 * b2 + w * 1.0526913;
        return (b0 + b1 + b2 + w * 0.1848) * 0.2;
      };
    }
    if (kind === 'metal') {
      // 短周期 LFSR(周期 127,金属质感)
      let r = 0x7F;
      return (clock) => {
        if (clock) {
          const bit = ((r & 1) ^ ((r >> 2) & 1)) & 1;
          r = ((r >> 1) | (bit << 6)) & 0x7F;
        }
        return ((r & 1) * 2 - 1) * 0.8;
      };
    }
    if (kind === 'sh') {
      // 采样保持随机阶梯
      let hold = 0, cnt = 0;
      return (clock) => {
        if (clock || cnt === 0) { hold = (step32() / 4294967295) * 2 - 1; cnt = 24; }
        cnt--;
        return hold;
      };
    }
    return () => 0;
  }

  // ---------------- 声部(每通道一个,单复声) ----------------
  class Voice {
    constructor() {
      this.active = false;
      this.env = new Env();
      this.filter = new Biquad();
      this.phase = 0; this.phase2 = 0;
      this.freq = 440; this.targetFreq = 440; this.glide = 0;
      this.noiseClock = 0;
      this.white = mkNoise('white'); this.pink = mkNoise('pink');
      this.metal = mkNoise('metal'); this.sh = mkNoise('sh');
      this.vibPhase = 0;
      this.t = 0;                 // 音符开始后秒数
      this.sampleOff = 0;
      this.fx = null;
      this.timbre = null;
      this.vel = 1;
      // 模拟族状态
      this.an = { s: 0, n: 0, burst: 0 };
      // 采样器
      this.smp = null; this.smpPos = 0; this.smpRate = 1;
      this.modPrev = 0;
      this.pulseW = 0.5;
    }

    noteOn(timbre, freq, vel, fx) {
      const wasFreq = this.active ? this.freq : freq;
      this.timbre = timbre;
      this.vel = vel == null ? 1 : vel;
      this.fx = fx || null;
      this.active = true;
      this.t = 0;
      this.freq = wasFreq; this.targetFreq = freq;
      this.glide = (timbre.glide || 0);
      const e = this.env;
      let A = timbre.adsr || [0.01, 0.05, 0.7, 0.15];
      if (timbre.family === 'an') A = [A[0], A[1], 1, A[3]]; // 鼓件自衰减:包络只管起音与释放
      e.set(A[0], A[1], A[2], A[3]);
      e.noteOn();
      this.pulseW = timbre.duty == null ? 0.5 : timbre.duty;
      if (timbre.filter) this.filter.setType(timbre.filter.type || 'lp', timbre.filter.cutoff || 8000, timbre.filter.q || 0.7);
      else this.filter.setType('lp', 20000, 0.7);
      // FX filter 替换音色 filter(§8.3:不叠加,后设者生效)
      if (fx && fx.filterSet) this.filter.setType(fx.filterType || 'lp', fx.filterCutoff || 8000, fx.filterQ || 1);
      // 模拟族/采样族特化
      if (timbre.family === 'an') {
        this.an.s = 1; this.an.n = 0; this.an.burst = 0;
        this.anModel = timbre.model === 'kit' ? (DRUMS[Math.round(freq)] ? DRUMS[Math.round(freq)] : 'kick') : timbre.model;
      }
      if (timbre.family === 'smp' && timbre.sampleData) {
        this.smp = timbre.sampleData; this.smpPos = 0;
        this.smpRate = (timbre.rate || 1) * (freq / 440);
      }
    }
    noteOff() { this.env.noteOff(); }

    done() { return !this.active || (this.env.stage === 'idle'); }

    next() {
      if (!this.active) return 0;
      const dt = 1 / SR;
      this.t += dt;
      const T = this.timbre;
      // 滑音
      if (this.glide > 0) {
        const k = Math.min(1, dt / this.glide);
        this.freq += (this.targetFreq - this.freq) * k;
      } else this.freq = this.targetFreq;
      // FX:滑向下一音 / 音高 LFO / 上滑下滑
      let fMul = 1;
      if (this.fx) {
        const fx = this.fx;
        if (fx.slideTo) fMul = Math.pow(fx.slideTo, Math.min(1, this.t / Math.max(0.001, fx.slideTime || 0.1)));
        if (fx.pitchLfo) fMul *= Math.pow(2, fx.pitchLfo.depth / 12 * Math.sin(2 * Math.PI * fx.pitchLfo.rate * this.t));
        if (fx.pitchSweep) fMul *= Math.pow(2, fx.pitchSweep * this.t);
      }
      // 颤音
      if (T.vib && T.vib.depth) {
        this.vibPhase += 2 * Math.PI * (T.vib.rate || 6) * dt;
        fMul *= Math.pow(2, (T.vib.depth / 12) * Math.sin(this.vibPhase));
      }
      const f = this.freq * fMul;
      const env = this.env.next();
      let out = 0;
      const fam = T.family;

      if (fam === 'fc') {
        const w = T.wave | 0;
        this.phase += f / SR;
        if (this.phase >= 1) this.phase -= 1;
        switch (w) {
          case 1: out = Math.sin(2 * Math.PI * this.phase); break;
          case 2: out = this.phase < 0.5 ? 1 : -1; break;
          case 3: {
            // 脉冲 + FX 脉宽扫描
            let duty = this.pulseW;
            if (this.fx && this.fx.pwmSweep) duty = Math.min(0.9, Math.max(0.05, duty + this.fx.pwmSweep * this.t));
            out = this.phase < duty ? 1 : -1; break;
          }
          case 4: out = 2 * this.phase - 1; break;
          case 5: out = 4 * Math.abs(this.phase - 0.5) - 1; break; // 三角(相位平移对称)
          case 6: out = (T.noise === 'pink') ? this.pink() : this.white(); break;
          case 7: { this.noiseClock += f / SR; const c = this.noiseClock >= 1; if (c) this.noiseClock -= 1; out = this.metal(c); break; }
          case 8: { this.noiseClock += f / SR; const c = this.noiseClock >= 1; if (c) this.noiseClock -= 1; out = this.sh(c); break; }
          default: out = 0;
        }
      } else if (fam === 'fm') {
        const car = T.car || {}, mod = T.mod || {};
        const mf = f * (mod.ratio == null ? 1 : mod.ratio);
        const cf = f * (car.ratio == null ? 1 : car.ratio);
        this.phase += cf / SR; if (this.phase >= 1) this.phase -= 1;
        this.phase2 += mf / SR; if (this.phase2 >= 1) this.phase2 -= 1;
        // 调制包络独立
        const mEnv = this.modEnv || (this.modEnv = new Env());
        if (this.env.stage === 'atk' && mEnv.stage === 'idle') { const MA = mod.adsr || [0.01, 0.1, 0.5, 0.2]; mEnv.set(MA[0], MA[1], MA[2], MA[3]); mEnv.noteOn(); }
        if (this.env.stage === 'rel' && mEnv.stage !== 'rel' && mEnv.stage !== 'idle') mEnv.noteOff();
        if (this.env.stage === 'idle') mEnv.reset();
        const mOut = mEnv.next() * (mod.level == null ? 1 : mod.level);
        const fb = (mod.fb || 0) * this.modPrev * 0.7;
        const modSig = Math.sin(2 * Math.PI * this.phase2 + fb + mOut * 2 * Math.PI);
        this.modPrev = modSig;
        const carEnv = env;
        out = T.ring
          ? carEnv * Math.sin(2 * Math.PI * this.phase) * modSig
          : carEnv * Math.sin(2 * Math.PI * this.phase + mOut * 2 * Math.PI * modSig);
        out *= 0.8;
      } else if (fam === 'an') {
        out = this.anSample(this.anModel, f);
      } else if (fam === 'smp' && this.smp) {
        const DEC = AC2.Mulaw.DEC;
        const p = this.smpPos | 0;
        if (p >= this.smp.length) { this.active = false; return 0; }
        out = DEC[this.smp[p]];
        this.smpPos += this.smpRate;
        out *= env;
        return out * (T.vol == null ? 1 : T.vol) * this.vel;
      }
      out *= env * (T.vol == null ? 1 : T.vol) * this.vel;
      // 音量 FX
      if (this.fx) {
        if (this.fx.fadeIn) out *= Math.min(1, this.t / Math.max(0.001, this.fx.fadeIn));
        if (this.fx.fadeOut) out *= Math.max(0, 1 - this.t / Math.max(0.001, this.fx.fadeOut));
        if (this.fx.volLfo) out *= 0.5 + 0.5 * Math.sin(2 * Math.PI * this.fx.volLfo.rate * this.t) * this.fx.volLfo.depth;
      }
      // 滤波
      if (T.filter || (this.fx && this.fx.filterSet) || (T.family === 'an' && this.anModel === '303')) {
        out = this.filter.next(out);
      }
      return out;
    }

    anSample(model, f) {
      const a = this.an;
      const w = this.white();
      switch (model) {
        case 'kick': {
          const p = Math.min(1, this.t / 0.3);
          const fr = 40 + 110 * Math.pow(1 - p, 3);
          a.s += fr / SR; if (a.s >= 1) a.s -= 1;
          return Math.sin(2 * Math.PI * a.s) * Math.pow(1 - p, 1.5) * 1.2 + (this.t < 0.005 ? w * 0.5 : 0);
        }
        case 'snare': {
          const p1 = Math.min(1, this.t / 0.12), p2 = Math.min(1, this.t / 0.2);
          a.s += 180 / SR; if (a.s >= 1) a.s -= 1;
          return (Math.sin(2 * Math.PI * a.s) * 0.4 * (1 - p1) + w * 0.8 * (1 - p2)) * 0.9;
        }
        case 'hat': case 'ohat': {
          const dur = model === 'hat' ? 0.05 : 0.35;
          const p = Math.min(1, this.t / dur);
          // 高通近似:差分
          const n = w - (a.n || 0); a.n = w;
          return n * (1 - p) * 0.9;
        }
        case 'clap': {
          const burstT = this.t % 0.012;
          const inBurst = this.t < 0.036 || (this.t > 0.048 && this.t < 0.2);
          const p = Math.min(1, this.t / 0.2);
          const n = w - (a.n || 0); a.n = w;
          return inBurst ? n * (1 - p) * 0.9 : 0;
        }
        case 'cowbell': {
          const p = Math.min(1, this.t / 0.3);
          a.s += 560 / SR; if (a.s >= 1) a.s -= 1;
          a.burst += 845 / SR; if (a.burst >= 1) a.burst -= 1;
          return ((a.s < 0.5 ? 1 : -1) + (a.burst < 0.5 ? 1 : -1)) * 0.3 * (1 - p);
        }
        case 'tom': {
          const p = Math.min(1, this.t / 0.25);
          const fr = 80 + 120 * Math.pow(1 - p, 2);
          a.s += fr / SR; if (a.s >= 1) a.s -= 1;
          return Math.sin(2 * Math.PI * a.s) * (1 - p);
        }
        case 'crash': case 'ride': {
          const dur = model === 'crash' ? 0.9 : 0.6;
          const p = Math.min(1, this.t / dur);
          const pn = this.pink();
          const n = pn - (a.n || 0); a.n = pn;
          return n * (1 - p) * 0.8;
        }
        case '303': {
          // 锯/方 + 滤波包络(截断频率随包络扫描)
          this.phase += f / SR; if (this.phase >= 1) this.phase -= 1;
          const wave = (this.timbre.w303 === 'square') ? (this.phase < 0.5 ? 1 : -1) : (2 * this.phase - 1);
          const p = Math.min(1, this.t / (this.timbre.decay303 || 0.25));
          const cut = (this.timbre.cutoff303 || 400) * Math.pow(2, (this.timbre.envMod || 3) * (1 - p));
          this.filter.setType('lp', cut, this.timbre.res || 6);
          return this.filter.next(wave) * Math.pow(1 - p, 0.7) * 0.9;
        }
        default: return 0;
      }
    }
  }

  // ---------------- 音频引擎 ----------------
  class AudioEngine {
    constructor() {
      this.sr = SR;
      this.chans = [];
      for (let i = 0; i < 8; i++) {
        this.chans.push({ voice: new Voice(), volume: 1, timbre: null, role: null, borrowed: null });
      }
      this.master = 0.7;
      this.timbres = [];
      this.patterns = [];
      this.musics = [];
      this.samples = {};
      this.playing = null;         // {music, tSamples, stepIdx, borrowed}
      this.sfxPlaying = [];
      this.lastOutput = new Uint8Array(FRAME_N);
      this.linearTap = new Float32Array(FRAME_N); // 编码前线信号(调试旁听,§8.1)
      this.aramBytes = 0;
      this.defaultTimbre = { family: 'fc', wave: 2, adsr: [0.005, 0.05, 0.7, 0.08], vol: 0.5 };
    }

    // ---- 数据装载(卡带 audio 段) ----
    loadAudioData(data) {
      this.timbres = data.timbres || [];
      this.patterns = data.patterns || [];
      this.musics = data.musics || [];
      this.samples = data.samples || {};
      // 采样块解码 b64 μ律 → Float32?直接保留 μ律字节,Voice 用 DEC 查表
      for (const t of this.timbres) {
        if (t.family === 'smp' && t.sample && this.samples[t.sample]) {
          t.sampleData = AC2.bytesFromB64(this.samples[t.sample]);
        }
      }
      this._calcAram();
    }
    addTimbre(t, idx) { this.timbres[idx != null ? idx : this.timbres.length] = t; this._calcAram(); }
    _calcAram() {
      let n = 0;
      for (const t of this.timbres) n += 128;
      for (const p of this.patterns) n += 64 * 8;
      for (const m of this.musics) n += 8 * 64 * 2;
      for (const k of Object.keys(this.samples)) n += this.samples[k].length * 0.75;
      this.aramBytes = n | 0;
    }

    // ---- BGM / SFX / 直驱 API(§8.4) ----
    playTrack(n) {
      const m = this.musics[n];
      if (!m) return false;
      this.stopTrack();
      this.playing = { music: m, tSamples: 0, lastStep: -1 };
      for (let i = 0; i < 8; i++) {
        const t = this.chans[i];
        t.role = 'music';
        const ti = this.timbres[this._trackTimbre(m, i)];
        t.timbre = ti || this.defaultTimbre;
      }
      return true;
    }
    stopTrack() {
      for (const c of this.chans) { if (c.role === 'music') { c.voice.noteOff(); } }
      this.playing = null;
    }
    _trackTimbre(music, trackIdx) {
      // 音轨乐器 = 该轨第一个 pattern 的乐器
      const tr = music.tracks && music.tracks[trackIdx];
      if (tr && tr.length && tr[0].p != null) {
        const pat = this.patterns[tr[0].p];
        if (pat) return pat.t;
      }
      return null;
    }
    playSfx(n, opt) {
      const pat = this.patterns[n];
      if (!pat) return false;
      let ch = opt && opt.ch;
      if (ch == null) {
        // 借空闲通道(§8.4:SFX 可抢占;结束自动归还)
        ch = this.chans.findIndex(c => !c.voice.active);
        if (ch < 0) ch = 0;
      }
      this.chans[ch].borrowed = { prevRole: this.chans[ch].role, prevTimbre: this.chans[ch].timbre };
      this.chans[ch].role = 'sfx';
      this.chans[ch].timbre = this.timbres[pat.t] || this.defaultTimbre;
      this.sfxPlaying.push({ pat, ch, tSamples: 0, lastStep: -1, bpm: (opt && opt.bpm) || 120 });
      return true;
    }
    ch(chIdx) {
      const self = this, c = this.chans[chIdx];
      return {
        set(k, v) {
          if (k === 'volume') c.volume = v;
          else if (k === 'timbre') c.timbre = self.timbres[v] || self.defaultTimbre;
        },
        note(freq, len) {
          c.voice.noteOn(c.timbre || self.defaultTimbre, freq, 1);
          if (len != null) {
            self._noteOffs.push({ voice: c.voice, at: self._sampleClock + Math.round(len * SR) });
          }
        },
        off() { c.voice.noteOff(); }
      };
    }
    volume(v) { this.master = v; }
    stopAll() {
      this.stopTrack();
      this.sfxPlaying = [];
      for (const c of this.chans) { c.voice.active = false; c.voice.env.reset(); }
    }

    // ---- FX 计算(pattern 两条 FX 轨,起止区域内音符受影响 §8.3) ----
    fxFor(pat, step, nextNote) {
      let fx = null;
      const add = (o) => { fx = Object.assign(fx || {}, o); };
      for (const fxt of (pat.fx || [])) {
        if (step < fxt.start || step > fxt.end) continue;
        const p = fxt.params || {};
        switch (fxt.type) {
          case 'pitchLfo': add({ pitchLfo: { rate: p.rate || 6, depth: p.depth == null ? 0.3 : p.depth } }); break;
          case 'pitchUp': add({ pitchSweep: (p.rate || 1) * 0.2 }); break;
          case 'pitchDown': add({ pitchSweep: -(p.rate || 1) * 0.2 }); break;
          case 'slideNext': add({ slideTo: nextNote ? nextNote / 1 : 1, slideTime: (fxt.end - step + 1) * 0.125 * (60 / 120) }); break;
          case 'volLfo': add({ volLfo: { rate: p.rate || 4, depth: p.depth == null ? 0.5 : p.depth } }); break;
          case 'fadeIn': add({ fadeIn: (fxt.end - step + 1) * 0.12 }); break;
          case 'fadeOut': add({ fadeOut: (fxt.end - step + 1) * 0.12 }); break;
          case 'filter': add({ filterSet: true, filterType: p.type || 'lp', filterCutoff: p.cutoff || 2000, filterQ: p.q || 2 }); break;
          case 'arp': add({ arp: { dir: p.dir || 'up', rate: p.rate || 16 } }); break;
          case 'pwm': add({ pwmSweep: (p.dir === 'down' ? -1 : 1) * (p.rate || 0.15) }); break;
        }
      }
      return fx;
    }

    // ---- 帧推进(400 样本) ----
    step() {
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      if (!this._noteOffs) this._noteOffs = [];
      if (!this._sampleClock) this._sampleClock = 0;
      // 序列器:步进处理(BGM)
      if (this.playing) this._seqStep(this.playing, 'music');
      // SFX 序列
      for (let i = this.sfxPlaying.length - 1; i >= 0; i--) {
        const s = this.sfxPlaying[i];
        this._seqStep(s, 'sfx');
        const dur = (60 / s.bpm) * 16;   // 64 步 × 每步 1/16 拍?每步 = 16 分音符 → 总 4 拍
        if (s.tSamples > (60 / s.bpm) * 4 * SR + SR * 0.5) {
          // 归还借道
          const c = this.chans[s.ch];
          if (c.borrowed) { c.role = c.borrowed.prevRole; c.timbre = c.borrowed.prevTimbre; c.borrowed = null; }
          c.voice.noteOff();
          this.sfxPlaying.splice(i, 1);
        }
      }
      // 定长 noteOff
      for (let i = this._noteOffs.length - 1; i >= 0; i--) {
        if (this._sampleClock >= this._noteOffs[i].at) { this._noteOffs[i].voice.noteOff(); this._noteOffs.splice(i, 1); }
      }
      // 合成
      const out = this.lastOutput, lin = this.linearTap;
      const mix = new Float32Array(FRAME_N);
      for (let ci = 0; ci < 8; ci++) {
        const c = this.chans[ci];
        if (!c.voice.active) continue;
        const v = c.voice;
        for (let i = 0; i < FRAME_N; i++) {
          mix[i] += v.next() * c.volume;
        }
      }
      for (let i = 0; i < FRAME_N; i++) {
        let x = mix[i] * this.master;
        // 软限幅
        x = x < -1 ? -1 : x > 1 ? 1 : x;
        if (x > 0.7) x = 0.7 + (x - 0.7) / 3; else if (x < -0.7) x = -0.7 + (x + 0.7) / 3;
        lin[i] = x;
        out[i] = AC2.Mulaw.encodeSample(x);
        this._sampleClock++;
      }
      this.stepMs = (typeof performance !== 'undefined' ? performance.now() : 0) - t0;
      // 电平表(调试设备)
      this.levels = this.levels || new Float32Array(8);
      for (let ci = 0; ci < 8; ci++) {
        const c = this.chans[ci];
        let m = 0;
        if (c.voice.active) { /* 近似:包络值 */ m = c.voice.env.v * (c.voice.timbre && c.voice.timbre.vol != null ? c.voice.timbre.vol : 1); }
        this.levels[ci] = m;
      }
    }

    // 序列器步进(挂在帧上;每帧 400 样本)
    _seqStep(seq, kind) {
      const m = seq.music || seq.pat;
      const bpm = kind === 'music' ? seq.music.bpm : seq.bpm;
      const swing = kind === 'music' ? (seq.music.swing || 0) : 0;
      const stepDur = (60 / bpm) / 4; // 16 分音符
      seq.tSamples += FRAME_N;
      const curStep = Math.floor(seq.tSamples / (stepDur * SR));
      if (curStep === seq.lastStep) return;
      const totalSteps = kind === 'music' ? Infinity : 64;
      const from = seq.lastStep + 1, to = Math.min(curStep, seq.lastStep + 8);
      for (let st = from; st <= to; st++) {
        seq.lastStep = st;
        if (kind === 'sfx') {
          this._firePattern(seq.pat, st, seq.ch, bpm);
        } else {
          const music = seq.music;
          const barLen = 16; // 每小节 16 步
          const bar = Math.floor(st / barLen), pos = st % barLen;
          const loopBar = music.loop != null ? music.loop : Infinity;
          if (bar >= loopBar) { seq.tSamples = 0; seq.lastStep = -1; return; } // 循环回起点
          for (let tr = 0; tr < 8; tr++) {
            const arr = (music.tracks && music.tracks[tr]) || [];
            for (const slot of arr) {
              if (slot.b === bar) {
                const pat = this.patterns[slot.p];
                if (pat) this._firePattern(pat, pos, tr, bpm);
              }
            }
          }
          void swing; // swing 在 _firePattern 的偏移中体现
        }
      }
    }

    _firePattern(pat, step, chIdx, bpm) {
      const notes = pat.notes || [];
      const stepDur = (60 / bpm) / 4;
      for (const n of notes) {
        if (n.s !== step) continue;
        const vel = (pat.vol && pat.vol[step] != null) ? pat.vol[step] : (n.v != null ? n.v : 1);
        let fx = this.fxFor(pat, step, null);
        const c = this.chans[chIdx];
        const freq = typeof n.n === 'string' ? (DRUMS[n.n] ? midiHz(Object.keys(DRUMS).find(k => DRUMS[k] === n.n) || 36) : 440) : midiHz(n.n);
        c.voice.noteOn(c.timbre || this.defaultTimbre, freq, vel, fx);
        // 音长:len 步后 noteOff(记录绝对样本时钟)
        if (n.l != null && n.l > 0) {
          this._noteOffs = this._noteOffs || []; this._sampleClock = this._sampleClock || 0;
          this._noteOffs.push({ voice: c.voice, at: this._sampleClock + Math.round(n.l * stepDur * SR) });
        }
      }
    }
  }

  AC2.AudioEngine = AudioEngine;
  AC2.AUDIO_SR = SR;
  AC2.midiHz = midiHz;
})();
