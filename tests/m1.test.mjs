/* tests/m1.test.mjs — M1 验收(模式1):双 BG、滚动回绕、精灵优先级、OAM 128、每线 32 上限 */
import { load } from './load.mjs';

const AC2 = load(
  'js/core/ansi.js', 'js/core/comp.js', 'js/core/mulaw.js',
  'js/core/font.js', 'js/core/biosfont.js', 'js/core/cart.js',
  'js/host/input.js', 'js/host/mode1.js', 'js/host/mode2.js',
  'js/host/ajs.js', 'js/host/audio.js', 'js/host/bios.js', 'js/host/machine.js'
);

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok', name); }
  catch (e) { failed++; console.log('FAIL', name, '—', e.message); }
}

// —— 测试用 tileset 生成:tile 0 = 全透明;k = 纯色实心 ——
function makeTiles(n) {
  const buf = new Uint8Array(n * 72);
  for (let k = 1; k < n; k++) {
    const base = k * 72;
    for (let i = 0; i < 64; i++) buf[base + i] = k;
    // mask 全 0 = 全不透明
  }
  return buf;
}
function solidTile(buf, k, color) {
  const base = k * 72;
  for (let i = 0; i < 64; i++) buf[base + i] = color;
  for (let y = 0; y < 8; y++) buf[base + 64 + y] = 0;
}

const M = new AC2.Machine({});
M.setMode(1);

console.log('== M1 模式1 ==');
t('装载 tileset + 地图 + 双层优先级(BG0 < 精灵01 < BG1 < 精灵23)', () => {
  const tiles = makeTiles(16);
  M.S.loadTiles('bg', { data: tiles }, 0, 16);
  M.S.loadTiles('obj', { data: tiles }, 0, 16);
  const L0 = new Uint16Array(32 * 32).fill(M.S.entry(1));
  const L1 = new Uint16Array(32 * 32);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 16; x++) L1[y * 32 + x] = M.S.entry(2);
  M.S.setMap(0, 0, 0, 32, 32, L0);
  M.S.setMap(1, 0, 0, 32, 32, L1);
  M.m1.frameStart();
  M.S.setSprite(0, { x: 200, y: 100, tile: 4, prio: 0 });
  M.S.setSprite(1, { x: 20, y: 100, tile: 5, prio: 2 });
  M.m1.compose(M.fb);
  const at = (x, y) => M.fb[y * 240 + x];
  if (at(203, 100) !== 4) throw new Error('精灵 prio0 应盖 BG0: got ' + at(203, 100));
  if (at(23, 100) !== 5) throw new Error('精灵 prio2 应盖 BG1: got ' + at(23, 100));
});

t('tile 透明位露出下层 / tile 0 露出 backdrop', () => {
  const tiles = makeTiles(16);
  const base = 4 * 72;
  for (let y = 0; y < 8; y++) tiles[base + 64 + y] = 0xFF; // 全透明
  tiles[base + 64 + 0] = 0xFE; // 行 0 仅 x=0 不透明
  tiles[base + 0] = 77;
  M.S.loadTiles('bg', { data: tiles }, 0, 16);
  M.S.setMap(0, 0, 0, 32, 32, new Uint16Array(32 * 32).fill(M.S.entry(4)));
  M.S.setMap(1, 0, 0, 32, 32, new Uint16Array(32 * 32));
  M.m1.setBackdrop(9);
  M.m1.frameStart();
  M.m1.hideAll();
  M.m1.compose(M.fb);
  const at = (x, y) => M.fb[y * 240 + x];
  if (at(0, 0) !== 77) throw new Error('不透明点应显示 tile 色: got ' + at(0, 0));
  if (at(2, 0) !== 9) throw new Error('透明位应露 backdrop: got ' + at(2, 0));
});

t('滚动 + 地图回绕(水平/垂直)', () => {
  const L0 = new Uint16Array(32 * 32).fill(M.S.entry(1));
  L0[0] = M.S.entry(3);
  M.S.setMap(0, 0, 0, 32, 32, L0);
  M.S.setMap(1, 0, 0, 32, 32, new Uint16Array(32 * 32));
  M.m1.hideAll();
  M.S.scroll(0, 8, 0);
  M.m1.compose(M.fb);
  M.S.scroll(0, 256, 0);
  M.m1.compose(M.fb);
  if (M.fb[0] !== 3) throw new Error('水平回绕失败: got ' + M.fb[0]);
  M.S.scroll(0, 0, 256);
  M.m1.compose(M.fb);
  if (M.fb[0] !== 3) throw new Error('垂直回绕失败: got ' + M.fb[0]);
});

