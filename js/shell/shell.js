/* js/shell/shell.js — 主机壳:画布缩放、固定步长帧循环、三路输入采集(§9.4)、音频输出、卡带库
 * 壳不参与游戏逻辑;物理采集 → 每帧一次 pushInput(60Hz)。
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};
  const { ANSI } = AC2;

  // §9.1 键盘映射:方向/WASD;Z/J=A;X/K/Space=B;Enter=Start
  const KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
    KeyZ: 'a', KeyJ: 'a',
    KeyX: 'b', KeyK: 'b', Space: 'b',
    Enter: 'start'
  };

  class Shell {
    constructor(canvas, opts) {
      opts = opts || {};
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      canvas.width = 240; canvas.height = 176;
      this.img = this.ctx.createImageData(240, 176);
      this.u32 = new Uint32Array(this.img.data.buffer);
      // 调色板 → ABGR(小端)
      this.pal32 = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        const r = ANSI.rgbTable[i * 3], g = ANSI.rgbTable[i * 3 + 1], b = ANSI.rgbTable[i * 3 + 2];
        this.pal32[i] = (0xFF << 24) | (b << 16) | (g << 8) | r;
      }
      this.machine = opts.machine || new AC2.Machine({ storage: opts.storage });
      this.zoom = opts.zoom || 3;
      this.showFps = opts.showFps !== false;
      this._raf = 0;
      this._last = 0;
      this._running = false;
      this._keys = {};     // 键盘(事件维护,按住跨帧保持)
      this._padKeys = {};  // 手柄(每帧轮询重置)
      this._mouse = { x: 0, y: 0, buttons: 0, dx: 0, dy: 0 };
      this.fps = 0; this._fpsN = 0; this._fpsT = 0;
      this.onBeforeStep = opts.onBeforeStep || null;
      this.onAfterStep = opts.onAfterStep || null;
      this._bindInput();
      this._applyZoom();
      window.addEventListener('resize', () => this._applyZoom());
      // 音频
      this.audioCtx = null;
      this._audioTail = new Float32Array(0);
      if (opts.audio !== false) this._initAudio();
    }

    _applyZoom() {
      const vw = window.innerWidth - 24, vh = window.innerHeight - 24;
      let z = Math.max(1, Math.min(Math.floor(vw / 240), Math.floor(vh / 176)));
      this.zoom = z;
      this.canvas.style.width = (240 * z) + 'px';
      this.canvas.style.height = (176 * z) + 'px';
    }

    // ---------- 输入采集(§9) ----------
    _bindInput() {
      const c = this.canvas;
      window.addEventListener('keydown', (e) => {
        const k = KEYMAP[e.code];
        if (k) { this._keys[k] = true; e.preventDefault(); }
      });
      window.addEventListener('keyup', (e) => {
        const k = KEYMAP[e.code];
        if (k) { this._keys[k] = false; e.preventDefault(); }
      });
      c.addEventListener('mousemove', (e) => {
        const r = c.getBoundingClientRect();
        this._mouse.x = Math.floor((e.clientX - r.left) / this.zoom);
        this._mouse.y = Math.floor((e.clientY - r.top) / this.zoom);
        this._mouse.dx += e.movementX / this.zoom;
        this._mouse.dy += e.movementY / this.zoom;
      });
      c.addEventListener('mousedown', (e) => {
        this._mouse.buttons |= (e.button === 0 ? 1 : 2);
        e.preventDefault();
      });
      window.addEventListener('mouseup', (e) => {
        this._mouse.buttons &= ~(e.button === 0 ? 1 : 2);
      });
      c.addEventListener('contextmenu', e => e.preventDefault());
    }

    _pollGamepad() {
      // 手柄(§9.3):十字=方向;A/B + R→A、L→B;Start;右摇杆 → 鼠标相对增量;死区 0.25
      if (!navigator.getGamepads) return;
      const pads = navigator.getGamepads();
      const k = this._padKeys = {};
      for (const p of pads) {
        if (!p) continue;
        const b = (i) => p.buttons[i] && p.buttons[i].pressed;
        if (b(12)) k.up = true;
        if (b(13)) k.down = true;
        if (b(14)) k.left = true;
        if (b(15)) k.right = true;
        if (b(0)) k.a = true;
        if (b(1)) k.b = true;
        if (b(5)) k.a = true;   // R 肩 → A
        if (b(4)) k.b = true;   // L 肩 → B
        if (b(9)) k.start = true;
        const dz = 0.25;
        const rx = p.axes[2] || 0, ry = p.axes[3] || 0;
        if (Math.abs(rx) > dz || Math.abs(ry) > dz) {
          const mag = Math.min(1, Math.hypot(rx, ry));
          const ang = Math.atan2(ry, rx);
          this._mouse.dx += Math.cos(ang) * mag * 6;
          this._mouse.dy += Math.sin(ang) * mag * 6;
        }
        break; // 单人
      }
    }

    _sampleInput() {
      // 合成快照:键盘 ∪ 手柄;鼠标按键并入 A/B
      const kb = this._keys, gp = this._padKeys || {};
      const keys = {
        up: !!(kb.up || gp.up), down: !!(kb.down || gp.down),
        left: !!(kb.left || gp.left), right: !!(kb.right || gp.right),
        a: !!(kb.a || gp.a || (this._mouse.buttons & 1)),
        b: !!(kb.b || gp.b || (this._mouse.buttons & 2)),
        start: !!(kb.start || gp.start)
      };
      const snap = {
        keys,
        x: Math.max(-256, Math.min(496, this._mouse.x)),
        y: Math.max(-256, Math.min(432, this._mouse.y)),
        dx: this._mouse.dx, dy: this._mouse.dy
      };
      this._mouse.dx = 0; this._mouse.dy = 0; // 相对量为每帧原始增量
      return snap;
    }

    // ---------- 帧循环(固定步长,不追帧 §5.1) ----------
    start() {
      if (this._running) return;
      this._running = true;
      this._last = performance.now();
      const tick = (now) => {
        if (!this._running) return;
        this._raf = requestAnimationFrame(tick);
        // 每个垂直同步至多推进 1 帧(掉帧即掉帧,无补偿)
        if (now - this._last >= 15.5) {
          this._last = now;
          this.frame();
        }
        this.render();
      };
      this._raf = requestAnimationFrame(tick);
    }
    stop() { this._running = false; cancelAnimationFrame(this._raf); }

    frame() {
      this._pollGamepad();
      this.machine.input.pushInput(this._sampleInput());
      if (this.onBeforeStep) this.onBeforeStep(this.machine);
      this.machine.step();
      this._pushAudio();
      if (this.onAfterStep) this.onAfterStep(this.machine);
      // FPS 统计
      this._fpsN++;
      const t = performance.now();
      if (t - this._fpsT > 500) {
        this.fps = Math.round(this._fpsN * 1000 / (t - this._fpsT));
        this._fpsN = 0; this._fpsT = t;
      }
    }

    render() {
      const fb = this.machine.fb, u32 = this.u32;
      for (let i = 0; i < fb.length; i++) u32[i] = this.pal32[fb[i]];
      this.ctx.putImageData(this.img, 0, 0);
    }

    // ---------- 音频输出(μ律 → 浮点 → ScriptProcessor) ----------
    _initAudio() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.audioCtx = new AC({ sampleRate: 24000 });
      } catch (e) {
        this.audioCtx = new AC();
      }
      const ctx = this.audioCtx;
      const node = ctx.createScriptProcessor(2048, 0, 1);
      const self = this;
      node.onaudioprocess = (ev) => {
        const out = ev.outputBuffer.getChannelData(0);
        const q = self._audioQueue;
        let n = 0;
        while (n < out.length) {
          if (q.length === 0) {
            // 无新样本:静音(暂停/装载中)
            out.fill(0, n);
            break;
          }
          const blk = q.shift();
          const take = Math.min(out.length - n, blk.length);
          out.set(blk.subarray(0, take), n);
          n += take;
          if (take < blk.length) q.unshift(blk.subarray(take));
        }
      };
      node.connect(ctx.destination);
      this._audioNode = node;
      this._audioQueue = [];
      const resume = () => { if (ctx.state === 'suspended') ctx.resume(); };
      window.addEventListener('pointerdown', resume);
      window.addEventListener('keydown', resume);
    }

    _pushAudio() {
      const a = this.machine.audio;
      if (!a || !this._audioQueue) return;
      const bytes = a.lastOutput;   // Uint8Array(400) μ律,机器每帧产出
      if (!bytes || !bytes.length) return;
      const f = new Float32Array(bytes.length);
      const DEC = AC2.Mulaw.DEC;
      for (let i = 0; i < bytes.length; i++) f[i] = DEC[bytes[i]];
      this._audioQueue.push(f);
      // 上限保护:超过 0.5s 丢弃旧块
      while (this._audioQueue.length > 30) this._audioQueue.shift();
    }

    // ---------- 卡带库(localStorage,§7.3) ----------
    static libGet() {
      try { return JSON.parse(localStorage.getItem('ac2.lib') || '{}'); } catch (e) { return {}; }
    }
    static libPut(lib) { localStorage.setItem('ac2.lib', JSON.stringify(lib)); }
    static async libAdd(buf) {
      const cart = await AC2.Cart.load(buf);
      const lib = Shell.libGet();
      const prev = lib[cart.id];
      if (prev && prev.version >= cart.version) return { cart, replaced: false, reason: '已有同 ID 更高版本' };
      lib[cart.id] = { version: cart.version, title: cart.title, mode: cart.mode, b64: AC2.b64FromBytes(buf), added: Date.now() };
      Shell.libPut(lib);
      return { cart, replaced: true };
    }
    static libRemove(id) { const lib = Shell.libGet(); delete lib[id]; Shell.libPut(lib); }
    static libBytes(id) {
      const lib = Shell.libGet();
      return lib[id] ? AC2.bytesFromB64(lib[id].b64) : null;
    }
  }

  AC2.Shell = Shell;
})();
