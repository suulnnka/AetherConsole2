/* tests/m6.test.mjs — M6 验收:打包核心(自动识别/预算/混淆/冒烟/ID 登记) */
import { load } from './load.mjs';

const AC2 = load(
  'js/core/ansi.js', 'js/core/comp.js', 'js/core/mulaw.js',
  'js/core/font.js', 'js/core/biosfont.js', 'js/core/cart.js', 'js/core/packer.js',
  'js/host/input.js', 'js/host/mode1.js', 'js/host/mode2.js',
  'js/host/ajs.js', 'js/host/audio.js', 'js/host/bios.js', 'js/host/machine.js'
);

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok', name); } catch (e) { failed++; console.log('FAIL', name, '—', e.message); } }
async function ta(name, fn) { try { await fn(); passed++; console.log('  ok', name); } catch (e) { failed++; console.log('FAIL', name, '—', e.message); } }

const enc = (s) => new TextEncoder().encode(s);

function sampleProject(opts = {}) {
  const tiles = new Uint8Array(72 * 8);
  for (let k = 1; k < 8; k++) for (let i = 0; i < 64; i++) tiles[k * 72 + i] = 100 + k;
  return [
    { path: 'cart.json', data: enc(JSON.stringify({ id: 'PACKTST1', title: 'Pack Test', version: 3, mode: 1, sampling: 'nearest' })) },
    { path: 'cover.bin', data: new Uint8Array(1024).fill(9) },
    { path: 'main.ajs', data: enc('function init(){print("HI")} function update(){R.text(1,1,"x",{color:15})}') },
    { path: 'gfx/obj.til', data: (() => { const b = new Uint8Array(8 + 72 * 8); const dv = new DataView(b.buffer); dv.setUint32(0, 0x324C4954, true); dv.setUint16(4, 8, true); b[6] = 1; b.set(tiles, 8); return b; })() },
    { path: 'audio/tune.aud', data: enc(JSON.stringify({ timbres: [{ family: 'fc', wave: 2 }], patterns: [], musics: [] })) },
    { path: 'data/levels.bin', data: new Uint8Array(512) }
  ];
}

console.log('== M6 打包环境 ==');
await ta('自动识别:配置/图标/代码/图集/音乐集/自由数据 → 段表正确', async () => {
  const { bytes, report } = await AC2.Packer.buildFromFiles(sampleProject(), {});
  const types = report.segments.map(s => s.type);
  if (!types.includes('code')) throw new Error('code 段缺失');
  if (!types.includes('tilesobj')) throw new Error('obj tileset 段缺失: ' + types);
  if (!types.includes('audio')) throw new Error('audio 段缺失');
  if (!types.includes('data')) throw new Error('data 段缺失');
  if (!report.ok) throw new Error('预算不通过');
  const cart = await AC2.Cart.load(bytes);
  if (cart.id !== 'PACKTST1' || cart.version !== 3 || cart.sampling !== 'nearest') throw new Error('manifest 丢失');
});

await ta('code/ 多文件按名序拼接 + main.ajs 优先', async () => {
  const files = sampleProject().filter(f => f.path === 'cart.json' || f.path === 'cover.bin');
  files.push({ path: 'code/a_first.ajs', data: enc('var ORDER = ["a"];') });
  files.push({ path: 'code/b_second.ajs', data: enc('ORDER.push("b"); function init(){print("ORD " + ORDER.join(","))} function update(){}') });
  const { bytes } = await AC2.Packer.buildFromFiles(files, {});
  const cart = await AC2.Cart.load(bytes);
  const M = new AC2.Machine({ bios: false });
  M.bootCart(cart);
  if (!M.printLog.some(l => l.line === 'ORD a,b')) throw new Error('拼接顺序错:' + M.printLog.map(l => l.line).join('|'));
});

await ta('两种出品均可被内核装载运行(标准 + 混淆)', async () => {
  for (const obf of [false, true]) {
    const { bytes, report } = await AC2.Packer.buildFromFiles(sampleProject(), { obfuscate: obf });
    if (report.obfuscated !== obf) throw new Error('标志错');
    const s = await AC2.Packer.smoke(bytes, 30);
    if (!s.ok) throw new Error((obf ? '混淆' : '标准') + '冒烟失败: ' + s.error);
    // 混淆产物不可直读源码(段标识抹除/数据混淆)
    if (obf) {
      const raw = new TextDecoder().decode(bytes);
      if (raw.includes('function init')) throw new Error('混淆卡源码可直读');
    }
  }
});

await ta('256KB 硬上限:超限拒绝出品并报告最大段', async () => {
  const files = sampleProject();
  const big = new Uint8Array(300 * 1024);
  let rs = 0x12345678;
  for (let i = 0; i < big.length; i++) {
    rs ^= rs << 13; rs >>>= 0; rs ^= rs >>> 17; rs ^= rs << 5; rs >>>= 0;
    big[i] = rs & 255; // xorshift 高熵,不可压缩
  }
  files.push({ path: 'data/big.bin', data: big });
  let threw = null;
  try { await AC2.Packer.buildFromFiles(files, {}); } catch (e) { threw = e; }
  if (!threw || !threw.report) throw new Error('超限未拒绝');
  if (!threw.message.includes('big.bin')) throw new Error('未提示最大段: ' + threw.message);
});

await ta('装载冒烟:坏代码卡带被拦截', async () => {
  const files = sampleProject();
  files.find(f => f.path === 'main.ajs').data = enc('function init(){ print("go"); } function update(){ if (frame() > 10) throw new Error("X"); }');
  const { bytes } = await AC2.Packer.buildFromFiles(files, {});
  const s = await AC2.Packer.smoke(bytes, 30);
  if (s.ok) throw new Error('坏卡带未被冒烟拦截');
  if (!/X/.test(s.error)) throw new Error('错误信息丢失: ' + s.error);
});

t('ID 登记(本地 registry 防冲突)', () => {
  AC2.Packer.Registry._mem = new Map();
  AC2.Packer.Registry.register('REGTEST1', 'A', 1);
  if (!AC2.Packer.Registry.check('REGTEST1', 1)) throw new Error('同版本应提示');
  if (!AC2.Packer.Registry.check('REGTEST1', 0)) throw new Error('低版本应提示');
  if (AC2.Packer.Registry.check('REGTEST1', 2)) throw new Error('高版本不应提示');
  if (AC2.Packer.Registry.check('OTHERID1', 1)) throw new Error('未登记 ID 不应提示');
  AC2.Packer.Registry.register('REGTEST1', 'A', 2);
  if (!AC2.Packer.Registry.check('REGTEST1', 1)) throw new Error('登记 v2 后 v1 应视为冲突');
});

await ta('manifest 缺失项给默认值 + 非法 ID 拒绝', async () => {
  const files = sampleProject().filter(f => f.path !== 'cart.json');
  files.find(f => f.path === 'main.ajs').data = enc('function init(){} function update(){}');
  const { report } = await AC2.Packer.buildFromFiles(files, {});
  if (report.id !== 'AC2TEMP1') throw new Error('默认 ID 错: ' + report.id);
  const bad = sampleProject();
  bad.find(f => f.path === 'cart.json').data = enc(JSON.stringify({ id: 'TOO LONG!' }));
  let threw = false;
  try { await AC2.Packer.buildFromFiles(bad, {}); } catch (e) { threw = true; }
  if (!threw) throw new Error('非法 ID 未拒绝');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
