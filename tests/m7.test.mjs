/* tests/m7.test.mjs — M7 验收:编辑器产物(格式正确性)→ 打包 → 内核显示 端到端 */
import { load } from './load.mjs';

const AC2 = load(
  'js/core/ansi.js', 'js/core/comp.js', 'js/core/mulaw.js',
  'js/core/font.js', 'js/core/biosfont.js', 'js/core/cart.js', 'js/core/packer.js',
  'js/host/input.js', 'js/host/mode1.js', 'js/host/mode2.js',
  'js/host/ajs.js', 'js/host/audio.js', 'js/host/bios.js', 'js/host/machine.js',
  'js/tools/imgedit.js'
);

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok', name); } catch (e) { failed++; console.log('FAIL', name, '—', e.message); } }
async function ta(name, fn) { try { await fn(); passed++; console.log('  ok', name); } catch (e) { failed++; console.log('FAIL', name, '—', e.message); } }
const enc = (s) => new TextEncoder().encode(s);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

console.log('== M7 图像编辑器 ==');

const IE = AC2.ImgEdit;

t('精灵 8×8 导出 .til:格式(TIL2/OBJ/72B 每 tile)可被内核 loadTiles', () => {
  const sp = IE.sprite;
  sp.size = 8;
  sp.frames = [{ px: new Uint8Array(64).fill(9), tmask: new Uint8Array(64) }];
  sp.frames[0].tmask[0] = 1; // (0,0) 透明
  sp.cur = 0;
  const til = sp.exportTil();
  const dv = new DataView(til.buffer);
  if (dv.getUint32(0, true) !== 0x324C4954) throw new Error('magic');
  if (dv.getUint16(4, true) !== 1) throw new Error('count');
  if (til[6] !== 1) throw new Error('kind=OBJ');
  if (til.length !== 8 + 72) throw new Error('长度');
  // 内核装载
  const M = new AC2.Machine({ bios: false });
  M.setMode(1);
  M.S.loadTiles('obj', { data: til.subarray(8) }, 0, 1);
  M.m1.frameStart();
  M.S.setSprite(0, { x: 0, y: 0, tile: 0 });
  M.m1.compose(M.fb);
  if (M.fb[0] !== 0 || M.fb[1] !== 9) throw new Error('透明/实色错位');
});

t('精灵 16×16 导出 4 连续 tile,内核 2×2 展开正确', () => {
  const sp = IE.sprite;
  sp.size = 16;
  const px = new Uint8Array(256), tm = new Uint8Array(256);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    px[y * 16 + x] = x < 8 ? (y < 8 ? 20 : 22) : (y < 8 ? 21 : 23); // 四象限四色
  }
  sp.frames = [{ px, tmask: tm }];
  sp.cur = 0;
  const til = sp.exportTil();
  const dv = new DataView(til.buffer);
  if (dv.getUint16(4, true) !== 4) throw new Error('应有 4 tile');
  const M = new AC2.Machine({ bios: false });
  M.setMode(1);
  M.S.loadTiles('obj', { data: til.subarray(8) }, 0, 4);
  M.m1.frameStart();
  M.S.setSprite(0, { x: 40, y: 60, tile: 0, big: 1 });
  M.m1.compose(M.fb);
  const at = (x, y) => M.fb[y * 240 + x];
  if (at(41, 61) !== 20 || at(55, 61) !== 21 || at(41, 75) !== 22 || at(55, 75) !== 23) throw new Error('象限错位');
});

t('地图导出 .map(MAP2)+ 碰撞 .bin(COL1)+ 内核装载', () => {
  const map = IE.map;
  map.w = 32; map.h = 22;
  map.layers = [new Uint16Array(32 * 22), new Uint16Array(32 * 22)];
  map.collision = new Uint8Array(32 * 22);
  map.layers[0][5 * 32 + 7] = 3;      // tile 3 at (7,5)
  map.collision[5 * 32 + 7] = 1;
  const mb = map.exportMap();
  const dv = new DataView(mb.buffer);
  if (dv.getUint32(0, true) !== 0x3250414D) throw new Error('MAP2 magic');
  if (dv.getUint16(4, true) !== 32 || dv.getUint16(6, true) !== 22) throw new Error('尺寸');
  const M = new AC2.Machine({ bios: false });
  M.setMode(1);
  const tiles = new Uint8Array(8 + 72 * 8);
  for (let k = 1; k < 8; k++) for (let i = 0; i < 64; i++) tiles[8 + k * 72 + i] = 40 + k;
  const tildv = new DataView(tiles.buffer);
  tildv.setUint32(0, 0x324C4954, true); tildv.setUint16(4, 8, true); tiles[6] = 0;
  M.S.loadTiles('bg', { data: tiles.subarray(8) }, 0, 8);
  M.S.loadMap(0, { data: mb }, 0);
  M.m1.hideAll();
  M.m1.compose(M.fb);
  if (M.fb[5 * 8 * 240 + 7 * 8] !== 43) throw new Error('地图条目未生效: ' + M.fb[5 * 8 * 240 + 7 * 8]);
  const col = map.exportCollision();
  if (new DataView(col.buffer).getUint32(0, true) !== 0x314C4F43) throw new Error('COL1 magic');
  const bit = (col[8 + ((5 * 32 + 7) >> 3)] >> (7 & 5)) & 1; // bit = i&7
  const i = 5 * 32 + 7;
  if (!((col[8 + (i >> 3)] >> (i & 7)) & 1)) throw new Error('碰撞位错');
});

