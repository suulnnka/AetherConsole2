/* js/core/font.js — AFNT v2 字体格式(§11.4/§7.4)+ Font 对象
 * 布局:magic "AFNT" · u16 version(2) · u16 count · codepoint u32×n · 每字形 14 行 × u16 LE(28B)
 * 位定义:bit n = 第 n 列,bit0 = 14 网格最左列(入侵区);行 0–11 主区(12px),12–13 尾部区
 * 步进 12px;绘制原点 = 主区左上角(即网格第 2 列、第 0 行),入侵 2 列画到前字符区,尾部 2 行画到下一行区
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};

  class Font {
    constructor() {
      this.map = new Map();   // codepoint → Uint16Array(14)
      this.advance = 12;
      this.lineH = 14;        // 默认行高(主区 12 + 尾部 2)
    }
    set(cp, rows14) { this.map.set(cp, rows14); }
    get(cp) { return this.map.get(cp); }
    has(cp) { return this.map.has(cp); }
    codepoints() { return Array.from(this.map.keys()).sort((a, b) => a - b); }

    measure(str, scale) {
      scale = scale || 1;
      return str.length * this.advance * scale;
    }

    serialize() {
      const cps = this.codepoints();
      const head = 8 + cps.length * 4;
      const buf = new Uint8Array(head + cps.length * 28);
      buf.set([0x41, 0x46, 0x4E, 0x54], 0); // "AFNT"
      buf[4] = 2; buf[5] = 0;
      buf[6] = cps.length & 255; buf[7] = cps.length >> 8;
      const dv = new DataView(buf.buffer);
      for (let i = 0; i < cps.length; i++) {
        dv.setUint32(8 + i * 4, cps[i], true);
        const rows = this.map.get(cps[i]);
        for (let r = 0; r < 14; r++) dv.setUint16(head + i * 28 + r * 2, rows[r], true);
      }
      return buf;
    }

    static parse(buf) {
      if (buf.length < 8) throw new Error('AFNT: too short');
      if (!(buf[0] === 0x41 && buf[1] === 0x46 && buf[2] === 0x4E && buf[3] === 0x54)) throw new Error('AFNT: bad magic');
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
      const ver = dv.getUint16(4, true);
      if (ver !== 2) throw new Error('AFNT: version ' + ver + ' unsupported');
      const count = dv.getUint16(6, true);
      const f = new Font();
      const head = 8 + count * 4;
      for (let i = 0; i < count; i++) {
        const cp = dv.getUint32(8 + i * 4, true);
        const rows = new Uint16Array(14);
        for (let r = 0; r < 14; r++) rows[r] = dv.getUint16(head + i * 28 + r * 2, true);
        f.map.set(cp, rows);
      }
      return f;
    }

    static fromBuiltin() {
      const f = new Font();
      const bf = AC2.BiosFont;
      for (let i = 0; i < bf.codepoints.length; i++) {
        f.map.set(bf.codepoints[i], Uint16Array.from(bf.glyphs[i]));
      }
      return f;
    }
  }

  AC2.Font = Font;
})();
