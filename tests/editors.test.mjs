/* tests/editors.test.mjs — 编辑器搬运验收
 * 1) 魔塔编辑器试玩通道:data 段 MAPS/MON 覆盖 → 重打包 → 真机运行且行为与原版可区分
 * 2) FPS 编辑器几何核心(fpsmap-core):示例地图缝合/校验、T 接自动切线、splitLine
 */
import { load } from './load.mjs';
import { readFileSync } from 'node:fs';

const AC2 = load(
  'js/core/ansi.js', 'js/core/comp.js', 'js/core/mulaw.js',
  'js/core/font.js', 'js/core/biosfont.js', 'js/core/cart.js', 'js/core/packer.js',
  'js/host/input.js', 'js/host/mode1.js', 'js/host/mode2.js',
  'js/host/ajs.js', 'js/host/audio.js', 'js/host/bios.js', 'js/host/machine.js',
  'js/tools/fpsmap-core.js'
);
const FM = AC2.FPSMap;

let passed = 0, failed = 0;
async function ta(name, fn) { try { await fn(); passed++; console.log('  ok', name); } catch (e) { failed++; console.log('FAIL', name, '—', e.message); } }
function assert(cond, msg) { if (!cond) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ': ' + JSON.stringify(a) + ' ≠ ' + JSON.stringify(b)); }

const k = (over) => ({ keys: Object.assign({ up: 0, down: 0, left: 0, right: 0, a: 0, b: 0, start: 0 }, over), x: 120, y: 88, dx: 0, dy: 0 });
const memStorage = () => ({ _m: new Map(), getItem(k2) { return this._m.has(k2) ? this._m.get(k2) : null; }, setItem(k2, v) { this._m.set(k2, String(v)); }, removeItem(k2) { this._m.delete(k2); } });

/* ================= 魔塔编辑器试玩通道 ================= */

const MT_FILES = ['cart.json', 'main.ajs', 'cover.bin', 'gfx/bg.til', 'gfx/obj.til', 'audio/game.aud', 'data/pal.json']
  .map(p => ({ path: p, data: new Uint8Array(readFileSync(new URL('../carts/magictower/' + p, import.meta.url))) }));

// 自定义 3 层塔(编辑器里的典型产物:楼梯配对/钥匙/怪/结局 L)
const CUSTOM_MAPS = [
  ['###########',
   '#x.k...u..<',
   '#.........#',
   '#....g....#',
   '#.........#',
   '#..d......#',
   '#.........#',
   '#.........#',
   '#.........#',
   '#.........#',
   '###########'],
  ['###########',
   '#>........#',
   '#.........#',
   '#....y....#',
   '#.........#',
   '#.........#',
   '#.........#',
   '#.........#',
   '#.........#',
   '#........<#',
   '###########'],
  ['###########',
   '#>........#',
   '#.........#',
   '#.........#',
   '#.........#',
   '#....L....#',
   '#.........#',
   '#.........#',
   '#.........#',
   '#.........#',
   '###########']
];

async function buildOverrideCart() {
  const pal = JSON.parse(new TextDecoder().decode(MT_FILES.find(f => f.path === 'data/pal.json').data));
  pal.MAPS = CUSTOM_MAPS;
  pal.MON = { g: { n: 'SLIME', hp: 3, atk: 5, def: 0, gold: 7 } };
  const enc = new TextEncoder();
  const files = MT_FILES.map(f =>
    f.path === 'data/pal.json' ? { path: f.path, data: enc.encode(JSON.stringify(pal)) } : f);
  const { bytes } = await AC2.Packer.buildFromFiles(files);
  return { bytes, cart: await AC2.Cart.load(bytes) };
}

console.log('== 编辑器搬运验收 ==');

await ta('魔塔:覆盖 MAPS/MON 进 data 段 → 重打包 → 段内确有覆盖', async () => {
  const { bytes, cart } = await buildOverrideCart();
  assert(bytes.length <= AC2.Cart.LIMIT, '超 256KB');
  eq(cart.id, 'MAGICTW1');
  const d = JSON.parse(new TextDecoder().decode(cart.seg('data', 0).data));
  eq(d.MAPS.length, 3);
  eq(d.MAPS[0][1], '#x.k...u..<' .slice(0, 11));
  eq(d.MON.g.hp, 3);
  eq(d.MON.g.atk, 5);
});

