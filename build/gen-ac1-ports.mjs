/* build/gen-ac1-ports.mjs — AC1→AC2 移植资产生成
 * 负责:RGB565 调色板 → ANSI 256 量化;逐游戏 tileset/地图/封面/pal.json/audio.aud/cart.json
 * 用法:node build/gen-ac1-ports.mjs [gameId ...]   (缺省全部)
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { load } from '../tests/load.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
load('js/core/ansi.js', 'js/core/comp.js', 'js/core/mulaw.js', 'js/core/font.js', 'js/core/biosfont.js', 'js/core/cart.js', 'js/core/packer.js',
  'js/host/input.js', 'js/host/mode1.js', 'js/host/mode2.js', 'js/host/ajs.js', 'js/host/audio.js', 'js/host/bios.js', 'js/host/machine.js');
const { ANSI } = globalThis.AC2;

// ---------------- 基础工具 ----------------
const rgb = (c) => [Math.round((c >> 11 & 31) * 255 / 31), Math.round((c >> 5 & 63) * 255 / 63), Math.round((c & 31) * 255 / 31)];
const q = (c) => { const [r, g, b] = rgb(c); return ANSI.fromRgb(r, g, b); };
// 调色板:名字 → RGB565 → ANSI 索引
function pal(pairs) {
  const out = {};
  for (const [name, c] of pairs) out[name] = q(c);
  return out;
}

function tile8(fn) {
  const px = new Uint8Array(64), mask = new Uint8Array(8);
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const v = fn(x, y);
    if (v == null) mask[y] |= 1 << x;
    else px[y * 8 + x] = v;
  }
  return { px, mask };
}
// 16×16 字符画 → 4 连续 tile(TL,TR,BL,BR)
function tile16(rows, map, oy = 0) {
  const q4 = [[0, 0], [8, 0], [0, 8], [8, 8]];
  return q4.map(([ox, oy2]) => tile8((x, y) => {
    const gy = oy2 + y - oy, gx = ox + x;
    if (gy < 0 || gy >= rows.length) return null;
    const ch = rows[gy][gx];
    return ch === '.' || ch === undefined || ch === ' ' ? null : map[ch];
  }));
}
// 16×16 函数式
function tile16f(fn) {
  const q4 = [[0, 0], [8, 0], [0, 8], [8, 8]];
  return q4.map(([ox, oy]) => tile8((x, y) => fn(ox + x, oy + y)));
}
function til(kind, tiles) {
  const buf = new Uint8Array(8 + tiles.length * 72);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x324C4954, true);
  dv.setUint16(4, tiles.length, true);
  buf[6] = kind;
  tiles.forEach((t, i) => { buf.set(t.px, 8 + i * 72); buf.set(t.mask, 8 + i * 72 + 64); });
  return buf;
}
function map2(w, h, entries) {
  const buf = new Uint8Array(8 + w * h * 2);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x3250414D, true);
  dv.setUint16(4, w, true); dv.setUint16(6, h, true);
  for (let i = 0; i < w * h; i++) dv.setUint16(8 + i * 2, entries[i], true);
  return buf;
}
function cover32(fn) {
  const out = new Uint8Array(1024);
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) out[y * 32 + x] = fn(x, y) ?? 16;
  return out;
}
// 简易 32×32 作画上下文(rect 到 cover)
function coverCtx() {
  const px = new Uint8Array(1024).fill(-1);
  const rect = (x, y, w, h, c) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (xx >= 0 && xx < 32 && yy >= 0 && yy < 32) px[yy * 32 + xx] = c; };
  const done = () => { const o = new Uint8Array(1024); for (let i = 0; i < 1024; i++) o[i] = px[i] < 0 ? 16 : px[i]; return o; };
  return { rect, done };
}

// ---------------- 共享音频(六枚 SFX,索引即 pattern 号) ----------------
function sharedAud(extraTimbres = [], extraPatterns = [], extraMusics = []) {
  return {
    timbres: [
      { family: 'fc', wave: 2, adsr: [0.001, 0.03, 0.5, 0.05], vol: 0.3 },                                  // 0 beep
      { family: 'fc', wave: 3, adsr: [0.001, 0.03, 0.5, 0.05], vol: 0.32, duty: 0.25, glide: 0.03 },        // 1 hop/jump
      { family: 'fc', wave: 1, adsr: [0.001, 0.04, 0.5, 0.08], vol: 0.34 },                                 // 2 ping(coin)
      { family: 'fc', wave: 6, adsr: [0.001, 0.14, 0.0, 0.05], vol: 0.42, filter: { type: 'hp', cutoff: 900, q: 1 } }, // 3 hurt
      { family: 'an', model: 'kick', adsr: [0.001, 0.02, 1, 0.2], vol: 0.6 },                               // 4 boom
      { family: 'fm', car: { level: 1, adsr: [0.002, 0.12, 0.4, 0.2], ratio: 2 }, mod: { level: 4, adsr: [0.002, 0.14, 0.3, 0.15], ratio: 3.01, fb: 1 }, vol: 0.3 }, // 5 chime
      { family: 'fc', wave: 4, adsr: [0.001, 0.05, 0.3, 0.04], vol: 0.24, filter: { type: 'hp', cutoff: 2400, q: 1 } } // 6 shoot/laser
    ].concat(extraTimbres),
    patterns: [
      { t: 0, notes: [{ s: 0, n: 88, l: 3 }] },                     // 0 UI
      { t: 1, notes: [{ s: 0, n: 84, l: 5 }] },                     // 1 跳/弹
      { t: 2, notes: [{ s: 2, n: 88, l: 2 }, { s: 2, n: 93, l: 5 }] }, // 2 金币/拾取
      { t: 3, notes: [{ s: 3, n: 55, l: 8 }] },                     // 3 受伤
      { t: 4, notes: [{ s: 4, n: 36 }, { s: 2, n: 60, l: 8 }] },    // 4 爆
      { t: 5, notes: [{ s: 5, n: 72, l: 2 }, { s: 5, n: 76, l: 2 }, { s: 5, n: 79, l: 2 }, { s: 5, n: 84, l: 8 }] }, // 5 通关
      { t: 6, notes: [{ s: 6, n: 90, l: 4 }] }                      // 6 射击
    ].concat(extraPatterns),
    musics: extraMusics,
    samples: {}
  };
}

function writeGame(dir, g) {
  mkdirSync(join(dir, 'gfx'), { recursive: true });
  mkdirSync(join(dir, 'audio'), { recursive: true });
  if (g.data) mkdirSync(join(dir, 'data'), { recursive: true });
  for (const [name, buf] of Object.entries(g.files || {})) writeFileSync(join(dir, name), buf);
  for (const [name, buf] of Object.entries(g.gfx || {})) writeFileSync(join(dir, 'gfx', name), buf);
  for (const [name, obj] of Object.entries(g.data || {})) writeFileSync(join(dir, 'data', name), typeof obj === 'string' ? obj : JSON.stringify(obj));
  writeFileSync(join(dir, 'audio', 'game.aud'), JSON.stringify(g.audio));
  writeFileSync(join(dir, 'cover.bin'), g.cover);
  writeFileSync(join(dir, 'cart.json'), JSON.stringify({ id: g.id, title: g.title, version: 1, mode: g.mode, sampling: g.sampling || 'auto' }, null, 2));
  console.log('✓', g.id, g.title, '(mode' + g.mode + ')');
}

const GAMES = {};
const only = process.argv.slice(2);

/* =====================================================================
 * MAGIC TOWER(mode1)
 * tile 索引(BG):0 空 1 墙 2 地板 3 上楼 4 下楼 5/6/7 黄/蓝/红门
 * OBJ(16×16 索引):0-3 hero 4+ 每怪 4 tile;y 仙子;物品走 8×8(索引 200+ 由 OBJ 尾部排布)
 * ===================================================================== */
