/* js/host/machine.js — 主机内核(§5):帧时序、内存区、模式切换、生命周期、存档、随机
 * 帧模型:固定步长 1/60s,不追帧;单帧 = 输入采样(壳)→ aJS update() → 显示合成 → 音频推进 400 样本。
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};

  const W = 240, H = 176;

  function defaultStorage() {
    if (typeof localStorage !== 'undefined') return localStorage;
    const mem = new Map();
    return {
      getItem: (k) => mem.has(k) ? mem.get(k) : null,
      setItem: (k, v) => { mem.set(k, String(v)); },
      removeItem: (k) => { mem.delete(k); }
    };
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  class Machine {
    constructor(opts) {
      opts = opts || {};
      this.W = W; this.H = H;
      this.fb = new Uint8Array(W * H);
      this.storage = opts.storage || defaultStorage();
      this.input = new AC2.InputState();
      this.audio = (opts.audio === false) ? null : new AC2.AudioEngine();
      this.frameCount = 0;
      this.mode = 0;                        // 未初始化;装载/BIOS 进入时设置
      this.cart = null;
      this.game = null;                     // {init, update, env, src}
      this.error = null;
      this.halted = false;
      this.paused = false;
      this.state = 'boot';                  // boot | menu | game | pause
      this.bios = null;                     // M5 接入
      this.onStateChange = null;
      this.onError = null;
      this.printLog = [];
      this.sampling = 'auto';
      // 调试设备钩子(§13.6)
      this.debugHooks = {
        apiBreaks: new Set(),      // API 名集合
        onApiCall: null,           // (name) → bool(halt)
        bpLines: new Set(),        // aJS 行断点
        onLineBp: null,            // (line) → bool(halt)
        watchReads: null           // [{start,end,label}] VRAM/ARAM 读写断点(以 API 粒度)
      };
      this.breakHit = null;        // {type:'api'|'line', info, frame}
      this.snapshots = [];         // 步退快照环(≤300)
      this.maxSnapshots = 300;
      this._rng = mulberry32(opts.seed != null ? (opts.seed >>> 0) : 0xA11CE);
      this._modeSwitches = [];
      // 资源区
      this.m1 = AC2.createMode1(this);
      this.m2 = AC2.createMode2(this);
      this.fonts = { bios: AC2.Font.fromBuiltin() };
      this.bios = (opts.bios === false || !AC2.BIOS) ? null : new AC2.BIOS(this);
      this._biosText = [];
      this.biosApi = Object.freeze({
        text: (x, y, str, opt) => {
          if (this.mode === 2) this.m2.text(x, y, str, Object.assign({ font: 'bios' }, opt));
          else this._biosText.push([x, y, String(str), opt || {}]);
        },
        reset: () => this.resetCart(),
        exit: () => this.exitToMenu(),
        print: (...a) => this.biosPrint(...a),
        cartridges: () => AC2.Lib.list().map(it => ({ id: it.id, title: it.title, version: it.version })),
        saveList: (id) => { const raw = this.storage.getItem('ac2.save.' + id); return raw ? [id] : []; }
      });
      // 统计(§12.4 性能可见性)
      this.stats = {
        logicMs: 0, drawMs: 0, audioMs: 0, totalMs: 0,
        history: [], overRate: 0, _over: 0, _n: 0
      };
      this.buildAPI();
    }

    // ---------- API 对象(冻结,§12.5) ----------
    buildAPI() {
      const m = this;
      const m1 = this.m1, m2 = this.m2;

      const S = {
        loadTiles: (dst, seg, off, n) => m1.loadTiles(dst, seg, off, n),
        mapSize: (l, w, h) => m1.mapSize(l, w, h),
        loadMap: (l, seg, off) => m1.loadMap(l, seg, off),
        setMap: (l, x, y, w, h, e) => m1.setMap(l, x, y, w, h, e),
        setTile: (l, x, y, e) => m1.setTile(l, x, y, e),
        entry: (t, fh, fv) => m1.entry(t, fh, fv),
        scroll: (l, x, y) => m1.scroll(l, x, y),
        backdrop: (c) => m1.setBackdrop(c),
        setSprite: (i, a) => m1.setSprite(i, a),
        hide: (i) => m1.hide(i),
        clear: () => { m1.layers[0].sx = 0; m1.layers[0].sy = 0; m1.layers[1].sx = 0; m1.layers[1].sy = 0; m1.hideAll(); },
        get dropped() { return m1.droppedLines; }
      };

      const R = {
        loadBitmap: (id, seg, off) => m2.loadBitmap(id, seg, off),
        loadVector: (id, seg, off) => m2.loadVector(id, seg, off),
        bitmap: (id) => m2.bitmap(id),
        unload: (id) => m2.unload(id),
        setRepeat: (id, on) => m2.setRepeat(id, on),
        clear: (c) => m2.clear(c),
        setMatrix: (mm) => m2.setMatrix(mm),
        push: () => m2.push(),
        pop: () => m2.pop(),
        identity: () => m2.identity(),
        translate: (x, y) => m2.translate(x, y),
        scale: (sx, sy) => m2.scale(sx, sy),
        rotate: (a) => m2.rotate(a),
        pset: (x, y, c) => m2.pset(x, y, c),
        pget: (x, y) => m2.pget(x, y),
        line: (x0, y0, x1, y1, c, w) => m2.line(x0, y0, x1, y1, c, w),
        rect: (x, y, w, h, c, fill) => m2.rect(x, y, w, h, c, fill),
        poly: (pts, opt) => m2.poly(pts, opt),
        triTex: (p0, p1, p2, u0, u1, u2, t) => m2.triTex(p0, p1, p2, u0, u1, u2, t),
        blit: (id, x, y, opt) => (opt == null && isT(m2.matrix)) ? m2.blitFast(id, Math.round(x), Math.round(y)) : m2.blit(id, x, y, opt),
        blitRot: (id, x, y, opt) => m2.blit(id, x, y, opt),
        text: (x, y, s, o) => m2.text(x, y, s, o),
        get matrix() { return m2.matrix; }
      };
      function isT(mm) { return mm[0] === 1 && mm[1] === 0 && mm[2] === 0 && mm[3] === 1 && mm[4] === 0 && mm[5] === 0; }

      const A = m.audio ? Object.freeze({
        playTrack: (n) => m.audio.playTrack(n),
        stopTrack: () => m.audio.stopTrack(),
        playSfx: (n, o) => m.audio.playSfx(n, o),
        ch: (i) => m.audio.ch(i),
        volume: (v) => m.audio.volume(v),
        stopAll: () => m.audio.stopAll()
      }) : Object.freeze({});

      this.A = A;
      const wrap = (obj) => {
        const out = {};
        for (const k of Object.keys(obj)) {
          const v = obj[k];
          if (typeof v === 'function') {
            out[k] = function (...args) {
              const dh = m.debugHooks;
              if (dh && dh.apiBreaks && dh.apiBreaks.has(k)) {
                if (m.debugHooks.onApiCall) m.debugHooks.onApiCall(k);
              }
              return v.apply(this, args);
            };
          } else out[k] = v;
        }
        return out;
      };
      this.S = Object.freeze(wrap(S));
      this.R = Object.freeze(wrap(R));
      this._Araw = A;
      this.A = Object.freeze(wrap(A));
    }

    setMode(mode) {
      mode = mode | 0;
      if (mode !== 1 && mode !== 2) throw new Error('setMode: 1 或 2');
      if (this.mode === mode) return;
      this.mode = mode;
      this._modeSwitches.push(this.frameCount);
      // 切换清空 VRAM 与 OAM(§6.5)
      this.m1.reset();
      this.m2.reset();
      this.fb.fill(0);
      if (this.debugHooks && this.debugHooks.onModeSwitch) this.debugHooks.onModeSwitch(mode, this.frameCount);
    }

    // 高频切换告警(调试设备,§6.5)
    modeSwitchRate() {
      const cut = this.frameCount - 60;
      return this._modeSwitches.filter(f => f > cut).length;
    }

    // ---------- 生命周期 ----------
    bootCart(cart) {
      this.cart = cart;
      this.error = null;
      this.halted = false;
      this.state = 'game';
      this.mode = 0;
      this.setMode(cart.mode);
      this.sampling = cart.sampling || 'auto';
      this.m2.setSampling(this.sampling);
      // 卡带字体
      this.fonts.cart = null;
      const fontSeg = cart.seg('font', 0);
      if (fontSeg) {
        try { this.fonts.cart = AC2.Font.parse(fontSeg.data); } catch (e) { this.fonts.cart = null; }
      }
      // 音频段(音色/pattern/music/采样)
      if (this.audio) {
        const audioSeg = cart.seg('audio', 0);
        if (audioSeg) {
          try {
            const data = JSON.parse(new TextDecoder().decode(audioSeg.data));
            this.audio.loadAudioData(data);
          } catch (e) { this.biosPrint('audio 段解析失败: ' + e.message); }
        }
      }
      // aJS
      const codeSeg = cart.seg('code', 0);
      if (!codeSeg) { this._halt(new Error('卡带无 code 段')); return; }
      const src = new TextDecoder().decode(codeSeg.data);
      this.game = AC2.AJS.compile(src, this);
      if (this.onStateChange) this.onStateChange(this.state);
      try {
        if (this.game.init) this.game.init();
      } catch (e) { this._halt(e); }
    }

    exitToMenu() {
      this.cart = null;
      this.game = null;
      this.error = null;
      this.halted = false;
      this.state = 'menu';
      this.mode = 0;
      this.setMode(2);
      if (this.audio) this.audio.stopAll();
      if (this.bios) this.bios.enterMenu();
      if (this.onStateChange) this.onStateChange(this.state);
    }

    resetCart() {
      if (this.cart) {
        const cart = this.cart;
        if (this.audio) this.audio.stopAll();
        this.bootCart(cart);
      }
    }

    _halt(e) {
      this.halted = true;
      this.error = {
        message: e && e.message ? e.message : String(e),
        stack: e && e.stack ? e.stack : '',
        frame: this.frameCount
      };
      if (this.onError) this.onError(this.error);
    }

    // ---------- 调试 ----------
    lineBpCheck(line) {
      if (this.breakHit || !this.debugHooks.bpLines.has(line)) return;
      if (this.debugHooks.onLineBp) this.debugHooks.onLineBp(line);
    }
    haltByBp(type, info) {
      this.breakHit = { type, info, frame: this.frameCount };
    }
    resumeFromBp() {
      this.breakHit = null;
      this.paused = false;
    }
    captureSnapshot() {
      const m1 = this.m1;
      const snap = {
        frame: this.frameCount, mode: this.mode,
        fb: this.fb.slice(),
        m1: {
          bgColor: m1.bg.colors.slice(), bgMask: m1.bg.mask.slice(), bgCount: m1.bg.count,
          objColor: m1.obj.colors.slice(), objMask: m1.obj.mask.slice(), objCount: m1.obj.count,
          layers: m1.layers.map(L => ({ w: L.w, h: L.h, entries: L.entries.slice(), sx: L.sx, sy: L.sy })),
          oam: m1.oam.map(s => Object.assign({}, s)),
          backdrop: m1.backdrop
        },
        input: this.input.snapshotKeys(),
        rngState: this._rngSave()
      };
      this.snapshots.push(snap);
      if (this.snapshots.length > this.maxSnapshots) this.snapshots.shift();
      return snap;
    }
    restoreSnapshot(snap) {
      this.frameCount = snap.frame;
      this.fb.set(snap.fb);
      if (this.mode !== snap.mode) { this.mode = 0; this.setMode(snap.mode); }
      const m1 = this.m1, s1 = snap.m1;
      m1.bg.colors.set(s1.bgColor); m1.bg.mask.set(s1.bgMask); m1.bg.count = s1.bgCount;
      m1.obj.colors.set(s1.objColor); m1.obj.mask.set(s1.objMask); m1.obj.count = s1.objCount;
      m1.layers.forEach((L, i) => {
        const d = s1.layers[i];
        if (d.w !== L.w || d.h !== L.h) { L.w = d.w; L.h = d.h; L.entries = new Uint16Array(d.entries); }
        else L.entries.set(d.entries);
        L.sx = d.sx; L.sy = d.sy;
      });
      m1.oam.forEach((s, i) => Object.assign(s, s1.oam[i]));
      m1.setBackdrop(s1.backdrop);
      this._rngRestore(snap.rngState);
    }
    _rngSave() { return this._rngS = this._rngS || { get: this._rng }; }
    _rngRestore(st) { if (st && st.get) this._rng = st.get; }

    // ---------- 帧 ----------
    step() {
      if (this.halted) return;
      if (this.breakHit) return;   // 断点挂起(调试设备继续后恢复)
      if (!this.paused && this.snapshots.length >= 0 && this._snapOn) this.captureSnapshot();
      if (this.paused) {
        // 系统暂停(§5.1):逻辑/音序器/输入沿一并冻结;浮层仍绘制
        if (this.state === 'pause' && this.bios) {
          try { this.bios.update(); } catch (e) { this._halt(e); }
        }
        return;
      }
      const t0 = performance.now();
      this.frameCount++;
      this.debugFrameStart && this.debugFrameStart();
      // Start+方向左 → 暂停浮层(§7.1)
      if (this.state === 'game' && this.bios && this.input.pad.start.down && this.input.pad.left.pressed) {
        this.bios.pauseGame();
        return;
      }
      if (this.mode === 1) this.m1.frameStart();
      try {
        if (this.state === 'game' && this.game && this.game.update) this.game.update();
        else if (this.bios && (this.state === 'boot' || this.state === 'menu' || this.state === 'pause')) this.bios.update();
      } catch (e) {
        this._halt(e);
      }
      const t1 = performance.now();
      if (this.mode === 1) {
        this.m1.compose(this.fb);
        for (const t of this._biosText) this.m2.text(t[0], t[1], t[2], Object.assign({ font: 'bios' }, t[3]));
        this._biosText.length = 0;
      }
      const t2 = performance.now();
      if (this.audio) this.audio.step();
      const t3 = performance.now();
      const s = this.stats;
      s.logicMs = t1 - t0; s.drawMs = t2 - t1; s.audioMs = t3 - t2; s.totalMs = t3 - t0;
      s._n++;
      if (s.totalMs > 16.67) s._over++;
      s.overRate = s._over / s._n;
      if (s.history.length > 240) s.history.splice(0, s.history.length - 240);
      s.history.push([s.logicMs, s.drawMs, s.audioMs]);
    }

    // ---------- 随机与时间(§12.1) ----------
    frame() { return this.frameCount; }
    rng(seed) {
      if (seed != null) { this._rng = mulberry32(seed >>> 0); return; }
      return this._rng();
    }

    // ---------- 存档(§10.2) ----------
    saveKey() { return 'ac2.save.' + (this.cart ? this.cart.id : 'BIOS'); }
    save(bytes) {
      if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes || []);
      if (bytes.length > 2048) throw new Error('存档超限:' + bytes.length + ' > 2048');
      let sum = 0;
      for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i]) & 0xFFFF;
      const out = new Uint8Array(4 + 2 + bytes.length + 2);
      out.set([0x53, 0x41, 0x56, 0x32], 0); // "SAV2"
      out[4] = bytes.length & 255; out[5] = bytes.length >> 8;
      out.set(bytes, 6);
      out[6 + bytes.length] = sum & 255; out[6 + bytes.length + 1] = sum >> 8;
      this.storage.setItem(this.saveKey(), AC2.b64FromBytes(out));
      return true;
    }
    loadSave() {
      const s = this.storage.getItem(this.saveKey());
      if (!s) return null;
      try {
        const buf = AC2.bytesFromB64(s);
        if (buf.length < 8 || buf[0] !== 0x53 || buf[1] !== 0x41 || buf[2] !== 0x56 || buf[2 + 1] !== 0x32) return null;
        const len = buf[4] | (buf[5] << 8);
        if (buf.length < 8 + len) return null;
        let sum = 0;
        const data = buf.subarray(6, 6 + len);
        for (let i = 0; i < len; i++) sum = (sum + data[i]) & 0xFFFF;
        const got = buf[6 + len] | (buf[6 + len + 1] << 8);
        if (sum !== got) return null; // 校验失败 → 空档(§10.2 损坏即报告,不崩)
        return data.slice();
      } catch (e) { return null; }
    }
    hasSave() { return !!this.storage.getItem(this.saveKey()); }
    deleteSave() { this.storage.removeItem(this.saveKey()); }

    biosPrint(...args) {
      const line = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
      this.printLog.push({ frame: this.frameCount, line });
      if (this.printLog.length > 500) this.printLog.shift();
    }
  }

  // base64 工具(两端通用)
  AC2.b64FromBytes = function (bytes) {
    let bin = '';
    const CH = 8192;
    for (let i = 0; i < bytes.length; i += CH) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return typeof btoa !== 'undefined' ? btoa(bin) : Buffer.from(bin, 'binary').toString('base64');
  };
  AC2.bytesFromB64 = function (b64) {
    const bin = typeof atob !== 'undefined' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  AC2.Machine = Machine;
})();