await ta('魔塔:试玩真机运行,自定义塔行为与原版可区分', async () => {
  const { cart } = await buildOverrideCart();
  const st = memStorage();
  const M = new AC2.Machine({ bios: false, storage: st });
  M.bootCart(cart);
  M.step();
  assert(!M.halted, 'boot: ' + (M.error && M.error.message));
  M.input.pushInput(k({ a: 1 })); M.step();   // 标题 → 新游戏
  M.input.pushInput(k({})); M.step();
  assert(!M.halted, 'start: ' + (M.error && M.error.message));
  let hash = 0;
  for (let f = 0; f < 300; f++) {
    M.input.pushInput(k({ right: f % 60 < 30, down: f % 90 > 60 }));
    M.step();
    assert(!M.halted, 'frame ' + f + ': ' + (M.error && M.error.message));
  }
  for (let i = 0; i < M.fb.length; i += 97) hash += M.fb[i] * (i % 7);

  // 原版 21 层塔同脚本运行,画面哈希必须不同(证明覆盖被游戏消费)
  const stock = await AC2.Cart.load(new Uint8Array(readFileSync(new URL('../carts/dist/magictower.aec', import.meta.url))));
  const M2 = new AC2.Machine({ bios: false, storage: memStorage() });
  M2.bootCart(stock);
  M2.step();
  M2.input.pushInput(k({ a: 1 })); M2.step();
  M2.input.pushInput(k({})); M2.step();
  for (let f = 0; f < 300; f++) {
    M2.input.pushInput(k({ right: f % 60 < 30, down: f % 90 > 60 }));
    M2.step();
    assert(!M2.halted, 'stock frame ' + f);
  }
  let hash2 = 0;
  for (let i = 0; i < M2.fb.length; i += 97) hash2 += M2.fb[i] * (i % 7);
  assert(hash !== hash2, '自定义塔与原版画面完全相同——覆盖未生效');
});

await ta('魔塔:试玩存档往返(MT 头/键值)', async () => {
  const { cart } = await buildOverrideCart();
  const st = memStorage();
  const M = new AC2.Machine({ bios: false, storage: st });
  M.bootCart(cart);
  M.step();
  M.input.pushInput(k({ a: 1 })); M.step();   // 新游戏即 persist
  M.input.pushInput(k({})); M.step();
  M.input.pushInput(k({ right: 1 })); M.step();  // 拿钥匙也 persist
  const d = M.loadSave();
  assert(d && d.length >= 12 && d[0] === 77 && d[1] === 84, '存档缺失或头错误');
  // 重启读档
  const M2 = new AC2.Machine({ bios: false, storage: st });
  M2.bootCart(cart);
  M2.step();
  const d2 = M2.loadSave();
  assert(d2 && d2[0] === 77, '重启后存档丢失');
});

/* ================= FPS 编辑器几何核心 ================= */

function buildExampleMap() {   // 与编辑器 buildExample 同序列
  const map = FM.newMapData('示例:堡垒广场');
  const sec = (p, props) => FM.createSectorFromPath(map, FM.rectPath(map, p[0], p[1], p[2], p[3]), props);
  sec([-384, -384, 384, 384], { floorH: -16, ceilH: 224, light: 216, sky: true,
    floorC: '#6e6a5e', wallC: '#8d897b', ceilC: '#10131f' });
  sec([-256, -256, 256, 256], { floorH: 0, ceilH: 168, light: 176,
    floorC: '#7b6f5c', wallC: '#a08d6f', ceilC: '#46423c' });
  sec([-96, -96, 96, 96], { floorH: 24, ceilH: 168, light: 196,
    floorC: '#96825f', wallC: '#b09a6e', ceilC: '#46423c' });
  sec([208, -32, 240, 32], { floorH: 8, ceilH: 224, light: 210, sky: true,
    floorC: '#6a675c', wallC: '#83807a', ceilC: '#10131f' });
  sec([240, -32, 272, 32], { floorH: 32, ceilH: 224, light: 210, sky: true,
    floorC: '#6a675c', wallC: '#83807a', ceilC: '#10131f' });
  sec([272, -80, 368, 80], { floorH: 40, ceilH: 224, light: 208, sky: true,
    floorC: '#5f6e5a', wallC: '#7d8a76', ceilC: '#10131f' });
  sec([-368, -368, -272, -208], { floorH: 0, ceilH: 112, light: 132,
    floorC: '#6d5c4e', wallC: '#8a7660', ceilC: '#3a352e' });
  const th = (t, x, z, a) => map.things.push({ type: t, x, z, angle: a || 0 });
  th('player1', 0, -160, 0);
  th('stalker', 80, 80); th('stalker', -120, -40);
  th('wasp', -220, 300); th('wasp', 320, -160);
  th('sentry', 320, 0, 180); th('brute', -320, -288, 90);
  th('armor', 0, 0); th('medkit', -210, 160); th('vial', 200, 180);
  th('ammo', -60, 160); th('barrel', 150, 250); th('barrel', 176, 250);
  return map;
}