GAMES.magictower = () => {
  const P = pal([
    ['INK', 0x0000], ['WALL', 0x5A8E], ['WALLLT', 0x8C15], ['FLOOR', 0x2947], ['FLOORD', 0x18E5],
    ['WHITE', 0xFFFF], ['LGRAY', 0xADB8], ['GRAY', 0x7C32], ['DGRAY', 0x426B], ['RED', 0xF800],
    ['DRED', 0xA0C3], ['ORANGE', 0xFC86], ['YELLOW', 0xFE87], ['GOLD', 0xFE40], ['GREEN', 0x2EED],
    ['DGREEN', 0x1B67], ['CYAN', 0x07FF], ['BLUE', 0x3B7F], ['DBLUE', 0x2129], ['VIOLET', 0x8ADE],
    ['PINK', 0xE25A], ['SKIN', 0xFE72], ['BROWN', 0x8AC5], ['DBROWN', 0x59C3], ['STEEL', 0xC65A],
    ['SLATE', 0x5B30], ['TAN', 0xAF7F], ['LIME', 0xB7EF], ['TEAL', 0x05F7], ['MAGENTA', 0xF81F],
    ['PURPLE', 0x601F], ['NAVY', 0x1082]
  ]);
  const bg = [];
  // 1 墙 / 2 地板(映射到 entry 索引时 +1,因为 0 保留透明)
  bg[1] = tile8((x, y) => y < 3 ? P.WALLLT : (y === 7 ? P.INK : (y === 8 || y === 9 ? P.WALLLT : P.WALL)) || P.WALL);
  // 修墙 tile:显式重画(上面表达式过拧)
  bg[1] = tile8((x, y) => {
    if (y < 3) return P.WALLLT;
    if (y === 7) return P.INK;
    if (y === 8 || y === 9) return P.WALLLT;
    if ((x === 5 || x === 6) && (y === 4 || y === 5)) return P.INK;
    return P.WALL;
  });
  bg[2] = tile8((x, y) => ((x === 3 && y === 3) || (x === 12 % 8 && y === 3) || (x === 7 % 8 && y === 0)) ? P.FLOORD : P.FLOOR);
  bg[2] = tile8((x, y) => {
    if ((x === 3 && y === 3) || (x === 4 && y === 3) || (x === 3 && y === 12 % 8) || (x === 7 && y === 8 % 8) || (x === 3 && y === 4 + 0) && false) return P.FLOORD;
    if ((x + 5) % 8 === 0 && (y + 5) % 8 === 0) return P.FLOORD;
    if (x === 7 && y === 0) return P.FLOORD;
    return P.FLOOR;
  });
  bg[2] = tile8((x, y) => {
    if ((x === 3 && y === 3) || (x === 5 && y === 3) || (x === 7 && y === 8 % 8) || (x === 3 && y === 6)) return P.FLOORD;
    return P.FLOOR;
  });
  // 3 上楼(<)4 下楼(>):地板 + 阶梯
  const stairs = (up) => tile16f((x, y) => {
    if (x < 2 || x > 13 || y < 1 || y > 14) return null;
    const i = up ? Math.floor((14 - y) / 4) : Math.floor((y - 1) / 4);
    if (y < 1 + 12 - i * 4 && up) {
      if (y >= 2 + i * 4 && y < 5 + i * 4 && x >= 2 + i * 2 && x <= 13 - i * 2)
        return i === 0 ? P.LGRAY : i === 1 ? P.GRAY : P.DGRAY;
      return null;
    }
    return P.FLOOR;
  });
  // 简化阶梯:三级横条
  const stairs2 = (up) => tile16f((x, y) => {
    if (x < 2 || x > 13) return null;
    const i = up ? Math.min(2, Math.floor((15 - y) / 5)) : Math.min(2, Math.floor(y / 5));
    const top = up ? 3 + i * 4 : 2 + i * 4;
    const bot = top + 3;
    if (y >= top && y <= bot && x >= 2 + i * 2 && x <= 13 - i * 2)
      return i === 0 ? P.DGRAY : i === 1 ? P.GRAY : P.LGRAY;
    return null;
  });
  const door = (c1, c2) => tile16f((x, y) => {
    if (x >= 2 && x <= 13 && y >= 1 && y <= 14) {
      if (x === 2 || x === 13 || y === 1 || y === 14) return c2;
      if (x >= 3 && x <= 12 && y >= 2 && y <= 13) {
        if ((x === 7 || x === 8) && (y === 7 || y === 8)) return P.INK;
        if (y === 2) return P.WHITE;
        return c1;
      }
    }
    return null;
  });
  const bgTiles = [null, bg[1], bg[2]];
  const up16 = stairs2(true), dn16 = stairs2(false);
  const doorY = door(P.GOLD, P.YELLOW), doorB = door(P.CYAN, P.BLUE), doorR = door(P.RED, P.DRED);
  // BG tileset:0 空,1 墙,2 地板,3..6 上/下/门Y(16×16 占 2×2 → 用 8×8 版本!BG tile 恒 8×8)
  // 16×16 元素按 2×2 展开进 BG tileset(BG 地图 entry 直接排 4 格)
  const bgList = [tile8(() => null), bg[1], bg[2]];
  const push16 = (t4) => { const base = bgList.length; t4.forEach(t => bgList.push(t)); return base; };
  const T = {
    WALL: 1, FLOOR: 2,
    UP: push16(up16), DN: push16(dn16),
    DOOR_Y: push16(doorY), DOOR_B: push16(doorB), DOOR_R: push16(doorR)
  };
  // OBJ:hero + 17 怪 + 仙子,每只 4 tile(部分怪 14 行 → 装进 16×16)
  const AM = {
    hero: { rows: ['....oooo....', '...osssso...', '..osssssso..', '..osksskso..', '..osssssso..', '...oooooo...', '..obbbbbbo..', '.obwbbbbwbo.', '.obbbbbbbbo.', '..obbbbbbo..', '...ob..bo...', '...oo..oo...', '..ooo..ooo..'], map: { o: P.DGRAY, s: P.SKIN, k: P.INK, b: P.BLUE, w: P.WHITE } },
    g: { rows: ['....dddd....', '..ddggggdd..', '.dggggggggd.', '.dggggggggd.', 'dggwkggwkggd', 'dggggggggggd', 'dgggkkkkkggd', 'dggggggggggd', '.dggggggggd.', '..ddggggdd..', '....dddd....'], map: { d: P.DGREEN, g: P.GREEN, w: P.WHITE, k: P.INK } },
    h: { rows: ['....dddd....', '..ddggggdd..', '.dggggggggd.', '.dggggggggd.', 'dggwkggwkggd', 'dggggggggggd', 'dgggkkkkkggd', 'dggggggggggd', '.dggggggggd.', '..ddggggdd..', '....dddd....'], map: { d: P.DRED, g: P.PINK, w: P.WHITE, k: P.INK } },
    f: { rows: ['.v...vv...v.', '.vv.vvvv.vv.', '.vvvvvvvvvv.', '..vwkvvwkvv.', '..vvvvvvvv..', '...vvvvvv...', '....v..v....', '...vv..vv...'], map: { v: P.VIOLET, w: P.WHITE, k: P.INK } },
    F: { rows: ['.v...vv...v.', '.vv.vvvv.vv.', '.vvvvvvvvvv.', '..vwkvvwkvv.', '..vvvvvvvv..', '...vvvvvv...', '....v..v....', '...vv..vv...'], map: { v: P.DBLUE, w: P.WHITE, k: P.INK } },
    v: { rows: ['.v...vv...v.', '.vv.vvvv.vv.', '.vvvvvvvvvv.', '..vwkvvwkvv.', '..vvvvvvvv..', '...vvvvvv...', '....v..v....', '...vv..vv...'], map: { v: P.RED, w: P.WHITE, k: P.INK } },
    n: { rows: ['...wwwwww...', '..wwwwwwww..', '..wkwwwwkw..', '..wwwkkwww..', '...wwwwww...', '..w.wwww.w..', '..w.wwww.w..', '...w....w...', '..ww....ww..'], map: { w: P.LGRAY, k: P.INK } },
    m: { rows: ['...tttttt...', '..tttttttt..', '..wkwwwwkw..', '..wwwkkwww..', '...tttttt...', '..t.wwww.t..', '..w.wwww.w..', '...w....w...', '..ww....ww..'], map: { t: P.STEEL, w: P.LGRAY, k: P.INK } },
    c: { rows: ['....mmmm....', '..mmmmmmmm..', '.mmmmmmmmmm.', '...ssssss...', '..sksssks...', '...ssssss...', '..mmmmmmmm..', '.mmmmmmmmmm.', '.mmmmmmmmmm.', '..mmmmmmmm..'], map: { m: P.BLUE, s: P.SKIN, k: P.INK } },
    C: { rows: ['....mmmm....', '..mmmmmmmm..', '.mmmmmmmmmm.', '...ssssss...', '..sksssks...', '...ssssss...', '..mmmmmmmm..', '.mmmmmmmmmm.', '.mmmmmmmmmm.', '..mmmmmmmm..'], map: { m: P.PURPLE, s: P.SKIN, k: P.INK } },
    t: { rows: ['...dddddd...', '..dggggggd..', '.dggkgggggd.', '.dggggkkggd.', 'dgggggggggd', 'dgkggggkggd', 'dgggggggggd', '.dggkkkggd..', '..dggggggd..', '...dddddd...'], map: { d: P.DGRAY, g: P.GRAY, k: P.INK } },
    o: { rows: ['...DDDDDD...', '..DGGGGGGD..', '.DGGkGGkGGD.', '.DGGGGGGGGD.', '..DGGwwGGD..', '..DbbbbbbD..', '.DbbbbbbbbD.', '..DGG..GGD..', '..DD....DD..'], map: { D: P.DGREEN, G: P.GREEN, k: P.RED, w: P.WHITE, b: P.BROWN } },
    O: { rows: ['...tttttt...', '..DGGGGGGD..', '.DGkGGGkGGD.', '.DGGGGGGGGD.', '..DGGwwGGD..', '..DttttttD..', '.DGttttttGD.', '..DGG..GGD..', '..DD....DD..'], map: { D: P.DGREEN, G: P.GREEN, k: P.RED, w: P.WHITE, t: P.STEEL } },
    w: { rows: ['....rrrr....', '...tttttt...', '..ttkttktt..', '..tttttttt..', '..t.tttt.t..', '..t.tttt.t..', '....tttt....', '....tttt....', '...tt..tt...', '...tt..tt...'], map: { t: P.STEEL, k: P.CYAN, r: P.RED } },
    G: { rows: ['....PPPP....', '..PPPPPPPP..', '.PPPPPPPPPP.', '.PPcPPPPcPP.', '.PPPPPPPPPP.', '..PPPPPPPP..', '..PPPPPPPP..', '...PPPPPP...', '....PPPP....'], map: { P: P.PURPLE, c: P.CYAN } },
    N: { rows: ['....RRRR....', '..RRRRRRRR..', '.RRRRRRRRRR.', '.RRkwkkwkRR.', '.RRRRRRRRRR.', '..RRyRRyRR..', '..RRRRRRRR..', '..RRRRRRRR..', '...RRRRRR...'], map: { R: P.MAGENTA, k: P.INK, w: P.WHITE, y: P.GOLD } },
    D: { rows: ['..dd......dd..', '..dRd....dRd..', '..dRRd..dRRd..', '...dRRddRRd...', '....RRRRRR....', '...RRkRRRRR...', '..RRRRRRRRRR..', '.dRRyyyyyyRRd.', '.dRRyyyyyyRRd.', '..dRRyyyyRRd..', '...dRRyyRRd...', '....dRRRRd....', '....dR..Rd....', '...ddd..ddd...'], map: { d: P.DRED, R: P.RED, y: P.GOLD, k: P.INK } },
    L: { rows: ['..V........V..', '..VV.VVVV.VV..', '..VVVVVVVVVV..', '..VVrVVVVrVV..', '..VVVkkkVVVV..', '...VVVVVVVV...', '..VVVVVVVVVV..', '.VVVVVVVVVVVV.', '.VVwVVVVVVwVV.', '..VV.VVVV.VV..', '..VV.VVVV.VV..', '.....V..V.....', '....VV..VV....', '...VVV..VVV...'], map: { V: P.VIOLET, r: P.RED, k: P.INK, w: P.WHITE } },
    y: { rows: ['....yyyy....', '..w..ss..w..', '..ww.ss.ww..', '...wsssssw..', '....skks....', '....ssss....', '..w.ssss.w..', '..ww....ww..', '...w....w...'], map: { y: P.GOLD, s: P.SKIN, k: P.INK, w: P.WHITE } }
  };
  const objTiles = [];
  const SPR = {};
  for (const k of ['hero', 'g', 'h', 'f', 'F', 'v', 'n', 'm', 'c', 'C', 't', 'o', 'O', 'w', 'G', 'N', 'D', 'L', 'y']) {
    const base = objTiles.length;
    tile16(AM[k].rows, AM[k].map).forEach(t => objTiles.push(t));
    SPR[k] = base;
  }
  // 物品(8×8):钥匙×3 药水×2 宝石×2 剑×4 盾×4 箱 粒子
  const IT = {};
  const keyT = (c1) => tile8((x, y) => {
    if (x === 3 && y >= 1 && y <= 5) return c1;
    if (x === 4 && y >= 1 && y <= 5) return c1;
    if (y === 1 && (x === 1 || x === 2)) return c1;
    if (y === 2 && x === 1) return c1;
    if ((y === 4 || y === 5) && (x === 5 || x === 6)) return c1;
    return null;
  });
  const potT = (c1, big) => tile8((x, y) => {
    const w = big ? 4 : 3, h = big ? 5 : 4;
    const x0 = 4 - (w >> 1), y0 = 8 - h - 1;
    if (x >= x0 && x < x0 + w && y >= y0 && y < y0 + h) return c1;
    if (x >= 3 && x <= 4 && y === y0 - 1) return P.LGRAY;
    if (x === x0 && y === y0 + 1) return P.WHITE;
    return null;
  });
  const gemT = (c1) => tile8((x, y) => {
    const dx = Math.abs(x - 3.5), dy = Math.abs(y - 4);
    if (dx + dy <= 3) { if (x === 3 && y === 3) return P.WHITE; if (dy === 3) return P.LGRAY; return c1; }
    return null;
  });
  const swordT = (tier) => tile8((x, y) => {
    if (x >= 3 && x <= 4 && y >= 0 && y <= 5) return y === 0 ? P.WHITE : tier;
    if (y === 6 && x >= 2 && x <= 5) return P.GOLD;
    if (x >= 3 && x <= 4 && y === 7) return P.BROWN;
    return null;
  });
  const shieldT = (tier, inner) => tile8((x, y) => {
    if (y <= 1 && x >= 1 && x <= 6) return tier;
    if (y >= 2 && y <= 4 && x >= 2 && x <= 5) return tier;
    if (y === 5 && x >= 3 && x <= 4) return tier;
    if (y === 2 && x >= 3 && x <= 4) return inner;
    return null;
  });
  IT.keyY = objTiles.push(keyT(P.GOLD)) - 1;
  IT.keyB = objTiles.push(keyT(P.CYAN)) - 1;
  IT.keyR = objTiles.push(keyT(P.RED)) - 1;
  IT.potS = objTiles.push(potT(P.RED, false)) - 1;
  IT.potL = objTiles.push(potT(P.BLUE, true)) - 1;
  IT.gemR = objTiles.push(gemT(P.RED)) - 1;
  IT.gemB = objTiles.push(gemT(P.BLUE)) - 1;
  IT.sword = [P.STEEL, P.WHITE, P.GOLD, P.YELLOW].map(c => { const b = objTiles.length; objTiles.push(swordT(c)); return b; });
  IT.shield = [[P.STEEL, P.GRAY], [P.WHITE, P.GRAY], [P.GOLD, P.ORANGE], [P.YELLOW, P.ORANGE]].map(cc => { const b = objTiles.length; objTiles.push(shieldT(cc[0], cc[1])); return b; });
  IT.chest = objTiles.push(tile8((x, y) => {
    if (y >= 2 && y <= 6 && x >= 1 && x <= 6) {
      if (y === 2) return P.BROWN;
      if (y === 3) return P.GOLD;
      if (y === 4 && x >= 3 && x <= 4) return P.YELLOW;
      if (y === 1 && x >= 2 && x <= 5) return P.BROWN;
      return P.DBROWN;
    }
    if (y === 1 && x >= 2 && x <= 5) return P.BROWN;
    return null;
  })) - 1;
  writeGame(join(root, 'carts', 'magictower'), {
    id: 'MAGICTW1', title: 'Magic Tower', mode: 1,
    gfx: { 'bg.til': til(0, bgList), 'obj.til': til(1, objTiles) },
    data: { 'pal.json': { P, T, SPR, IT } },
    audio: sharedAud(),
    cover: (() => {
      const c = coverCtx();
      c.rect(4, 2, 24, 28, P.WALL); c.rect(6, 4, 20, 26, P.FLOOR);
      c.rect(9, 6, 14, 5, P.DGRAY); c.rect(10, 7, 12, 3, P.INK);
      c.rect(9, 13, 14, 5, P.GRAY); c.rect(10, 14, 12, 3, P.INK);
      c.rect(9, 20, 14, 5, P.LGRAY); c.rect(10, 21, 12, 3, P.INK);
      c.rect(14, 26, 4, 2, P.GOLD);
      return c.done();
    })()
  });
};

