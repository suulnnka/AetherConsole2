/* js/core/ansi.js — ANSI/xterm 256 色定义(§6.2,固定不可改) */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};

  const rgbTable = new Uint8Array(256 * 3);
  // 0–15 标准色
  const base16 = [
    0x000000, 0x800000, 0x008000, 0x808000, 0x000080, 0x800080, 0x008080, 0xc0c0c0,
    0x808080, 0xff0000, 0x00ff00, 0xffff00, 0x0000ff, 0xff00ff, 0x00ffff, 0xffffff
  ];
  for (let i = 0; i < 16; i++) {
    rgbTable[i * 3] = (base16[i] >> 16) & 255;
    rgbTable[i * 3 + 1] = (base16[i] >> 8) & 255;
    rgbTable[i * 3 + 2] = base16[i] & 255;
  }
  // 16–231 6×6×6 立方
  const CUBE = [0, 95, 135, 175, 215, 255];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
    const i = 16 + 36 * r + 6 * g + b;
    rgbTable[i * 3] = CUBE[r]; rgbTable[i * 3 + 1] = CUBE[g]; rgbTable[i * 3 + 2] = CUBE[b];
  }
  // 232–255 灰阶
  for (let i = 0; i < 24; i++) {
    const v = 8 + 10 * i, j = (232 + i) * 3;
    rgbTable[j] = rgbTable[j + 1] = rgbTable[j + 2] = v;
  }

  function fromRgb(r, g, b) {
    r |= 0; g |= 0; b |= 0;
    let best = 0, bd = Infinity;
    for (let i = 0; i < 256; i++) {
      const dr = rgbTable[i * 3] - r, dg = rgbTable[i * 3 + 1] - g, db = rgbTable[i * 3 + 2] - b;
      const d = dr * dr + dg * dg + db * db;
      if (d < bd) { bd = d; best = i; if (d === 0) break; }
    }
    return best;
  }

  // 用 3-3-3 位切片缓存加速频繁量化(编辑器导入用)
  const cache = new Int16Array(512).fill(-1);
  function fromRgbFast(r, g, b) {
    r = Math.max(0, Math.min(255, r | 0)); g = Math.max(0, Math.min(255, g | 0)); b = Math.max(0, Math.min(255, b | 0));
    const k = ((r >> 5) << 6) | ((g >> 5) << 3) | (b >> 5);
    const c = cache[k];
    if (c >= 0) return c;
    const v = fromRgb(r, g, b);
    cache[k] = v;
    return v;
  }

  function css(i) {
    return 'rgb(' + rgbTable[i * 3] + ',' + rgbTable[i * 3 + 1] + ',' + rgbTable[i * 3 + 2] + ')';
  }

  AC2.ANSI = { rgbTable, fromRgb, fromRgbFast, css, base16 };
})();
