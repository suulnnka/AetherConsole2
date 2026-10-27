/* js/host/bios.js — BIOS(§7):启动特效(SEGA 式)、系统菜单(卡带库)、存档管理、关于、暂停浮层
 * BIOS 恒用模式2 自绘 + 内置字体(§7.4);开机 jingle 走 BIOS 自有音色,不占游戏通道。
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};

  // 卡带库(两端通用;浏览器 localStorage / Node 内存)
  const Lib = {
    get() {
      try { return JSON.parse(this._st().getItem('ac2.lib') || '{}'); } catch (e) { return {}; }
    },
    put(lib) { this._st().setItem('ac2.lib', JSON.stringify(lib)); },
    _st() {
      if (this._mem) return this._mem;
      if (typeof localStorage !== 'undefined') return localStorage;
      return this._mem = {
        _m: new Map(),
        getItem: (k) => this._mem._m.has(k) ? this._mem._m.get(k) : null,
        setItem: (k, v) => this._mem._m.set(k, String(v)),
        removeItem: (k) => this._mem._m.delete(k)
      };
    },
    async add(bytes) {
      const cart = await AC2.Cart.load(bytes);
      const lib = this.get();
      const prev = lib[cart.id];
      if (prev && prev.version > cart.version) return { cart, replaced: false }; // 按 ID 去重:保留高版本(§7.3)
      lib[cart.id] = { version: cart.version, title: cart.title, mode: cart.mode, b64: AC2.b64FromBytes(bytes), added: Date.now() || 0 };
      this.put(lib);
      return { cart, replaced: true };
    },
    remove(id) { const lib = this.get(); delete lib[id]; this.put(lib); },
    bytes(id) {
      const lib = this.get();
      return lib[id] ? AC2.bytesFromB64(lib[id].b64) : null;
    },
    list() {
      const lib = this.get();
      // 按 ID 去重由 Map 天然保证;列出并按标题排序
      return Object.keys(lib).map(id => ({ id, ...lib[id] })).sort((a, b) => (a.title || '').localeCompare(b.title || ''));
    }
  };
  AC2.Lib = Lib;

  class BIOS {
    constructor(machine) {
      this.m = machine;
      this.state = 'boot';
      this.t = 0;
      this.sel = 0;
      this.page = 0;             // 0 卡带页;1 系统页
      this.items = [];
      this.coversLoaded = false;
      this.loading = null;
      this.errorMsg = null;
      this.errorT = 0;
      this.saveSel = 0;
      this.confirmDel = false;
      this.aboutT = 0;
      this.bootDone = false;
      this._jingled = false;
    }

    enterMenu() {
      this.state = 'menu';
      this.m.state = 'menu';
      this.page = 0;
      this.sel = 0;
      this.loading = null;
      this.m.setMode(2);
      this.reloadList();
    }

    reloadList() {
      this.items = Lib.list();
      const R = this.m.m2;
      this.items.forEach((it, i) => {
        const bytes = AC2.bytesFromB64(it.b64);
        // 只读封面(BIOS 零解压直读,§11.2)
        const px = bytes.subarray(64, 64 + 1024);
        R.loadBitmapRaw('cov' + i, { w: 32, h: 32, px: px.slice(), tmask: new Uint8Array(1024) });
      });
      this.coversLoaded = true;
    }

    // ---------- 暂停浮层(游戏中 Start+Left,§7.1) ----------
    pauseGame() {
      const m = this.m;
      if (m.state !== 'game' || m.paused) return;
      m.paused = true;
      m.state = 'pause';
      this.state = 'pause';
      this.pauseSel = 0;
      if (m.audio) m.audio.lastOutput.fill(255); // 数字静音
    }
    resumeGame() {
      const m = this.m;
      m.paused = false;
      m.state = 'game';
      this.state = 'menu';
    }

    // ---------- 每帧 ----------
    update() {
      this.t++;
      switch (this.state) {
        case 'boot': this.updateBoot(); break;
        case 'menu': this.updateMenu(); break;
        case 'saves': this.updateSaves(); break;
        case 'about': this.updateAbout(); break;
        case 'pause': this.updatePause(); break;
      }
    }

    // ---------- 启动特效(§7.2,约 2.0s 不可跳过) ----------
    updateBoot() {
      const m = this.m, R = m.m2, f = this.t;
      R.clear(0);
      const cx = 120, cy = 74;
      const logo = 'AETHERCONSOLE';
      const logo2 = '2';
      if (f >= 12 && f < 48) {
        // 由深处飞入(0.6s):缩放 + 拖影
        const p = (f - 12) / 36;
        const ease = 1 - Math.pow(1 - p, 3);
        const scale = 0.12 + 0.88 * ease;
        // 拖影:三个历史位置,灰阶递减(棋盘抖动式,无混合 §6.6)
        for (let k = 3; k >= 1; k--) {
          const pe = Math.max(0, (f - 12 - k * 3) / 36);
          if (pe <= 0) continue;
          const ee = 1 - Math.pow(1 - pe, 3);
          const sc = 0.12 + 0.88 * ee;
          const col = 235 + k;
          R.text(cx, cy - 8 - (1 - ee) * 30, logo, { color: col, scale: sc, font: 'bios' });
        }
        R.text(cx, cy - 8 - (1 - ease) * 30, logo, { color: 15, scale: scale });
        R.text(cx + 88, cy - 8 - (1 - ease) * 30, logo2, { color: 196, scale: scale * 1.4 });
      } else if (f >= 48) {
        // 定格 + jingle + 闪白一次
        if (!this._jingled) {
          this._jingled = true;
          this.playJingle();
        }
        if (f < 54) {
          // 闪白 6 帧(渐密抖动)
          this.dither(15, (54 - f) / 6);
        }
        R.text(cx, cy - 8, logo, { color: 15, scale: 1 });
        R.text(cx + 88, cy - 8, logo2, { color: 196, scale: 1.4 });
        R.text(cx - 60, cy + 16, 'FANTASY CONSOLE 240x176', { color: 245, scale: 1 });
      }
      if (f >= 96 && f < 118) {
        // 渐隐(棋盘抖动密度递增)
        this.dither(0, (f - 96) / 22);
      }
      if (f >= 118) {
        this.enterMenu();
      }
    }

    // 无混合时代的"透明感":棋盘/噪声抖动覆盖(§6.6 手法表)
    dither(color, density) {
      const fb = this.m.fb, W = 240;
      const th = Math.max(0, Math.min(1, density));
      const n = (th * 65536) | 0;
      let seed = 0x9E3779B9;
      for (let i = 0; i < fb.length; i++) {
        seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
        if ((seed & 0xFFFF) < n) fb[i] = color;
      }
    }

    playJingle() {
      const a = this.m.audio;
      if (!a) return;
      // 上滑音(0.25s)+ 三和弦收尾(~0.8s)
      a.addTimbre({ family: 'fc', wave: 1, adsr: [0.005, 0.05, 0.6, 0.3], vol: 0.35, glide: 0.18 }, 60);
      a.addTimbre({ family: 'fc', wave: 5, adsr: [0.01, 0.4, 0.0, 0.5], vol: 0.22 }, 61);
      a.ch(6).set('timbre', 60);
      a.ch(7).set('timbre', 61);
      a.ch(6).note(220, 0.22);           // glide 拉到目标
      a.chans[6].voice.targetFreq = 880;
      this._chordAt = 16;                // ~0.27s 后三和弦
      this._chordNotes = [69, 73, 76];
    }

    // ---------- 系统菜单(§7.3) ----------
    updateMenu() {
      const m = this.m, R = m.m2, pad = m.input.pad;
      // jingle 和弦(挂帧推进)
      if (this._chordAt != null && this.t >= 0 && this._chordAt-- <= 0) {
        const a = m.audio;
        a.addTimbre({ family: 'fc', wave: 1, adsr: [0.01, 0.3, 0.4, 0.5], vol: 0.16 }, 61);
        for (let i = 0; i < 3; i++) {
          a.ch(7).set('timbre', 61);
          a.ch(7).note(AC2.midiHz(this._chordNotes[i]), 0.7);
        }
        this._chordAt = null;
      }
      R.clear(16);
      R.rect(0, 0, 240, 14, 236, true);
      R.text(4, 1, this.page === 0 ? 'AETHERCONSOLE 2 · GAME LIB' : 'AETHERCONSOLE 2 · SYSTEM', { color: 16 });
      R.text(160, 1, AC2.FW_VER, { color: 244 });

      if (this.page === 0) this.menuGrid(pad);
      else this.menuSystem(pad);

      if (this.errorMsg) {
        const t = Math.floor(this.errorT / 20) & 1;
        if (t) R.text(4, 162, '! ' + this.errorMsg, { color: 196 });
        if (++this.errorT > 180) { this.errorMsg = null; this.errorT = 0; }
      }
      if (this.loading) {
        R.rect(60, 70, 120, 36, 0, true);
        R.rect(60, 70, 120, 36, 250, false);
        R.text(72, 82, 'LOADING ' + this.loading, { color: 15 });
      }
    }

    menuGrid(pad) {
      const R = this.m.m2;
      const items = this.items;
      // 网格:2 列 × 2 行可见(64px 封面 2×),+ 底部两个系统入口
      const COLS = 3, ROWS = 2;
      const cells = [];
      for (let i = 0; i < items.length && cells.length < COLS * ROWS; i++) cells.push({ kind: 'cart', i });
      cells.push({ kind: 'sys', label: 'SAVES' });
      cells.push({ kind: 'sys', label: 'ABOUT' });
      if (pad.right.pressed && this.sel < cells.length - 1) this.sel++;
      if (pad.left.pressed && this.sel > 0) this.sel--;
      if (pad.down.pressed && this.sel + COLS < cells.length) this.sel += COLS;
      if (pad.up.pressed && this.sel - COLS >= 0) this.sel -= COLS;

      cells.forEach((c, idx) => {
        const col = idx % COLS, row = (idx / COLS) | 0;
        const x = 12 + col * 76, y = 24 + row * 66;
        if (c.kind === 'cart') {
          const it = items[c.i];
          R.blitFast('cov' + c.i, x, y);
          R.rect(x - 1, y - 1, 66, 66, 236, false);
          R.text(x, y + 2 + 62, it.title.slice(0, 10), { color: 15 });
          R.text(x, y + 2 + 62 + 12, it.id + ' v' + it.version, { color: 8 });
        } else {
          R.rect(x, y + 16, 64, 30, 236, true);
          R.rect(x, y + 16, 64, 30, 250, false);
          R.text(x + 6, y + 26, c.label, { color: 15 });
        }
        if (idx === this.sel) {
          // 选中框:四角括号
          const bx = x - 3, by = (c.kind === 'cart' ? y - 3 : y + 13);
          const bw = 70, bh = c.kind === 'cart' ? 90 : 36;
          R.line(bx, by, bx + 8, by, 46, 2); R.line(bx, by, bx, by + 8, 46, 2);
          R.line(bx + bw - 8, by, bx + bw, by, 46, 2); R.line(bx + bw, by, bx + bw, by + 8, 46, 2);
          R.line(bx, by + bh - 8, bx, by + bh, 46, 2); R.line(bx, by + bh, bx + 8, by + bh, 46, 2);
          R.line(bx + bw - 8, by + bh, bx + bw, by + bh, 46, 2); R.line(bx + bw, by + bh - 8, bx + bw, by + bh, 46, 2);
        }
      });
      R.text(4, 166, 'DPAD:sel  A/ENTER:boot  cart=' + this.items.length + '  [no cart? drop .aec / import]', { color: 244 });

      const sel = cells[this.sel];
      if (sel) {
        if (sel.kind === 'cart' && (pad.a.pressed || pad.start.pressed)) {
          this.launch(sel.i);
        } else if (sel.kind === 'sys' && (pad.a.pressed || pad.start.pressed)) {
          this.state = sel.label === 'SAVES' ? 'saves' : 'about';
          this.saveSel = 0; this.confirmDel = false; this.aboutT = 0;
          if (this.state === 'saves') this.saveList = this.buildSaveList();
        }
      }
    }

    async launch(i) {
      const it = this.items[i];
      if (!it || this.loading) return;
      this.loading = it.title.slice(0, 10);
      try {
        const bytes = Lib.bytes(it.id);
        const cart = await AC2.Cart.load(bytes);
        if (this.m.audio) this.m.audio.stopAll();
        this.m.bootCart(cart);
        this.state = 'menu'; // machine.state = 'game' 接管
      } catch (e) {
        this.errorMsg = 'ERR ' + (it.id || '?') + ': ' + e.message.slice(0, 40);
        this.loading = null;
      }
    }

    menuSystem(pad) {
      const R = this.m.m2;
      const lines = [
        'FIRMWARE ' + AC2.FW_VER,
        'DISPLAY   240x176 ANSI256',
        'MODES     1:SPRITE  2:RASTER',
        'AUDIO     24kHz 8bit u-law',
        'CHANNELS  8 (FC/FM/AN/SMP)',
        'CART      .aec <=256KB',
        'SAVE      2048B / game',
        '',
        'B: back'
      ];
      lines.forEach((l, i) => R.text(12, 26 + i * 14, l, { color: i === lines.length - 1 ? 8 : 15 }));
      if (pad.b.pressed) this.page = 0;
    }

    buildSaveList() {
      return Lib.list().map(it => {
        const key = 'ac2.save.' + it.id;
        const raw = this.m.storage.getItem(key);
        let ok = false, when = 0;
        if (raw) {
          try {
            const buf = AC2.bytesFromB64(raw);
            ok = buf.length >= 8 && buf[0] === 0x53 && buf[1] === 0x41;
            when = it.added || 0;
          } catch (e) { ok = false; }
        }
        return { id: it.id, title: it.title, ok, key, when };
      });
    }

    updateSaves() {
      const m = this.m, R = m.m2, pad = m.input.pad;
      R.clear(16);
      R.rect(0, 0, 240, 14, 236, true);
      R.text(4, 1, 'SAVE MANAGER', { color: 16 });
      const list = this.saveList || (this.saveList = this.buildSaveList());
      if (pad.up.pressed && this.saveSel > 0) this.saveSel--;
      if (pad.down.pressed && this.saveSel < list.length - 1) this.saveSel++;
      list.forEach((s, i) => {
        const y = 22 + i * 16;
        R.text(8, y, (i === this.saveSel ? '>' : ' ') + s.title.slice(0, 14), { color: i === this.saveSel ? 46 : 15 });
        R.text(150, y, s.ok ? '[SAVED]' : '[ ---- ]', { color: s.ok ? 40 : 240 });
        if (i === this.saveSel && this.confirmDel && s.ok) R.text(150, y, 'DEL? A=y B=n', { color: 196 });
      });
      R.text(4, 158, 'A:del  X:export .sav  B:back', { color: 8 });
      const s = list[this.saveSel];
      if (s) {
        if (pad.b.pressed) { this.confirmDel = false; this.state = 'menu'; }
        if (s.ok && pad.a.pressed) {
          if (this.confirmDel) { m.storage.removeItem(s.key); this.saveList = this.buildSaveList(); this.confirmDel = false; this.errorMsg = 'DELETED ' + s.id; this.errorT = 0; }
          else this.confirmDel = true;
        }
        if (s.ok && pad.b.released) this.confirmDel = false;
        if (s.ok && pad.a.released) { /* noop */ }
        // 导出(浏览器)
        if (s.ok && typeof document !== 'undefined' && this._expBtn && this._expBtn.clicked) {
          this._expBtn.clicked = false;
          this.downloadSav(s);
        }
      }
    }

    downloadSav(s) {
      if (typeof document === 'undefined') return;
      const raw = this.m.storage.getItem(s.key);
      const blob = new Blob([AC2.bytesFromB64(raw)], { type: 'application/octet-stream' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = s.id + '.sav';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }

    updateAbout() {
      const R = this.m.m2, pad = this.m.input.pad;
      this.aboutT++;
      R.clear(16);
      R.text(60, 30, 'AETHERCONSOLE 2', { color: 15, scale: 1 });
      R.text(84, 48, AC2.FW_VER, { color: 46 });
      R.text(30, 70, '240x176 / ANSI256 / 60fps', { color: 250 });
      R.text(30, 84, '24kHz u-law / 8ch', { color: 250 });
      R.text(30, 98, 'cart .aec <=256KB / save 2KB', { color: 250 });
      if ((this.aboutT >> 4) & 1) R.text(84, 130, 'B: BACK', { color: 8 });
      if (pad.b.pressed) this.state = 'menu';
    }

    // ---------- 暂停浮层(§7.1:返回菜单/重启卡带/存档管理) ----------
    updatePause() {
      const m = this.m, R = m.m2, pad = m.input.pad;
      // 覆盖在最后画面上:半透明 → 棋盘抖动(§6.6 官方手法)
      this.dither(16, 0.55);
      R.rect(52, 46, 136, 84, 236, true);
      R.rect(52, 46, 136, 84, 15, false);
      R.text(92, 52, 'PAUSE', { color: 15 });
      const items = ['RESUME', 'RESTART CART', 'SAVE MGMT', 'EXIT TO MENU'];
      items.forEach((it, i) => {
        R.text(84, 70 + i * 14, (i === this.pauseSel ? '> ' : '  ') + it, { color: i === this.pauseSel ? 46 : 250 });
      });
      if (pad.up.pressed && this.pauseSel > 0) this.pauseSel--;
      if (pad.down.pressed && this.pauseSel < items.length - 1) this.pauseSel++;
      if (pad.a.pressed || pad.start.pressed) {
        switch (this.pauseSel) {
          case 0: this.resumeGame(); break;
          case 1: m.paused = false; m.state = 'game'; this.state = 'menu'; m.resetCart(); break;
          case 2: this.state = 'saves'; this.saveSel = 0; this.saveList = this.buildSaveList(); break;
          case 3: m.paused = false; m.exitToMenu(); break;
        }
      }
      if (pad.b.pressed) this.resumeGame();
    }
  }

  AC2.FW_VER = 'FW 1.0 (spec v0.9)';
  AC2.BIOS = BIOS;
})();
