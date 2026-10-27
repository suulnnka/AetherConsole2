/* tests/m8.test.mjs — M8 验收:字体编辑器(三区网格/自定义码点含中文/AFNT v2 往返/入卡带游戏内生效) */
import { load } from './load.mjs';

const AC2 = load(
  'js/core/ansi.js', 'js/core/comp.js', 'js/core/mulaw.js',
  'js/core/font.js', 'js/core/biosfont.js', 'js/core/cart.js', 'js/core/packer.js',
  'js/host/input.js', 'js/host/mode1.js', 'js/host/mode2.js',
  'js/host/ajs.js', 'js/host/audio.js', 'js/host/bios.js', 'js/host/machine.js',
  'js/tools/fontedit.js'
);

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok', name); } catch (e) { failed++; console.log('FAIL', name, '—', e.message); } }
async function ta(name, fn) { try { await fn(); passed++; console.log('  ok', name); } catch (e) { failed++; console.log('FAIL', name, '—', e.message); } }
const enc = (s) => new TextEncoder().encode(s);

console.log('== M8 字体编辑器 ==');

t('14×14 三区:主区 12×12 + 左 2 入侵 + 下 2 尾部(编辑 API)', () => {
  const FE = AC2.FontEdit;
  FE.state.font = AC2.Font.fromBuiltin();
  FE.state.cp = 65;
  FE.loadGlyph();
  // 'A' 应有主区字形
  let bits = 0;
  for (let y = 0; y < 14; y++) bits |= FE.state.grid[y];
  if (!bits) throw new Error('A 字形为空');
  // 画入侵区(列 0)与尾部区(行 13)
  FE.state.grid[0] |= 1;       // 列 0 = 入侵区
  FE.state.grid[13] |= (1 << 5); // 行 13 = 尾部区
  FE.storeGlyph();
  const g = FE.state.font.get(65);
  if (!(g[0] & 1)) throw new Error('入侵区位未存');
  if (!(g[13] & (1 << 5))) throw new Error('尾部区位未存');
});

t('自定义码点(中文 U+4E2D)添加 + AFNT v2 往返', () => {
  const f = AC2.Font.fromBuiltin();
  const rows = new Uint16Array(14);
  rows[3] = 0x0FF0; // 主区一横
  f.set(0x4E2D, rows);
  const buf = f.serialize();
  const f2 = AC2.Font.parse(buf);
  if (!f2.has(0x4E2D)) throw new Error('中文码点丢失');
  if (f2.get(0x4E2D)[3] !== 0x0FF0) throw new Error('字形位丢失');
  if (f2.map.size !== 96) throw new Error('字数: ' + f2.map.size);
});

await ta('入卡带:游戏内 R.text 用卡带字体,BIOS 菜单仍内置字体(§7.4)', async () => {
  // 自制字体:'A' 改成只有主区 (2,2) 单点;BIOS 字体的 'A' 远多于一个点
  const f = AC2.Font.fromBuiltin();
  f.set(65, Uint16Array.from([0, 0, 1 << 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const afnt = f.serialize();
  const files = [
    { path: 'cart.json', data: enc(JSON.stringify({ id: 'FONTTEST', title: 'Font', version: 1, mode: 2 })) },
    { path: 'cover.bin', data: new Uint8Array(1024).fill(3) },
    { path: 'main.ajs', data: enc(`
      function init(){ R.clear(0); }
      function update(){
        R.clear(0);
        R.text(10, 10, 'A', { color: 15 });        // 应走卡带字体(单点)
        bios.text(10, 40, 'A', { color: 15 });     // 恒用 BIOS 字体(多点)
      }`) },
    { path: 'font.afnt', data: afnt }
  ];
  const { bytes } = await AC2.Packer.buildFromFiles(files, {});
  const M = new AC2.Machine({ bios: false });
  M.bootCart(await AC2.Cart.load(bytes));
  M.step();
  if (!M.fonts.cart) throw new Error('卡带字体未装载');
  // R.text 的 'A':单点在 (10-2+2, 10+2) = (10, 12)
  let cartPts = 0;
  for (let y = 10; y < 24; y++) for (let x = 8; x < 22; x++) if (M.fb[y * 240 + x] === 15) cartPts++;
  if (cartPts !== 1) throw new Error('卡带字体未生效(点数 ' + cartPts + ')');
  // bios.text 的 'A':BIOS 字形多像素
  let biosPts = 0;
  for (let y = 40; y < 54; y++) for (let x = 8; x < 22; x++) if (M.fb[y * 240 + x] === 15) biosPts++;
  if (biosPts < 5) throw new Error('BIOS 字体未用(点数 ' + biosPts + ')');
  console.log('    游戏内文本 ' + cartPts + ' 点(卡带字体) vs bios.text ' + biosPts + ' 点(内置字体)');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
