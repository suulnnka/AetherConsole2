/* js/tools/gif.js — GIF89a 编码器(调试设备录屏导出,§13.6)
 * 输入帧为 240×176 ANSI 索引图 —— ANSI 256 色恰好就是 GIF 全局色表。
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};

  function lzwEncode(minCodeSize, indices, out) {
    const CLEAR = 1 << minCodeSize, EOI = CLEAR + 1;
    let codeSize = minCodeSize + 1, next = EOI + 1;
    let dict = new Map();
    const reset = () => {
      dict = new Map();
      codeSize = minCodeSize + 1;
      next = EOI + 1;
    };
    reset();
    let cur = 0, curLen = 0;
    const buf = [];
    const emit = (code) => {
      cur |= code << curLen;
      curLen += codeSize;
      while (curLen >= 8) {
        buf.push(cur & 255);
        cur >>= 8;
        curLen -= 8;
      }
    };
    emit(CLEAR);
    let prefix = null;
    for (const k of indices) {
      if (prefix == null) { prefix = k; continue; }
      const key = (prefix << 8) | k;
      const hit = dict.get(key);
      if (hit != null) {
        prefix = hit;
      } else {
        emit(prefix);
        dict.set(key, next++);
        if (next === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
        if (next >= 4095) { emit(CLEAR); reset(); }
        prefix = k;
      }
    }
    if (prefix != null) emit(prefix);
    emit(EOI);
    if (curLen > 0) buf.push(cur & 255);
    // 分块 ≤255
    for (let i = 0; i < buf.length; i += 255) {
      const n = Math.min(255, buf.length - i);
      out.push(n);
      for (let j = 0; j < n; j++) out.push(buf[i + j]);
    }
    out.push(0);
  }

  // rgbTable:Uint8Array(768);frames:[{delayCs, indices:Uint8Array(240*176)}]
  function encodeGif(w, h, rgbTable, frames) {
    const bytes = [];
    const s = (str) => { for (let i = 0; i < str.length; i++) bytes.push(str.charCodeAt(i)); };
    s('GIF89a');
    bytes.push(w & 255, w >> 8, h & 255, h >> 8);
    bytes.push(0xF7, 0, 0); // 全局色表 256 项
    for (let i = 0; i < 768; i++) bytes.push(rgbTable[i]);
    for (const f of frames) {
      // 图形控制扩展
      bytes.push(0x21, 0xF9, 4, 0x04, f.delayCs & 255, (f.delayCs >> 8) & 255, 0, 0);
      bytes.push(0x2C);
      bytes.push(0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8);
      bytes.push(0); // 无局部色表
      bytes.push(8); // LZW min code size
      const out = [];
      lzwEncode(8, f.indices, out);
      for (const b of out) bytes.push(b);
    }
    bytes.push(0x3B);
    return Uint8Array.from(bytes);
  }

  AC2.encodeGif = encodeGif;
})();
