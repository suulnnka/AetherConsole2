/* js/host/input.js — 输入状态(§9):虚拟键位 7 键 + 光标;双查询视图 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};

  const KEYS = ['up', 'down', 'left', 'right', 'a', 'b', 'start'];

  class InputState {
    constructor() {
      this._down = {};      // 键名 → bool
      this._pressed = {};
      this._released = {};
      for (const k of KEYS) { this._down[k] = false; this._pressed[k] = false; this._released[k] = false; }
      this._rawPrev = {};   // 上一帧物理快照(算沿)
      for (const k of KEYS) this._rawPrev[k] = false;
      this.mouseX = 0; this.mouseY = 0; this.dx = 0; this.dy = 0;

      const self = this;
      const mkBtn = (k) => ({
        get down() { return self._down[k]; },
        get pressed() { return self._pressed[k]; },
        get released() { return self._released[k]; }
      });
      const btn = {}; for (const k of KEYS) btn[k] = mkBtn(k);
      this.pad = btn;
      this.mouse = {
        get left() { return self._down.a; }, get right() { return self._down.b; },
        get x() { return self.mouseX; }, get y() { return self.mouseY; },
        get dx() { return self.dx; }, get dy() { return self.dy; }
      };
      // 录制/回放钩子(调试设备 §13.6)
      this.recorder = null;   // {frames: []}
      this.replay = null;     // {frames: [], i: 0}
      this._lastSnapshot = null;
    }

    // 壳每帧调用:snapshot = {keys:{up:bool,...}, x, y, dx, dy}(坐标已换算到 240×176)
    pushInput(snap) {
      if (this.replay) {
        // 回放模式:忽略物理输入,吃录制帧(确定性保证)
        snap = this.replay.frames[this.replay.i % this.replay.frames.length];
        this.replay.i++;
        if (this.replay.oneShot && this.replay.i >= this.replay.frames.length) this.replay = null;
      }
      if (this.recorder) {
        this.recorder.frames.push({
          keys: Object.assign({}, snap.keys), x: snap.x, y: snap.y, dx: snap.dx, dy: snap.dy
        });
      }
      for (const k of KEYS) {
        const now = !!snap.keys[k];
        this._pressed[k] = now && !this._rawPrev[k];
        this._released[k] = !now && this._rawPrev[k];
        this._down[k] = now;
        this._rawPrev[k] = now;
      }
      this.mouseX = snap.x; this.mouseY = snap.y;
      this.dx = snap.dx; this.dy = snap.dy;
    }

    // 内部直接注入(虚拟手柄面板/BIOS 暂停键合成)
    injectKey(name, down) {
      const now = !!down;
      this._pressed[name] = now && !this._down[name];
      this._released[name] = !now && this._down[name];
      this._down[name] = now;
    }

    snapshotKeys() { return Object.assign({}, this._down); }
  }

  AC2.InputState = InputState;
  AC2.INPUT_KEYS = KEYS;
})();