/* =====================================================================
 * BREAKOUT(mode1)
 * BG:0 空 1 边框深 2 边框亮 3 顶墙 4 星点(四种)
 * OBJ:0-1 金币?否——0 球(8×8 白点)1 挡板半(16×4 载于 16×16)2-5 砖(满/裂/装甲/重裂)6 碎屑 7 大粒子点 8 小粒子点
 * ===================================================================== */
GAMES.breakout = () => {
  const P = pal([['BG', 0x0000], ['NAVY', 0x2129], ['SLATE', 0x5B30], ['LGRAY', 0xADB8], ['WHITE', 0xFFFF],
    ['RED', 0xF20B], ['ORANGE', 0xFC86], ['YELLOW', 0xFE87], ['GREEN', 0x2EED], ['CYAN', 0x3E1E],
    ['PINK', 0xFBF5], ['MAGENTA', 0xE25A], ['VIOLET', 0x8ADE], ['LIME', 0xAF89], ['PCYAN', 0xAF7F], ['CREAM', 0xFF98]]);
  const bgList = [tile8(() => null)];
  bgList.push(tile8(() => P.NAVY));                                        // 1 边框深
  bgList.push(tile8((x, y) => (x === 0 || y === 0 || x === 7 || y === 7) ? P.SLATE : P.NAVY)); // 2 边框块
  bgList.push(tile8((x, y) => y < 2 ? P.SLATE : P.NAVY));                  // 3 顶墙
  for (let s = 0; s < 4; s++) bgList.push(tile8((x, y) => ((x * 13 + y * 7 + s * 31) % 29 === 0) ? (s % 2 ? P.NAVY : P.SLATE) : null)); // 4-7 星
  const objTiles = [];
  // 0 球(3×3 白)
  objTiles.push(tile8((x, y) => (x >= 3 && x <= 5 && y >= 3 && y <= 5) ? P.WHITE : null));
  // 1 挡板左半 / 2 右半(16×16 内 16×4 条)
  const padHalf = (right) => tile16f((x, y) => {
    if (y < 10 || y > 13) return null;
    if (x === 0 && !right || x === 15 && right) return null;
    if (y === 10) return P.WHITE;
    if (y === 13) return P.LGRAY;
    return P.WHITE;
  });
  objTiles.push(...padHalf(false), ...tile16f(() => null), ...tile16f(() => null));
  // 修正:tile16 排布 TL,TR,BL,BR —— 挡板横条放 TL+TR(索引 4..7)
  objTiles.length = 0;
  objTiles.push(tile8((x, y) => (x >= 3 && x <= 5 && y >= 3 && y <= 5) ? P.WHITE : null)); // 0 球
  const padTL = tile8((x, y) => (y === 2 || y === 3) ? (x === 0 ? null : P.WHITE) : null);
  const padTR = tile8((x, y) => (y === 2 || y === 3) ? (x === 7 ? null : P.WHITE) : null);
  objTiles.push(padTL, padTR, tile8(() => null), tile8(() => null));                        // 1..4? 不 —— 挡板需要 16 宽
  // 用两个 16×16 精灵拼 32px 挡板:每半边一个 16×16(tile 4 连续)
  objTiles.length = 0;
  objTiles.push(tile8((x, y) => (x >= 3 && x <= 5 && y >= 3 && y <= 5) ? P.WHITE : null));  // 0:球(8×8)
  const pad16 = (leftHalf) => tile16f((x, y) => {
    if (y < 5 || y > 8) return null;
    if (leftHalf && x > 15) return null;
    if (!leftHalf && x < 0) return null;
    if (y === 5 && x >= 2 && x <= 13) return P.PCYAN;
    if (y === 8) return P.LGRAY;
    if (x >= 1 && x <= 14) return P.WHITE;
    return null;
  });
  const padL4 = pad16(true);   // 左半(条居中偏左)
  const padR4 = pad16(false);
  // 砖(16×8 内):5 满血 6 满血亮边?做成:5 满 6 裂 7 装甲(2血)8 装甲裂 9 重裂(将碎)
  const brick = (mode) => tile16f((x, y) => {
    if (y > 7) return null;
    if (y === 0) return P.WHITE;
    if (y === 7 || x === 15) return P.NAVY;
    if (x === 0) return P.WHITE;
    if (mode === 1) { // 裂
      if ((x === 5 && y === 1) || (x === 6 && y === 2) || (x === 8 && y === 4) || (x === 9 && y === 5) || (x === 11 && y === 2) || (x === 12 && y === 3)) return P.NAVY;
    } else if (mode === 2) { // 装甲
      if (y === 2 || y === 5) return P.SLATE;
    } else if (mode === 3) { // 装甲裂
      if (y === 2 || y === 5) return P.SLATE;
      if ((x === 4 && y === 1) || (x === 5 && y === 2) || (x === 7 && y === 3) || (x === 10 && y === 4) || (x === 12 && y === 2)) return P.NAVY;
    }
    return P.CYAN;
  });
  const brickTiles = [brick(0), brick(1), brick(2), brick(3)];
  // 粒子点:小 1px / 中 2×2
  const dot = (size) => tile8((x, y) => (x >= 4 && x < 4 + size && y >= 4 && y < 4 + size) ? P.WHITE : null);
  // 排布 OBJ:0 球 | 1-4 挡板左 | 5-8 挡板右 | 9-12 砖0 | 13-16 砖1 | 17-20 砖2 | 21-24 砖3 | 25 粒子1 | 26 粒子2
  const padLbase = 1, padRbase = 5;
  const brickBase = [9, 13, 17, 21];
  objTiles.push(...padL4);          // 1-4
  objTiles.push(...padR4);          // 5-8
  for (const bt of brickTiles) objTiles.push(...bt); // 9-24
  objTiles.push(dot(1));            // 25
  objTiles.push(dot(2));            // 26
  writeGame(join(root, 'carts', 'breakout'), {
    id: 'BREAKOU1', title: 'Breakout', mode: 1,
    gfx: { 'bg.til': til(0, bgList), 'obj.til': til(1, objTiles) },
    data: { 'pal.json': { P, PAD_L: padLbase, PAD_R: padRbase, BRICK: brickBase, BALL: 0, DOT1: 25, DOT2: 26 } },
    audio: sharedAud(),
    cover: (() => {
      const c = coverCtx();
      c.rect(0, 0, 32, 32, P.NAVY);
      for (let r = 0; r < 3; r++) for (let col = 0; col < 4; col++) c.rect(2 + col * 8, 3 + r * 5, 6, 3, r === 0 ? P.PCYAN : P.CYAN);
      c.rect(2, 3, 6, 1, P.WHITE);
      c.rect(12, 26, 8, 2, P.WHITE);
      c.rect(18, 21, 3, 3, P.SLATE);
      c.rect(19, 20, 2, 2, P.WHITE);
      c.rect(4, 27, 2, 1, P.LGRAY);
      return c.done();
    })()
  });
};

