/*
 * js/tools/mtedit.js — 魔塔编辑器(AC2 版,自 AC1 tools/magictower-editor.js 搬运)
 * 图块/精灵图标直接取自 carts/magictower 的 TIL2 + pal.json,与游戏内逐像素一致;
 * 试玩 = 把编辑中的楼层与怪物数值写进 data 段 → AC2.Packer 现场重打包 .aec →
 *        真实 Machine 内核直启(bootCart,跳 BIOS)。
 * 导入/导出保持 AC1 的 aether-mt v1 JSON 格式(两边文件互通)。
 */
(function () {
  'use strict';

  const BASE = '../carts/magictower/';
  const FILES = ['cart.json', 'main.ajs', 'cover.bin', 'gfx/bg.til', 'gfx/obj.til', 'audio/game.aud', 'data/pal.json'];
  const DRAFT_KEY = 'ac2mtedit_draft_v1';
  const SAVE_KEY = 'ac2.save.MAGICTW1';   // 与卡带存档键一致(试玩前备份)
  const MW = 11, MH = 11;
  const TS = 36;                          // 编辑画布每格像素

  /* —— 与 carts/magictower/main.ajs 保持一致的默认数据(游戏侧可用 data 段覆盖)—— */
  const MON_DEFAULT = {
    g: { n: 'SLIME', hp: 35, atk: 18, def: 1, gold: 1 },
    h: { n: 'R-SLIME', hp: 45, atk: 20, def: 2, gold: 2 },
    f: { n: 'BAT', hp: 35, atk: 38, def: 3, gold: 3 },
    F: { n: 'BIG BAT', hp: 80, atk: 90, def: 10, gold: 8 },
    n: { n: 'SKELETON', hp: 110, atk: 25, def: 5, gold: 5 },
    m: { n: 'SKEL KN', hp: 150, atk: 40, def: 20, gold: 8 },
    c: { n: 'MAGE', hp: 60, atk: 35, def: 3, gold: 6, first: true },
    C: { n: 'HI-MAGE', hp: 100, atk: 60, def: 8, gold: 10, first: true },
    t: { n: 'ROCK', hp: 100, atk: 68, def: 30, gold: 7 },
    o: { n: 'ORC', hp: 320, atk: 115, def: 10, gold: 13 },
    O: { n: 'ORC KN', hp: 345, atk: 130, def: 30, gold: 17 },
    v: { n: 'RED BAT', hp: 130, atk: 120, def: 15, gold: 10 },
    w: { n: 'GUARD', hp: 800, atk: 160, def: 60, gold: 30 },
    G: { n: 'SENTRY', hp: 1500, atk: 340, def: 140, gold: 50, first: true },
    N: { n: 'PRIEST', hp: 600, atk: 260, def: 60, gold: 60, first: true },
    D: { n: 'DRAGON', hp: 3000, atk: 440, def: 140, gold: 0 },
    L: { n: 'DEVIL', hp: 2600, atk: 480, def: 150, gold: 0 }
  };
  const ITEM_CH = {
    k: 'keyY', j: 'keyB', i: 'keyR',
    u: 'potS', p: 'potL', U: 'potL2', P: 'potS2',
    a: 'gemR', s: 'gemB',
    A: 'sw0', Z: 'sw1', Q: 'sw2', E: 'sw3',
    S: 'sh0', X: 'sh1', W: 'sh2', R: 'sh3'
  };
  const DEFAULT_MAPS = [
    ['###########','#<..#..k..#','#...#.g.a.#','#.###.....#','#.#.###d###','#.#.....#.#','#.#..h..#.#','#d####.##.#','#x..k...u.#','#....g....#','###########'],
    ['###########','#..f..n..<#','#.#######.#','#k#.....#k#','#.#..A..#.#','#.#.....#.#','#.###d###.#','#......f..#','#.g.....u.#','#>..g...u.#','###########'],
    ['###########','#h.f#<#.S.#','#.s.d.b..a#','#...#k#m..#','#...#.#...#','#kjf.....j#','#...#.#...#','#...#j#h..#','#c..ad.b.c#','#...#>#.s.#','###########'],
    ['###########','#<....m..F#','#.#######.#','#u#a...s#u#','#.#..Z..#.#','#j#.....#j#','#.###b###.#','#F.v...m..#','#p.......p#','#>..a.s...#','###########'],
    ['###########','#.n.#<#.f.#','#..pd.b.c.#','#...#k#...#','#...#.#...#','#kps.y..pj#','#...#.#...#','#...#j#..h#','#.n.d.b.f.#','#...#>#...#','###########'],
    ['###########','#.n..#...<#','#c...djm..#','#....#....#','#...k#U...#','#.b..#..b.#','#....#...n#','#..m.#.t..#','#.c..d..X.#','#>...#j.n.#','###########'],
    ['###########','#.C..v...<#','#..F...CP.#','#j##...##.#','#....F....#','##d#####b##','#....o.####','#.i....#aa#','#......r..#','#>..k..#ss#','###########'],
    ['###########','#u..j#k..<#','#....#....#','#.o..#..o.#','#....d....#','#tU..#..Ut#','#....b....#','#....#....#','#.p..#..p.#','#>...#...i#','###########'],
    ['###########','#v..y....<#','#.#######.#','#j#C...C#j#','#.#..Q..#.#','#.#.....#.#','#.###r###.#','#...o..P..#','#k.......v#','#>........#','###########'],
    ['###########','#.O..#.o.<#','#.........#','#....#U...#','#.k..#....#','#.d..#..d.#','#....#....#','#..U.#...w#','#.o..#....#','#>...#j.i.#','###########'],
    ['###########','#.O...w..<#','#.#######.#','#.#a..s.#.#','#d#..W..#d#','#.#s..a.#.#','#.###b###.#','#..O...P..#','#$.P......#','#>..k..k.j#','###########'],
    ['###########','#O..U..i.<#','#########r#','#..w...OP.#','#.#########','#Pd.w...P.#','########.##','#..O.w....#','#.#########','#>.UO..k..#','###########'],
    ['###########','#.w.#<#.O.#','#.asd.b...#','#...#k#C.P#','#...#.#...#','#.k..w.vj.#','#...#.#...#','#P.O#j#..w#','#.v.d.b.C.#','#...#>#...#','###########'],
    ['###########','#U.a.#.i.i#','#.a..rP...#','#s.w.#..aa#','#...<#....#','#....#..#.#','#....#...P#','#....#s...#','#.k.Ud..w.#','#>...#.s.s#','###########'],
    ['###########','#k......P<#','#..w..O...#','##d#####b##','#k...w...j#','#PO.....w.#','#.........#','##d#####d##','#......P..#','#>..O....k#','###########'],
    ['###########','#.N..w...<#','#.#######.#','#a#..s..#a#','#.#.a.s.#.#','#s#.....#P#','#.###d###.#','#..w.N....#','#$.......P#','#>.k......#','###########'],
    ['###########','#.N.#<#.j.#','#..Ud.b.N.#','#k..#.#...#','#...#.#...#','#.k.......#','#...#.#..P#','#...#j#...#','#.U.d.bPG.#','#...#>#..P#','###########'],
    ['###########','#....E...<#','#..##r##..#','#....w....#','#.w.......#','#..w...O..#','#.P.......#','####d######','#.k...O.w.#','#>..P....i#','###########'],
    ['###########','#>.......<#','#.........#','#.N...w...#','#.k....U..#','#.......P.#','####b######','#w.......w#','#.U..w...P#','#....R...j#','###########'],
    ['###########','#>.......<#','#.O...G...#','#...P.....#','#.k...O...#','#..w..P...#','#####r#####','#.........#','#....D....#','#.........#','###########'],
    ['###########','#>........#','#.........#','#..#...#..#','#.........#','#....L....#','#.........#','#..#...#..#','#.........#','#.........#','###########']
  ];
  const MON_IDS = Object.keys(MON_DEFAULT);

  /* —— 图块元数据(名称 / 分组 / 副标题)—— */
  const MON_SUB = id => {
    const m = state.mon[id] || MON_DEFAULT[id];
    return m.hp + '/' + m.atk + '/' + m.def + (m.first ? ' 先攻' : '');
  };
  const GROUPS = () => [
    { name: '地形', items: [
      ['#', '墙', '不可通行'], ['.', '地板', ''], ['<', '上楼', '去上一层'],
      ['>', '下楼', '去下一层'], ['x', '起点', '仅 1 层有效'],
    ]},
    { name: '门', items: [['d', '黄门', '消耗黄钥匙'], ['b', '蓝门', '消耗蓝钥匙'], ['r', '红门', '消耗红钥匙']] },
    { name: '钥匙', items: [['k', '黄钥匙', ''], ['j', '蓝钥匙', ''], ['i', '红钥匙', '']] },
    { name: '药水', items: [
      ['u', '红药水', 'HP+200'], ['p', '蓝药水', 'HP+500'],
      ['U', '大红瓶', 'HP+1000'], ['P', '大蓝瓶', 'HP+2000'],
    ]},
    { name: '宝石 · 剑盾', items: [
      ['a', '攻宝石', 'ATK+2'], ['s', '防宝石', 'DEF+2'],
      ['A', '铁剑', 'ATK+10'], ['Z', '银剑', 'ATK+20'], ['Q', '骑士剑', 'ATK+40'], ['E', '圣剑', 'ATK+100'],
      ['S', '铁盾', 'DEF+10'], ['X', '银盾', 'DEF+20'], ['W', '骑士盾', 'DEF+40'], ['R', '圣盾', 'DEF+100'],
    ]},
    { name: '怪物', items: MON_IDS.map(id => [id, MON_DEFAULT[id].n, MON_SUB(id)]) },
    { name: '事件', items: [['y', '仙子', '5层+1000HP·9层飞行翼'], ['$', '商店', '100金换属性']] },
  ];

  const CHARSET = (() => {
    const s = new Set(['#', '.', '<', '>', 'x', 'd', 'b', 'r', 'k', 'j', 'i',
      'u', 'p', 'U', 'P', 'a', 's', 'A', 'Z', 'Q', 'E', 'S', 'X', 'W', 'R', 'y', '$']);
    for (const id of MON_IDS) s.add(id);
    return s;
  })();

  /* —— 状态 —— */
  const state = {
    name: '我的魔塔',
    floors: DEFAULT_MAPS.map(m => m.slice()),
    names: [],                            // 每层备注名(仅编辑器)
    mon: JSON.parse(JSON.stringify(MON_DEFAULT)),
    cur: 0,
    brush: '#',
  };
  let hoverCell = null;
  let baseFiles = null;                   // 抓取的卡带源文件(试玩重打包用)
  let PAL = null;                         // data/pal.json(P/T/SPR/IT)
  let bgTiles = null, objTiles = null;    // TIL2 解析结果

  /* ============ TIL2 解析与图块渲染(与游戏逐像素一致)============ */

  function parseTil(u8) {
    let d = u8, n;
    if (d.length >= 8 && d[0] === 0x54 && d[1] === 0x49 && d[2] === 0x4C && d[3] === 0x32) {
      n = d[4] | (d[5] << 8);
      d = d.subarray(8);
    } else n = Math.floor(d.length / 72);
    const tiles = [];
    for (let t = 0; t < n; t++)
      tiles.push({ c: d.subarray(t * 72, t * 72 + 64), m: d.subarray(t * 72 + 64, t * 72 + 72) });
    return tiles;
  }

  function cellBase(ch) {                 // 地形 → BG tile 基索引(同 main.ajs cellEntry)
    const T = PAL.T;
    if (ch === '#') return T.WALL;
    if (ch === '<') return T.UP;
    if (ch === '>') return T.DN;
    if (ch === 'd') return T.DOOR_Y;
    if (ch === 'b') return T.DOOR_B;
    if (ch === 'r') return T.DOOR_R;
    return T.FLOOR;
  }
  function entTileIdx(ch) {               // 实体 → OBJ tile 基索引(同 main.ajs entTile)
    const SPR = PAL.SPR, IT = PAL.IT;
    if (MON_DEFAULT[ch]) return SPR[ch];
    if (ch === 'y') return SPR.y;
    if (ch === '$') return IT.chest;
    var k = ITEM_CH[ch];
    if (!k) return -1;
    if (k === 'potL2') return IT.potL;
    if (k === 'potS2') return IT.potS;
    if (k[0] === 's' && k[1] === 'w') return IT.sword[+k[2]];
    if (k[0] === 's' && k[1] === 'h') return IT.shield[+k[2]];
    return IT[k];
  }

  const cellCache = new Map();            // ch → 16×16 canvas
  function tileCanvas(ch) {
    if (cellCache.has(ch)) return cellCache.get(ch);
    const cv = document.createElement('canvas');
    cv.width = 16; cv.height = 16;
    const g = cv.getContext('2d');
    const img = g.createImageData(16, 16);
    const px = new Uint32Array(img.data.buffer);
    const put = (set, ti, ox, oy) => {
      const t = set[ti];
      if (!t) return;
      for (let y = 0; y < 8; y++) {
        const mrow = t.m[y];
        for (let x = 0; x < 8; x++) {
          if (mrow & (1 << x)) continue;          // mask 位=1 透明(同 mode1)
          px[(oy + y) * 16 + ox + x] = AC.ansiLut[t.c[y * 8 + x]];
        }
      }
    };
    const base = cellBase(ch);
    for (let iy = 0; iy < 2; iy++) for (let ix = 0; ix < 2; ix++)
      put(bgTiles, base + iy * 2 + ix, ix * 8, iy * 8);
    let ti = entTileIdx(ch);
    if (ch === 'x') ti = PAL.SPR.hero;            // 起点格叠主角(同游戏)
    if (ti >= 0) for (let iy = 0; iy < 2; iy++) for (let ix = 0; ix < 2; ix++)
      put(objTiles, ti + iy * 2 + ix, ix * 8, iy * 8);
    g.putImageData(img, 0, 0);
    cellCache.set(ch, cv);
    return cv;
  }

  /* ============ 撤销 / 草稿 ============ */

  const undoStack = [], redoStack = [];
  function snapshot() {
    // 深拷贝楼层:行数组必须复制,否则后续 setCell 会把快照一并改掉(AC1 原版的撤销 bug)
    return { floors: state.floors.map(m => m.slice()), names: state.names.slice() };
  }
  function pushUndo() {
    const snap = snapshot();
    const top = undoStack[undoStack.length - 1];
    if (top && JSON.stringify(top) === JSON.stringify(snap)) return;
    undoStack.push(snap);
    if (undoStack.length > 200) undoStack.shift();
    redoStack.length = 0;
  }
  function applySnap(s) {
    state.floors = s.floors.map(m => m.slice());
    state.names = s.names.slice();
    state.cur = Math.min(state.cur, state.floors.length - 1);
    allChanged();
  }

  let draftTimer = 0;
  function saveDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      AC.draft.save(DRAFT_KEY, { name: state.name, floors: state.floors, names: state.names, mon: state.mon });
    }, 300);
  }

  function allChanged() { saveDraft(); renderEdit(); renderFloors(); renderPalSubtitles(); }

  /* ============ 楼层编辑 ============ */

  function blankFloor() { return Array.from({ length: MH }, () => '###########'); }

  function setCell(f, x, y, ch) {
    const row = state.floors[f][y];
    state.floors[f][y] = row.slice(0, x) + ch + row.slice(x + 1);
  }
  function getCell(f, x, y) { return state.floors[f][y][x]; }

  /* ============ 编辑画布 ============ */

  const editCv = document.getElementById('edit');
  const editCtx = editCv.getContext('2d');

  function renderEdit() {
    const g = editCtx;
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#0b0b0e';
    g.fillRect(0, 0, MW * TS, MH * TS);
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
      g.drawImage(tileCanvas(getCell(state.cur, x, y)), x * TS + 2, y * TS + 2, 32, 32);
    }
    // 网格
    g.strokeStyle = 'rgba(255,255,255,.07)';
    g.beginPath();
    for (let i = 1; i < MW; i++) { g.moveTo(i * TS + .5, 0); g.lineTo(i * TS + .5, MH * TS); }
    for (let i = 1; i < MH; i++) { g.moveTo(0, i * TS + .5); g.lineTo(MW * TS, i * TS + .5); }
    g.stroke();
    // 悬停高亮
    if (hoverCell) {
      g.strokeStyle = '#e0c26c';
      g.lineWidth = 2;
      g.strokeRect(hoverCell[0] * TS + 1, hoverCell[1] * TS + 1, TS - 2, TS - 2);
      g.lineWidth = 1;
    }
    document.getElementById('curFloorLabel').textContent = 'F' + String(state.cur + 1).padStart(2, '0');
    document.getElementById('stStats').textContent =
      '怪物 ' + countAll(MON_IDS) + ' · 黄门 ' + countAll(['d']) + ' · 黄钥匙 ' + countAll(['k']);
  }

  function countAll(chars) {
    let n = 0;
    for (const m of state.floors) {
      const flat = m.join('');
      for (const ch of chars) n += flat.split(ch).length - 1;
    }
    return n;
  }

  function cellFromEvent(e) {
    const r = editCv.getBoundingClientRect();
    const x = Math.floor(e.offsetX / r.width * MW);
    const y = Math.floor(e.offsetY / r.height * MH);
    if (x < 0 || x >= MW || y < 0 || y >= MH) return null;
    return [x, y];
  }

  let painting = false;
  editCv.addEventListener('contextmenu', e => e.preventDefault());
  editCv.addEventListener('pointerdown', e => {
    const c = cellFromEvent(e);
    if (!c) return;
    try { editCv.setPointerCapture(e.pointerId); } catch (err) {}
    if (e.button === 2 || e.button === 1) {          // 右键 / 中键吸管
      setBrush(getCell(state.cur, c[0], c[1]));
      return;
    }
    pushUndo();
    painting = true;
    setCell(state.cur, c[0], c[1], state.brush);
    allChanged();
  });
  editCv.addEventListener('pointermove', e => {
    const c = cellFromEvent(e);
    hoverCell = c;
    document.getElementById('stPos').textContent = c
      ? `(${c[0]},${c[1]}) "${getCell(state.cur, c[0], c[1])}"` : '';
    if (painting && c) {
      setCell(state.cur, c[0], c[1], state.brush);
      saveDraft(); renderEdit(); renderFloorThumb(state.cur);
    }
  });
  window.addEventListener('pointerup', () => { painting = false; });
  editCv.addEventListener('pointerleave', () => { hoverCell = null; renderEdit(); });

  /* ============ 楼层列表 ============ */

  const floorList = document.getElementById('floorList');

  function renderFloors() {
    floorList.textContent = '';
    document.getElementById('floorCount').textContent = state.floors.length + ' 层';
    state.floors.forEach((m, i) => {
      const it = AC.el('div', { class: 'floorItem' + (i === state.cur ? ' sel' : '') });
      const cv = AC.el('canvas', { width: 44, height: 44, style: 'width:44px;height:44px;' });
      drawThumb(cv, m);
      it.append(AC.el('span', { class: 'no' }, 'F' + String(i + 1).padStart(2, '0')),
        cv, AC.el('span', { class: 'name' }, state.names[i] || ''));
      it.addEventListener('click', () => {
        if (state.cur !== i) { state.cur = i; renderFloors(); renderEdit(); syncFloorName(); }
      });
      floorList.append(it);
    });
  }

  function drawThumb(cv, m) {
    const g = cv.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.fillStyle = '#0b0b0e';
    g.fillRect(0, 0, 44, 44);
    for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++)
      g.drawImage(tileCanvas(m[y][x]), x * 4, y * 4, 4, 4);
  }
  function renderFloorThumb(i) {
    const items = floorList.children;
    if (items[i]) drawThumb(items[i].querySelector('canvas'), state.floors[i]);
  }

  function syncFloorName() {
    document.getElementById('floorName').value = state.names[state.cur] || '';
  }
  document.getElementById('floorName').addEventListener('change', e => {
    pushUndo();
    state.names[state.cur] = e.target.value.trim();
    saveDraft(); renderFloors();
  });

  function curFloorOp(fn) {
    pushUndo();
    fn();
    allChanged();
  }
  document.getElementById('fAdd').addEventListener('click', () => {
    if (state.floors.length >= 21) return AC.toast('最多 21 层(与游戏一致)', true);
    curFloorOp(() => {
      state.floors.push(blankFloor());
      state.names.push('');
      state.cur = state.floors.length - 1;
    });
  });
  document.getElementById('fDup').addEventListener('click', () => {
    if (state.floors.length >= 21) return AC.toast('最多 21 层', true);
    curFloorOp(() => {
      state.floors.push(state.floors[state.cur].slice());
      state.names.push((state.names[state.cur] || '') + ' 副本');
      state.cur = state.floors.length - 1;
    });
  });
  document.getElementById('fDel').addEventListener('click', () => {
    if (state.floors.length <= 2) return AC.toast('至少保留 2 层', true);
    curFloorOp(() => {
      state.floors.splice(state.cur, 1);
      state.names.splice(state.cur, 1);
      state.cur = Math.min(state.cur, state.floors.length - 1);
    });
  });
  document.getElementById('fUp').addEventListener('click', () => {
    if (state.cur === 0) return;
    pushUndo();
    const f = state.floors.splice(state.cur, 1)[0];
    state.floors.splice(state.cur - 1, 0, f);
    const n = state.names.splice(state.cur, 1)[0];
    state.names.splice(state.cur - 1, 0, n);
    state.cur--;
    allChanged();
  });
  document.getElementById('fDown').addEventListener('click', () => {
    if (state.cur === state.floors.length - 1) return;
    pushUndo();
    const f = state.floors.splice(state.cur, 1)[0];
    state.floors.splice(state.cur + 1, 0, f);
    const n = state.names.splice(state.cur, 1)[0];
    state.names.splice(state.cur + 1, 0, n);
    state.cur++;
    allChanged();
  });

  /* ============ 快捷操作 ============ */

  document.getElementById('tWall').addEventListener('click', () => curFloorOp(() => {
    state.floors[state.cur] = blankFloor();
  }));
  document.getElementById('tFloor').addEventListener('click', () => curFloorOp(() => {
    const m = state.floors[state.cur];
    for (let y = 1; y < MH - 1; y++)
      m[y] = '#' + '.'.repeat(MW - 2) + '#';
  }));
  document.getElementById('tBorder').addEventListener('click', () => curFloorOp(() => {
    const m = state.floors[state.cur].slice();
    m[0] = '#'.repeat(MW);
    m[MH - 1] = '#'.repeat(MW);
    for (let y = 1; y < MH - 1; y++) m[y] = '#' + m[y].slice(1, MW - 1) + '#';
    state.floors[state.cur] = m;
  }));
  document.getElementById('tRoom').addEventListener('click', () => curFloorOp(() => {
    const m = state.floors[state.cur].slice();
    for (let y = 2; y <= 8; y++) {
      let row = m[y].split('');
      for (let x = 2; x <= 8; x++) row[x] = (y === 2 || y === 8 || x === 2 || x === 8) ? '#' : '.';
      m[y] = row.join('');
    }
    m[5] = m[5].slice(0, 2) + '.' + m[5].slice(3);   // 左墙开门洞
    state.floors[state.cur] = m;
  }));

  /* ============ 图块调色板 ============ */

  const palHost = document.getElementById('pal');
  function setBrush(ch) {
    state.brush = ch;
    const g = document.getElementById('brushIcon').getContext('2d');
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, 16, 16);
    g.drawImage(tileCanvas(ch), 0, 0);
    const grp = GROUPS().find(g2 => g2.items.some(it => it[0] === ch));
    const it = grp && grp.items.find(i2 => i2[0] === ch);
    document.getElementById('brushName').textContent = it ? it[1] : ch;
    renderPal();
  }

  function renderPal() {
    palHost.textContent = '';
    for (const grp of GROUPS()) {
      const box = AC.el('div', { class: 'palGroup' });
      box.append(AC.el('div', { class: 'ghead' }, grp.name));
      const grid = AC.el('div', { class: 'palGrid' });
      for (const [ch, label, sub] of grp.items) {
        const it = AC.el('div', { class: 'palItem' + (ch === state.brush ? ' sel' : '') });
        const cv = AC.el('canvas', { width: 16, height: 16, style: 'width:32px;height:32px;' });
        cv.getContext('2d').drawImage(tileCanvas(ch), 0, 0);
        it.append(cv, AC.el('div', { class: 't' }, label),
          AC.el('div', { class: 's', 'data-mon': MON_IDS.includes(ch) ? ch : '' }, sub));
        it.addEventListener('click', () => setBrush(ch));
        grid.append(it);
      }
      box.append(grid);
      palHost.append(box);
    }
  }
  function renderPalSubtitles() {          // 怪物数值改后刷新副标题
    for (const node of palHost.querySelectorAll('.s[data-mon]')) {
      const id = node.getAttribute('data-mon');
      if (id) node.textContent = MON_SUB(id);
    }
  }

  /* ============ 撤销 / 重做 ============ */

  document.getElementById('btnUndo').addEventListener('click', () => {
    if (!undoStack.length) return;
    redoStack.push(snapshot());
    applySnap(undoStack.pop());
  });
  document.getElementById('btnRedo').addEventListener('click', () => {
    if (!redoStack.length) return;
    undoStack.push(snapshot());
    applySnap(redoStack.pop());
  });
  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? document.getElementById('btnRedo').click() : document.getElementById('btnUndo').click();
    }
  });

  /* ============ 怪物数值 ============ */

  document.getElementById('btnMon').addEventListener('click', () => {
    AC.dialog((dlg, close) => {
      dlg.style.maxWidth = '460px';
      dlg.append(AC.el('h3', {}, '怪物数值'));
      const table = AC.el('table', { class: 'monTable' });
      const tr = AC.el('tr', {}, AC.el('th'), AC.el('th', {}, '名称'),
        AC.el('th', {}, 'HP'), AC.el('th', {}, '攻击'), AC.el('th', {}, '防御'),
        AC.el('th', {}, '金币'), AC.el('th', {}, '先攻'));
      table.append(AC.el('thead', {}, tr));
      const tb = AC.el('tbody');
      for (const id of MON_IDS) {
        const m = state.mon[id];
        const mk = (key, min) => {
          const inp = AC.el('input', { type: 'number', min: min, value: m[key] });
          inp.addEventListener('change', () => {
            m[key] = Math.max(min, inp.value | 0);
            saveDraft(); renderPalSubtitles();
          });
          return inp;
        };
        const first = AC.el('input', { type: 'checkbox' });
        first.checked = !!m.first;
        first.addEventListener('change', () => { m.first = first.checked; saveDraft(); renderPalSubtitles(); });
        const cv = AC.el('canvas', { width: 16, height: 16, style: 'width:24px;height:24px;vertical-align:middle;' });
        cv.getContext('2d').drawImage(tileCanvas(id), 0, 0);
        tb.append(AC.el('tr', {},
          AC.el('td', {}, cv), AC.el('td', { class: 'nm' }, m.n),
          AC.el('td', {}, mk('hp', 1)), AC.el('td', {}, mk('atk', 0)), AC.el('td', {}, mk('def', 0)),
          AC.el('td', {}, mk('gold', 0)), AC.el('td', {}, first)));
      }
      table.append(tb);
      dlg.append(table);
      dlg.append(AC.el('div', { class: 'foot' },
        AC.el('button', { class: 'btn', onclick: () => {
          state.mon = JSON.parse(JSON.stringify(MON_DEFAULT));
          saveDraft(); close(); renderPalSubtitles();
          document.getElementById('btnMon').click();
        } }, '恢复原版数值'),
        AC.el('button', { class: 'btn primary', onclick: close }, '完成')));
    });
  });

  /* ============ 校验(规则同 AC1)============ */

  function validate() {
    const errs = [], warns = [];
    const E = (f, msg) => errs.push(`F${f + 1} · ${msg}`);
    if (state.floors.length < 2 || state.floors.length > 21)
      errs.push(`楼层数 ${state.floors.length}(需 2..21)`);
    state.floors.forEach((m, f) => {
      if (m.length !== MH) E(f, `行数 ${m.length} ≠ 11`);
      m.forEach((row, y) => { if (row.length !== MW) E(f, `第 ${y} 行宽 ${row.length}`); });
      for (const ch of m.join('')) if (!CHARSET.has(ch)) E(f, `非法字符 "${ch}"`);
      const cnt = ch => m.join('').split(ch).length - 1;
      if (f === 0 && cnt('x') !== 1) E(f, cnt('x') ? '起点 x 多于一个' : '缺起点 x');
      if (f > 0 && cnt('>') !== 1) E(f, cnt('>') ? '下楼 > 多于一个' : '缺下楼 >');
      if (f < state.floors.length - 1 && cnt('<') !== 1) E(f, cnt('<') ? '上楼 < 多于一个' : '缺上楼 <');
      if (f === state.floors.length - 1 && cnt('<')) E(f, '顶层不应有上楼 <');
      // 连通性(门视作可通行)
      const seen = Array.from({ length: MH }, () => Array(MW).fill(false));
      let start = null;
      for (let y = 0; y < MH && !start; y++) for (let x = 0; x < MW; x++)
        if (m[y][x] === (f === 0 ? 'x' : '>')) { start = [x, y]; break; }
      if (start) {
        const q = [start];
        seen[start[1]][start[0]] = true;
        while (q.length) {
          const [x, y] = q.pop();
          for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || nx > 10 || ny < 0 || ny > 10 || seen[ny][nx]) continue;
            if (m[ny][nx] === '#') continue;
            seen[ny][nx] = true; q.push([nx, ny]);
          }
        }
        let bad = 0;
        for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++)
          if (m[y][x] !== '#' && !seen[y][x]) bad++;
        if (bad) E(f, `${bad} 格不可达(从入口 BFS)`);
      }
    });
    // 钥匙收支
    let ky = 0, kb = 0, kr = 0;
    state.floors.forEach((m, f) => {
      const flat = m.join('');
      const c = ch => flat.split(ch).length - 1;
      ky += c('k') - c('d'); kb += c('j') - c('b'); kr += c('i') - c('r');
      if (ky < 0) E(f, '黄钥匙收支为负(累计 ' + ky + ')');
      if (kb < 0) E(f, '蓝钥匙收支为负(累计 ' + kb + ')');
      if (kr < 0) E(f, '红钥匙收支为负(累计 ' + kr + ')');
    });
    // 提示
    const all = state.floors.join('');
    if (!all.includes('L')) warns.push('没有魔王 L:无法触发通关(击败 L 进入结局)');
    if (!all.includes('y')) warns.push('没有仙子 y(5 层 +1000HP、9 层飞行翼的奖励固定绑定这两个层号)');
    else {
      if (!state.floors[4] || !state.floors[4].join('').includes('y'))
        warns.push('仙子 +1000HP 只在第 5 层生效');
      if (!state.floors[8] || !state.floors[8].join('').includes('y'))
        warns.push('飞行翼只在第 9 层仙子处获得');
    }
    if (all.split('$').length - 1 === 0) warns.push('没有商店 $(金币无处消费)');
    if (all.split('i').length - 1 > all.split('r').length - 1) warns.push('红钥匙多于红门,注意结余');
    return { errs, warns };
  }

  document.getElementById('btnCheck').addEventListener('click', () => {
    const { errs, warns } = validate();
    AC.dialog((dlg, close) => {
      dlg.append(AC.el('h3', {}, '地图校验'));
      const list = AC.el('div', { class: 'valList' });
      if (!errs.length && !warns.length)
        list.append(AC.el('div', { class: 'ok' }, '✔ 没有发现问题'));
      for (const e of errs) list.append(AC.el('div', { class: 'e' }, '✘ ' + e));
      for (const w of warns) list.append(AC.el('div', { class: 'w' }, '⚠ ' + w));
      dlg.append(list, AC.el('div', { class: 'kv' },
        '校验项:11×11 与字符集 · 楼梯配对 · 起点 · 入口 BFS 连通性 · 三色钥匙累计收支'),
        AC.el('div', { class: 'foot' }, AC.el('button', { class: 'btn primary', onclick: close }, '关闭')));
    });
  });

  /* ============ 试玩(现场重打包 .aec + 真实内核)============ */

  async function buildPlayCart() {
    const data = JSON.parse(JSON.stringify(PAL));
    data.MAPS = state.floors.map(m => m.slice());
    data.MON = JSON.parse(JSON.stringify(state.mon));
    const enc = new TextEncoder();
    const files = baseFiles.map(f =>
      f.path === 'data/pal.json' ? { path: f.path, data: enc.encode(JSON.stringify(data)) } : f);
    const { bytes } = await AC2.Packer.buildFromFiles(files);
    return await AC2.Cart.load(bytes);
  }

  let playing = null;
  document.getElementById('btnPlay').addEventListener('click', async () => {
    if (playing) return;
    const { errs } = validate();
    if (errs.length) {
      AC.toast('地图有 ' + errs.length + ' 处错误,请先校验', true);
      document.getElementById('btnCheck').click();
      return;
    }
    let cart;
    try {
      AC.toast('正在重打包 .aec…', { ms: 1200 });
      cart = await buildPlayCart();
    } catch (e) {
      AC.toast('打包失败:' + e.message, true);
      return;
    }
    // 备份真实存档(试玩写入的是同一 ID 的槽位)
    const saveBak = localStorage.getItem(SAVE_KEY);
    localStorage.removeItem(SAVE_KEY);

    const con = new AC2.Machine({ bios: false });   // 直启卡带,跳过 BIOS
    const keys = { up: false, down: false, left: false, right: false, a: false, b: false, start: false };
    const keyMap = {
      ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down',
      ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
      KeyZ: 'a', KeyJ: 'a', Enter: 'start', KeyX: 'b', KeyK: 'b',
    };
    const onKey = e => {
      const k = keyMap[e.code];
      if (!k) {
        if (e.code === 'Escape') endPlay();
        return;
      }
      if (e.code === 'Enter' || e.code.startsWith('Arrow')) e.preventDefault();
      keys[k] = e.type === 'keydown';
    };

    const ov = AC.el('div', { class: 'overlay' });
    const dlg = AC.el('div', { class: 'dlg' });
    dlg.style.maxWidth = '560px';
    dlg.append(AC.el('h3', {}, '试玩 · ' + (state.name || '魔塔') +
      ' · ' + cart.id + ' ' + (cart.bytes ? (cart.bytes.length / 1024).toFixed(1) + 'KB' : '')));
    const cv = AC.el('canvas', { class: 'ptCanvas', width: 240, height: 176,
      style: 'width:480px;height:352px;background:#000;display:block;margin:0 auto;border-radius:4px;' });
    dlg.append(cv);
    dlg.append(AC.el('div', { class: 'kv', style: 'text-align:center;margin-top:8px;' },
      '方向键/WASD 移动 · Z 确认开战 · X 取消/楼梯上飞行 · Enter 暂停 · Esc 结束'));
    dlg.append(AC.el('div', { class: 'foot' },
      AC.el('button', { class: 'btn danger', id: 'ptEnd' }, '结束试玩(恢复原存档)')));
    ov.append(dlg);
    ov.addEventListener('pointerdown', e => { if (e.target === ov) endPlay(); });
    document.body.append(ov);
    document.getElementById('ptEnd').addEventListener('click', endPlay);

    con.onError = e => {
      AC.toast('游戏停机 @' + e.frame + ':' + e.message, true);
      endPlay();
    };
    con.bootCart(cart);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);

    const pctx = cv.getContext('2d');
    const img = pctx.createImageData(240, 176);
    const u32 = new Uint32Array(img.data.buffer);
    function paint() {
      for (let i = 0; i < con.fb.length; i++) u32[i] = AC.ansiLut[con.fb[i]];
      pctx.putImageData(img, 0, 0);
    }
    let raf = 0, lastT = performance.now(), acc = 0;
    function loop(now) {
      if (!playing) return;
      raf = requestAnimationFrame(loop);
      acc += Math.min(100, now - lastT);
      lastT = now;
      let n = 0;
      while (acc >= 16.6 && n < 4) {
        con.input.pushInput({ keys: Object.assign({}, keys), x: 120, y: 88, dx: 0, dy: 0 });
        con.step();
        acc -= 16.6; n++;
        if (con.halted) break;
      }
      paint();
    }

    playing = {
      machine: con, keys,
      end: endPlay,
    };
    window.__MTPLAY = playing;                    // 调试/自动化钩子
    raf = requestAnimationFrame(loop);

    function endPlay() {
      if (!playing) return;
      cancelAnimationFrame(raf);
      playing = null;
      window.__MTPLAY = null;
      con.audio && con.audio.stopAll && con.audio.stopAll();
      ov.remove();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      // 恢复真实存档
      if (saveBak != null) localStorage.setItem(SAVE_KEY, saveBak);
      else localStorage.removeItem(SAVE_KEY);
      AC.toast('已恢复原存档(试玩进度不保留)');
    }
  });

  /* ============ 导入 / 导出(格式与 AC1 互通)============ */

  const ioMenu = document.getElementById('ioMenu');
  const ioPop = AC.el('div', { class: 'pop' },
    AC.el('button', { class: 'btn', onclick: doExport }, '导出 JSON'),
    AC.el('button', { class: 'btn', onclick: doImport }, '导入 JSON'),
    AC.el('button', { class: 'btn', onclick: doExportText }, '导出地图文本'),
    AC.el('button', { class: 'btn', onclick: doImportText }, '导入地图文本'));
  ioMenu.append(ioPop);
  ioMenu.addEventListener('pointerenter', () => ioPop.style.display = 'flex');
  ioMenu.addEventListener('pointerleave', () => ioPop.style.display = 'none');
  ioPop.style.display = 'none';

  document.getElementById('ioBtn').addEventListener('click', () => {
    ioPop.style.display = ioPop.style.display === 'none' ? 'flex' : 'none';
  });

  function doExport() {
    ioPop.style.display = 'none';
    const data = { format: 'aether-mt', version: 1, name: state.name,
      floors: state.floors, names: state.names, mon: state.mon };
    AC.download((state.name || 'magictower') + '-mt.json', JSON.stringify(data, null, 1), 'application/json');
  }

  function doImport() {
    ioPop.style.display = 'none';
    AC.pickFile('.json,.txt', 'text').then(f => {
      if (!f) return;
      try {
        const d = JSON.parse(f.data);
        if (d.format !== 'aether-mt') throw new Error('不是 aether-mt 文件');
        applyProject(d);
        AC.toast('已导入:' + f.name);
      } catch (err) { AC.toast('导入失败:' + err.message, true); }
    });
  }

  function applyProject(d) {
    if (!Array.isArray(d.floors) || d.floors.length < 2 || d.floors.length > 21)
      throw new Error('floors 需为 2..21 层');
    for (const m of d.floors) {
      if (m.length !== MH) throw new Error('每层需 11 行');
      for (const row of m) {
        if (row.length !== MW) throw new Error('每行需 11 字符');
        for (const ch of row) if (!CHARSET.has(ch)) throw new Error(`非法字符 "${ch}"`);
      }
    }
    pushUndo();
    state.name = d.name || '导入的魔塔';
    state.floors = d.floors.map(m => m.slice());
    state.names = (d.names || []).slice();
    if (d.mon) for (const id of MON_IDS) if (d.mon[id])
      state.mon[id] = Object.assign({}, MON_DEFAULT[id], d.mon[id]);
    document.getElementById('projName').value = state.name;
    state.cur = 0;
    allChanged(); syncFloorName();
  }

  function doExportText() {
    ioPop.style.display = 'none';
    AC.dialog((dlg, close) => {
      dlg.append(AC.el('h3', {}, '地图文本(字符画)'));
      const ta = AC.el('textarea', { spellcheck: 'false' });
      ta.value = state.floors.map(m => m.join('\n')).join('\n\n');
      dlg.append(ta, AC.el('div', { class: 'foot' },
        AC.el('button', { class: 'btn primary', onclick: close }, '关闭')));
    });
  }

  function doImportText() {
    ioPop.style.display = 'none';
    AC.dialog((dlg, close) => {
      dlg.append(AC.el('h3', {}, '导入地图文本'));
      const ta = AC.el('textarea', { placeholder: '每层 11 行,层间空行分隔' });
      dlg.append(ta, AC.el('div', { class: 'foot' },
        AC.el('button', { class: 'btn primary', onclick: () => {
          const floors = ta.value.trim().split(/\n\s*\n/).map(b => b.split(/\r?\n/).map(r => r.trim()).filter(Boolean));
          if (!floors.length) return AC.toast('没有内容', true);
          try {
            applyProject({ name: state.name, floors, names: state.names, mon: state.mon });
            close();
          } catch (err) { AC.toast(err.message, true); }
        } }, '导入'),
        AC.el('button', { class: 'btn', onclick: close }, '取消')));
    });
  }

  /* ============ 新建 / 初始化 ============ */

  document.getElementById('btnNew').addEventListener('click', () => {
    AC.dialog((dlg, close) => {
      dlg.append(AC.el('h3', {}, '新建塔(丢弃当前内容)'));
      const cnt = AC.el('input', { type: 'number', min: 2, max: 21, value: 10, style: 'width:70px;' });
      const row = AC.el('div', { class: 'row' }, AC.el('span', { class: 'kv' }, '层数'), cnt);
      dlg.append(row, AC.el('div', { class: 'foot' },
        AC.el('button', { class: 'btn danger', onclick: () => {
          const n = Math.max(2, Math.min(21, cnt.value | 0));
          pushUndo();
          state.floors = Array.from({ length: n }, blankFloor);
          state.names = Array.from({ length: n }, () => '');
          // 首层:中间留地板 + 起点
          const first = state.floors[0].slice();
          first[5] = first[5].slice(0, 5) + 'x' + first[5].slice(6);
          state.floors[0] = first;
          state.name = '我的魔塔';
          document.getElementById('projName').value = state.name;
          state.cur = 0;
          allChanged(); syncFloorName();
          close();
        } }, '新建'),
        AC.el('button', { class: 'btn', onclick: close }, '取消')));
    });
  });

  document.getElementById('projName').addEventListener('change', e => {
    state.name = e.target.value.trim() || '我的魔塔';
    saveDraft();
  });

  // —— 启动:抓取卡带源 → 解析资产 → 草稿优先,否则原版 21 层 ——
  (async function init() {
    window.__MTEDIT = { state, validate, buildPlayCart };
    try {
      baseFiles = await AC.fetchFiles(BASE, FILES);
    } catch (e) {
      AC.toast(e.message, true, { ms: 8000 });
      document.getElementById('st1').textContent = '卡带源抓取失败:' + e.message;
      return;
    }
    PAL = JSON.parse(new TextDecoder().decode(
      baseFiles.find(f => f.path === 'data/pal.json').data));
    bgTiles = parseTil(baseFiles.find(f => f.path === 'gfx/bg.til').data);
    objTiles = parseTil(baseFiles.find(f => f.path === 'gfx/obj.til').data);

    const draft = AC.draft.load(DRAFT_KEY);
    if (draft && Array.isArray(draft.floors) && draft.floors.length >= 2 &&
        draft.floors.every(m => m.length === MH && m.every(r => r.length === MW))) {
      state.floors = draft.floors.map(m => m.slice());
      state.names = (draft.names || []).slice();
      if (draft.mon) for (const id of MON_IDS)
        if (draft.mon[id]) state.mon[id] = Object.assign({}, MON_DEFAULT[id], draft.mon[id]);
      if (draft.name) state.name = draft.name;
      AC.toast('已恢复上次草稿');
    } else {
      state.names = Array.from({ length: state.floors.length }, () => '');
    }
    document.getElementById('projName').value = state.name;
    syncFloorName();
    setBrush('#');
    renderFloors();
    renderEdit();
  })();
})();
