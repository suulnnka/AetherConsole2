/* build/gen-assets.mjs — M12 示例卡带资产生成(格式与编辑器导出完全一致:.til/.map/.bm2/COL1/.aud/cover.bin)
 * 用法:node build/gen-assets.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { load } from '../tests/load.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
load('js/core/ansi.js', 'js/core/comp.js', 'js/core/mulaw.js', 'js/core/font.js', 'js/core/biosfont.js', 'js/core/cart.js', 'js/core/packer.js',
  'js/host/input.js', 'js/host/mode1.js', 'js/host/mode2.js', 'js/host/ajs.js', 'js/host/audio.js', 'js/host/bios.js', 'js/host/machine.js');
const { ANSI, b64FromBytes, Mulaw } = globalThis.AC2;

const A = (i) => ANSI.rgbTable[i * 3];
// 常用色
const C = {
  grass: ANSI.fromRgbFast(70, 160, 70), grassD: ANSI.fromRgbFast(40, 110, 50),
  dirt: ANSI.fromRgbFast(140, 95, 60), dirtD: ANSI.fromRgbFast(110, 72, 45),
  brick: ANSI.fromRgbFast(180, 70, 60), brickD: ANSI.fromRgbFast(130, 45, 40),
  spike: ANSI.fromRgbFast(170, 170, 180), spikeD: ANSI.fromRgbFast(110, 110, 120),
  stone: ANSI.fromRgbFast(150, 150, 160), stoneD: ANSI.fromRgbFast(100, 100, 110),
  pole: ANSI.fromRgbFast(80, 120, 200), flag: ANSI.css ? 51 : 51,
  white: 15, black: 16, blue: 21, skin: ANSI.fromRgbFast(235, 190, 150),
  shirt: ANSI.fromRgbFast(220, 60, 60), shirtD: ANSI.fromRgbFast(170, 40, 40),
  pants: ANSI.fromRgbFast(50, 70, 140),
  coin: ANSI.fromRgbFast(250, 210, 60), coinD: ANSI.fromRgbFast(200, 150, 30),
  slime: ANSI.fromRgbFast(90, 200, 120), slimeD: ANSI.fromRgbFast(50, 140, 80),
  rock: ANSI.fromRgbFast(140, 130, 120), rockD: ANSI.fromRgbFast(95, 88, 80),
  ship: ANSI.fromRgbFast(120, 200, 255), shipD: 75, flame: 208,
  bg1: ANSI.fromRgbFast(28, 30, 44)
};

// ---------- TIL2 写出 ----------
function til(kind, tiles) {
  const buf = new Uint8Array(8 + tiles.length * 72);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x324C4954, true);
  dv.setUint16(4, tiles.length, true);
  buf[6] = kind;
  tiles.forEach((t, i) => {
    buf.set(t.px, 8 + i * 72);
    buf.set(t.mask, 8 + i * 72 + 64);
  });
  return buf;
}
// 8×8 tile 构造:fn(x,y) → 色号 | null(透明)
function tile8(fn) {
  const px = new Uint8Array(64), mask = new Uint8Array(8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const v = fn(x, y);
    if (v == null) mask[y] |= 1 << x;
    else px[y * 8 + x] = v;
  }
  return { px, mask };
}
// 16×16 → 4 连续 tile(TL,TR,BL,BR)
function tile16(fn) {
  const q = [[0, 0], [8, 0], [0, 8], [8, 8]];
  return q.map(([ox, oy]) => tile8((x, y) => fn(x + ox, y + oy)));
}

// ---------- MAP2 / COL1 ----------
function map2(w, h, entries) {
  const buf = new Uint8Array(8 + w * h * 2);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x3250414D, true);
  dv.setUint16(4, w, true); dv.setUint16(6, h, true);
  for (let i = 0; i < w * h; i++) dv.setUint16(8 + i * 2, entries[i], true);
  return buf;
}
function col1(w, h, solid) {
  const bytes = Math.ceil(w * h / 8);
  const buf = new Uint8Array(8 + bytes);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x314C4F43, true);
  dv.setUint16(4, w, true); dv.setUint16(6, h, true);
  for (let i = 0; i < w * h; i++) if (solid[i]) buf[8 + (i >> 3)] |= 1 << (i & 7);
  return buf;
}

// ---------- BM2 ----------
function bm2(w, h, fn) {
  const n = w * h, stride = (w + 7) >> 3;
  const buf = new Uint8Array(8 + n + stride * h);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x20324D42, true);
  dv.setUint16(4, w, true); dv.setUint16(6, h, true);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = fn(x, y);
    if (v == null) buf[8 + n + y * stride + (x >> 3)] |= 1 << (x & 7);
    else buf[8 + y * w + x] = v;
  }
  return buf;
}

// =====================================================================
// 游戏一:平台跳跃(jumpman)
// =====================================================================
function genJumper(dir) {
  mkdirSync(join(dir, 'gfx'), { recursive: true });
  mkdirSync(join(dir, 'audio'), { recursive: true });
  mkdirSync(join(dir, 'data'), { recursive: true });

  // ---- BG tiles ----
  const bg = [];
  bg[0] = tile8(() => null);
  bg[1] = tile8((x, y) => y === 0 ? C.grass : (y < 3 ? C.grassD : (((x * 7 + y * 3) & 7) ? C.dirt : C.dirtD))); // 草地
  bg[2] = tile8((x, y) => (((x * 5 + y * 7) & 7) < 6 ? C.dirt : C.dirtD)); // 泥土
  bg[3] = tile8((x, y) => { // 砖
    const row = y >> 1, off = (row & 1) * 4;
    const bx = (x + off) & 7;
    return (y & 1) || bx < 1 ? C.brickD : C.brick;
  });
  bg[4] = tile8((x, y) => { // 尖刺
    const t = Math.abs(x - 3.5);
    if (y >= 7 - Math.floor(3.5 - t)) return y >= 6 ? C.spikeD : C.spike;
    return null;
  });
  bg[5] = tile8((x, y) => (y === 0 || y === 7 || x === 0 || x === 7) ? C.stoneD : (((x + y) & 3) ? C.stone : C.stoneD)); // 石块
  bg[6] = tile8((x, y) => { // 旗杆
    if (x >= 3 && x <= 4 && y > 1) return C.pole;
    if (y <= 1 && x > 4 && x <= 7 && (x + y) % 2 === 0) return 15;
    return null;
  });
  bg[7] = tile8((x, y) => { // 云(半透明观感用棋盘抖动)
    const dx = x - 3.5, dy = y - 3.5;
    return (dx * dx / 16 + dy * dy / 9 < 1) ? (((x + y) & 1) ? 255 : 251) : null;
  });
  bg[8] = tile8((x, y) => { // 灌木
    const dx = x - 3.5, dy = y - 4;
    return (dx * dx / 12 + dy * dy / 10 < 1) ? (((x * 3 + y) & 3) ? C.slimeD : C.slime) : null;
  });
  writeFileSync(join(dir, 'gfx/bg.til'), til(0, bg));

  // ---- OBJ tiles ----
  const obj = [];
  // 0..3 玩家帧1,4..7 帧2(跑动腿)
  const dude = (leg) => tile16((x, y) => {
    const dx = x - 7.5;
    // 头
    if (y >= 1 && y <= 5 && Math.abs(dx) <= 2.5) {
      if (y === 2 && (dx === -1 || dx === 1)) return 16; // 眼
      return C.skin;
    }
    // 身
    if (y >= 6 && y <= 11 && Math.abs(dx) <= 3) return (x + y) % 2 ? C.shirt : C.shirtD;
    // 腿
    if (y >= 12 && y <= 15) {
      if (leg === 0) return dx <= -0.5 && dx >= -3 ? C.pants : (dx >= 0.5 && dx <= 3 && y <= 13 ? C.pants : null);
      return dx >= -0.5 && dx <= 0.5 ? C.pants : null;
    }
    return null;
  });
  obj.push(...dude(0), ...dude(1));
  // 8..9 金币两帧
  obj[8] = tile8((x, y) => { const dx = Math.abs(x - 3.5); return dx <= 3 && y >= 1 && y <= 6 ? (dx < 1.5 ? C.coinD : C.coin) : null; });
  obj[9] = tile8((x, y) => { const dx = Math.abs(x - 3.5); return dx <= 1 && y >= 1 && y <= 6 ? C.coin : null; });
  // 10..13 史莱姆敌人(16×16,扁)
  obj.push(...tile16((x, y) => {
    const dx = x - 7.5, dy = y - 11;
    if (dy <= 3 && dy >= -4 && Math.abs(dx) <= 6 - Math.max(0, dy)) {
      if (dy === -4 && (dx === -3 || dx === 3)) return 16; // 眼
      return (x + y) % 3 ? C.slime : C.slimeD;
    }
    return null;
  }));
  writeFileSync(join(dir, 'gfx/obj.til'), til(1, obj));

  // ---- 关卡(字符画)----
  const rows = [
    '................................................................',
    '................................................................',
    '................................................................',
    '..........................ccc...................................',
    '................BBBBB.................BBBB.......................',
    '................................................................',
    '.........ccc....................................................',
    '....BBBB...................................ccc.....^............',
    '...................................BBBBBBBB......................',
    '................................................................',
    '..P........e...................e..................................',
    '######...####...###...####...####...###...####.....###....###..#',
    '######.?.######.###.?.#####.#####.?.###.?.######.e...###.e..###..#',
    '######...####...###...####...####...###...####.......###....###..#',
    '######...####...###...####...####...###...####.......###....###..#',
    '######^^.####^^.###.^.#####.#####.^.###.^.######......###....###..#',
    '######...####...###...####...####...###...####.......###....###..#',
    '######...####...###...####...####...###...####.......###....###F.#',
    '######...####...###...####...####...###...####.......###....######',
    '######...####...###...####...####...###...####.......###....######',
    '######...####...###...####...####...###...####.......###....######',
    '################################################################'
  ];
  const W = 64, H = rows.length;
  const entries = new Uint16Array(W * H);
  const solid = new Uint8Array(W * H);
  const coins = [], enemies = [], spikes = [];
  let playerStart = [2, 8], flagAt = [61, 15];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const ch = rows[y][x];
    const i = y * W + x;
    if (ch === '#') {
      const above = y > 0 ? rows[y - 1][x] : '#';
      entries[i] = (above === '.' || above === 'c' || above === 'P' || above === 'e' || above === '^') ? 1 : 2;
      solid[i] = 1;
    } else if (ch === 'B') { entries[i] = 3; solid[i] = 1; }
    else if (ch === 'S') { entries[i] = 5; solid[i] = 1; }
    else if (ch === '^') { entries[i] = 4; spikes.push([x, y]); }
    else if (ch === 'c') coins.push([x, y]);
    else if (ch === 'e') enemies.push([x, y]);
    else if (ch === 'P') playerStart = [x, y];
    else if (ch === 'F') { flagAt = [x, y]; }
    else if (ch === '?') { entries[i] = 8; } // 灌木装饰
  }
  // 旗
  entries[flagAt[1] * W + flagAt[0]] = 6;
  // 云装饰
  for (const [cx, cy] of [[8, 1], [30, 2], [52, 1], [20, 6]]) entries[cy * W + cx] = 7;
  writeFileSync(join(dir, 'gfx/level.map'), map2(W, H, entries));
  writeFileSync(join(dir, 'data/col.bin'), col1(W, H, solid));
  const level = {
    w: W, h: H, playerStart, flag: flagAt,
    coins: coins.map(([x, y]) => [x * 8 + 4, y * 8 + 4]),
    enemies: enemies.map(([x, y]) => ({ x: x * 8, y: y * 8 - 8, min: (x - 3) * 8, max: (x + 4) * 8 })),
    spikes
  };
  writeFileSync(join(dir, 'data/level.json'), JSON.stringify(level));

  // ---- 音频 ----
  const aud = {
    timbres: [
      { family: 'fc', wave: 4, adsr: [0.002, 0.05, 0.5, 0.06], vol: 0.28, vib: { rate: 5, depth: 0.03 }, name: 'lead' },
      { family: 'fc', wave: 5, adsr: [0.003, 0.08, 0.35, 0.06], vol: 0.38, name: 'bass' },
      { family: 'an', model: 'kick', adsr: [0.001, 0.02, 1, 0.2], vol: 0.65 },
      { family: 'an', model: 'snare', adsr: [0.001, 0.02, 1, 0.18], vol: 0.42 },
      { family: 'an', model: 'hat', adsr: [0.001, 0.02, 1, 0.05], vol: 0.3 },
      { family: 'fc', wave: 1, adsr: [0.002, 0.03, 0.5, 0.08], vol: 0.35, name: 'ping' },
      { family: 'fc', wave: 3, adsr: [0.001, 0.02, 0.4, 0.05], vol: 0.4, duty: 0.25, glide: 0.04, name: 'jump' },
      { family: 'fc', wave: 6, adsr: [0.001, 0.12, 0.0, 0.05], vol: 0.45, name: 'hurt' },
      { family: 'fm', car: { level: 1, adsr: [0.002, 0.06, 0.6, 0.1], ratio: 2 }, mod: { level: 4, adsr: [0.002, 0.1, 0.4, 0.1], ratio: 3.01, fb: 1 }, vol: 0.3, name: 'coin' },
      { family: 'fc', wave: 1, adsr: [0.004, 0.2, 0.3, 0.2], vol: 0.3, name: 'win' }
    ],
    patterns: [
      // 0 lead 主旋律(2 小节)
      { t: 0, notes: [
        { s: 0, n: 76, l: 2 }, { s: 2, n: 79, l: 2 }, { s: 4, n: 81, l: 2 }, { s: 6, n: 79, l: 2 },
        { s: 8, n: 76, l: 2 }, { s: 10, n: 72, l: 2 }, { s: 12, n: 74, l: 3 },
        { s: 16, n: 74, l: 2 }, { s: 18, n: 76, l: 2 }, { s: 20, n: 79, l: 2 }, { s: 22, n: 76, l: 2 },
        { s: 24, n: 74, l: 2 }, { s: 26, n: 72, l: 2 }, { s: 28, n: 69, l: 4 }
      ] },
      // 1 bass
      { t: 1, notes: [
        { s: 0, n: 45, l: 3 }, { s: 4, n: 45, l: 3 }, { s: 8, n: 50, l: 3 }, { s: 12, n: 50, l: 3 },
        { s: 16, n: 43, l: 3 }, { s: 20, n: 43, l: 3 }, { s: 24, n: 45, l: 3 }, { s: 28, n: 47, l: 3 }
      ] },
      // 2 kick
      { t: 2, notes: [{ s: 0, n: 36 }, { s: 6, n: 36 }, { s: 8, n: 36 }, { s: 16, n: 36 }, { s: 22, n: 36 }, { s: 24, n: 36 }] },
      // 3 snare+hat
      { t: 3, notes: [{ s: 4, n: 38 }, { s: 12, n: 38 }, { s: 20, n: 38 }, { s: 28, n: 38 }] },
      { t: 4, notes: [{ s: 2, n: 42 }, { s: 10, n: 42 }, { s: 18, n: 42 }, { s: 26, n: 42 }, { s: 30, n: 42 }] },
      // 5 SFX 跳
      { t: 6, notes: [{ s: 0, n: 74, l: 5 }] },
      // 6 SFX 金币
      { t: 8, notes: [{ s: 0, n: 88, l: 2 }, { s: 2, n: 93, l: 5 }] },
      // 7 SFX 受伤
      { t: 7, notes: [{ s: 0, n: 50, l: 8 }] },
      // 8 SFX 通关
      { t: 9, notes: [{ s: 0, n: 72, l: 2 }, { s: 2, n: 76, l: 2 }, { s: 4, n: 79, l: 2 }, { s: 6, n: 84, l: 8 }] }
    ],
    musics: [
      { bpm: 138, swing: 0.05, tracks: [[{ p: 0, b: 0 }], [{ p: 1, b: 0 }], [{ p: 2, b: 0 }], [{ p: 3, b: 0 }], [{ p: 4, b: 0 }], [], [], []] }
    ],
    samples: {}
  };
  writeFileSync(join(dir, 'audio/game.aud'), JSON.stringify(aud));

  // ---- 封面 32×32 ----
  const cover = new Uint8Array(1024);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    let c = null;
    if (y >= 24) c = ((x + y) & 3) ? C.dirt : C.dirtD;          // 地面
    else if (y >= 22) c = C.grass;
    else {
      const dx = x - 15, dy = y - 12;                             // 小人
      if (dy >= -4 && dy <= -1 && Math.abs(dx) <= 2) c = C.skin;
      else if (dy >= 0 && dy <= 4 && Math.abs(dx) <= 3) c = (x + y) % 2 ? C.shirt : C.shirtD;
      else if (dy >= 5 && dy <= 7 && Math.abs(dx) <= 2) c = C.pants;
      else if (x >= 6 && x <= 9 && y >= 14 && y <= 22) c = ((x + y) & 1) ? C.coin : C.coinD; // 金币
      else if (x >= 22 && x <= 26 && y >= 10 && y <= 22 && Math.abs(x - 24) + (22 - y) <= 6) c = C.slime; // 史莱姆
      else c = C.bg1;
    }
    cover[y * 32 + x] = c;
  }
  writeFileSync(join(dir, 'cover.bin'), cover);

  writeFileSync(join(dir, 'cart.json'), JSON.stringify({ id: 'JUMPMAN1', title: 'Jumpman', version: 1, mode: 1 }, null, 2));
  console.log('jumper assets →', dir);
}

// =====================================================================
// 游戏二:旋转射击(rockblaster)
// =====================================================================
function genShooter(dir) {
  mkdirSync(join(dir, 'gfx'), { recursive: true });
  mkdirSync(join(dir, 'audio'), { recursive: true });

  // ---- 位图 ----
  // 飞船 16×16(朝上)
  writeFileSync(join(dir, 'gfx/ship.bm2'), bm2(16, 16, (x, y) => {
    const dx = x - 7.5, dy = y - 7.5;
    const nx = dx / 7.5, ny = dy / 7.5;
    const d = Math.hypot(nx, ny * 1.1);
    if (d > 1) return null;
    // 尖头 + 双翼
    if (Math.abs(dx) <= 1.5 && y >= 2 && y <= 11) return y < 5 ? C.white : C.ship;
    if (Math.abs(dx) <= 4.5 && y >= 6 && y <= 12) return (x + y) % 3 ? C.ship : C.shipD;
    if (y >= 11 && y <= 13 && Math.abs(dx) >= 3 && Math.abs(dx) <= 6.5) return C.shipD;
    if (y >= 12 && Math.abs(dx) <= 2) return y % 2 ? C.flame : 209; // 尾焰
    return null;
  }));
  // 岩石 24/16/10 三档(不规则)
  const rockOf = (r, seed) => bm2(r, r, (x, y) => {
    const dx = (x - (r - 1) / 2) / (r / 2), dy = (y - (r - 1) / 2) / (r / 2);
    const ang = Math.atan2(dy, dx);
    const wob = 0.75 + 0.25 * Math.abs(Math.sin(ang * (3 + seed) + seed * 2.1));
    const d = Math.hypot(dx, dy);
    if (d > wob) return null;
    if (d > wob - 0.25) return C.rockD;
    return ((x * 7 + y * 5 + seed) & 7) < 5 ? C.rock : C.rockD;
  });
  writeFileSync(join(dir, 'gfx/rock24.bm2'), rockOf(24, 1));
  writeFileSync(join(dir, 'gfx/rock16.bm2'), rockOf(16, 2));
  writeFileSync(join(dir, 'gfx/rock10.bm2'), rockOf(10, 3));
  // 子弹 5×5
  writeFileSync(join(dir, 'gfx/bullet.bm2'), bm2(5, 5, (x, y) => (Math.hypot(x - 2, y - 2) <= 2) ? 220 : (Math.hypot(x - 2, y - 2) <= 2.4 ? 208 : null)));
  // 敌舰 14×12
  writeFileSync(join(dir, 'gfx/ufobm.bm2'), bm2(14, 12, (x, y) => {
    const dx = Math.abs(x - 6.5);
    if (y === 5 || y === 6) return dx <= 6.5 ? ((x + y) % 2 ? 196 : 202) : null;
    if (y >= 7 && y <= 8 && dx <= 3.5) return 51;
    if (y >= 2 && y <= 4 && dx <= 2.5 - (y - 2)) return 46;
    return null;
  }));

  // ---- 音频 ----
  const aud = {
    timbres: [
      { family: 'fc', wave: 3, adsr: [0.002, 0.04, 0.5, 0.05], vol: 0.3, duty: 0.25, filter: { type: 'lp', cutoff: 6000, q: 2 } },
      { family: 'fc', wave: 5, adsr: [0.003, 0.08, 0.35, 0.06], vol: 0.4 },
      { family: 'an', model: 'kick', adsr: [0.001, 0.02, 1, 0.2], vol: 0.6 },
      { family: 'an', model: 'hat', adsr: [0.001, 0.02, 1, 0.05], vol: 0.28 },
      { family: 'an', model: 'snare', adsr: [0.001, 0.02, 1, 0.15], vol: 0.4 },
      { family: 'fc', wave: 2, adsr: [0.001, 0.1, 0.0, 0.03], vol: 0.3, filter: { type: 'hp', cutoff: 2000, q: 1 }, name: 'laser' },
      { family: 'fc', wave: 6, adsr: [0.001, 0.25, 0.0, 0.05], vol: 0.5, name: 'boom' },
      { family: 'fm', car: { level: 1, adsr: [0.002, 0.05, 0.6, 0.1], ratio: 1 }, mod: { level: 6, adsr: [0.001, 0.15, 0.2, 0.1], ratio: 5.1, fb: 3 }, vol: 0.28, name: 'hit' }
    ],
    patterns: [
      { t: 0, notes: [ // lead 短句
        { s: 0, n: 69, l: 2 }, { s: 3, n: 72, l: 1 }, { s: 4, n: 76, l: 2 }, { s: 8, n: 74, l: 2 }, { s: 11, n: 71, l: 1 }, { s: 12, n: 74, l: 2 },
        { s: 16, n: 69, l: 2 }, { s: 19, n: 72, l: 1 }, { s: 20, n: 76, l: 2 }, { s: 24, n: 81, l: 3 }, { s: 28, n: 79, l: 3 }
      ] },
      { t: 1, notes: [{ s: 0, n: 33, l: 6 }, { s: 8, n: 33, l: 6 }, { s: 16, n: 36, l: 6 }, { s: 24, n: 31, l: 6 }] },
      { t: 2, notes: [{ s: 0, n: 36 }, { s: 8, n: 36 }, { s: 16, n: 36 }, { s: 20, n: 36 }, { s: 24, n: 36 }] },
      { t: 3, notes: [{ s: 4, n: 38 }, { s: 12, n: 38 }, { s: 20, n: 38 }, { s: 28, n: 38 }] },
      { t: 4, notes: [{ s: 2, n: 42 }, { s: 6, n: 42 }, { s: 10, n: 42 }, { s: 14, n: 42 }, { s: 18, n: 42 }, { s: 22, n: 42 }, { s: 26, n: 42 }, { s: 30, n: 42 }] },
      { t: 5, notes: [{ s: 0, n: 90, l: 4 }] },   // SFX laser
      { t: 6, notes: [{ s: 0, n: 40, l: 12 }] },  // SFX boom
      { t: 7, notes: [{ s: 0, n: 88, l: 3 }, { s: 3, n: 83, l: 3 }] } // SFX hit
    ],
    musics: [
      { bpm: 128, swing: 0, tracks: [[{ p: 0, b: 0 }], [{ p: 1, b: 0 }], [{ p: 2, b: 0 }], [{ p: 3, b: 0 }], [{ p: 4, b: 0 }], [], [], []] }
    ],
    samples: {}
  };
  writeFileSync(join(dir, 'audio/game.aud'), JSON.stringify(aud));

  // ---- 封面 ----
  const cover = new Uint8Array(1024);
  const rseed = { s: 42 };
  const rnd = () => { rseed.s = (rseed.s * 1103515245 + 12345) & 0x7FFFFFFF; return rseed.s / 0x7FFFFFFF; };
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    let c = C.bg1;
    const dx = x - 15, dy = y - 13;
    if (Math.abs(dx) <= 2 && dy >= -7 && dy <= 4) c = dy < -3 ? C.white : C.ship;             // 船
    else if (Math.abs(dx) <= 5 && dy >= -2 && dy <= 5) c = (x + y) % 3 ? C.ship : C.shipD;
    else if (dy >= 6 && dy <= 8 && Math.abs(dx) <= 2) c = 208;                                  // 焰
    else if (Math.hypot(x - 25, y - 8) < 5) c = ((x * 3 + y) & 3) ? C.rock : C.rockD;           // 岩
    else if (Math.hypot(x - 6, y - 22) < 4) c = ((x + y * 2) & 3) ? C.rock : C.rockD;
    else if (Math.hypot(x - 22, y - 22) < 2.5) c = 220;                                          // 弹
    else if (rnd() < 0.04) c = 252;                                                               // 星
    cover[y * 32 + x] = c;
  }
  writeFileSync(join(dir, 'cover.bin'), cover);

  writeFileSync(join(dir, 'cart.json'), JSON.stringify({ id: 'ROCKBLS1', title: 'Rock Blaster', version: 1, mode: 2, sampling: 'auto' }, null, 2));
  console.log('shooter assets →', dir);
}

genJumper(join(root, 'carts', 'jumpman'));
genShooter(join(root, 'carts', 'rockblaster'));
console.log('done');