await ta('FPS 核心:示例地图 7 扇区自动缝合,校验零错误', async () => {
  const map = buildExampleMap();
  eq(map.sectors.length, 7);
  for (const l of map.linedefs) assert(l.front >= 0, '存在缺前侧的线');
  const { errs, warns } = FM.validate(map);
  eq(errs.length, 0, '校验错误: ' + errs.join('; '));
  eq(warns.length, 0, '校验警告: ' + warns.join('; '));
});

await ta('FPS 核心:sectorAt 归属与 JSON 往返', async () => {
  const map = buildExampleMap();
  eq(FM.sectorAt(map, -370, 10), 0, '外院');
  eq(FM.sectorAt(map, 0, -200), 1, '大厅');
  eq(FM.sectorAt(map, 0, 0), 2, '中央高台');
  eq(FM.sectorAt(map, 224, 0), 3, '台阶1');
  eq(FM.sectorAt(map, 256, 0), 4, '台阶2');
  eq(FM.sectorAt(map, 320, 0), 5, '东侧高台');
  eq(FM.sectorAt(map, -320, -288), 6, '西北暗室');
  const rt = JSON.parse(JSON.stringify(map));   // 编辑器存草稿/导出的路径
  const v = FM.validate(rt);
  eq(v.errs.length, 0, 'JSON 往返后校验错误: ' + v.errs.join('; '));
});

await ta('FPS 核心:T 接自动切线并双面缝合', async () => {
  const map = FM.newMapData('t');
  FM.createSectorFromPath(map, FM.rectPath(map, -200, -200, 200, 200), {});
  const linesBefore = map.linedefs.length;
  // 外墙顶部(z=200)中段外接一个 annex,底边两端点落在原线内部 → 原线应被切分
  FM.createSectorFromPath(map, FM.rectPath(map, -100, 200, 100, 300), {});
  map.things.push({ type: 'player1', x: 0, z: 0, angle: 0 });
  assert(map.linedefs.length > linesBefore + 3, '切分未发生');
  const { errs } = FM.validate(map);
  eq(errs.length, 0, 'T 接后校验错误: ' + errs.join('; '));
  eq(FM.sectorAt(map, 0, 250), 1, 'annex 归属');
  eq(FM.sectorAt(map, 0, 0), 0, '原扇区保持');
  // 外墙顶线中段应为双面线(前=原区 后=annex)
  let shared = 0;
  for (const l of map.linedefs) {
    const a = FM.V(map, l.v1), b = FM.V(map, l.v2);
    if (Math.abs(a.z - 200) < 0.01 && Math.abs(b.z - 200) < 0.01 && a.x >= -99 && b.x <= 99)
      if (l.front >= 0 && l.back >= 0) shared++;
  }
  assert(shared >= 1, '共享边未缝成双面线');
});

await ta('FPS 核心:splitLine 中点分割', async () => {
  const map = FM.newMapData('s');
  FM.createSectorFromPath(map, FM.rectPath(map, -64, -64, 64, 64), {});
  map.things.push({ type: 'player1', x: 0, z: 0, angle: 0 });
  const v0 = map.vertices.length;
  const nv = FM.splitLine(map, 0, { x: -64, z: 0 });
  assert(nv >= 0 && map.vertices.length === v0 + 1, '顶点未增加');
  eq(map.linedefs.length, 5);
  const { errs } = FM.validate(map);
  eq(errs.length, 0, '分割后校验错误: ' + errs.join('; '));
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
