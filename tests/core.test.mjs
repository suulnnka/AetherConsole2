/* tests/core.test.mjs — 核心库单元测试:ansi / comp(deflate+crc) / mulaw / font / cart */
import { load } from './load.mjs';
import assert from 'node:assert';

const AC2 = load('js/core/ansi.js', 'js/core/comp.js', 'js/core/mulaw.js', 'js/core/font.js', 'js/core/biosfont.js', 'js/core/cart.js');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok', name); }
  catch (e) { failed++; console.log('FAIL', name, '—', e.message); }
}

console.log('== ansi ==');
t('256 色表基本值', () => {
  assert.equal(AC2.ANSI.rgbTable[0], 0);           // #000000
  assert.equal(AC2.ANSI.rgbTable[15 * 3], 0xff);   // #ffffff
  assert.equal(AC2.ANSI.rgbTable[16 * 3], 0);      // 立方 (0,0,0)
  assert.equal(AC2.ANSI.rgbTable[(16 + 36 * 5 + 6 * 5 + 5) * 3], 255); // (255,255,255)
  assert.equal(AC2.ANSI.rgbTable[232 * 3], 8);     // 灰阶首
  assert.equal(AC2.ANSI.rgbTable[255 * 3], 238);   // 8+10*23
});
t('fromRgb 往返(按 RGB 三元组比较,ANSI 有重复色)', () => {
  for (let i = 0; i < 256; i += 7) {
    const r = AC2.ANSI.rgbTable[i * 3], g = AC2.ANSI.rgbTable[i * 3 + 1], b = AC2.ANSI.rgbTable[i * 3 + 2];
    const j = AC2.ANSI.fromRgb(r, g, b);
    assert.equal(AC2.ANSI.rgbTable[j * 3], r);
    assert.equal(AC2.ANSI.rgbTable[j * 3 + 1], g);
    assert.equal(AC2.ANSI.rgbTable[j * 3 + 2], b);
  }
});

console.log('== comp(deflate + crc32) ==');
await (async () => {
  const mk = (n, f) => { const a = new Uint8Array(n); for (let i = 0; i < n; i++) a[i] = f(i); return a; };
  const cases = [
    ['zeros', mk(10000, () => 0)],
    ['text', new TextEncoder().encode('AETHERCONSOLE2 '.repeat(500))],
    ['random', mk(50000, () => (Math.random() * 256) | 0)],
    ['ramp', mk(65536, i => i & 255)]
  ];
  for (const [name, data] of cases) {
    try {
      const c = await AC2.Comp.compress(data);
      const d = await AC2.Comp.decompress(c);
      assert.deepEqual(Array.from(d), Array.from(data));
      passed++;
      console.log('  ok', `deflate 往返 ${name} (${data.length} → ${c.length})`);
    } catch (e) { failed++; console.log('FAIL', name, e.message); }
  }
  t('crc32 已知值', () => {
    assert.equal(AC2.Comp.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
  });
})();

console.log('== mulaw ==');
t('编解码往返(SNR ≥ 30dB)', () => {
  const N = 24000, f = new Float32Array(N), rec = new Float32Array(N);
  for (let i = 0; i < N; i++) f[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / 24000) + 0.2 * Math.sin(2 * Math.PI * 1234 * i / 24000);
  const enc = AC2.Mulaw.encodeBlock(f);
  const dec = AC2.Mulaw.decodeBlock(enc, rec);
  let se = 0, ss = 0;
  for (let i = 0; i < N; i++) { const e = f[i] - dec[i]; se += e * e; ss += f[i] * f[i]; }
  const snr = 10 * Math.log10(ss / se);
  assert.ok(snr > 30, 'SNR=' + snr.toFixed(1));
  console.log('    440Hz+1234Hz SNR =', snr.toFixed(1), 'dB');
});

console.log('== font ==');
t('BIOS 字体 95 字形 + AFNT 往返', () => {
  const f = AC2.Font.fromBuiltin();
  assert.equal(f.map.size, 95);
  const buf = f.serialize();
  const f2 = AC2.Font.parse(buf);
  assert.equal(f2.map.size, 95);
  for (const [cp, rows] of f.map) assert.deepEqual(Array.from(f2.get(cp)), Array.from(rows));
  assert.ok(buf.length === 8 + 95 * 4 + 95 * 28);
});

console.log('== cart(.aec build/load 往返)==');
await (async () => {
  const code = new TextEncoder().encode('function init(){} function update(){ /* ' + 'x'.repeat(2000) + ' */ }');
  const tiles = new Uint8Array(72 * 64); for (let i = 0; i < tiles.length; i++) tiles[i] = (i * 7) & 255;
  const cover = new Uint8Array(1024); for (let i = 0; i < 1024; i++) cover[i] = (i * 3) & 255;
  for (const obf of [false, true]) {
    try {
      const buf = await AC2.Cart.build({
        id: 'TESTCART', title: '测试卡带', version: 3, mode: 1,
        segments: [
          { type: 'code', name: 'main.ajs', data: code },
          { type: 'tilesobj', name: 'obj.til', data: tiles }
        ],
        obfuscate: obf, cover
      });
      const cart = await AC2.Cart.load(buf);
      assert.equal(cart.id, 'TESTCART');
      assert.equal(cart.version, 3);
      assert.equal(cart.mode, 1);
      assert.equal(cart.title, '测试卡带');
      const seg = cart.seg('code', 0);
      assert.deepEqual(Array.from(seg.data), Array.from(code));
      assert.deepEqual(Array.from(cart.seg('tilesobj', 0).data), Array.from(tiles));
      assert.deepEqual(Array.from(cart.cover), Array.from(cover));
      passed++;
      console.log('  ok', `cart 往返 obfuscate=${obf}(${buf.length}B)`);
    } catch (e) { failed++; console.log('FAIL', 'cart obf=' + obf, e.message); }
  }
  t('坏 CRC 报错', () => {
    // 直接构造再篡改
    assert.ok(true); // 在下方异步验证
  });
  try {
    const buf = await AC2.Cart.build({ id: 'TESTCART', title: 't', segments: [{ type: 'code', data: code }], cover });
    buf[70] ^= 0xFF;
    await AC2.Cart.load(buf);
    failed++; console.log('FAIL', '坏 CRC 应报错');
  } catch (e) {
    passed++; console.log('  ok', '坏 CRC 报错:', e.message);
  }
})();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
