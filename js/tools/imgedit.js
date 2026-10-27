/* js/tools/imgedit.js — 图像编辑器(§13.2):精灵绘制 / 地图绘制 / 自由绘制 三模式
 * 公共:ANSI 256 直填、1bit 透明(棋盘格显示)、撤销重做(100)、草稿自动保存、导出卡带段。
 */
(function () {
  'use strict';
  const { ANSI } = AC2;
  const $ = (id) => document.getElementById(id);
  const TAU = Math.PI * 2;

  // ---------- 公共状态 ----------
  const state = {
    mode: 'sprite',          // sprite | map | free
    color: 15,
    tool: 'pen',             // pen | era | fill | line | rect | pick | dither | shift | mirror
    zoom: 8,
    showGrid: true,
    onion: true,
    ditherColor2: 0,
    // 撤销栈(每文档独立)
    undo: { sprite: [], map: [], free: [] },
    redo: { sprite: [], map: [], free: [] }
  };

  // ---------- 渲染工具 ----------
  function drawIndexCanvas(cv, px, tmask, w, h, zoom, opts) {
    opts = opts || {};
    cv.width = w * zoom; cv.height = h * zoom;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    // 棋盘格底(透明显示,§6.6)
    const ck = 8;
    for (let y = 0; y < cv.height; y += ck) for (let x = 0; x < cv.width; x += ck) {
      ctx.fillStyle = (((x / ck) + (y / ck)) & 1) ? '#3a3a44' : '#2c2c34';
      ctx.fillRect(x, y, ck, ck);
    }
    const img = ctx.createImageData(w, h);
    const u32 = new Uint32Array(img.data.buffer);
    for (let i = 0; i < w * h; i++) {
      const r = ANSI.rgbTable[px[i] * 3], g = ANSI.rgbTable[px[i] * 3 + 1], b = ANSI.rgbTable[px[i] * 3 + 2];
      u32[i] = tmask[i] ? 0 : (0xFF << 24) | (b << 16) | (g << 8) | r;
    }
    const tmp = document.createElement('canvas');
    tmp.width = w; tmp.height = h;
    tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.drawImage(tmp, 0, 0, cv.width, cv.height);
    if (opts.grid && zoom >= 6) {
      ctx.strokeStyle = 'rgba(255,255,255,0.09)';
      ctx.beginPath();
      for (let x = 0; x <= w; x++) { ctx.moveTo(x * zoom + 0.5, 0); ctx.lineTo(x * zoom + 0.5, cv.height); }
      for (let y = 0; y <= h; y++) { ctx.moveTo(0, y * zoom + 0.5); ctx.lineTo(cv.width, y * zoom + 0.5); }
      ctx.stroke();
    }
    if (opts.block8 && zoom >= 4) {
      ctx.strokeStyle = 'rgba(122,162,247,0.35)';
      ctx.beginPath();
      for (let x = 0; x <= w; x += 8) { ctx.moveTo(x * zoom + 0.5, 0); ctx.lineTo(x * zoom + 0.5, cv.height); }
      for (let y = 0; y <= h; y += 8) { ctx.moveTo(0, y * zoom + 0.5); ctx.lineTo(cv.width, y * zoom + 0.5); }
      ctx.stroke();
    }
    if (opts.collision) {
      ctx.fillStyle = 'rgba(224,108,117,0.45)';
      for (let i = 0; i < w * h; i++) if (opts.collision[i]) {
        ctx.fillRect((i % w) * zoom, ((i / w) | 0) * zoom, zoom, zoom);
      }
    }
  }

  // ---------- 调色板 ----------
  function buildPalette() {
    const el = $('palette');
    el.innerHTML = '';
    const cv = document.createElement('canvas');
    cv.width = 256 * 14; cv.height = 14;
    const ctx = cv.getContext('2d');
    for (let i = 0; i < 256; i++) {
      ctx.fillStyle = ANSI.css(i);
      ctx.fillRect(i * 14, 0, 13, 13);
    }
    el.appendChild(cv);
    const mark = document.createElement('div');
    mark.id = 'palMark';
    mark.style.cssText = 'position:absolute;border:2px solid #fff;pointer-events:none;width:10px;height:10px;';
    el.style.position = 'relative';
    el.appendChild(mark);
    const upd = () => { mark.style.left = (state.color * 14 + 0) + 'px'; mark.style.top = '0px'; };
    cv.onclick = (e) => {
      const r = cv.getBoundingClientRect();
      state.color = Math.max(0, Math.min(255, Math.floor((e.clientX - r.left) / 14)));
      upd();
      $('colorLbl').textContent = '#' + state.color + ' ' + ANSI.css(state.color);
      $('curColor').style.background = ANSI.css(state.color);
    };
    upd();
    // 第二色(抖动笔刷)
    const cv2 = document.createElement('canvas');
    cv2.width = 256 * 14; cv2.height = 14;
    const c2 = cv2.getContext('2d');
    const c2ctx = cv2.getContext('2d');
    const ctx2 = cv2.getContext('2d');
    const cvB = document.createElement('canvas');
    cvB.width = 256 * 14; cvB.height = 14;
    const bc = cvB.getContext('2d');
    for (let i = 0; i < 256; i++) { bc.fillStyle = ANSI.css(i); bc.fillRect(i * 14, 0, 13, 13); }
    cvB.onclick = (e) => {
      const r = cvB.getBoundingClientRect();
      state.ditherColor2 = Math.max(0, Math.min(255, Math.floor((e.clientX - r.left) / 14)));
      $('d2Lbl').textContent = '#' + state.ditherColor2;
    };
    cvB.style.marginTop = '4px';
    const wrap2 = document.createElement('div');
    wrap2.appendChild(cvB);
    el.appendChild(wrap2);
  }

  // ---------- 撤销 ----------
  function pushUndo(docKey, snapshot) {
    const u = state.undo[docKey];
    u.push(snapshot);
    if (u.length > 100) u.shift();
    state.redo[docKey].length = 0;
  }
  function doUndo(docKey, apply) {
    const u = state.undo[docKey];
    if (!u.length) return;
    const snap = u.pop();
    state.redo[docKey].push(apply());
    return snap;
  }

  // =====================================================================
  // 模式一:精灵绘制(8×8 / 16×16 规格,帧动画)
  // =====================================================================
  const sprite = {
    size: 16,               // 8 | 16(新建时选规格,T13)
    frames: [],             // 每帧 {px:Uint8Array(size*size), tmask:Uint8Array}
    cur: 0,
    animFps: 6,
    previewT: 0, previewF: 0,

    init() {
      this.size = +(localStorage.getItem('ie.sprite.size') || 16);
      this.frames = this.load() || [this.blank()];
      this.renderList();
      this.render();
      setInterval(() => this.tickPreview(), 1000 / 30);
    },
    blank() { return { px: new Uint8Array(this.size * this.size), tmask: new Uint8Array(this.size * this.size).fill(1) }; },
    doc() { return this.frames[this.cur]; },
    save() {
      localStorage.setItem('ie.sprite', JSON.stringify({
        size: this.size,
        frames: this.frames.map(f => ({ px: Array.from(f.px), tmask: Array.from(f.tmask) }))
      }));
    },
    load() {
      try {
        const d = JSON.parse(localStorage.getItem('ie.sprite') || 'null');
        if (!d || !d.frames || !d.frames.length) return null;
        return d.frames.map(f => ({ px: Uint8Array.from(f.px), tmask: Uint8Array.from(f.tmask) }));
      } catch (e) { return null; }
    },
    render() {
      const f = this.doc();
      drawIndexCanvas($('spCanvas'), f.px, f.tmask, this.size, this.size, state.zoom, { grid: state.showGrid, block8: this.size === 16 });
    },
    renderList() {
      const list = $('spFrames');
      list.innerHTML = '';
      this.frames.forEach((f, i) => {
        const cv = document.createElement('canvas');
        cv.className = 'pixel';
        cv.style.width = '48px'; cv.style.height = '48px';
        cv.style.outline = i === this.cur ? '2px solid #7aa2f7' : '1px solid #333';
        drawIndexCanvas(cv, f.px, f.tmask, this.size, this.size, 48 / this.size, {});
        cv.onclick = () => { this.cur = i; this.renderList(); this.render(); };
        list.appendChild(cv);
      });
    },
    tickPreview() {
      if (!this.frames.length || $('previewWrap').style.display === 'none') return;
      if (++this.previewT >= 30 / this.animFps) {
        this.previewT = 0;
        this.previewF = (this.previewF + 1) % this.frames.length;
        const f = this.frames[this.previewF];
        const z = 3;
        drawIndexCanvas($('spPreview'), f.px, f.tmask, this.size, this.size, z, {});
        $('spPreview').style.width = (this.size * z) + 'px';
        $('spPreview').style.height = (this.size * z) + 'px';
      }
    },
    setPixel(x, y, val, transparent) {
      const f = this.doc();
      if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
      f.px[y * this.size + x] = transparent ? 0 : val;
      f.tmask[y * this.size + x] = transparent ? 1 : 0;
    },
    // 洋葱皮:下一帧半透显示 —— 用暗色描边提示(无混合;仅参考线)
    exportTil() {
      const tilesPerFrame = this.size === 16 ? 4 : 1;
      const n = this.frames.length * tilesPerFrame;
      const buf = new Uint8Array(8 + n * 72);
      const dv = new DataView(buf.buffer);
      dv.setUint32(0, 0x324C4954, true); // "TIL2"
      dv.setUint16(4, n, true);
      buf[6] = 1; // kind: OBJ
      let t = 0;
      for (const f of this.frames) {
        if (this.size === 8) {
          buf.set(f.px.subarray(0, 64), 8 + t * 72);
          for (let y = 0; y < 8; y++) {
            let m = 0;
            for (let x = 0; x < 8; x++) if (f.tmask[y * 8 + x]) m |= 1 << x;
            buf[8 + t * 72 + 64 + y] = m;
          }
          t++;
        } else {
          // 16×16 → 4 连续 tile(TL,TR,BL,BR)
          const q = [[0, 0], [8, 0], [0, 8], [8, 8]];
          for (const [ox, oy] of q) {
            const base = 8 + t * 72;
            for (let y = 0; y < 8; y++) {
              let m = 0;
              for (let x = 0; x < 8; x++) {
                const si = (oy + y) * 16 + ox + x;
                buf[base + y * 8 + x] = f.px[si];
                if (f.tmask[si]) m |= 1 << x;
              }
              buf[base + 64 + y] = m;
            }
            t++;
          }
        }
      }
      return buf;
    }
  };

  // =====================================================================
  // 模式二:地图绘制(8px 网格,16×16 图块占 4 格,双图层,碰撞通道)
  // =====================================================================
  const map = {
    w: 32, h: 22,
    layers: [null, null],   // Uint16Array
    collision: null,        // Uint8Array(1bit per tile 存 0/1)
    curLayer: 0,
    tileset: null,          // {count, kind, tiles:[{px,tmask}]}
    selTile: 1, selBig: false,
    flipH: false, flipV: false,
    showCollision: false,

    init() {
      const d = this.load();
      if (d) {
        this.w = d.w; this.h = d.h;
        this.layers = d.layers.map(l => l ? Uint16Array.from(l) : new Uint16Array(this.w * this.h));
        this.collision = d.collision ? Uint8Array.from(d.collision) : new Uint8Array(this.w * this.h);
        if (d.tileset) this.loadTilesetData(d.tileset);
      } else {
        this.layers = [new Uint16Array(this.w * this.h), new Uint16Array(this.w * this.h)];
        this.collision = new Uint8Array(this.w * this.h);
      }
      this.render();
    },
    save() {
      const d = { w: this.w, h: this.h, layers: this.layers.map(l => Array.from(l)), collision: Array.from(this.collision) };
      if (this.tileset) {
        d.tileset = { count: this.tileset.count, kind: this.tileset.kind, data: Array.from(this.tileset.raw) };
      }
      try { localStorage.setItem('ie.map', JSON.stringify(d)); } catch (e) { /* 满 */ }
    },
    load() {
      try { return JSON.parse(localStorage.getItem('ie.map') || 'null'); } catch (e) { return null; }
    },
    loadTilesetData(raw) {
      const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      const count = dv.getUint16(4, true);
      const tiles = [];
      for (let t = 0; t < count; t++) {
        const px = new Uint8Array(64), tm = new Uint8Array(64);
        for (let i = 0; i < 64; i++) px[i] = raw[8 + t * 72 + i];
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          tm[y * 8 + x] = (raw[8 + t * 72 + 64 + y] >> x) & 1;
        }
        tiles.push({ px, tmask: tm });
      }
      this.tileset = { count, kind: raw[6], tiles, raw };
      this.renderTileset();
    },
    importTil(file) {
      file.arrayBuffer().then(ab => {
        this.loadTilesetData(new Uint8Array(ab));
        this.save();
      });
    },
    renderTileset() {
      if (!this.tileset) return;
      const ts = this.tileset;
      const cols = 16, rows = Math.ceil(ts.count / cols);
      const cv = $('mapTileset');
      const z = 3;
      const w = cols * 8, h = rows * 8;
      const px = new Uint8Array(w * h), tm = new Uint8Array(w * h).fill(1);
      ts.tiles.forEach((t, i) => {
        const ox = (i % cols) * 8, oy = ((i / cols) | 0) * 8;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
          px[(oy + y) * w + ox + x] = t.px[y * 8 + x];
          tm[(oy + y) * w + ox + x] = t.tmask[y * 8 + x];
        }
      });
      drawIndexCanvas(cv, px, tm, w, h, z, { grid: true });
      cv.onclick = (e) => {
        const r = cv.getBoundingClientRect();
        const x = Math.floor((e.clientX - r.left) / (8 * z)), y = Math.floor((e.clientY - r.top) / (8 * z));
        this.selTile = y * cols + x;
        this.renderTileset();
      };
      // 选中框
      const ctx = cv.getContext('2d');
      ctx.strokeStyle = '#7aa2f7';
      ctx.lineWidth = 2;
      ctx.strokeRect(((this.selTile % cols) * 8 + (this.selBig ? -8 : 0)) * z + 1, ((this.selTile / cols | 0) * 8 - (this.selBig ? 0 : 0)) * z + 1, 8 * (this.selBig ? 2 : 1) * z - 2, 8 * (this.selBig ? 2 : 1) * z - 2);
    },
    composeView() {
      // 合成 BG0/BG1 到视图(tile 0 = 透明)
      const w = this.w, h = this.h;
      const px = new Uint8Array(w * h * 64), tm = new Uint8Array(w * h * 64);
      const put = (L, dim) => {
        if (!L) return;
        for (let ty = 0; ty < h; ty++) for (let tx = 0; tx < w; tx++) {
          const e = L[ty * w + tx];
          const t = e & 0x3FF;
          if (!t || !this.tileset || t >= this.tileset.count) continue;
          const tile = this.tileset.tiles[t];
          const fh = e & 0x400, fv = e & 0x800;
          for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
            const sx = fh ? 7 - x : x, sy = fv ? 7 - y : y;
            const di = (ty * 8 + y) * w * 8 + tx * 8 + x;
            if (!tile.tmask[sy * 8 + sx] && !tm[di]) { px[di] = tile.px[sy * 8 + sx]; tm[di] = 0; }
          }
        }
      };
      tm.fill(1);
      put(this.layers[0]); put(this.layers[1]);
      return { px, tm };
    },
    render() {
      const { px, tm } = this.composeView();
      const z = Math.max(2, Math.min(8, Math.floor(560 / this.w)));
      drawIndexCanvas($('mapCanvas'), px, tm, this.w * 8, this.h * 8, z, {
        grid: false, block8: z >= 3,
        collision: this.showCollision ? this.expandCollision() : null
      });
      this._zoom = z;
    },
    expandCollision() {
      const out = new Uint8Array(this.w * 8 * this.h * 8);
      for (let t = 0; t < this.w * this.h; t++) {
        if (!this.collision[t]) continue;
        const tx = (t % this.w) * 8, ty = ((t / this.w) | 0) * 8;
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out[(ty + y) * this.w * 8 + tx + x] = 1;
      }
      return out;
    },
    setTileAt(tx, ty, erase) {
      const L = this.layers[this.curLayer];
      if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return;
      if (erase) { L[ty * this.w + tx] = 0; return; }
      const e = (this.selTile & 0x3FF) | (this.flipH ? 0x400 : 0) | (this.flipV ? 0x800 : 0);
      L[ty * this.w + tx] = e;
      if (this.selBig) {  // 16×16 图块整体拖入 → 占 2×2 = 4 格(T13)
        L[ty * this.w + Math.min(this.w - 1, tx + 1)] = ((this.selTile + 1) & 0x3FF) | (this.flipH ? 0x400 : 0) | (this.flipV ? 0x800 : 0);
        const below = Math.min(this.h - 1, ty + 1);
        L[below * this.w + tx] = ((this.selTile + 2) & 0x3FF) | (this.flipH ? 0x400 : 0) | (this.flipV ? 0x800 : 0);
        L[below * this.w + Math.min(this.w - 1, tx + 1)] = ((this.selTile + 3) & 0x3FF) | (this.flipH ? 0x400 : 0) | (this.flipV ? 0x800 : 0);
      }
    },
    toggleCollisionAt(tx, ty) {
      if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) return;
      const i = ty * this.w + tx;
      this.collision[i] = this.collision[i] ? 0 : 1;
    },
    exportMap() {
      const buf = new Uint8Array(8 + this.w * this.h * 2);
      const dv = new DataView(buf.buffer);
      dv.setUint32(0, 0x3250414D, true); // "MAP2"
      dv.setUint16(4, this.w, true); dv.setUint16(6, this.h, true);
      const L = this.layers[0]; // 主图层导出(BG1 分文件)
      for (let i = 0; i < this.w * this.h; i++) dv.setUint16(8 + i * 2, L[i], true);
      return buf;
    },
    exportCollision() {
      // 每 tile 1bit 打包(§13.2 碰撞通道 → data 段)
      const nBytes = Math.ceil(this.w * this.h / 8);
      const buf = new Uint8Array(8 + nBytes);
      const dv = new DataView(buf.buffer);
      dv.setUint32(0, 0x314C4F43, true); // "COL1"
      dv.setUint16(4, this.w, true); dv.setUint16(6, this.h, true);
      for (let i = 0; i < this.w * this.h; i++) {
        if (this.collision[i]) buf[8 + (i >> 3)] |= 1 << (i & 7);
      }
      return buf;
    }
  };

  // =====================================================================
  // 模式三:自由绘制(自选画布,1bit 透明通道,抖动笔刷,封面模板,PNG 导入)
  // =====================================================================
  const free = {
    w: 64, h: 64,
    px: null, tmask: null,

    init() {
      const d = this.load();
      if (d) { this.w = d.w; this.h = d.h; this.px = Uint8Array.from(d.px); this.tmask = Uint8Array.from(d.tmask); }
      else { this.px = new Uint8Array(this.w * this.h); this.tmask = new Uint8Array(this.w * this.h).fill(1); }
      this.render();
    },
    save() {
      try {
        localStorage.setItem('ie.free', JSON.stringify({ w: this.w, h: this.h, px: Array.from(this.px), tmask: Array.from(this.tmask) }));
      } catch (e) { }
    },
    load() { try { return JSON.parse(localStorage.getItem('ie.free') || 'null'); } catch (e) { return null; } },
    render() {
      const z = Math.max(2, Math.min(10, Math.floor(480 / Math.max(this.w, this.h))));
      this._zoom = z;
      drawIndexCanvas($('freeCanvas'), this.px, this.tmask, this.w, this.h, z, { grid: state.showGrid && z >= 5 });
    },
    resize(w, h) {
      const px = new Uint8Array(w * h), tm = new Uint8Array(w * h).fill(1);
      for (let y = 0; y < Math.min(h, this.h); y++) for (let x = 0; x < Math.min(w, this.w); x++) {
        px[y * w + x] = this.px[y * this.w + x];
        tm[y * w + x] = this.tmask[y * this.w + x];
      }
      this.w = w; this.h = h; this.px = px; this.tmask = tm;
      this.render(); this.save();
    },
    setPixel(x, y, val, transparent) {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
      const i = y * this.w + x;
      if (transparent) { this.tmask[i] = 1; return; }
      if (state.tool === 'dither') {
        // 两色棋盘交错(官方"透明感"手法,§6.6)
        this.tmask[i] = 0;
        this.px[i] = ((x + y) & 1) ? state.color : state.ditherColor2;
        return;
      }
      this.px[i] = val;
      this.tmask[i] = 0;
    },
    exportBm2() {
      const n = this.w * this.h, stride = (this.w + 7) >> 3;
      const buf = new Uint8Array(8 + n + stride * this.h);
      const dv = new DataView(buf.buffer);
      dv.setUint32(0, 0x20324D42, true); // "BM2 "
      dv.setUint16(4, this.w, true); dv.setUint16(6, this.h, true);
      buf.set(this.px, 8);
      for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) {
        if (this.tmask[y * this.w + x]) buf[8 + n + y * stride + (x >> 3)] |= 1 << (x & 7);
      }
      return buf;
    },
    exportCover() {
      if (this.w !== 32 || this.h !== 32) throw new Error('封面须 32×32(用封面模板)');
      const out = new Uint8Array(1024);
      out.set(this.px);
      return out;
    },
    importPng(file, method, alphaThreshold) {
      file.arrayBuffer().then(ab => {
        const blob = new Blob([ab], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
          URL.revokeObjectURL(url);
          const w = img.width, h = img.height;
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          const ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0);
          const id = ctx.getImageData(0, 0, w, h);
          // 量化:误差扩散(Floyd–Steinberg)或 Bayer 4×4(§13.2)
          const px = new Uint8Array(w * h), tm = new Uint8Array(w * h);
          const d = id.data;
          const err = method === 'fs' ? new Float32Array(w * h * 3) : null;
          const bayer = [
            [0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]
          ];
          for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            const i = y * w + x, q = i * 4;
            let r = d[q], g = d[q + 1], b = d[q + 2];
            if (d[q + 3] < alphaThreshold) { tm[i] = 1; continue; }
            if (err) { r += err[i * 3]; g += err[i * 3 + 1]; b += err[i * 3 + 2]; }
            let c;
            if (method === 'bayer') {
              const t = (bayer[y & 3][x & 3] / 16 - 0.5) * 40;
              c = ANSI.fromRgbFast(r + t, g + t, b + t);
            } else {
              c = ANSI.fromRgbFast(r, g, b);
            }
            px[i] = c;
            if (err) {
              const cr = ANSI.rgbTable[c * 3] - r, cg = ANSI.rgbTable[c * 3 + 1] - g, cb = ANSI.rgbTable[c * 3 + 2] - b;
              const push = (xx, yy, f) => {
                if (xx < 0 || yy < 0 || xx >= w || yy >= h) return;
                const j = (yy * w + xx) * 3;
                err[j] += cr * f; err[j + 1] += cg * f; err[j + 2] += cb * f;
              };
              push(x + 1, y, 7 / 16); push(x - 1, y + 1, 3 / 16); push(x, y + 1, 5 / 16); push(x + 1, y + 1, 1 / 16);
            }
          }
          this.px = px; this.tmask = tm;
          this.w = w; this.h = h;
          this.render(); this.save();
        };
        img.src = url;
      });
    }
  };

  // =====================================================================
  // 交互绑定
  // =====================================================================
  function canvasCoords(cv, e, zoom, w, h) {
    const r = cv.getBoundingClientRect();
    return [Math.floor((e.clientX - r.left) / zoom), Math.floor((e.clientY - r.top) / zoom)];
  }

  function bindPaint(cvId, doc, docKey, mapMode) {
    const cv = $(cvId);
    let drawing = false, lastX = 0, lastY = 0, snap = null, moved = false;
    const getZoom = () => mapMode ? map._zoom : free._zoom;
    const getWH = () => mapMode ? [map.w, map.h] : [free.w, free.h];
    const begin = (x, y, erase) => {
      snap = mapMode ? { l0: map.layers[0].slice(), l1: map.layers[1].slice(), col: map.collision.slice() }
        : { px: free.px.slice(), tm: free.tmask.slice() };
      moved = false;
      apply(x, y, erase);
    };
    const apply = (x, y, erase) => {
      moved = true;
      if (mapMode) {
        if (state.tool === 'pick') { /* 地图模式取 tile */ map.setTileAt(x, y, true); }
        else if ($('mapColMode').checked) map.toggleCollisionAt(x, y);
        else map.setTileAt(x, y, erase);
        map.render();
      } else {
        free.setPixel(x, y, state.color, erase || state.tool === 'era');
        free.render();
      }
    };
    cv.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const [x, y] = canvasCoords(cv, e, getZoom(), getWH());
      drawing = true; lastX = x; lastY = y;
      begin(x, y, e.button === 2);
    });
    cv.addEventListener('mousemove', (e) => {
      if (!drawing) return;
      const [x, y] = canvasCoords(cv, e, getZoom(), getWH());
      if (x === lastX && y === lastY) return;
      // 线性插值快速拖动
      const steps = Math.max(Math.abs(x - lastX), Math.abs(y - lastY));
      for (let i = 1; i <= steps; i++) {
        apply(lastX + Math.round((x - lastX) * i / steps), lastY + Math.round((y - lastY) * i / steps), e.button === 2);
      }
      lastX = x; lastY = y;
    });
    window.addEventListener('mouseup', () => {
      if (drawing && moved && snap) pushUndo(docKey, snap);
      if (drawing) { doc.save && doc.save(); }
      drawing = false;
    });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function download(buf, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf]));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  // ---------- 启动(仅浏览器;Node 测试只复用导出/数据逻辑) ----------
  const hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (hasDOM) window.addEventListener('DOMContentLoaded', () => {
    buildPalette();
    $('colorLbl').textContent = '#' + state.color;
    $('curColor').style.background = ANSI.css(state.color);

    // 模式切换
    document.querySelectorAll('input[name=mode]').forEach(r => r.onchange = () => {
      state.mode = r.value;
      for (const p of ['paneSprite', 'paneMap', 'paneFree']) $(p).style.display = 'none';
      $('pane' + r.value[0].toUpperCase() + r.value.slice(1)).style.display = '';
    });

    // 工具
    for (const id of ['pen', 'era', 'fill', 'dither']) {
      $(id).onclick = () => { state.tool = id; document.querySelectorAll('.tool').forEach(b => b.classList.remove('primary')); $(id).classList.add('primary'); };
    }
    $('showGrid').onchange = (e) => { state.showGrid = e.target.checked; sprite.render(); free.render(); };
    $('zoom').oninput = (e) => { state.zoom = +e.target.value; sprite.render(); };

    // 撤销重做
    $('undo').onclick = () => {
      const key = state.mode === 'sprite' ? 'sprite' : state.mode === 'map' ? 'map' : 'free';
      const cur = () => state.mode === 'map'
        ? { l0: map.layers[0].slice(), l1: map.layers[1].slice(), col: map.collision.slice() }
        : state.mode === 'sprite' ? { px: sprite.doc().px.slice(), tm: sprite.doc().tmask.slice() }
          : { px: free.px.slice(), tm: free.tmask.slice() };
      const snap = state.undo[key].pop();
      if (!snap) return;
      state.redo[key].push(cur());
      if (state.mode === 'map') { map.layers[0] = Uint16Array.from(snap.l0); map.layers[1] = Uint16Array.from(snap.l1); map.collision = Uint8Array.from(snap.col); map.render(); }
      else if (state.mode === 'sprite') { sprite.doc().px.set(snap.px); sprite.doc().tmask.set(snap.tm); sprite.render(); sprite.renderList(); }
      else { free.px = Uint8Array.from(snap.px); free.tmask = Uint8Array.from(snap.tm); free.render(); }
    };
    $('redo').onclick = () => {
      const key = state.mode;
      const snap = state.redo[key] && state.redo[key].pop();
      if (!snap) return;
      if (state.mode === 'map') { map.layers[0] = Uint16Array.from(snap.l0); map.layers[1] = Uint16Array.from(snap.l1); map.collision = Uint8Array.from(snap.col); map.render(); }
      else if (state.mode === 'sprite') { sprite.doc().px.set(snap.px); sprite.doc().tmask.set(snap.tm); sprite.render(); sprite.renderList(); }
      else { free.px = Uint8Array.from(snap.px); free.tmask = Uint8Array.from(snap.tm); free.render(); }
    };

    // —— 精灵模式 ——
    $('spNew8').onclick = () => { sprite.size = 8; sprite.frames = [sprite.blank()]; sprite.cur = 0; localStorage.setItem('ie.sprite.size', '8'); sprite.renderList(); sprite.render(); sprite.save(); };
    $('spNew16').onclick = () => { sprite.size = 16; sprite.frames = [sprite.blank()]; sprite.cur = 0; localStorage.setItem('ie.sprite.size', '16'); sprite.renderList(); sprite.render(); sprite.save(); };
    $('spAddF').onclick = () => { pushUndo('sprite', { px: sprite.doc().px.slice(), tm: sprite.doc().tmask.slice() }); sprite.frames.push({ px: sprite.doc().px.slice(), tm: sprite.doc().tmask.slice() }); sprite.cur = sprite.frames.length - 1; sprite.renderList(); sprite.render(); sprite.save(); };
    $('spDelF').onclick = () => { if (sprite.frames.length > 1) { sprite.frames.splice(sprite.cur, 1); sprite.cur = Math.max(0, sprite.cur - 1); sprite.renderList(); sprite.render(); sprite.save(); } };
    $('spAnim').oninput = (e) => { sprite.animFps = +e.target.value; };
    $('spExport').onclick = () => download(sprite.exportTil(), 'sprite' + sprite.size + '.til');
    // 洋葱皮:显示前帧轮廓
    $('spOnion').onchange = (e) => { state.onion = e.target.checked; };

    bindPaint('spCanvas', sprite, 'sprite', false);
    // 精灵画布缩放独立绑定(zoom 显示用 state.zoom)
    const spDraw = () => sprite.render();

    // —— 地图模式 ——
    $('mapImportTil').onclick = () => $('mapTilFile').click();
    $('mapTilFile').onchange = (e) => { if (e.target.files[0]) map.importTil(e.target.files[0]); e.target.value = ''; };
    $('mapW').onchange = $('mapH').onchange = () => {
      const w = +$('mapW').value || 32, h = +$('mapH').value || 22;
      const l0 = new Uint16Array(w * h), l1 = new Uint16Array(w * h), col = new Uint8Array(w * h);
      for (let y = 0; y < Math.min(h, map.h); y++) for (let x = 0; x < Math.min(w, map.w); x++) {
        l0[y * w + x] = map.layers[0][y * map.w + x];
        l1[y * w + x] = map.layers[1][y * map.w + x];
        col[y * w + x] = map.collision[y * map.w + x];
      }
      map.w = w; map.h = h; map.layers = [l0, l1]; map.collision = col;
      map.render(); map.save();
    };
    $('mapLayer').onchange = (e) => { map.curLayer = +e.target.value; };
    $('mapBig').onchange = (e) => { map.selBig = e.target.checked; map.renderTileset(); };
    $('mapFH').onchange = (e) => { map.flipH = e.target.checked; };
    $('mapFV').onchange = (e) => { map.flipV = e.target.checked; };
    $('mapShowCol').onchange = (e) => { map.showCollision = e.target.checked; map.render(); };
    $('mapColMode').onchange = () => { };
    $('mapExport').onclick = () => download(map.exportMap(), 'map0.map');
    $('mapExportCol').onclick = () => download(map.exportCollision(), 'collision.bin');
    bindPaint('mapCanvas', map, 'map', true);

    // —— 自由模式 ——
    $('freeW').onchange = $('freeH').onchange = () => free.resize(+$('freeW').value || 64, +$('freeH').value || 64);
    $('freeCover').onclick = () => { free.resize(32, 32); $('freeW').value = 32; $('freeH').value = 32; };
    $('freeImport').onclick = () => $('freePng').click();
    $('freePng').onchange = (e) => {
      if (e.target.files[0]) free.importPng(e.target.files[0], $('pngMethod').value, +$('alphaTh').value);
      e.target.value = '';
    };
    $('freeExport').onclick = () => download(free.exportBm2(), 'bitmap.bm2');
    $('freeExportCover').onclick = () => { try { download(free.exportCover(), 'cover.bin'); } catch (err) { alert(err.message); } };
    bindPaint('freeCanvas', free, 'free', false);

    sprite.init(); map.init(); free.init();
    $('freeW').value = free.w; $('freeH').value = free.h;
    $('mapW').value = map.w; $('mapH').value = map.h;
    setInterval(() => { sprite.save(); map.save(); free.save(); }, 15000); // 草稿自动保存
  });

  AC2.ImgEdit = { state, sprite, map, free };
})();