/* =====================================================================
 * DEEP DROP(mode1)
 * BG:0 空 1 洞壁 2 顶刺座 3 岩台左 4 岩台中 5 岩台右 6 苔岩左 7 苔中 8 苔右
 *    9 龟裂左 10 龟裂中 11 龟裂右 12 尖刺台 13 弹簧 14 冰台左 15 冰台中 16 冰台右
 *    17 火把 18 顶刺齿
 * OBJ:0-3 玩家(2 帧)4 金币?无。粒子用 8×8 点(tile 4/5)
 * ===================================================================== */
GAMES.drop = () => {
  const P = pal([['BG', 0x0000], ['INK', 0x1082], ['WALL', 0x2129], ['ROCK', 0x3A28], ['LGRAY', 0xADB8],
    ['WHITE', 0xFFFF], ['RED', 0xF800], ['ORANGE', 0xFC86], ['YELLOW', 0xFE87], ['GOLD', 0xFE40],
    ['GREEN', 0x2EED], ['CYAN', 0x07FF], ['VIOLET', 0x8ADE], ['PINK', 0xE25A], ['ICE', 0xAF7F], ['SLATE', 0x5B30]]);
  const bgList = [tile8(() => null)];
  const T = {};
  T.WALL = bgList.push(tile8((x, y) => ((x * 7 + y * 13) % 11 < 2) ? P.ROCK : P.WALL)) - 1;
  T.SPIKE_BASE = bgList.push(tile8((x, y) => (y >= 5) ? P.WALL : (((x % 6) < 3 ? P.RED : null))) ) - 1;
  bgList[T.SPIKE_BASE] = tile8((x, y) => {
    if (y >= 5) return (x === 0 || x === 7) ? P.ROCK : P.WALL;
    const t = x % 6;
    if (t === 2) return y === 0 ? P.WHITE : (y <= 2 ? P.RED : (y === 3 || y === 4 ? P.RED : null));
    if (t >= 1 && t <= 3) return y >= 1 && y <= 2 ? P.LGRAY : null;
    return null;
  });
  const capL = (cTop, cBody, cDark) => tile8((x, y) => {
    if (y === 0) return cTop;
    if (y === 3) return cDark;
    if (y === 1 || y === 2) return x === 0 ? cDark : cBody;
    return null;
  });
  const capM = (cTop, cBody, cDark, crack) => tile8((x, y) => {
    if (y === 0) return cTop;
    if (y === 3) return cDark;
    if (crack && ((x === 6 && y === 1) || (x === 7 && y === 2))) return cDark;
    return cBody;
  });
  const capR = (cTop, cBody, cDark) => tile8((x, y) => {
    if (y === 0) return cTop;
    if (y === 3) return cDark;
    if (y === 1 || y === 2) return x === 7 ? cDark : cBody;
    return null;
  });
  T.ROCK_L = bgList.push(capL(P.GREEN, P.ROCK, P.SLATE)) - 1;
  T.ROCK_M = bgList.push(capM(P.GREEN, P.ROCK, P.SLATE, false)) - 1;
  T.ROCK_R = bgList.push(capR(P.GREEN, P.ROCK, P.SLATE)) - 1;
  T.CRUMB_L = bgList.push(capL(P.LGRAY, P.LGRAY, P.SLATE)) - 1;
  T.CRUMB_M = bgList.push(capM(P.LGRAY, P.LGRAY, P.SLATE, true)) - 1;
  T.CRUMB_R = bgList.push(capR(P.LGRAY, P.LGRAY, P.SLATE)) - 1;
  T.ICE_L = bgList.push(capL(P.WHITE, P.ICE, P.CYAN)) - 1;
  T.ICE_M = bgList.push(capM(P.WHITE, P.ICE, P.CYAN, false)) - 1;
  T.ICE_R = bgList.push(capR(P.WHITE, P.ICE, P.CYAN)) - 1;
  // 弹簧台(单 tile 中段)
  T.SPRING = bgList.push(tile8((x, y) => {
    if (y === 0 || y === 1) return (x >= 2 && x <= 5) ? P.YELLOW : null;
    if (y === 2 || y === 3) return P.GOLD;
    if (y === 4) return P.ORANGE;
    return null;
  })) - 1;
  // 火把
  T.TORCH = bgList.push(tile8((x, y) => {
    if (x >= 3 && x <= 4 && y >= 3 && y <= 7) return P.SLATE;
    if (x >= 3 && x <= 4 && y === 2) return P.ORANGE;
    if (x >= 3 && x <= 4 && y === 1) return P.YELLOW;
    return null;
  })) - 1;
  // 顶刺条(危险线)
  T.SPIKE_ROW = bgList.push(tile8((x, y) => {
    if (y <= 1) return P.WALL;
    if (y === 2) return (x % 6 === 2) ? P.WHITE : ((x % 6 >= 1 && x % 6 <= 3) ? P.LGRAY : null);
    if (y === 3 || y === 4) return (x % 6 >= 1 && x % 6 <= 3) ? P.RED : null;
    return null;
  })) - 1;
  // OBJ 玩家(16×16 两帧:站/跳)+ 粒子
  const miner = (jump) => tile16f((x, y) => {
    const dx = x - 7.5;
    // 安全帽
    if (y >= 1 && y <= 3 && Math.abs(dx) <= 3.5) return y === 1 ? P.ORANGE : P.YELLOW;
    // 脸
    if (y >= 4 && y <= 6 && Math.abs(dx) <= 2.5) { if (y === 5 && (dx === -1 || dx === 1)) return P.INK; return P.PINK; }
    // 身
    if (y >= 7 && y <= 11 && Math.abs(dx) <= 3) return (x + y) % 2 ? P.CYAN : P.CYAN;
    // 腿
    if (y >= 12 && y <= 14) {
      if (jump) return Math.abs(dx) <= 1 ? P.VIOLET : null;
      return (dx <= -2 && dx >= -3) || (dx >= 2 && dx <= 3) ? P.VIOLET : (Math.abs(dx) <= 1 ? P.VIOLET : null);
    }
    return null;
  });
  const obj = [];
  obj.push(...miner(false), ...miner(true));           // 0-3,4-7
  const dot = (s, c) => tile8((x, y) => (x >= 4 && x < 4 + s && y >= 4 && y < 4 + s) ? c : null);
  obj.push(dot(1, P.LGRAY)); obj.push(dot(2, P.LGRAY)); obj.push(dot(1, P.GOLD)); // 8,9,10
  writeGame(join(root, 'carts', 'drop'), {
    id: 'DEEPDROP', title: 'Deep Drop', mode: 1,
    gfx: { 'bg.til': til(0, bgList), 'obj.til': til(1, obj) },
    data: { 'pal.json': { P, T, HERO: 0, HERO_JUMP: 4, DOT1: 8, DOT2: 9, GDOT: 10 } },
    audio: sharedAud(),
    cover: (() => {
      const c = coverCtx();
      c.rect(0, 0, 32, 32, P.INK);
      c.rect(0, 0, 4, 32, P.WALL); c.rect(28, 0, 4, 32, P.WALL);
      c.rect(8, 6, 12, 2, P.ROCK); c.rect(8, 6, 12, 1, P.GREEN);
      c.rect(20, 14, 8, 2, P.ROCK); c.rect(20, 14, 8, 1, P.GREEN);
      c.rect(12, 22, 10, 2, P.GOLD);
      c.rect(14, 10, 4, 4, P.CYAN); c.rect(15, 7, 2, 2, P.PINK); c.rect(14, 6, 4, 1, P.YELLOW);
      return c.done();
    })()
  });
};

/* =====================================================================
 * PIXEL DASH / runner(mode1)
 * BG0(世界):0 空 1 草面 2 草 3 泥 4 泥暗 5 尖刺 6 箱面 7 箱体 8 墙面 9 墙体 10 杠红 11 杠黄
 * BG1(视差天空):12 天 13 远山 14 近丘 15 云
 * OBJ:0-3 跑者帧1 4-7 跑者帧2 8-11 滑铲 12-13 金币帧 14-15 尖刺?尖刺走 BG。粒子 16/17
 * ===================================================================== */