t('16×16 图块笔刷一次占 2×2 = 4 格(T13)', () => {
  const map = IE.map;
  map.w = 32; map.h = 22;
  map.layers = [new Uint16Array(32 * 22), new Uint16Array(32 * 22)];
  map.collision = new Uint8Array(32 * 22);
  map.selTile = 10; map.selBig = true; map.flipH = map.flipV = false;
  map.setTileAt(4, 3, false);
  const L = map.layers[0];
  if (L[3 * 32 + 4] !== 10 || L[3 * 32 + 5] !== 11 || L[4 * 32 + 4] !== 12 || L[4 * 32 + 5] !== 13) {
    throw new Error('4 格写入错:' + [L[3 * 32 + 4], L[3 * 32 + 5], L[4 * 32 + 4], L[4 * 32 + 5]]);
  }
  map.selBig = false;
});

t('自由绘制导出 .bm2 / cover.bin(封面模板 32×32)', () => {
  const free = IE.free;
  free.w = 32; free.h = 32;
  free.px = new Uint8Array(1024);
  free.tmask = new Uint8Array(1024);
  for (let i = 0; i < 1024; i++) free.px[i] = (i * 7) & 255;
  free.px[100] = 9; free.tmask[100] = 1;
  const bm = free.exportBm2();
  const M = new AC2.Machine({ bios: false });
  M.setMode(2);
  M.R.loadBitmap('b', { data: bm });
  const b = M.R.bitmap('b');
  if (b.w !== 32 || b.h !== 32) throw new Error('尺寸');
  if (!b.tmask[100] || b.tmask[101]) throw new Error('透明位');
  M.R.blit('b', 0, 0);
  // 位图像素 101 = (x=5, y=3) → 屏幕 fb[3*240+5]
  if (M.fb[3 * 240 + 5] !== ((101 * 7) & 255)) throw new Error('blit 像素');
  if (M.fb[3 * 240 + 4] === 9) throw new Error('透明位未被跳过');
  const cover = free.exportCover();
  if (cover.length !== 1024 || cover[0] !== 0) throw new Error('cover');
});

await ta('端到端:编辑器产物 → 打包环境 → 内核装载显示', async () => {
  // 组一个 mode1 小卡带:精灵 .til + 地图 .map + 位图(自由) → 显示
  const sp = IE.sprite;
  sp.size = 8;
  sp.frames = [{ px: new Uint8Array(64).fill(46), tmask: new Uint8Array(64) }];
  sp.cur = 0;
  const til = sp.exportTil();

  const map = IE.map;
  map.w = 32; map.h = 22;
  map.layers = [new Uint16Array(32 * 22), new Uint16Array(32 * 22)];
  map.collision = new Uint8Array(32 * 22);
  map.layers[0].fill(1); // tile 1 = 编辑器导出的精灵 tile(色 46)
  const mapBuf = map.exportMap();

  const free = IE.free;
  free.w = 16; free.h = 16;
  free.px = new Uint8Array(256).fill(196);
  free.tmask = new Uint8Array(256);
  const bm2 = free.exportBm2();

  const files = [
    { path: 'cart.json', data: enc(JSON.stringify({ id: 'EDIT2CRT', title: 'Editor E2E', version: 1, mode: 1 })) },
    { path: 'cover.bin', data: (() => { const c = new Uint8Array(1024).fill(2); return c; })() },
    { path: 'main.ajs', data: enc(`
      function init(){
        S.loadTiles('obj', cart.seg('tilesobj',0).data, 1, 1);  // 段内第 1 个 tile → 放到索引 1
        S.loadTiles('bg', cart.seg('tilesobj',0).data, 1, 1);
        S.loadMap(0, cart.seg('maps',0).data, 0);
        S.backdrop(16);
        var dv = new DataView(cart.seg('data',0).data.buffer);
        print('DATA ' + dv.getUint16(0, true));
      }
      function update(){
        S.setSprite(0, { x: (frame() >> 2) % 220, y: 80, tile: 1 });
        bios.text(4, 4, 'E2E OK', { color: 15 });
      }`) },
    { path: 'gfx/spr.til', data: til },
    { path: 'gfx/bg.map', data: mapBuf },
    { path: 'data/hdr.bin', data: (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint16(0, 1234, true); return b; })() }
  ];
  const { bytes } = await AC2.Packer.buildFromFiles(files, {});
  const s = await AC2.Packer.smoke(bytes, 30);
  if (!s.ok) throw new Error('冒烟失败: ' + s.error + '\n' + (s.stack || ''));
  // 验证显示:tile 1 铺屏(色 40+1=41?精灵 tile 在索引 8)
  const M = new AC2.Machine({ bios: false });
  const cart = await AC2.Cart.load(bytes);
  M.bootCart(cart);
  for (let i = 0; i < 8; i++) M.step();
  if (!M.printLog.some(l => l.line === 'DATA 1234')) throw new Error('数据段读取失败');
  const at = (x, y) => M.fb[y * 240 + x];
  if (at(10, 10) !== 46) throw new Error('BG 未铺: ' + at(10, 10));
  if (at(5, 80) !== 46 && at(70, 84) !== 46) throw new Error('精灵未动');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