t('H/V 翻转(精灵)', () => {
  const tiles = makeTiles(16);
  const base = 6 * 72;
  for (let y = 0; y < 8; y++) tiles[base + 64 + y] = 0xFF;
  tiles[base + 64 + 0] = 0xFE; // 行 0 仅 x=0 不透明
  tiles[base + 0] = 7;
  M.S.loadTiles('obj', { data: tiles }, 0, 16);
  M.m1.frameStart();
  M.S.setSprite(0, { x: 100, y: 50, tile: 6 });
  M.m1.compose(M.fb);
  if (M.fb[50 * 240 + 100] !== 7) throw new Error('原始朝向失败');
  M.m1.frameStart();
  M.S.setSprite(0, { x: 100, y: 50, tile: 6, fh: 1 });
  M.m1.compose(M.fb);
  if (M.fb[50 * 240 + 107] !== 7) throw new Error('H 翻转失败');
  M.m1.frameStart();
  M.S.setSprite(0, { x: 100, y: 50, tile: 6, fv: 1 });
  M.m1.compose(M.fb);
  if (M.fb[57 * 240 + 100] !== 7) throw new Error('V 翻转失败');
});

t('16×16 精灵引用 4 连续 tile 展开', () => {
  const tiles = makeTiles(16);
  solidTile(tiles, 8, 20); solidTile(tiles, 9, 21); solidTile(tiles, 10, 22); solidTile(tiles, 11, 23);
  M.S.loadTiles('obj', { data: tiles }, 0, 16);
  M.m1.frameStart();
  M.S.setSprite(0, { x: 40, y: 60, tile: 8, big: 1 });
  M.m1.compose(M.fb);
  const at = (x, y) => M.fb[y * 240 + x];
  if (at(41, 61) !== 20) throw new Error('TL 错');
  if (at(55, 61) !== 21) throw new Error('TR 错');
  if (at(41, 75) !== 22) throw new Error('BL 错');
  if (at(55, 75) !== 23) throw new Error('BR 错');
});

t('每扫描线 32 上限:40 个同行精灵,超出按 OAM 序逐线丢弃', () => {
  const tiles = makeTiles(16);
  solidTile(tiles, 12, 40);
  M.S.loadTiles('obj', { data: tiles }, 0, 16);
  const L0 = new Uint16Array(32 * 32);
  M.S.setMap(0, 0, 0, 32, 32, L0);
  M.S.setMap(1, 0, 0, 32, 32, L0);
  M.m1.setBackdrop(0);
  M.m1.frameStart();
  for (let i = 0; i < 40; i++) M.S.setSprite(i, { x: i * 6, y: 80, tile: 12 });
  M.m1.compose(M.fb);
  if (M.m1.droppedLines !== 64) throw new Error('droppedLines=' + M.m1.droppedLines + ' 应为 64');
  const at = (x, y) => M.fb[y * 240 + x];
  if (at(239, 83) !== 0) throw new Error('第 33+ 个精灵应被丢弃: got ' + at(239, 83));
  if (at(10, 83) !== 40) throw new Error('前 32 个精灵之一应可见');
});

t('128 精灵满屏 + 帧首自动清 OAM(写回法)+ 合成性能', () => {
  M.m1.frameStart();
  M.m1.compose(M.fb);
  if (M.fb[83 * 240 + 10] === 40) throw new Error('帧首应自动清 OAM');
  const tiles = makeTiles(16);
  solidTile(tiles, 12, 40);
  M.S.loadTiles('obj', { data: tiles }, 0, 16);
  const L0 = new Uint16Array(32 * 32).fill(M.S.entry(1));
  M.S.setMap(0, 0, 0, 32, 32, L0);
  M.S.setMap(1, 0, 0, 32, 32, L0);
  const t0 = performance.now();
  let n = 0;
  for (let f = 0; f < 60; f++) {
    M.m1.frameStart();
    for (let i = 0; i < 128; i++) M.S.setSprite(i, { x: (i * 19 + f) % 232, y: (i * 13) % 168, tile: 12 });
    M.m1.compose(M.fb);
    n++;
  }
  const dt = (performance.now() - t0) / n;
  console.log('    128 精灵 × 双 BG 合成耗时/帧:', dt.toFixed(3), 'ms');
  if (dt > 8) throw new Error('模式1 合成过慢');
});

t('模式切换清 VRAM/OAM(§6.5)', () => {
  M.S.loadTiles('bg', { data: makeTiles(16) }, 0, 16);
  M.setMode(2);
  if (M.m1.bg.count !== 0) throw new Error('切换后 BG tileset 应清空');
  if (M.m1.oam.some(s => s.vis)) throw new Error('切换后 OAM 应清空');
  M.setMode(1);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