GAMES.runner = () => {
  const P = pal([['BG', 0x0000], ['INK', 0x1082], ['SKY1', 0x651F], ['SKY2', 0x963F], ['SKY3', 0xC73F],
    ['WHITE', 0xFFFF], ['LGRAY', 0xADB8], ['MTF', 0x6C77], ['MTN', 0x4B73], ['HILL', 0x340C],
    ['GRASS', 0x5E2D], ['GRASSD', 0x450A], ['DIRT', 0xA3C9], ['DIRTD', 0x7AC6], ['ORANGE', 0xFC86],
    ['RED', 0xF800], ['GOLD', 0xFE40], ['YELLOW', 0xFE87], ['CYAN', 0x07FF], ['SLATE', 0x5B30],
    ['VIOLET', 0x8ADE], ['PINK', 0xE25A], ['ICE', 0xAF7F], ['GREEN', 0x2EED]]);
  const bg = [tile8(() => null)];
  const T = {};
  T.GRASS = bg.push(tile8((x, y) => {
    if (y === 0) return P.GRASS;
    if (y === 1 || y === 2) return P.GRASSD;
    return ((x + (y % 2) * 4) % 8 < 3 && y % 4 === 1) ? P.DIRTD : P.DIRT;
  })) - 1;
  T.DIRT = bg.push(tile8((x, y) => ((x * 5 + y * 7) % 9 < 4) ? P.DIRT : P.DIRTD)) - 1;
  T.SPIKE = bg.push(tile8((x, y) => {
    const t = x % 5;
    if (y === 0 && t === 2) return P.WHITE;
    if ((y === 1 || y === 2) && t >= 1 && t <= 3) return y === 1 ? P.LGRAY : P.SLATE;
    if (y >= 3 && y <= 4) return P.SLATE;
    if (y === 5) return P.SLATE;
    return null;
  })) - 1;
  T.CRATE = bg.push(tile8((x, y) => {
    if (x === 0 || y === 0 || x === 7 || y === 7) return P.DIRTD;
    if (y === 2 || y === 5) return P.DIRT;
    if (x === 5 && (y === 3 || y === 4)) return P.GOLD;
    return P.DIRTD;
  })) - 1;
  T.WALL = bg.push(tile8((x, y) => {
    if (y === 0) return P.WHITE;
    if (y >= 4) return P.SLATE;
    return (y % 2) ? P.LGRAY : P.SLATE;
  })) - 1;
  T.BAR_R = bg.push(tile8((x, y) => (y >= 2 && y <= 3) ? P.RED : ((x < 3 && y >= 0 && y <= 5) ? P.LGRAY : null))) - 1;
  T.BAR_Y = bg.push(tile8((x, y) => (y >= 4 && y <= 5) ? P.YELLOW : ((x < 3 && y >= 1 && y <= 6) ? P.LGRAY : null))) - 1;
  T.BAR = bg.push(tile8((x, y) => (y === 0) ? P.WHITE : P.LGRAY)) - 1;
  T.PLAT = bg.push(tile8((x, y) => {
    if (y === 0) return P.GRASS;
    if (y === 1 || y === 2) return P.DIRT;
    return null;
  })) - 1;
  // 视差层 tiles(BG1 用)
  T.SKY = bg.push(tile8(() => P.SKY1)) - 1;
  T.MTF = bg.push(tile8(() => P.MTF)) - 1;
  T.MTN = bg.push(tile8(() => P.MTN)) - 1;
  T.HILL = bg.push(tile8(() => P.HILL)) - 1;
  T.CLOUD = bg.push(tile8((x, y) => (y >= 2 && y <= 4 && x >= 1 && x <= 6) ? P.WHITE : null)) - 1;
  T.SUN = bg.push(tile8((x, y) => Math.hypot(x - 3.5, y - 3.5) <= 3.4 ? P.YELLOW : null)) - 1;
  // OBJ
  const runnerF = (ph, slide) => tile16f((x, y) => {
    const dx = x - 8;
    if (slide) {
      if (y >= 10 && y <= 12 && dx >= -6 && dx <= 5) return P.ORANGE;
      if (y >= 9 && dx >= 4 && dx <= 6) return P.ORANGE;
      if (y === 10 && dx === 5) return P.WHITE;
      if (y === 11 && dx >= -7 && dx <= -5) return P.INK;
      if (y === 11 && dx >= -3 && dx <= 2) return P.RED;
      return null;
    }
    // 站/跑
    if (y >= 1 && y <= 4 && Math.abs(dx) <= 2.5) { // 头
      if (y === 2 && dx === 1) return P.WHITE;
      if (y === 2 && dx === 1.5) return P.INK;
      return P.ORANGE;
    }
    if (y === 0 || (y === 1 && Math.abs(dx) <= 3)) return (y === 1) ? P.ORANGE : null;
    if (y >= 0 && y <= 1 && Math.abs(dx) <= 3 && y === 1) return P.RED ? P.ORANGE : P.ORANGE;
    if (y >= 5 && y <= 9 && Math.abs(dx) <= 3) return P.ORANGE; // 身
    if (y === 5 && Math.abs(dx) <= 3 && dx < 0) return P.RED;   // 围巾
    if (y >= 10 && y <= 12) { // 腿
      if (ph === 0) return (dx <= -1 && dx >= -3) || (dx >= 1 && dx <= 3 && y <= 11) ? P.INK : null;
      return (dx >= 1 && dx <= 3) || (dx <= -1 && dx >= -3 && y <= 11) ? P.INK : null;
    }
    return null;
  });
  // 头带补:帧内画红头带
  const runner2 = (ph, slide) => tile16f((x, y) => {
    const v = runnerF(ph, slide);
    // runnerF 内部不再复用;直接完整重画(简洁)
    return v;
  });
  const drawRunner = (ph, slide) => tile16f((x, y) => {
    const dx = x - 8;
    if (slide) {
      if (y === 10 && dx >= -6 && dx <= 5) return P.ORANGE;
      if (y === 11 && dx >= -6 && dx <= 5) return P.ORANGE;
      if (y === 10 && dx >= 5 && dx <= 7) { return P.ORANGE; }
      if (y === 10 && dx === 6) return P.WHITE;
      if (y === 12 && dx >= -7 && dx <= -5) return P.INK;
      if (y === 11 && dx >= -3 && dx <= 2) return P.RED;
      return null;
    }
    if (y === 1 && Math.abs(dx) <= 3) return P.RED;            // 头带
    if (y >= 2 && y <= 5 && Math.abs(dx) <= 2.5) {              // 头
      if (y === 3 && dx === 1) return P.INK;
      return P.ORANGE;
    }
    if (y >= 6 && y <= 10 && Math.abs(dx) <= 3) return P.ORANGE; // 身
    if (y === 6 && dx <= -1 && dx >= -3) return P.RED;          // 围巾
    if (y >= 11 && y <= 13) {
      if (ph === 0) return (dx <= -1 && dx >= -3) || (dx >= 1 && dx <= 3 && y <= 12) ? P.INK : null;
      return (dx >= 1 && dx <= 3) || (dx <= -1 && dx >= -3 && y <= 12) ? P.INK : null;
    }
    return null;
  });
  const obj = [];
  obj.push(...drawRunner(0, false));   // 0-3
  obj.push(...drawRunner(1, false));   // 4-7
  obj.push(...drawRunner(0, true));    // 8-11 滑铲
  const coin = (phase) => tile8((x, y) => {
    const dx = Math.abs(x - 3.5);
    if (phase === 0) return dx <= 3 && y >= 1 && y <= 6 ? (dx < 1.5 ? P.GOLD : P.YELLOW) : null;
    return dx <= 1 && y >= 1 && y <= 6 ? P.GOLD : null;
  });
  obj.push(coin(0), coin(1));          // 12,13
  const dot = (s, c) => tile8((x, y) => (x >= 4 && x < 4 + s && y >= 4 && y < 4 + s) ? c : null);
  obj.push(dot(1, P.LGRAY), dot(1, P.GOLD), dot(1, P.CYAN)); // 14,15,16
  writeGame(join(root, 'carts', 'runner'), {
    id: 'PIXELDS1', title: 'Pixel Dash', mode: 1,
    gfx: { 'bg.til': til(0, bg), 'obj.til': til(1, obj) },
    data: { 'pal.json': { P, T, RUN0: 0, RUN1: 4, SLIDE: 8, COIN: 12, DOT: 14 } },
    audio: sharedAud(),
    cover: (() => {
      const c = coverCtx();
      c.rect(0, 0, 32, 20, P.SKY1); c.rect(0, 8, 32, 8, P.SKY2); c.rect(0, 16, 32, 8, P.SKY3);
      c.rect(24, 3, 4, 4, P.YELLOW);
      c.rect(0, 24, 32, 8, P.DIRT); c.rect(0, 24, 32, 1, P.GRASS);
      c.rect(20, 26, 3, 5, P.SLATE); c.rect(20, 25, 3, 1, P.LGRAY);
      c.rect(12, 18, 4, 6, P.ORANGE); c.rect(13, 16, 2, 2, P.ORANGE); c.rect(12, 16, 3, 1, P.RED);
      c.rect(26, 18, 2, 3, P.GOLD);
      return c.done();
    })()
  });
};

/* =====================================================================
 * STARFALL(mode1)
 * BG:0 空 1-3 星点(三档亮度)4 星云
 * OBJ:0-3 自机 4-7 妖精(2 帧)8-11 玉灵 12 飞镖 13-16 炮车 17-22 Boss(3×2 of 16×16, 用 6 tile 组)
 *     23/24 自机弹(青/冰)25 敌弹小 26 敌弹大 27 P 拾取 28 G 拾取 29/30 粒子
 * ===================================================================== */
