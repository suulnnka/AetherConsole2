/*
 * js/tools/fpsmap-core.js — 3D FPS 地图编辑器 · 纯数据/几何核心(自 AC1 tools/fps-editor.js 抽出)
 * 数据模型:vertices / linedefs(front·back 扇区)/ sectors(地板高·天花高·光照·颜色·天空)/
 *          things(类型·位置·朝向)。单层建筑(无 3D floor,同经典 Doom)。
 * 纯函数(map 显式传参),浏览器与 Node 共用;fpsedit.js 与 tests/editors.test.mjs 都走这里。
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};

  const M = {};

  /* ================= 常量与物件类型 ================= */

  M.STEP = 24;          // 可自动登上台阶高度(mu)
  M.PH = 56;            // 玩家高
  M.EYE = 48;           // 眼高
  M.PR = 16;            // 玩家半径

  M.THING_TYPES = {
    player1: { name: '玩家出生点', color: '#7ed08c', r: 16, h: 56, kind: 'start' },
    stalker: { name: '追猎者', color: '#fda64d', r: 15, h: 60, kind: 'enemy', eye: '#ffe14d' },
    wasp:    { name: '蜂群',   color: '#ffe14d', r: 13, h: 36, kind: 'enemy', eye: '#ffffff' },
    sentry:  { name: '哨兵',   color: '#ff8c1a', r: 16, h: 64, kind: 'enemy', eye: '#ff5050' },
    brute:   { name: '巨像',   color: '#e94444', r: 26, h: 90, kind: 'enemy', eye: '#ffe14d' },
    vial:    { name: '药瓶 +10',  color: '#7ed08c', r: 12, h: 22, kind: 'item' },
    medkit:  { name: '医疗包 +25', color: '#4fc466', r: 14, h: 26, kind: 'item' },
    armor:   { name: '护甲 +50',  color: '#7ec8e3', r: 14, h: 26, kind: 'item' },
    ammo:    { name: '弹药箱',    color: '#d9c06a', r: 13, h: 24, kind: 'item' },
    barrel:  { name: '油桶(障碍)', color: '#b0693a', r: 16, h: 44, kind: 'block' },
  };

  M.defaultSector = function () {
    return { floorH: 0, ceilH: 160, light: 192, floorC: '#6b675e', ceilC: '#3c3a36',
             wallC: '#8a8578', sky: false };
  };

  M.newMapData = function (name) {
    return {
      format: 'aether-fpsmap', version: 1, name: name || '未命名地图',
      vertices: [], linedefs: [], sectors: [], things: [],
      meta: { fog: '#0a0c14', fogD: 2600 },
    };
  };

  /* ================= 几何工具(map 显式传参)================= */

  M.V = (map, i) => map.vertices[i];

  M.findVertexAt = function (map, x, z) {
    for (let i = 0; i < map.vertices.length; i++)
      if (Math.abs(map.vertices[i].x - x) < 0.01 && Math.abs(map.vertices[i].z - z) < 0.01) return i;
    return -1;
  };
  M.addVertex = function (map, x, z) {
    const ex = M.findVertexAt(map, x, z);
    if (ex >= 0) return ex;
    map.vertices.push({ x, z });
    return map.vertices.length - 1;
  };
  M.lineBetween = function (map, a, b) {
    for (let i = 0; i < map.linedefs.length; i++) {
      const l = map.linedefs[i];
      if ((l.v1 === a && l.v2 === b) || (l.v1 === b && l.v2 === a)) return i;
    }
    return -1;
  };
  M.sectorEdges = function (map, si) {
    const out = [];
    for (let i = 0; i < map.linedefs.length; i++)
      if (map.linedefs[i].front === si || map.linedefs[i].back === si) out.push(i);
    return out;
  };
  /* 偶奇规则(支持带洞的多环边界,与顶点方向无关) */
  M.sectorContains = function (map, si, x, z) {
    let inside = false;
    for (const li of M.sectorEdges(map, si)) {
      const l = map.linedefs[li], a = M.V(map, l.v1), b = M.V(map, l.v2);
      if ((a.z > z) !== (b.z > z)) {
        const xin = a.x + (z - a.z) / (b.z - a.z) * (b.x - a.x);
        if (x < xin) inside = !inside;
      }
    }
    return inside;
  };
  M.sectorAt = function (map, x, z) {
    for (let i = 0; i < map.sectors.length; i++) if (M.sectorContains(map, i, x, z)) return i;
    return -1;
  };
  /* 由边集拼闭合环(用于填充/质心);不闭合返回 null */
  M.sectorLoops = function (map, si) {
    const edges = M.sectorEdges(map, si).map(li => ({ ...map.linedefs[li], li }));
    const adj = new Map();
    for (const e of edges) {
      if (!adj.has(e.v1)) adj.set(e.v1, []);
      if (!adj.has(e.v2)) adj.set(e.v2, []);
      adj.get(e.v1).push(e); adj.get(e.v2).push(e);
    }
    const loops = [];
    const used = new Set();
    for (const e0 of edges) {
      if (used.has(e0.li)) continue;
      let cur = e0.v2, prev = e0.v1;
      const loop = [e0.v1];
      used.add(e0.li);
      for (;;) {
        loop.push(cur);
        if (cur === e0.v1) { loops.push(loop); break; }
        const opts = (adj.get(cur) || []).filter(e => !used.has(e.li) &&
          e.v1 !== prev && e.v2 !== prev);
        if (!opts.length) {                    // 度数断链:边界不闭合
          const back = (adj.get(cur) || []).filter(e => !used.has(e.li));
          if (!back.length) return null;
          opts.push(back[0]);
        }
        const e = opts[0];
        used.add(e.li);
        prev = cur;
        cur = e.v1 === cur ? e.v2 : e.v1;
        if (loop.length > edges.length + 2) return null;
      }
    }
    return loops;
  };
  M.sectorCentroid = function (map, si) {
    const loops = M.sectorLoops(map, si);
    if (!loops || !loops.length) return null;
    let sx = 0, sz = 0, n = 0;
    for (const v of loops[0]) { sx += M.V(map, v).x; sz += M.V(map, v).z; n++; }
    return { x: sx / n, z: sz / n };
  };
  M.distToSeg = function (px, pz, a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    if (l2 < 1e-9) return Math.hypot(px - a.x, pz - a.z);
    let t = ((px - a.x) * dx + (pz - a.z) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (a.x + t * dx), pz - (a.z + t * dz));
  };
  M.segClosest = function (px, pz, a, b) {
    const dx = b.x - a.x, dz = b.z - a.z;
    const l2 = dx * dx + dz * dz;
    let t = l2 < 1e-9 ? 0 : ((px - a.x) * dx + (pz - a.z) * dz) / l2;
    t = Math.max(0, Math.min(1, t));
    return { x: a.x + t * dx, z: a.z + t * dz };
  };

  M.rectPath = function (map, x0, z0, x1, z1) {
    return [M.addVertex(map, x0, z0), M.addVertex(map, x1, z0),
            M.addVertex(map, x1, z1), M.addVertex(map, x0, z1)];
  };

  /* 线段真相交(A→B 与 C→D),返回交点与参数 */
  M.segX = function (A, B, C, D) {
    const r1x = B.x - A.x, r1z = B.z - A.z, r2x = D.x - C.x, r2z = D.z - C.z;
    const den = r1x * r2z - r1z * r2x;
    if (Math.abs(den) < 1e-9) return null;
    const t = ((C.x - A.x) * r2z - (C.z - A.z) * r2x) / den;
    const u = ((C.x - A.x) * r1z - (C.z - A.z) * r1x) / den;
    if (t <= 0.001 || t >= 0.999 || u <= 0.001 || u >= 0.999) return null;
    return { x: A.x + t * r1x, z: A.z + t * r1z };
  };

  M.splitLine = function (map, li, pos) {
    const l = map.linedefs[li];
    const nv = M.addVertex(map, pos.x, pos.z);
    if (nv === l.v1 || nv === l.v2) return nv;
    map.linedefs.push({ v1: nv, v2: l.v2, front: l.front, back: l.back });
    l.v2 = nv;
    return nv;
  };

  /* 点在 v1→v2 的右侧(前侧)则 'front' */
  M.sideOfLine = function (map, l, p) {
    const a = M.V(map, l.v1), b = M.V(map, l.v2);
    return (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x) > 0 ? 'front' : 'back';
  };
  /* 任意线集合上的偶奇包含(去重) */
  M.parityOver = function (map, lines, x, z) {
    let inside = false;
    const seen = new Set();
    for (const l of lines) {
      if (seen.has(l)) continue;
      seen.add(l);
      const a = M.V(map, l.v1), b = M.V(map, l.v2);
      if ((a.z > z) !== (b.z > z)) {
        const xin = a.x + (z - a.z) / (b.z - a.z) * (b.x - a.x);
        if (x < xin) inside = !inside;
      }
    }
    return inside;
  };

  /* 通用:用顶点路径创建扇区并自动缝合相邻扇区。
     - 与已有线十字相交 / T 接时双方自动切分,保证边界干净铺砌;
     - 双侧都被占用时按新多边形质心方向从旧占有者"切割"出让;
     - 完全落进新扇区内部的旧线(被吞没)删除;
     - 空侧归属用"带上新边界的偶奇探针"统一判定(避免顺序赋值造成奇偶泄漏)。
     失败时返回 -1 并写 M.lastError。 */
  M.createSectorFromPath = function (map, vpath, props) {
    M.lastError = '';
    if (vpath.length < 3) { M.lastError = '至少 3 个顶点才能成区'; return -1; }
    const sec = map.sectors.length;
    map.sectors.push(Object.assign(M.defaultSector(), props || {}));
    let cx = 0, cz = 0;
    for (const vi of vpath) { cx += M.V(map, vi).x; cz += M.V(map, vi).z; }
    const C = { x: cx / vpath.length, z: cz / vpath.length };
    const touched = [];                        // {l, side, prev}
    const claim = (u, v) => {
      const li = M.lineBetween(map, u, v);
      if (li < 0) {
        const l = { v1: u, v2: v, front: sec, back: -1 };
        map.linedefs.push(l);
        touched.push({ l, side: null, prev: null });
        return;
      }
      const l = map.linedefs[li];
      if (l.front === sec || l.back === sec) return;      // 已是自己的边
      let side;
      if (l.front < 0) side = 'front';
      else if (l.back < 0) side = 'back';
      else side = M.sideOfLine(map, l, C);                // 双侧占用:质心侧切割
      touched.push({ l, side, prev: l[side] });
      l[side] = sec;
    };
    for (let i = 0; i < vpath.length; i++) {
      let a = vpath[i], b = vpath[(i + 1) % vpath.length];
      // 1) 与已有线十字相交 → 已有线在交点切开,本边截为两段
      for (let round = 0; round < 8; round++) {
        let cut = false;
        for (let li = 0; li < map.linedefs.length; li++) {
          const l = map.linedefs[li];
          const p = M.segX(M.V(map, a), M.V(map, b), M.V(map, l.v1), M.V(map, l.v2));
          if (!p) continue;
          const nn = M.splitLine(map, li, p);
          if (nn < 0 || nn === a) break;
          map.linedefs.push({ v1: a, v2: nn, front: sec, back: -1 });
          touched.push({ l: map.linedefs[map.linedefs.length - 1], side: null, prev: null });
          a = nn;
          cut = true;
          break;
        }
        if (!cut) break;
      }
      if (a === b) continue;
      // 2) 已有顶点落在边内(T 接)→ 本边在该顶点处分段
      const A = M.V(map, a), B = M.V(map, b);
      const mids = [];
      for (let vi = 0; vi < map.vertices.length; vi++) {
        if (vi === a || vi === b) continue;
        const p = M.V(map, vi);
        const cp = M.segClosest(p.x, p.z, A, B);
        if (Math.hypot(p.x - cp.x, p.z - cp.z) < 0.05 &&
            Math.hypot(cp.x - A.x, cp.z - A.z) > 0.05 && Math.hypot(cp.x - B.x, cp.z - B.z) > 0.05)
          mids.push({ vi, t: (cp.x - A.x) * (B.x - A.x) + (cp.z - A.z) * (B.z - A.z) });
      }
      mids.sort((p, q) => p.t - q.t);
      // 3) 路径端点落在已有线内 → 切开那条线
      for (const endv of [a, b]) {
        const E = M.V(map, endv);
        for (let li = 0; li < map.linedefs.length; li++) {
          const l = map.linedefs[li];
          const cp = M.segClosest(E.x, E.z, M.V(map, l.v1), M.V(map, l.v2));
          if (Math.hypot(E.x - cp.x, E.z - cp.z) < 0.05 &&
              Math.hypot(cp.x - M.V(map, l.v1).x, cp.z - M.V(map, l.v1).z) > 0.05 &&
              Math.hypot(cp.x - M.V(map, l.v2).x, cp.z - M.V(map, l.v2).z) > 0.05)
            M.splitLine(map, li, E);
        }
      }
      // 4) 逐段认领
      const chain = [a, ...mids.map(m => m.vi), b];
      for (let k = 0; k + 1 < chain.length; k++)
        claim(chain[k], chain[k + 1]);
    }
    // 5) 吞没线删除:完全落进新扇区内部的旧线
    const limboSet = new Set(touched.map(t => t.l));
    for (let li = map.linedefs.length - 1; li >= 0; li--) {
      const l = map.linedefs[li];
      if (limboSet.has(l)) continue;
      const a = M.V(map, l.v1), b = M.V(map, l.v2);
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      if (!M.parityOver(map, limboSet, mx, mz)) continue;
      let near = false;
      for (const tl of limboSet)
        if (M.distToSeg(mx, mz, M.V(map, tl.v1), M.V(map, tl.v2)) < 1.0) { near = true; break; }
      if (!near) map.linedefs.splice(li, 1);
    }
    // 6) 空侧缝合:统一带新边界探测邻居
    const jobs = [];
    for (const t of touched) {
      const l = t.l;
      const emptySide = l.front < 0 ? 'front' : l.back < 0 ? 'back' : null;
      if (!emptySide) continue;
      const a = M.V(map, l.v1), b = M.V(map, l.v2);
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;   // 前侧(右)法向
      const sideSign = emptySide === 'front' ? 1 : -1;
      jobs.push({ l, emptySide, x: mx + nx * sideSign * 3, z: mz + nz * sideSign * 3 });
    }
    for (const job of jobs) {
      let nb = -1;
      for (let i = 0; i < map.sectors.length; i++) {
        if (i === sec) continue;
        const set = new Set(M.sectorEdges(map, i).map(li => map.linedefs[li]));
        for (const l of limboSet) set.add(l);
        if (M.parityOver(map, set, job.x, job.z)) { nb = i; break; }
      }
      if (nb >= 0) job.l[job.emptySide] = nb;
    }
    return sec;
  };

  /* ================= 校验(编辑器与测试共用)================= */

  M.validate = function (map) {
    const errs = [], warns = [];
    let starts = 0;
    for (const t of map.things) if (t.type === 'player1') starts++;
    if (!starts) errs.push('缺少玩家出生点(player1)');
    if (starts > 1) errs.push(`玩家出生点有 ${starts} 个(应恰好 1 个)`);
    for (let i = 0; i < map.linedefs.length; i++) {
      const l = map.linedefs[i];
      if (l.front < 0 && l.back < 0) errs.push(`线 ${i}:两侧都没有扇区`);
      else if (l.front < 0) errs.push(`线 ${i}:只有背面扇区(选中按 F 翻转)`);
    }
    for (let i = 0; i < map.sectors.length; i++) {
      const s = map.sectors[i];
      if (M.sectorEdges(map, i).length < 3) errs.push(`扇区 ${i}:边少于 3 条`);
      if (!M.sectorLoops(map, i)) errs.push(`扇区 ${i}:边界不闭合(顶点度数断链)`);
      if (s.ceilH - s.floorH < 24) errs.push(`扇区 ${i}:天花 ${s.ceilH} - 地板 ${s.floorH} < 24,太矮`);
    }
    // 重叠检测:每条线的每一侧向内探 1.5,该点必须只属于本侧扇区
    for (let li = 0; li < map.linedefs.length; li++) {
      const l = map.linedefs[li];
      const a = M.V(map, l.v1), b = M.V(map, l.v2);
      const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
      const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      for (const [side, si] of [['front', l.front], ['back', l.back]]) {
        if (si < 0) continue;
        const px = mx + nx * (side === 'front' ? 1.5 : -1.5);
        const pz = mz + nz * (side === 'front' ? 1.5 : -1.5);
        for (let j = 0; j < map.sectors.length; j++) {
          if (j === si) continue;
          if (M.sectorContains(map, j, px, pz)) {
            errs.push(`扇区 ${si} 与 ${j} 重叠(线 ${li} 附近)`);
            li = map.linedefs.length;
            break;
          }
        }
      }
    }
    for (let i = 0; i < map.things.length; i++) {
      const t = map.things[i];
      if (M.sectorAt(map, t.x, t.z) < 0) errs.push(`物件 ${i}(${M.THING_TYPES[t.type].name})不在任何扇区内`);
    }
    // 可达性(出生点出发,双面线且 ≤ 台阶高、净高足够才通)
    const start = map.things.find(t => t.type === 'player1');
    if (start) {
      const reach = new Set();
      const s0 = M.sectorAt(map, start.x, start.z);
      if (s0 < 0) errs.push('玩家出生点不在扇区内');
      else {
        const q = [s0];
        reach.add(s0);
        while (q.length) {
          const si = q.pop();
          const s = map.sectors[si];
          for (const li of M.sectorEdges(map, si)) {
            const l = map.linedefs[li];
            const o = l.front === si ? l.back : l.front;
            if (o < 0 || reach.has(o)) continue;
            const os = map.sectors[o];
            if (os.floorH - s.floorH > M.STEP) continue;
            if (Math.min(s.ceilH, os.ceilH) - Math.max(s.floorH, os.floorH) < M.PH) continue;
            reach.add(o);
            q.push(o);
          }
        }
        if (reach.size < map.sectors.length) {
          const miss = [];
          for (let i = 0; i < map.sectors.length; i++) if (!reach.has(i)) miss.push(i);
          warns.push('从出生点走不到的扇区:' + miss.join(', '));
        }
      }
    }
    if (!map.things.some(t => M.THING_TYPES[t.type].kind === 'enemy'))
      warns.push('地图里没有敌人');
    const used = new Set();
    for (const l of map.linedefs) { used.add(l.v1); used.add(l.v2); }
    if (used.size < map.vertices.length)
      warns.push(`有 ${map.vertices.length - used.size} 个孤立顶点(删除线后残留,不影响运行)`);
    return { errs, warns };
  };

  AC2.FPSMap = M;
})();
