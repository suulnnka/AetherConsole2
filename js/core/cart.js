/* js/core/cart.js — .aec 卡带容器(§11)
 * 布局:
 *   头部 64B:magic "AEC2" · u8 ver · u8 flags(bit0=混淆,bit1=默认模式2)· ID[8] · u16 游戏版本
 *            · 标题 32B UTF-8 · u16 段数 · u32 整卡 CRC(覆盖头部之后全部字节)· 保留 10B(混淆种子)
 *   封面 1024B(恒不压缩):32×32 ANSI 索引
 *   段表:每段 16B:u8 类型 · u8 压缩标志 · u16 保留 · u32 压缩长 · u32 原始长 · u32 原始 CRC
 *   段数据(依表序)
 * 段类型:0 meta(json) 1 code 2 tiles-bg 3 tiles-obj 4 maps 5 bitmaps 6 vectors 7 audio 8 font 9 data
 * 压缩:段级 raw DEFLATE(两端内置,§11.3 v0.9);收益 <5% 自动放弃只置标志。
 * 混淆格式:flags.bit0=1;段表+数据区 XOR 键流(种子存头部保留区),段表 type 字节再 XOR 0xA5。
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};

  const SEG_NAMES = ['meta', 'code', 'tilesbg', 'tilesobj', 'maps', 'bitmaps', 'vectors', 'audio', 'font', 'data'];
  const SEG_IDS = { meta: 0, code: 1, tilesbg: 2, tilesobj: 3, maps: 4, bitmaps: 5, vectors: 6, audio: 7, font: 8, data: 9 };

  function keystream(seed, n) {
    const ks = new Uint8Array(n);
    let s0 = (seed[0] | (seed[1] << 8) | (seed[2] << 16) | (seed[3] << 24)) || 0x12345678;
    let s1 = (seed[4] | (seed[5] << 8) | (seed[6] << 16) | (seed[7] << 24)) || 0x9E3779B9;
    for (let i = 0; i < n; i++) {
      s0 ^= s0 << 13; s0 >>>= 0; s0 ^= s0 >>> 17; s0 ^= s0 << 5; s0 >>>= 0;
      s1 ^= s1 << 13; s1 >>>= 0; s1 ^= s1 >>> 17; s1 ^= s1 << 5; s1 >>>= 0;
      ks[i] = (s0 ^ (s1 >>> 16)) & 0xFF;
    }
    return ks;
  }

  // ---------- 构建(异步:DEFLATE) ----------
  async function build(opts) {
    // opts: {id, title, version, mode(1|2), sampling, segments:[{type, name?, data:Uint8Array}], obfuscate, cover:Uint8Array(1024)}
    const { Comp } = AC2;
    const id = String(opts.id || 'AC2TEMP1').toUpperCase();
    if (!/^[A-Z0-9]{8}$/.test(id)) throw new Error('cart id 必须为 8 字符 [A-Z0-9]:' + id);
    const title = String(opts.title || id);
    const segsIn = opts.segments.slice();
    const meta = {
      sampling: opts.sampling || 'auto',
      segNames: segsIn.map(s => s.name || ''),
      title
    };
    segsIn.unshift({ type: 'meta', name: 'meta', data: new TextEncoder().encode(JSON.stringify(meta)) });

    const cover = opts.cover;
    if (!cover || cover.length !== 1024) throw new Error('封面必须为 1024B(32×32 ANSI)');

    const nSeg = segsIn.length;
    const tableSize = nSeg * 16;
    const packed = [];
    for (const s of segsIn) {
      const raw = s.data instanceof Uint8Array ? s.data : new TextEncoder().encode(s.data);
      const comp = await Comp.compress(raw);
      const use = (comp.length > 0 && comp.length < raw.length * 0.95) ? comp : null;
      packed.push({ raw, comp: use });
    }
    let dataSize = 0;
    for (const p of packed) dataSize += (p.comp ? p.comp.length : p.raw.length);
    const total = 64 + 1024 + tableSize + dataSize;
    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);

    buf.set([0x41, 0x45, 0x43, 0x32], 0); // "AEC2"
    buf[4] = 1;                            // 格式版本
    let flags = 0;
    if (opts.obfuscate) flags |= 1;
    if (Number(opts.mode) === 2) flags |= 2;
    buf[5] = flags;
    buf.set(new TextEncoder().encode(id), 6);
    dv.setUint16(14, (opts.version || 1) & 0xFFFF, true);
    const tb = new TextEncoder().encode(title);
    buf.set(tb.subarray(0, Math.min(32, tb.length)), 16);
    dv.setUint16(48, nSeg, true);
    if (opts.obfuscate) {
      for (let i = 54; i < 64; i++) buf[i] = (Math.random() * 256) | 0;
    }
    buf.set(cover, 64);
    let off = 64 + 1024;
    for (let i = 0; i < nSeg; i++) {
      const t = SEG_IDS[segsIn[i].type];
      if (t == null) throw new Error('未知段类型 ' + segsIn[i].type);
      const p = packed[i];
      dv.setUint8(off, t);
      dv.setUint8(off + 1, p.comp ? 1 : 0);
      const len = p.comp ? p.comp.length : p.raw.length;
      dv.setUint32(off + 4, len, true);
      dv.setUint32(off + 8, p.raw.length, true);
      dv.setUint32(off + 12, Comp.crc32(p.raw), true);
      off += 16;
    }
    for (let i = 0; i < nSeg; i++) {
      const d = packed[i].comp || packed[i].raw;
      buf.set(d, off);
      off += d.length;
    }
    if (opts.obfuscate) {
      const regionStart = 64 + 1024;
      const ks = keystream(buf.subarray(54, 64), total - regionStart);
      for (let i = regionStart; i < total; i++) buf[i] ^= ks[i - regionStart];
      for (let i = 0; i < nSeg; i++) buf[regionStart + i * 16] ^= 0xA5; // type 混淆
    }
    dv.setUint32(50, Comp.crc32(buf, 64), true);
    return buf;
  }

  // ---------- 装载(异步) ----------
  async function load(buf) {
    const { Comp } = AC2;
    if (buf.length < 64 + 1024 + 16) throw new Error('AEC: 文件过短');
    if (!(buf[0] === 0x41 && buf[1] === 0x45 && buf[2] === 0x43 && buf[3] === 0x32)) throw new Error('AEC: magic 错误');
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const flags = buf[5];
    const id = String.fromCharCode.apply(null, buf.subarray(6, 14));
    const version = dv.getUint16(14, true);
    const title = new TextDecoder().decode(buf.subarray(16, 48)).replace(/\0+$/, '');
    const nSeg = dv.getUint16(48, true);
    if (Comp.crc32(buf, 64) !== dv.getUint32(50, true)) throw new Error('AEC: 整卡 CRC 校验失败(坏卡带)');

    let work = buf;
    if (flags & 1) {
      const regionStart = 64 + 1024;
      const ks = keystream(buf.subarray(54, 64), buf.length - regionStart);
      work = buf.slice();
      for (let i = regionStart; i < work.length; i++) work[i] ^= ks[i - regionStart];
      for (let i = 0; i < nSeg; i++) work[regionStart + i * 16] ^= 0xA5;
    }
    const dv2 = new DataView(work.buffer, work.byteOffset, work.byteLength);

    const segStart = 64 + 1024;
    const segments = [];
    let off = segStart + nSeg * 16;
    for (let i = 0; i < nSeg; i++) {
      const at = segStart + i * 16;
      const type = work[at] & 0xFF;
      const comp = work[at + 1];
      const clen = dv2.getUint32(at + 4, true);
      const rlen = dv2.getUint32(at + 8, true);
      const rcrc = dv2.getUint32(at + 12, true);
      let raw = work.subarray(off, off + clen);
      raw = comp ? await Comp.decompress(raw) : raw.slice();
      if (raw.length !== rlen || Comp.crc32(raw) !== rcrc) throw new Error('AEC: 段 ' + i + ' CRC 失败');
      segments.push({ type: SEG_NAMES[type] || ('?' + type), data: raw });
      off += clen;
    }
    let meta = {};
    if (segments.length && segments[0].type === 'meta') {
      try { meta = JSON.parse(new TextDecoder().decode(segments[0].data)); } catch (e) { /* meta 坏不致命 */ }
    }
    const cover = buf.subarray(64, 64 + 1024).slice();
    return {
      id, version, title, flags,
      mode: (flags & 2) ? 2 : 1,
      sampling: meta.sampling || 'auto',
      meta, segments, cover,
      seg(type, i) {
        i = i || 0;
        let n = 0;
        for (const s of this.segments) { if (s.type === type) { if (n === i) return s; n++; } }
        return null;
      },
      segs(type) { return this.segments.filter(s => s.type === type); }
    };
  }

  AC2.Cart = { build, load, SEG_NAMES, SEG_IDS, LIMIT: 262144 };
})();