GAMES.starfall = () => {
  const P = pal([['BG', 0x0000], ['INK', 0x1082], ['DNEB', 0x610C], ['SLATE', 0x5B30], ['CYAN', 0x07FF],
    ['WHITE', 0xFFFF], ['GOLD', 0xFE40], ['YELLOW', 0xFE87], ['RED', 0xF800], ['ORANGE', 0xFC86],
    ['VIOLET', 0x8ADE], ['PINK', 0xE25A], ['LGRAY', 0xADB8], ['ROCK', 0x3A28], ['GREEN', 0x2EED], ['ICE', 0xAF7F]]);
  const bg = [tile8(() => null)];
  const T = {};
  for (let s = 0; s < 3; s++) T['STAR' + s] = bg.push(tile8((x, y) => ((x * 11 + y * 29 + s * 37) % 37 < 2 + s) ? [P.INK, P.SLATE, P.LGRAY][s] : null)) - 1;
  T.NEB = bg.push(tile8((x, y) => ((x * 7 + y * 13) % 31 < 4) ? P.DNEB : null)) - 1;
  const obj = [];
  // 0-3 自机
  obj.push(...tile16f((x, y) => {
    const dx = x - 7.5;
    if (Math.abs(dx) <= 1 && y >= 3 && y <= 12) return y < 6 ? P.WHITE : P.WHITE;
    if (Math.abs(dx) <= 2 && y >= 5 && y <= 9) return P.WHITE;
    if (y === 4 && Math.abs(dx) <= 1) return P.CYAN;
    if (y >= 10 && y <= 11 && Math.abs(dx) >= 2 && Math.abs(dx) <= 4) return P.ICE;
    if (y === 12 && Math.abs(dx) >= 2 && Math.abs(dx) <= 4) return P.CYAN;
    if (y === 7 && Math.abs(dx) <= 0) return P.CYAN;
    return null;
  }));
  // 4-7 妖精(2 帧:扑翼)
  const fairy = (flap) => tile16f((x, y) => {
    const dx = x - 7.5;
    if (y === 4) return P.VIOLET;
    if (y >= 5 && y <= 9 && Math.abs(dx) <= 2) return P.PINK;
    if (y >= 6 && y <= 7 && Math.abs(dx) <= 1) return P.WHITE;
    if (y >= 5 && y <= 8) {
      const wing = flap ? y - 4 : 8 - y;
      if (Math.abs(dx) >= 3 && Math.abs(dx) <= 6 && y === 5 + (flap ? 0 : 1)) return P.LGRAY;
      if (Math.abs(dx) >= 3 && Math.abs(dx) <= 6 && y === 6 + (flap ? 0 : 1)) return P.LGRAY;
    }
    return null;
  });
  obj.push(...fairy(false), ...fairy(true));
  // 8-11 玉灵
  obj.push(...tile16f((x, y) => {
    const dx = Math.abs(x - 7.5), dy = y - 7.5;
    if (dx <= 5 && Math.abs(dy) <= 5) return P.VIOLET;
    if (dx <= 2 && Math.abs(dy) <= 2) return P.PINK;
    if (dx <= 1 && Math.abs(dy) <= 1) return P.WHITE;
    return null;
  }));
  // 12 飞镖
  obj.push(tile8((x, y) => {
    if (x >= 3 && x <= 4 && y >= 1 && y <= 6) return P.ICE;
    if (y >= 4 && y <= 6 && (x === 2 || x === 5)) return P.ICE;
    if (x >= 3 && x <= 4 && y === 0) return P.CYAN;
    return null;
  }));
  // 13-16 炮车
  obj.push(...tile16f((x, y) => {
    if (y >= 4 && y <= 12 && x >= 1 && x <= 14) return P.ROCK;
    if (y >= 6 && y <= 10 && x >= 3 && x <= 12) return P.SLATE;
    if (y >= 12 && y <= 14 && x >= 7 && x <= 9) return P.SLATE;
    if ((y === 7 || y === 8) && (x === 5 || x === 10)) return P.ORANGE;
    return null;
  }));
  // 17-22 Boss(3×2 拼 48×32;tile 按 TL,TM,TR / BL,BM,BR 顺序)
  const bossT = (cx, cy) => tile8((x, y) => {
    const X = cx + x, Y = cy + y;      // 0..23,0..15
    const dx = Math.abs(X - 11.5);
    if (Y >= 1 && Y <= 14 && dx <= 11) return P.VIOLET;
    if (dx >= 9 && Y >= 3 && Y <= 10) return P.ROCK;
    if (Y === 2 || Y === 12) return P.ROCK;
    if (dx <= 4 && Y >= 4 && Y <= 9) return P.PINK;
    if (dx <= 2 && Y >= 6 && Y <= 8) return P.WHITE;
    return null;
  });
  obj.push(bossT(0, 0), bossT(8, 0), bossT(16, 0), bossT(0, 8), bossT(8, 8), bossT(16, 8));
  // 23/24 自机弹(青/冰)
  obj.push(tile8((x, y) => (x >= 3 && x <= 4 && y >= 0 && y <= 6) ? P.CYAN : null));
  obj.push(tile8((x, y) => (x >= 3 && x <= 4 && y >= 0 && y <= 6) ? P.ICE : null));
  // 25/26 敌弹(小 3×3 / 大 5×5)
  const eb = (big, c) => tile8((x, y) => {
    const r = big ? 2.8 : 1.8, cx = 3.5, cy = 3.5;
    if (Math.hypot(x - cx, y - cy) <= r) return c;
    return null;
  });
  obj.push(eb(false, P.PINK), eb(true, P.PINK), eb(false, P.VIOLET), eb(true, P.VIOLET), eb(false, P.RED), eb(true, P.RED), eb(false, P.CYAN), eb(true, P.CYAN));
  // 31 P / 32 G 拾取
  obj.push(tile8((x, y) => {
    if (Math.abs(x - 3.5) <= 2.5 && Math.abs(y - 3.5) <= 2.5) {
      if ((x === 2 && y >= 2 && y <= 4) || (y === 2 && x >= 2 && x <= 4) || (x === 4 && y === 4)) return P.WHITE;
      return P.CYAN;
    }
    return null;
  }));
  obj.push(tile8((x, y) => (Math.abs(x - 3.5) <= 1.5 && Math.abs(y - 3.5) <= 2.5) ? P.GOLD : null));
  const dot = (c) => tile8((x, y) => (x === 3 && y === 3) ? c : null);
  obj.push(dot(P.WHITE), dot(P.ORANGE), dot(P.YELLOW), dot(P.ICE));
  writeGame(join(root, 'carts', 'starfall'), {
    id: 'STARFAL1', title: 'Starfall', mode: 1,
    gfx: { 'bg.til': til(0, bg), 'obj.til': til(1, obj) },
    data: { 'pal.json': { P, T, SHIP: 0, FAIRY: 4, ORB: 8, DART: 12, TANK: 13, BOSS: 17, PB_CYAN: 23, PB_ICE: 24, EB: 25, PICK_P: 33, PICK_G: 34, DOT: 35 } },
    audio: sharedAud([], [
      { t: 6, notes: [{ s: 6, n: 93, l: 2 }, { s: 6, n: 86, l: 3 }] }   // 7:激光双响
    ]),
    cover: (() => {
      const c = coverCtx();
      c.rect(0, 0, 32, 32, P.INK);
      for (let i = 0; i < 20; i++) c.rect((i * 7) % 32, (i * 13) % 32, 1, 1, i % 3 ? P.SLATE : P.LGRAY);
      c.rect(14, 8, 3, 9, P.WHITE); c.rect(13, 10, 5, 5, P.WHITE); c.rect(15, 9, 1, 3, P.CYAN);
      c.rect(10, 11, 3, 3, P.ICE); c.rect(18, 11, 3, 3, P.ICE);
      c.rect(4, 4, 2, 2, P.PINK); c.rect(26, 6, 2, 2, P.PINK); c.rect(22, 20, 2, 2, P.VIOLET);
      c.rect(6, 22, 6, 6, P.VIOLET); c.rect(8, 24, 2, 2, P.PINK);
      return c.done();
    })()
  });
};

/* =====================================================================
 * PUFF VOLLEY(mode1)
 * BG:0 空 1 天1 2 天2 3 天3 4 海 5 海暗 6 沙 7 沙点 8 网柱 9 网面 10 网顶
 * OBJ:0-3 玩家1(站)4-7 玩家1(跳/伸)8-11 玩家2(站)12-15 玩家2(跳)
 *     16/17 球(两旋转相位)18 影子 19/20 粒子
 * ===================================================================== */
