/* js/core/mulaw.js — G.711 μ律 编解码(§8.1) */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};

  const BIAS = 0x84, CLIP = 32635;
  const ENC = new Uint8Array(65536);
  const DEC = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    // 标准 μ律解码(注意存储值为取反编码)
    const u = (~i) & 0xFF;
    const t = ((u & 0x0F) << 3) + BIAS;
    const ex = t << ((u & 0x70) >> 4);
    const v = (u & 0x80) ? (BIAS - ex) : (ex - BIAS);
    DEC[i] = v / 32768;
  }
  // 编码表:对解码表逐值最近邻反查(与标准 μ律一致,且严格自洽)
  for (let v = -32768; v < 32768; v++) {
    let best = 0, bd = Infinity;
    const t = v / 32768;
    for (let b = 0; b < 256; b++) {
      const d = Math.abs(DEC[b] - t);
      if (d < bd) { bd = d; best = b; if (d === 0) break; }
    }
    ENC[v + 32768] = best;
  }

  // f ∈ [-1,1] → μ律字节
  function encodeSample(f) {
    let v = (f * 32768) | 0;
    if (v > 32767) v = 32767; if (v < -32768) v = -32768;
    return ENC[v + 32768];
  }
  // μ律字节 → f ∈ [-1,1]
  function decodeSample(b) { return DEC[b]; }

  function encodeBlock(f32, out) {
    const n = f32.length; out = out || new Uint8Array(n);
    for (let i = 0; i < n; i++) out[i] = encodeSample(f32[i]);
    return out;
  }
  function decodeBlock(u8, out) {
    const n = u8.length; out = out || new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = DEC[u8[i]];
    return out;
  }

  AC2.Mulaw = { encodeSample, decodeSample, encodeBlock, decodeBlock, DEC };
})();
