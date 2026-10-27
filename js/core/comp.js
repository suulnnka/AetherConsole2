/* js/core/comp.js — 压缩与校验(§11.3)
 * 算法:raw DEFLATE(zlib 流去掉外层)——浏览器 CompressionStream 与 Node 内置同款,压缩率高于 LZ4(v0.9 定案)。
 * 全部异步 API;CRC32 为自实现查表(两端无内置)。
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};

  async function streamThrough(transformer, bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(transformer);
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  async function compress(data) {
    if (typeof CompressionStream === 'undefined') throw new Error('环境无 CompressionStream');
    return streamThrough(new CompressionStream('deflate-raw'), data);
  }

  async function decompress(data) {
    if (typeof DecompressionStream === 'undefined') throw new Error('环境无 DecompressionStream');
    return streamThrough(new DecompressionStream('deflate-raw'), data);
  }

  // ---- CRC32 ----
  const CRCT = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[i] = c >>> 0;
    }
    return t;
  })();
  function crc32(buf, start, end) {
    start = start || 0; end = end == null ? buf.length : end;
    let c = 0xFFFFFFFF;
    for (let i = start; i < end; i++) c = CRCT[(c ^ buf[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  AC2.Comp = { compress, decompress, crc32 };
})();