GAMES.volley = () => {
  const P = pal([['INK', 0x0000], ['SKY1', 0x6E5C], ['SKY2', 0x9CD3], ['SKY3', 0xCE79], ['SUN', 0xFE87],
    ['SEA', 0x267E], ['SEAD', 0x133E], ['SAND', 0xFDB8], ['SANDD', 0xDB60], ['WHITE', 0xFFFF],
    ['LGRAY', 0xADB8], ['GRAY', 0x7C32], ['DGRAY', 0x426B], ['MINT', 0x5FDD], ['MINTD', 0x2EA6],
    ['CORAL', 0xFD42], ['CORALD', 0xCB03], ['RED', 0xF800], ['ORANGE', 0xFC86], ['YELLOW', 0xFE87],
    ['GREEN', 0x2EED], ['CYAN', 0x07FF], ['VIOLET', 0x8ADE], ['PINK', 0xE25A]]);
  const bg = [tile8(() => null)];
  const T = {};
  T.SKY1 = bg.push(tile8(() => P.SKY1)) - 1;
  T.SKY2 = bg.push(tile8(() => P.SKY2)) - 1;
  T.SKY3 = bg.push(tile8(() => P.SKY3)) - 1;
  T.SUN = bg.push(tile8((x, y) => Math.hypot(x - 3.5, y - 3.5) <= 3 ? P.SUN : null)) - 1;
  T.SEA = bg.push(tile8((x, y) => (y === 0 || y === 1) ? P.SEAD : (((x * 5 + y * 3) % 7 < 2) ? P.SKY3 : P.SEA))) - 1;
  T.SAND = bg.push(tile8((x, y) => ((x * 13 + y * 7) % 17 < 2) ? P.SANDD : P.SAND)) - 1;
  T.NETP = bg.push(tile8((x, y) => {
    if (x >= 2 && x <= 5) return P.DGRAY;
    return null;
  })) - 1;
  T.NETM = bg.push(tile8((x, y) => {
    if (y === 3 || y === 4) return P.WHITE;
    if ((x + y) % 4 === 0 && (y === 1 || y === 6)) return P.LGRAY;
    return null;
  })) - 1;
  T.CLOUD = bg.push(tile8((x, y) => (y >= 3 && y <= 5 && x >= 1 && x <= 6) || (y === 2 && x >= 3 && x <= 4) ? P.WHITE : null)) - 1;
  const puff = (c, cd, jump) => tile16f((x, y) => {
    const dx = x - 7.5, dy = y - 8;
    const rx = 6, ry = jump ? 6.5 : 5.5;
    const inBody = (dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1;
    if (inBody) {
      if (dy > ry - 1.5) return cd;
      return c;
    }
    // 耳朵
    if (dy < -ry && dy > -ry - 3 && (Math.abs(dx - 3) < 1 || Math.abs(dx + 3) < 1)) return c;
    // 眼睛
    if (Math.abs(dy + 1) < 1 && (Math.abs(dx - 3) < 1.2 || Math.abs(dx + 3) < 1.2)) return P.INK;
    if (Math.abs(dy + 1) < 1.4 && (Math.abs(dx - 3) < 1.6 || Math.abs(dx + 3) < 1.6)) return P.WHITE;
    if (Math.abs(dy - 3) < 1 && (Math.abs(dx - 4) < 1 || Math.abs(dx + 4) < 1)) return P.PINK;
    return null;
  });
  const obj = [];
  obj.push(...puff(P.MINT, P.MINTD, false));   // 0-3
  obj.push(...puff(P.MINT, P.MINTD, true));    // 4-7
  obj.push(...puff(P.CORAL, P.CORALD, false)); // 8-11
  obj.push(...puff(P.CORAL, P.CORALD, true));  // 12-15
  const ball = (ph) => tile8((x, y) => {
    const dx = x - 3.5, dy = y - 3.5;
    if (Math.hypot(dx, dy) > 3.4) return null;
    if (Math.hypot(dx, dy) > 2.6) return P.LGRAY;
    const a = Math.atan2(dy, dx) + ph * 2.09;
    if (Math.abs(Math.sin(a)) > 0.75 && Math.abs(dx) < 2.5) return ph === 0 ? P.ORANGE : P.YELLOW;
    return P.WHITE;
  });
  obj.push(ball(0), ball(1), ball(2));          // 16,17,18
  const dot = (c) => tile8((x, y) => (x === 3 && y === 3) ? c : null);
  obj.push(dot(P.WHITE), dot(P.SANDD), dot(P.YELLOW)); // 19-21
  writeGame(join(root, 'carts', 'volley'), {
    id: 'PUFFVOL1', title: 'Puff Volley', mode: 1,
    gfx: { 'bg.til': til(0, bg), 'obj.til': til(1, obj) },
    data: { 'pal.json': { P, T, P1: 0, P1J: 4, P2: 8, P2J: 12, BALL: 16, DOT: 19 } },
    audio: sharedAud(),
    cover: (() => {
      const c = coverCtx();
      c.rect(0, 0, 32, 14, P.SKY2); c.rect(0, 10, 32, 6, P.SKY3);
      c.rect(3, 3, 4, 4, P.SUN);
      c.rect(0, 16, 32, 4, P.SEA); c.rect(0, 16, 32, 1, P.SEAD);
      c.rect(0, 20, 32, 12, P.SAND);
      c.rect(15, 10, 2, 10, P.DGRAY); c.rect(12, 9, 8, 2, P.WHITE);
      c.rect(7, 14, 7, 6, P.MINT); c.rect(18, 13, 7, 7, P.CORAL);
      c.rect(15, 4, 3, 3, P.WHITE);
      return c.done();
    })()
  });
};

/* =====================================================================
 * TIDY UP!(mode1)
 * 地板屏 BG:0 空 1 地板A 2 地板B 3 墙裙 4 木箱 5 箱亮边
 * 货架屏 BG:6 墙A 7 墙B 8 层板 9 层板亮 10 槽底 11 槽框
 * OBJ:0-3 机器人 4-6 物品(书/瓶/盒)7 光标
 * ===================================================================== */
GAMES.tidy = () => {
  const P = pal([['INK', 0x0000], ['BG', 0x18C3], ['FLOORC', 0x39E3], ['FLOORD', 0x2126], ['WALLC', 0x6B0D],
    ['WALLD', 0x4A4A], ['WHITE', 0xFFFF], ['LGRAY', 0xADB8], ['GRAY', 0x7C32], ['RED', 0xF800],
    ['DRED', 0x9801], ['ORANGE', 0xFC86], ['YELLOW', 0xFE87], ['GREEN', 0x2EED], ['DGREEN', 0x1B67],
    ['DBROWN', 0x5920], ['BLUE', 0x2BFF], ['DBLUE', 0x1082], ['SKIN', 0xFE72], ['BROWN', 0x8AC5],
    ['CYAN', 0x07FF], ['PINK', 0xE25A], ['VIOLET', 0x8ADE], ['SLATE', 0x5B30]]);
  const bg = [tile8(() => null)];
  const T = {};
  T.FLOOR_A = bg.push(tile8(() => ((3 * 7 + 5 * 13) % 7 < 2) ? P.FLOORD : P.FLOORC)) - 1;
  T.FLOOR_A = bg.push(tile8((x, y) => ((x * 7 + y * 13) % 7 < 2) ? P.FLOORD : P.FLOORC)) - 1;
  T.FLOOR_B = bg.push(tile8(() => P.FLOORC)) - 1;
  T.SKIRT = bg.push(tile8((x, y) => y < 3 ? P.WALLD : P.FLOORC)) - 1;
  T.CRATE = bg.push(tile8((x, y) => {
    if (x === 0 || y === 0) return P.SKIN;
    if (y === 7) return P.DBROWN;
    if (x === 3 || x === 4) return P.SKIN;
    if (y === 3 || y === 4) return P.SKIN;
    return P.BROWN;
  })) - 1;
  T.WALL_A = bg.push(tile8(() => P.WALLC)) - 1;
  T.WALL_B = bg.push(tile8((x, y) => (y % 8 < 3) ? P.WALLD : P.WALLC)) - 1;
  T.SHELF = bg.push(tile8(() => P.BROWN)) - 1;
  T.SHELF_HI = bg.push(tile8((x, y) => y === 0 ? P.SKIN : P.BROWN)) - 1;
  T.SLOT = bg.push(tile8((x, y) => (x === 0 || y === 0 || x === 7 || y === 7) ? P.WALLD : P.BG)) - 1;
  T.TRAY = bg.push(tile8(() => P.INK)) - 1;
  T.TRAY_SLOT = bg.push(tile8((x, y) => (x === 0 || y === 0 || x === 7 || y === 7) ? P.WALLD : P.INK)) - 1;
  const robot = () => tile16f((x, y) => {
    const dx = x - 7.5;
    if (y === 0 && Math.abs(dx) <= 0.5) return P.RED;      // 天线灯
    if (y === 1 && Math.abs(dx) <= 0.5) return P.GRAY;
    if (y >= 2 && y <= 4 && Math.abs(dx) <= 3) {           // 头
      if (y === 3 && (Math.abs(dx) >= 1 && Math.abs(dx) <= 2.5)) return P.INK;
      return P.LGRAY;
    }
    if (y === 2 && Math.abs(dx) <= 3.5) return P.WHITE;
    if (y >= 5 && y <= 11 && Math.abs(dx) <= 3.5) {        // 身
      if (y === 5) return P.WHITE;
      if (y === 9) return P.GRAY;
      return P.LGRAY;
    }
    if (y >= 12 && y <= 14 && (Math.abs(dx) >= 1.5 && Math.abs(dx) <= 3.5)) return P.DBROWN; // 轮
    if (y >= 6 && y <= 9 && (dx === 5 || dx === -5)) return P.GRAY; // 臂
    return null;
  });
  const itemT = (cat) => tile8((x, y) => {
    if (cat === 0) { // 书
      if (x >= 1 && x <= 6 && y >= 2 && y <= 6) {
        if (x === 1 || y === 6) return P.DRED;
        if (x === 3 || x === 4) return y === 2 ? P.WHITE : P.RED;
        return P.RED;
      }
      return null;
    }
    if (cat === 1) { // 瓶
      if (x >= 3 && x <= 4 && y >= 1 && y <= 2) return P.GREEN;
      if (x >= 2 && x <= 5 && y >= 3 && y <= 6) return y === 6 ? P.DGREEN : P.GREEN;
      if (x === 2 && y === 3) return P.LGRAY;
      return null;
    }
    // 盒
    if (x >= 1 && x <= 6 && y >= 2 && y <= 6) {
      if (y === 4 || y === 5 || x === 3 || x === 4) return P.DBLUE;
      if (x === 2 && y === 3) return P.LGRAY;
      return P.BLUE;
    }
    return null;
  });
  const obj = [];
  obj.push(...robot());                       // 0-3
  obj.push(itemT(0), itemT(1), itemT(2));     // 4,5,6
  obj.push(tile8((x, y) => {
    const dx = x - 3.5, dy = y - 3.5, d = Math.hypot(dx, dy);
    if (d <= 1) return P.WHITE;
    if (d <= 2) return P.LGRAY;
    return null;
  }));                                        // 7 光标
  writeGame(join(root, 'carts', 'tidy'), {
    id: 'TIDYUP01', title: 'Tidy Up!', mode: 1,
    gfx: { 'bg.til': til(0, bg), 'obj.til': til(1, obj) },
    data: { 'pal.json': { P, T, ROBOT: 0, ITEM: 4, CURSOR: 7 } },
    audio: sharedAud(),
    cover: (() => {
      const c = coverCtx();
      c.rect(0, 0, 32, 32, P.WALLC);
      c.rect(4, 4, 24, 3, P.BROWN); c.rect(4, 12, 24, 3, P.BROWN); c.rect(4, 20, 24, 3, P.BROWN);
      c.rect(6, 1, 4, 3, P.RED); c.rect(14, 1, 3, 3, P.GREEN); c.rect(21, 1, 4, 3, P.BLUE);
      c.rect(8, 9, 4, 3, P.RED); c.rect(18, 9, 4, 3, P.BLUE);
      c.rect(6, 17, 3, 3, P.GREEN); c.rect(14, 17, 4, 3, P.RED); c.rect(22, 17, 3, 3, P.GREEN);
      c.rect(13, 25, 6, 6, P.LGRAY); c.rect(14, 26, 4, 2, P.INK); c.rect(16, 24, 1, 1, P.RED);
      return c.done();
    })()
  });
};

/* =====================================================================
 * NIGHT SURVIVOR / vampire(mode1)
 * BG:0 空 1 草A 2 草B 3 草点(循环地图 64×64)
 * OBJ:0 自机 1-5 敌(蝠/僵/灵/吐/蛮)6 精英框?精英用同 tile 放大 16(8×8 放大成 16 会糊——
 *     用 16×16 敌形)→ 简化:敌全部 8×8 小 tile,精英加金框 sprite?OAM 紧张,精英改用闪烁色 tile 变体
 *     7 Boss 8 宝石小 9 宝石大 10 心 11 磁铁 12 箱 13 弹 14 月珠 15-17 粒子
 * ===================================================================== */
GAMES.vampire = () => {
  const P = pal([['BG', 0x0000], ['INK', 0x1082], ['NAVY', 0x2129], ['SLATE', 0x5B30], ['LGRAY', 0xADB8],
    ['WHITE', 0xFFFF], ['GRAY', 0x7BEF], ['DG1', 0x03A0], ['DG2', 0x05C0], ['GREEN', 0x2EED],
    ['CYAN', 0x4FFF], ['ICE', 0xAF7F], ['RED', 0xF20B], ['BLOOD', 0x8002], ['ORANGE', 0xFC86],
    ['YELLOW', 0xFE87], ['GOLD', 0xFE40], ['PINK', 0xE25A], ['VIOLET', 0x8ADE], ['BONE', 0xFF98]]);
  const bg = [tile8(() => null)];
  const T = {};
  T.G1 = bg.push(tile8(() => P.DG1)) - 1;
  T.G2 = bg.push(tile8((x, y) => ((x * 5 + y * 3) % 7 < 2) ? P.DG2 : P.DG1)) - 1;
  T.G3 = bg.push(tile8((x, y) => ((x * 13 + y * 11) % 29 < 2) ? P.GREEN : ((x * 5 + y * 3) % 7 < 2 ? P.DG2 : P.DG1))) - 1;
  const obj = [];
  // 0 玩家
  obj.push(tile8((x, y) => {
    if (x >= 2 && x <= 5 && y >= 1 && y <= 6) {
      if (y === 1 || y === 2) return (x === 2 || x === 5) ? P.INK : P.BONE;
      if (y === 2) return P.INK;
      if (y === 6) return P.CYAN;
      return P.WHITE;
    }
    return null;
  }));
  // 1-5 敌人
  obj.push(tile8((x, y) => {                                  // 蝙蝠
    const fl = (x + y) % 2;
    if (y === 3 || y === 4) { if (x >= 2 && x <= 5) return P.VIOLET; }
    if (y === 2 && (x <= 1 || x >= 6)) return P.PINK;
    if (y === 3 && (x <= 0 || x >= 7)) return P.PINK;
    return null;
  }));
  obj.push(tile8((x, y) => {                                  // 僵尸
    if (x >= 2 && x <= 5 && y >= 1 && y <= 6) {
      if (y === 2 && (x === 2 || x === 5)) return P.RED;
      return P.GREEN;
    }
    if (y === 3 && (x === 1 || x === 6)) return P.GRAY;
    return null;
  }));
  obj.push(tile8((x, y) => {                                  // 幽灵
    if (x >= 2 && x <= 5 && y >= 1 && y <= 5) return P.ICE;
    if (y === 6 && (x === 2 || x === 4)) return P.ICE;
    if (y === 2 && (x === 2 || x === 5)) return P.INK;
    return null;
  }));
  obj.push(tile8((x, y) => {                                  // 吐息者
    if (x >= 2 && x <= 5 && y >= 1 && y <= 5) return y === 6 ? P.RED : P.PINK;
    if (y === 2 && (x === 2 || x === 5)) return P.YELLOW;
    if (y === 6 && x >= 3 && x <= 4) return P.RED;
    return null;
  }));
  obj.push(tile8((x, y) => {                                  // 蛮兵
    if (x >= 1 && x <= 6 && y >= 1 && y <= 6) {
      if (y === 2 && (x === 2 || x === 5)) return P.YELLOW;
      if (y === 1 || y === 6) return P.BLOOD;
      return P.RED;
    }
    if (y === 3 && (x === 0 || x === 7)) return P.BLOOD;
    return null;
  }));
  // 6 Boss(16×16)
  obj.push(...tile16f((x, y) => {
    if (x >= 3 && x <= 12 && y >= 2 && y <= 13) {
      if (y === 4 && (x === 5 || x === 9)) return P.YELLOW;
      if (y === 12) return P.INK;
      if (y === 12 && (x === 6 || x === 9)) return P.WHITE;
      return P.RED;
    }
    if ((x <= 2 || x >= 13) && y >= 1 && y <= 3) return P.BLOOD;
    return null;
  }));
  // 7-8 精英敌(同形加金边)—— 用第二组:直接引用同 tile,精英在游戏里以 prio+高 y 显示?OAM 不支持缩放;
  // 简化:精英 = 同 tile,游戏用"金框粒子"环绕提示
  // 9 宝石小 10 宝石大 11 心 12 磁 13 箱 14 弹 15 敌弹 16-18 粒子
  obj.push(tile8((x, y) => (x >= 3 && x <= 4 && y >= 3 && y <= 4) ? P.CYAN : null));          // 7
  obj.push(tile8((x, y) => (x >= 3 && x <= 5 && y >= 2 && y <= 5) ? P.GOLD : (x === 4 && y === 3 ? P.WHITE : null))); // 8
  obj.push(tile8((x, y) => {
    if ((x === 2 && y === 2) || (x === 5 && y === 2)) return P.RED;
    if (y === 3 && x >= 2 && x <= 5) return P.RED;
    if (y === 4 && x >= 3 && x <= 4) return P.RED;
    if (x === 2 && y === 2) return P.PINK;
    return null;
  }));                                                                                       // 9 心
  obj.push(tile8((x, y) => (y === 2 && x >= 2 && x <= 5) || (x === 2 && y >= 2 && y <= 5) || (x === 5 && y >= 2 && y <= 5) ? P.ICE : null)); // 10 磁
  obj.push(tile8((x, y) => {
    if (x >= 2 && x <= 5 && y >= 2 && y <= 6) {
      if (y === 2) return P.WHITE;
      if (y === 4) return P.ORANGE;
      if (y === 5 && x >= 3 && x <= 4) return P.YELLOW;
      return P.GOLD;
    }
    return null;
  }));                                                                                       // 11 箱
  obj.push(tile8((x, y) => (x >= 3 && x <= 4 && y >= 2 && y <= 5) ? P.VIOLET : null));       // 12 弹
  obj.push(tile8((x, y) => (x >= 3 && x <= 4 && y >= 3 && y <= 4) ? P.PINK : null));         // 13 敌弹
  const dot = (c) => tile8((x, y) => (x === 3 && y === 3) ? c : null);
  obj.push(dot(P.WHITE), dot(P.GOLD), dot(P.CYAN));                                          // 14-16
  obj.push(tile8((x, y) => (Math.hypot(x - 3.5, y - 3.5) <= 2.5) ? P.CYAN : null));          // 17 月珠
  writeGame(join(root, 'carts', 'vampire'), {
    id: 'NIGHTSV1', title: 'Night Survivor', mode: 1,
    gfx: { 'bg.til': til(0, bg), 'obj.til': til(1, obj) },
    data: { 'pal.json': { P, T, HERO: 0, BAT: 1, ZOMBIE: 2, GHOST: 3, SPIT: 4, BRUTE: 5, BOSS: 6, GEM_S: 10, GEM_L: 11, HEART: 12, MAGNET: 13, CHEST: 14, BULLET: 15, EBULLET: 16, DOT: 17, ORB: 20 } },
    audio: sharedAud(),
    cover: (() => {
      const c = coverCtx();
      c.rect(0, 0, 32, 32, P.DG1);
      for (let i = 0; i < 8; i++) c.rect((i * 9 + 3) % 30, (i * 11 + 2) % 30, 1, 1, P.DG2);
      c.rect(14, 13, 4, 7, P.WHITE); c.rect(14, 13, 4, 2, P.BONE);
      c.rect(9, 7, 3, 2, P.VIOLET); c.rect(20, 10, 3, 2, P.VIOLET); c.rect(5, 18, 3, 3, P.GREEN);
      c.rect(24, 20, 4, 4, P.RED); c.rect(25, 21, 2, 1, P.YELLOW);
      c.rect(13, 25, 2, 2, P.CYAN); c.rect(17, 24, 2, 2, P.CYAN);
      return c.done();
    })()
  });
};

/* =====================================================================
 * 模式2 三款:racer / stargate / fps —— 仅调色板 + 封面 + 音频
 * ===================================================================== */
function mode2Game(id, title, dir, palPairs, coverFn, audio) {
  const P = pal(palPairs);
  writeGame(join(root, 'carts', dir), {
    id, title, mode: 2,
    data: { 'pal.json': P },
    audio,
    cover: coverFn(P)
  });
}
GAMES.racer = () => mode2Game('AETHERG1', 'Aether GP', 'racer', [
  ['BG', 0x0000], ['INK', 0x1082], ['SKYD', 0x7DFF], ['SKYU', 0xFC6B], ['SKYN', 0x18E7],
  ['GAD', 0x2D0A], ['GBD', 0x23E8], ['GAU', 0x62C6], ['GBU', 0x4A25], ['GAN', 0x1965], ['GBN', 0x1104],
  ['ROADA', 0x4A4A], ['ROADB', 0x39E9], ['RED', 0xF800], ['WHITE', 0xFFFF], ['LGRAY', 0xADB8],
  ['SLATE', 0x5B30], ['GOLD', 0xFE40], ['YELLOW', 0xFE87], ['ORANGE', 0xFC86], ['GREEN', 0x2EED],
  ['ICE', 0xAF7F], ['CYAN', 0x07FF], ['VIOLET', 0x8ADE],
  ['MTFD', 0x84EB], ['MTND', 0x53B2], ['MTFU', 0x7A9D], ['MTNU', 0x51BA], ['MTFN', 0x296A], ['MTNN', 0x1907]
], (P) => {
  const c = coverCtx();
  c.rect(0, 0, 32, 12, P.SKYU);
  c.rect(4, 4, 4, 4, P.RED);
  for (let x = 0; x < 32; x++) {
    const h = 3 + Math.round(2 * Math.sin(x * 0.4));
    c.rect(x, 12 - h, 1, h, P.MTNU);
  }
  // 透视路面
  for (let y = 12; y < 32; y++) {
    const t = (y - 12) / 20;
    const half = Math.round(2 + t * 14);
    const par = ((y / 3) | 0) % 2;
    c.rect(0, y, 32, 1, par ? P.GAU : P.GBU);
    c.rect(16 - half, y, half * 2, 1, par ? P.ROADA : P.ROADB);
    if (par && half > 6) c.rect(16 - 1, y, 2, 1, P.LGRAY);
    if (half > 4) { c.rect(16 - half - 1, y, 1, 1, par ? P.RED : P.WHITE); c.rect(16 + half, y, 1, 1, par ? P.RED : P.WHITE); }
  }
  c.rect(10, 20, 12, 7, P.RED); c.rect(12, 22, 8, 3, P.INK);
  return c.done();
}, sharedAud());

GAMES.stargate = () => mode2Game('GATERUN1', 'Gate Runner', 'stargate', [
  ['BGC', 0x0000], ['INK', 0x1082], ['DEEP', 0x2129], ['GRID', 0x32A4], ['CYAN', 0x07FF],
  ['WHITE', 0xFFFF], ['GOLD', 0xFE40], ['YELLOW', 0xFE87], ['RED', 0xF800], ['ORANGE', 0xFC86],
  ['VIOLET', 0x8ADE], ['PINK', 0xE25A], ['LGRAY', 0xADB8], ['SLATE', 0x5B30], ['GREEN', 0x2EED], ['ICE', 0xAF7F]
], (P) => {
  const c = coverCtx();
  c.rect(0, 0, 32, 32, P.BGC);
  for (let i = 0; i < 24; i++) c.rect((i * 7 + 2) % 32, (i * 13) % 32, 1, 1, i % 3 ? P.DEEP : P.SLATE);
  for (let k = 0; k < 5; k++) {
    const s = 3 + k * 3.4;
    const x0 = Math.round(16 - s), y0 = Math.round(15 - s), w = Math.round(s * 2);
    const ci = k === 4 ? P.WHITE : k === 3 ? P.LGRAY : [P.GOLD, P.CYAN, P.VIOLET][k % 3];
    c.rect(x0, y0, w, 1, ci); c.rect(x0, y0 + w, w, 1, ci);
    c.rect(x0, y0, 1, w, ci); c.rect(x0 + w, y0, 1, w, ci);
  }
  c.rect(15, 14, 2, 2, P.WHITE);
  return c.done();
}, sharedAud());

GAMES.fps = () => mode2Game('PALECTL1', 'Pale Citadel', 'fps', [
  ['SKY', 0xFFFF], ['HAZE', 0xF79F], ['PAVE', 0xD67A], ['GRID', 0xAD76], ['GRAY', 0x8431],
  ['DGRAY', 0x52AC], ['INKB', 0x2125], ['NAVY', 0x1954], ['STEEL', 0x63D4], ['LBLUE', 0x9DBC],
  ['ICE', 0xD71E], ['YEL', 0xFF01], ['AMBER', 0xFD67], ['ORANGE', 0xFBA3], ['RORANGE', 0xFAA4],
  ['RED', 0xE944], ['DRED', 0x9883], ['BLACK', 0x0000], ['CYAN', 0x067C], ['GOLD', 0xFE48]
], (P) => {
  const c = coverCtx();
  c.rect(0, 0, 32, 32, P.SKY);
  // 透视建筑轮廓
  c.rect(2, 10, 6, 16, P.LBLUE); c.rect(24, 8, 7, 18, P.ICE); c.rect(11, 14, 9, 12, P.LBLUE);
  c.rect(2, 10, 6, 1, P.INKB); c.rect(24, 8, 7, 1, P.INKB); c.rect(11, 14, 9, 1, P.INKB);
  c.rect(2, 10, 1, 16, P.INKB); c.rect(24, 8, 1, 18, P.INKB); c.rect(11, 14, 1, 12, P.INKB);
  c.rect(12, 18, 3, 4, P.ORANGE); c.rect(26, 12, 3, 4, P.YEL);   // 敌人
  c.rect(14, 27, 4, 4, P.DGRAY); c.rect(15, 26, 2, 1, P.INKB);   // 枪
  c.rect(15, 15, 2, 2, P.BLACK);                                  // 准星
  return c.done();
}, sharedAud());

// ---------------- 执行 ----------------
const toRun = only.length ? only : Object.keys(GAMES);
for (const k of toRun) {
  if (!GAMES[k]) { console.error('未知游戏:', k); process.exit(1); }
  GAMES[k]();
}
console.log('AC1 移植资产生成完毕');
