/* js/host/mode1.js — 模式1:精灵模式(类 SFC 硬件层,§6.3)
 * 合成顺序(自下而上):BG0 → 精灵 prio0/1 → BG1 → 精灵 prio2/3;同优先级 OAM 序小者在上。
 * tile:8×8,64B ANSI 索引 + 8B 透明位平面(1=透明);16×16 精灵 = 4 连续 tile(TL,TR,BL,BR)。
 * 地图条目 u16:tile 10bit | fh bit10 | fv bit11(其余保留 0)。
 * 每扫描线最多 32 精灵,超出按 OAM 序逐线丢弃(droppedLines 计数供调试设备)。
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};
  const W = 240, H = 176, MAXT = 1024;

  function tilesetData() {
    return { colors: new Uint8Array(MAXT * 64), mask: new Uint8Array(MAXT * 8), count: 0 };
  }
  function mkLayer() {
    return { w: 32, h: 32, entries: new Uint16Array(32 * 32), sx: 0, sy: 0 };
  }

  function createMode1(machine) {
    const bg = tilesetData(), obj = tilesetData();
    const layers = [mkLayer(), mkLayer()];
    const oam = [];
    for (let i = 0; i < 128; i++) oam.push({ x: 0, y: 0, tile: 0, big: 0, fh: 0, fv: 0, prio: 0, vis: false });
    let backdrop = 0;
    const m1 = {
      bg, obj, layers, oam,
      droppedLines: 0, droppedSprites: 0,
      get backdrop() { return backdrop; }
    };

    function reset() {
      bg.count = 0; obj.count = 0;
      bg.colors.fill(0); bg.mask.fill(0); obj.colors.fill(0); obj.mask.fill(0);
      for (const L of layers) { L.w = 32; L.h = 32; L.entries = new Uint16Array(32 * 32); L.sx = 0; L.sy = 0; }
      m1.hideAll();
      backdrop = 0;
    }
    m1.reset = reset;
    m1.hideAll = () => { for (const s of oam) s.vis = false; };

    // ---- tile 装载(自动识别 TIL2 段头;off = 目标 tile 索引) ----
    function loadTiles(dst, seg, off, n) {
      let data = seg && seg.data ? seg.data : seg;
      if (data.length >= 8 && data[0] === 0x54 && data[1] === 0x49 && data[2] === 0x4C && data[3] === 0x32) {
        // "TIL2" 头:magic u32 + count u16 + kind u8 + rsv u8
        const cnt = data[4] | (data[5] << 8);
        data = data.subarray(8);
        if (n == null) n = cnt;
      }
      off = (off || 0) | 0;
      n = n == null ? Math.floor(data.length / 72) : n | 0;
      const set = dst === 'obj' ? obj : bg;
      if (off + n > MAXT) throw new Error('loadTiles: tileset 溢出(≤1024)');
      for (let t = 0; t < n; t++) {
        // off = 目标 tile 索引;源始终从段首读取(整批重写 = "整批换色"手法,§6.6)
        set.colors.set(data.subarray(t * 72, t * 72 + 64), (off + t) * 64);
        set.mask.set(data.subarray(t * 72 + 64, t * 72 + 72), (off + t) * 8);
      }
      set.count = Math.max(set.count, off + n);
    }
    m1.loadTiles = loadTiles;

    // ---- 地图 ----
    m1.mapSize = (layer, w, h) => {
      const L = layers[layer | 0];
      if (w * h > 16384) throw new Error('mapSize: 条目 ≤16384');
      if (w < 1 || h < 1 || w > 128 || h > 128) throw new Error('mapSize: 1..128');
      L.w = w; L.h = h;
      L.entries = new Uint16Array(w * h);
    };
    m1.loadMap = (layer, seg, off) => {
      const data = seg && seg.data ? seg.data : seg;
      off = off || 0;
      const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      const magic = dv.getUint32(off, true);
      if (magic !== 0x3250414D) throw new Error('loadMap: MAP2 magic 错误'); // "MAP2" LE
      const w = dv.getUint16(off + 4, true), h = dv.getUint16(off + 6, true);
      const L = layers[layer | 0];
      L.w = w; L.h = h;
      L.entries = new Uint16Array(w * h);
      for (let i = 0; i < w * h; i++) L.entries[i] = dv.getUint16(off + 8 + i * 2, true);
    };
    m1.setMap = (layer, x, y, w, h, entries) => {
      const L = layers[layer | 0];
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const mx = x + i, my = y + j;
        if (mx < 0 || my < 0 || mx >= L.w || my >= L.h) continue;
        L.entries[my * L.w + mx] = entries[j * w + i] & 0xFFFF;
      }
    };
    m1.setTile = (layer, x, y, entry) => {
      const L = layers[layer | 0];
      if (x < 0 || y < 0 || x >= L.w || y >= L.h) return;
      L.entries[y * L.w + x] = entry & 0xFFFF;
    };
    m1.entry = (tile, fh, fv) => (tile & 0x3FF) | (fh ? 0x400 : 0) | (fv ? 0x800 : 0);
    m1.scroll = (layer, x, y) => {
      const L = layers[layer | 0];
      L.sx = Math.round(x) & 0xFFFF; L.sy = Math.round(y) & 0xFFFF; // 11bit 寄存器语义:模地图尺寸生效
    };
    m1.setBackdrop = (c) => { backdrop = c & 0xFF; };

    // ---- OAM ----
    m1.setSprite = (i, attr) => {
      const s = oam[i | 0];
      if (!s) return;
      s.x = attr.x | 0; s.y = attr.y | 0;
      s.tile = (attr.tile | 0) & 0x3FF;
      s.big = attr.big === true || attr.big === 16 || attr.size === 16 || attr.big === 1 ? 1 : 0;
      s.fh = attr.fh || attr.flipH ? 1 : 0;
      s.fv = attr.fv || attr.flipV ? 1 : 0;
      s.prio = (attr.prio | 0) & 3;
      s.vis = true;
    };
    m1.hide = (i) => { const s = oam[i | 0]; if (s) s.vis = false; };

    // ---- 合成 ----
    function drawTileInto(fb, set, tile, dx, dy, fh, fv) {
      const colors = set.colors, mask = set.mask;
      const base = tile * 64, mbase = tile * 8;
      const px0 = Math.max(0, dx), px1 = Math.min(W, dx + 8);
      const py0 = Math.max(0, dy), py1 = Math.min(H, dy + 8);
      for (let y = py0; y < py1; y++) {
        const ty = y - dy;
        const mrow = mask[mbase + (fv ? 7 - ty : ty)];
        const crow = base + (fv ? 7 - ty : ty) * 8;
        let fbx = y * W;
        for (let x = px0; x < px1; x++) {
          const tx = x - dx;
          const mx = fh ? 7 - tx : tx;
          if (!(mrow & (1 << mx))) fb[fbx + x] = colors[crow + mx];
        }
      }
    }

    function drawLayer(fb, L) {
      const sx = ((L.sx % (L.w * 8)) + L.w * 8) % (L.w * 8);
      const sy = ((L.sy % (L.h * 8)) + L.h * 8) % (L.h * 8);
      const ox = -(sx & 7), oy = -(sy & 7);
      const tx0 = Math.floor(sx / 8), ty0 = Math.floor(sy / 8);
      for (let cy = 0; cy <= 22; cy++) {
        for (let cx = 0; cx <= 30; cx++) {
          const mx = ((tx0 + cx) % L.w + L.w) % L.w;
          const my = ((ty0 + cy) % L.h + L.h) % L.h;
          const e = L.entries[my * L.w + mx];
          const tile = e & 0x3FF;
          if (!tile) continue; // tile 0 恒透明(露出 backdrop)
          drawTileInto(fb, bg, tile, ox + cx * 8, oy + cy * 8, e & 0x400, e & 0x800);
        }
      }
    }

    // 每线 32 上限预计算(整帧共享计数;OAM 序小者优先,§6.3.4)
    function computeLineAllowance() {
      const counts = new Int32Array(H);
      m1.droppedLines = 0; m1.droppedSprites = 0;
      for (let i = 0; i < 128; i++) {
        const s = oam[i];
        if (!s.vis) continue;
        const size = s.big ? 16 : 8;
        const y0 = Math.max(0, s.y), y1 = Math.min(H, s.y + size);
        let any = false;
        s.rowOk = null;
        for (let y = y0; y < y1; y++) {
          if (counts[y] >= 32) { m1.droppedLines++; continue; }
          counts[y]++;
          any = true;
          if (!s.rowOk) { s.rowOk = new Uint8Array(size); }
          s.rowOk[y - s.y] = 1;
        }
        if (!any) m1.droppedSprites++;
      }
    }

    function drawSprites(fb, prios) {
      for (let i = 0; i < 128; i++) {
        const s = oam[i];
        if (!s.vis || !s.rowOk || prios.indexOf(s.prio) < 0) continue;
        const size = s.big ? 16 : 8;
        const y0 = Math.max(0, s.y), y1 = Math.min(H, s.y + size);
        for (let y = y0; y < y1; y++) {
          if (!s.rowOk[y - s.y]) continue;
          drawSpriteRow(fb, s, size, y - s.y, y);
        }
      }
    }

    function drawSpriteRow(fb, s, size, row, dy) {
      const tilesHigh = size >> 3;
      const qy = row >> 3;
      const ry = row & 7;
      for (let qx = 0; qx < tilesHigh; qx++) {
        const tile = s.tile + qy * 2 + qx; // 16×16 = 4 连续 tile(TL,TR,BL,BR)
        const dx = s.x + qx * 8;
        const colors = obj.colors, mask = obj.mask;
        const base = tile * 64, mbase = tile * 8;
        const ty = s.fv ? ((tilesHigh - 1 - qy) * 8 + 7 - ry) : ry;
        const mrow = mask[mbase + ty];
        const crow = base + ty * 8;
        const px0 = Math.max(0, dx), px1 = Math.min(W, dx + 8);
        for (let x = px0; x < px1; x++) {
          const tx = x - dx;
          const mx = s.fh ? 7 - tx : tx;
          if (!(mrow & (1 << mx))) fb[dy * W + x] = colors[crow + mx];
        }
      }
    }

    m1.compose = function (fb) {
      computeLineAllowance();
      fb.fill(backdrop);
      drawLayer(fb, layers[0]);
      drawSprites(fb, [0, 1]);
      drawLayer(fb, layers[1]);
      drawSprites(fb, [2, 3]);
    };

    // 帧首:自动清 OAM(写回法,§6.3.5)
    m1.frameStart = function () { m1.hideAll(); };

    reset();
    return m1;
  }

  AC2.createMode1 = createMode1;
})();
