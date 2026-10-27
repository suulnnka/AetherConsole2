/*
 * js/tools/fpsedit.js — 3D FPS 地图编辑器(AC2 版,自 AC1 tools/fps-editor.js 搬运)
 * 2D 视图:平移缩放、网格吸附、画多边形自动建区并自动与邻区缝合(几何核心在 fpsmap-core.js)。
 * 3D 预览:软件渲染门户列光线投射 + 地板/天花投影 + 深度缓冲精灵,
 *          第一人称漫游(指针锁定鼠标视角 / 重力 / 台阶 / 飞行),无三方库。
 * 数据格式 aether-fpsmap v1 与 AC1 编辑器互通。
 */
(function () {
  'use strict';

  const FM = AC2.FPSMap;
  const THING_TYPES = FM.THING_TYPES;
  const STEP = FM.STEP, PH = FM.PH, EYE = FM.EYE, PR = FM.PR;

  /* ================= 全局状态 ================= */

  let map = FM.newMapData();
  let sel = null;                 // {kind:'vertex'|'line'|'sector'|'thing', i}
  let mode = 'select';
  let thingType = 'stalker';
  let path = [];                  // 画区模式的顶点路径
  const cam = { x: 0, y: 0, scale: 0.3 };
  const DRAFT_KEY = 'ac2fpsedit_draft_v1';

  const undoStack = [], redoStack = [];
  function pushUndo() {
    const s = JSON.stringify(map);
    if (undoStack[undoStack.length - 1] === s) return;
    undoStack.push(s);
    if (undoStack.length > 120) undoStack.shift();
    redoStack.length = 0;
  }
  function doUndo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(map));
    map = JSON.parse(undoStack.pop());
    sel = fixSel(sel);
    changed();
  }
  function doRedo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(map));
    map = JSON.parse(redoStack.pop());
    sel = fixSel(sel);
    changed();
  }
  function fixSel(s) {
    if (!s) return s;
    const n = { vertex: 'vertices', line: 'linedefs', sector: 'sectors', thing: 'things' }[s.kind];
    return s.i < map[n].length ? s : null;
  }

  let draftTimer = 0;
  function changed() {
    window.__FPSMAP = map;                    // 调试钩子(控制台可见)
    window.__FPSCAM = cam;                    // __FPSEDIT(带 getter)在 init 里定义,这里不覆盖
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => AC.draft.save(DRAFT_KEY, map), 300);
    render2d();
    renderProps();
    renderPal();
    updateCounts();
  }

  /* ================= 几何工具(委托 fpsmap-core;map 为页面级 let,重绑安全)================= */

  const V = i => map.vertices[i];
  const findVertexAt = (x, z) => FM.findVertexAt(map, x, z);
  const addVertex = (x, z) => FM.addVertex(map, x, z);
  const lineBetween = (a, b) => FM.lineBetween(map, a, b);
  const sectorEdges = si => FM.sectorEdges(map, si);
  const sectorContains = (si, x, z) => FM.sectorContains(map, si, x, z);
  const sectorAt = (x, z) => FM.sectorAt(map, x, z);
  const sectorLoops = si => FM.sectorLoops(map, si);
  const sectorCentroid = si => FM.sectorCentroid(map, si);
  const distToSeg = (px, pz, a, b) => FM.distToSeg(px, pz, a, b);
  const segClosest = (px, pz, a, b) => FM.segClosest(px, pz, a, b);
  const segX = (A, B, C, D) => FM.segX(A, B, C, D);
  const splitLine = (li, pos) => FM.splitLine(map, li, pos);
  const sideOfLine = (l, p) => FM.sideOfLine(map, l, p);
  const parityOver = (lines, x, z) => FM.parityOver(map, lines, x, z);
  const rectPath = (x0, z0, x1, z1) => FM.rectPath(map, x0, z0, x1, z1);
  function createSectorFromPath(vpath, props) {
    const si = FM.createSectorFromPath(map, vpath, props);
    if (si < 0) AC.toast(FM.lastError || '无法创建扇区', true);
    return si;
  }

  /* ================= 示例 / 新建 ================= */

  function buildExample() {
    map = FM.newMapData('示例:堡垒广场');
    const sec = (p, props) => createSectorFromPath(rectPath(p[0], p[1], p[2], p[3]), props);
    sec([-384, -384, 384, 384], { floorH: -16, ceilH: 224, light: 216, sky: true,
      floorC: '#6e6a5e', wallC: '#8d897b', ceilC: '#10131f' });            // 外院
    sec([-256, -256, 256, 256], { floorH: 0, ceilH: 168, light: 176,
      floorC: '#7b6f5c', wallC: '#a08d6f', ceilC: '#46423c' });            // 大厅
    sec([-96, -96, 96, 96], { floorH: 24, ceilH: 168, light: 196,
      floorC: '#96825f', wallC: '#b09a6e', ceilC: '#46423c' });            // 中央高台
    sec([208, -32, 240, 32], { floorH: 8, ceilH: 224, light: 210, sky: true,
      floorC: '#6a675c', wallC: '#83807a', ceilC: '#10131f' });            // 台阶 1
    sec([240, -32, 272, 32], { floorH: 32, ceilH: 224, light: 210, sky: true,
      floorC: '#6a675c', wallC: '#83807a', ceilC: '#10131f' });            // 台阶 2
    sec([272, -80, 368, 80], { floorH: 40, ceilH: 224, light: 208, sky: true,
      floorC: '#5f6e5a', wallC: '#7d8a76', ceilC: '#10131f' });            // 东侧高台
    sec([-368, -368, -272, -208], { floorH: 0, ceilH: 112, light: 132,
      floorC: '#6d5c4e', wallC: '#8a7660', ceilC: '#3a352e' });            // 西北暗室
    const th = (t, x, z, a) => map.things.push({ type: t, x, z, angle: a || 0 });
    th('player1', 0, -160, 0);
    th('stalker', 80, 80); th('stalker', -120, -40);
    th('wasp', -220, 300); th('wasp', 320, -160);
    th('sentry', 320, 0, 180); th('brute', -320, -288, 90);
    th('armor', 0, 0); th('medkit', -210, 160); th('vial', 200, 180);
    th('ammo', -60, 160); th('barrel', 150, 250); th('barrel', 176, 250);
    fitView();
  }

  function buildEmpty() {
    map = FM.newMapData('未命名地图');
    createSectorFromPath(rectPath(-256, -256, 256, 256),
      { floorH: 0, ceilH: 176, light: 192 });
    map.things.push({ type: 'player1', x: 0, z: 0, angle: 0 });
    fitView();
  }

  /* ================= 2D 视图 ================= */

  const cv = document.getElementById('viewCv');
  const ctx = cv.getContext('2d');

  function resize() {
    const r = cv.parentElement.getBoundingClientRect();
    if (cv.width !== r.width | 0 || cv.height !== r.height | 0) {
      cv.width = r.width; cv.height = r.height;
    }
    render2d();
  }
  new ResizeObserver(resize).observe(document.getElementById('view'));

  const s2wx = sx => cam.x + (sx - cv.width / 2) / cam.scale;
  const s2wz = sy => cam.y + (sy - cv.height / 2) / cam.scale;

  function fitView() {
    if (!map.vertices.length) { cam.x = 0; cam.y = 0; cam.scale = 0.3; return; }
    let x0 = 1e9, x1 = -1e9, z0 = 1e9, z1 = -1e9;
    for (const v of map.vertices) {
      x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x);
      z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z);
    }
    cam.x = (x0 + x1) / 2; cam.y = (z0 + z1) / 2;
    cam.scale = Math.max(0.02, Math.min(1.2, Math.min(cv.width / (x1 - x0 + 200),
      cv.height / (z1 - z0 + 200))));
  }

  function shade(hex, f) {
    const m = /^#(..)(..)(..)/.exec(hex);
    const c = m.slice(1).map(h => Math.min(255, Math.round(parseInt(h, 16) * f)));
    return 'rgb(' + c.join(',') + ')';
  }

  function render2d() {
    const w = cv.width, h = cv.height;
    ctx.fillStyle = '#0b0b0e';
    ctx.fillRect(0, 0, w, h);
    const snap = +document.getElementById('snapSel').value || 32;
    // 网格
    const step = cam.scale < 0.08 ? 256 : cam.scale < 0.2 ? 64 : snap;
    drawGrid(step, 'rgba(255,255,255,.05)');
    drawGrid(step * 8, 'rgba(255,255,255,.10)');
    // 原点十字
    ctx.strokeStyle = 'rgba(126,200,227,.25)';
    ctx.beginPath();
    ctx.moveTo(w / 2 - cam.x * cam.scale, 0); ctx.lineTo(w / 2 - cam.x * cam.scale, h);
    ctx.moveTo(0, h / 2 - cam.y * cam.scale); ctx.lineTo(w, h / 2 - cam.y * cam.scale);
    ctx.stroke();
    // 扇区填充
    for (let si = 0; si < map.sectors.length; si++) {
      const loops = sectorLoops(si);
      if (!loops) continue;
      const s = map.sectors[si];
      const f = Math.max(0.45, Math.min(1.5, 1 + s.floorH / 400));
      ctx.fillStyle = shade(s.floorC, f);
      ctx.globalAlpha = si === (sel && sel.kind === 'sector' ? sel.i : -1) ? 0.55 : 0.30;
      ctx.beginPath();
      for (const loop of loops) {
        ctx.moveTo((V(loop[0]).x - cam.x) * cam.scale + w / 2,
                   (V(loop[0]).z - cam.y) * cam.scale + h / 2);
        for (let i = 1; i < loop.length; i++)
          ctx.lineTo((V(loop[i]).x - cam.x) * cam.scale + w / 2,
                     (V(loop[i]).z - cam.y) * cam.scale + h / 2);
        ctx.closePath();
      }
      ctx.fill('evenodd');
      ctx.globalAlpha = 1;
      if (sel && sel.kind === 'sector' && sel.i === si) {
        ctx.strokeStyle = '#e0c26c'; ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
    // 线
    for (let li = 0; li < map.linedefs.length; li++) {
      const l = map.linedefs[li];
      const a = V(l.v1), b = V(l.v2);
      const on = sel && sel.kind === 'line' && sel.i === li;
      ctx.strokeStyle = on ? '#ffffff'
        : l.front < 0 ? '#e06c6c'
        : l.back >= 0 ? '#7ec8e3' : '#e0c26c';
      ctx.lineWidth = on ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.moveTo((a.x - cam.x) * cam.scale + w / 2, (a.z - cam.y) * cam.scale + h / 2);
      ctx.lineTo((b.x - cam.x) * cam.scale + w / 2, (b.z - cam.y) * cam.scale + h / 2);
      ctx.stroke();
      if (on) {       // 前侧方向记号(Doom 惯例:短线指向 v1→v2 右侧)
        const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
        const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
        const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
        ctx.beginPath();
        ctx.moveTo((mx - cam.x) * cam.scale + w / 2, (mz - cam.y) * cam.scale + h / 2);
        ctx.lineTo((mx + nx * 12 - cam.x) * cam.scale + w / 2,
                   (mz + nz * 12 - cam.y) * cam.scale + h / 2);
        ctx.stroke();
      }
    }
    ctx.lineWidth = 1;
    // 画区路径预览
    if (mode === 'draw' && path.length) {
      ctx.strokeStyle = '#7ed08c';
      ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo((V(path[0]).x - cam.x) * cam.scale + w / 2,
                 (V(path[0]).z - cam.y) * cam.scale + h / 2);
      for (let i = 1; i < path.length; i++)
        ctx.lineTo((V(path[i]).x - cam.x) * cam.scale + w / 2,
                   (V(path[i]).z - cam.y) * cam.scale + h / 2);
      if (mouseW) ctx.lineTo(mouseW.x * cam.scale + w / 2, mouseW.z * cam.scale + h / 2);
      ctx.stroke();
      ctx.setLineDash([]);
      const p0 = V(path[0]);
      ctx.strokeStyle = '#7ed08c';
      ctx.beginPath();
      ctx.arc((p0.x - cam.x) * cam.scale + w / 2, (p0.z - cam.y) * cam.scale + h / 2, 7, 0, 7);
      ctx.stroke();
    }
    // 顶点
    for (let vi = 0; vi < map.vertices.length; vi++) {
      const v = V(vi);
      const sx = (v.x - cam.x) * cam.scale + w / 2, sy = (v.z - cam.y) * cam.scale + h / 2;
      const on = sel && sel.kind === 'vertex' && sel.i === vi;
      ctx.fillStyle = on ? '#e0c26c' : '#c9cdd6';
      const sz = on ? 5 : 3;
      ctx.fillRect(sx - sz / 2, sy - sz / 2, sz, sz);
    }
    // 物件
    for (let ti = 0; ti < map.things.length; ti++) {
      const t = map.things[ti];
      const T = THING_TYPES[t.type] || THING_TYPES.stalker;
      const sx = (t.x - cam.x) * cam.scale + w / 2, sy = (t.z - cam.y) * cam.scale + h / 2;
      const r = Math.max(4, T.r * cam.scale);
      ctx.fillStyle = T.color;
      ctx.beginPath(); ctx.arc(sx, sy, r, 0, 7); ctx.fill();
      const rad = (t.angle || 0) * Math.PI / 180;
      ctx.strokeStyle = 'rgba(0,0,0,.8)';
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + Math.cos(rad) * r * 1.8, sy + Math.sin(rad) * r * 1.8);
      ctx.stroke();
      if (sel && sel.kind === 'thing' && sel.i === ti) {
        ctx.strokeStyle = '#e0c26c'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(sx, sy, r + 4, 0, 7); ctx.stroke();
        ctx.lineWidth = 1;
      }
      if (t.type === 'player1') {
        ctx.fillStyle = '#7ed08c';
        ctx.font = '10px ui-monospace,monospace';
        ctx.fillText('P', sx + r + 3, sy + 3);
      }
    }
  }

  function drawGrid(step, color) {
    if (!step) return;
    const w = cv.width, h = cv.height;
    const x0 = Math.floor(s2wx(0) / step) * step, x1 = s2wx(w);
    const z0 = Math.floor(s2wz(0) / step) * step, z1 = s2wz(h);
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let x = x0; x <= x1; x += step) {
      const sx = (x - cam.x) * cam.scale + w / 2;
      ctx.moveTo(sx, 0); ctx.lineTo(sx, h);
    }
    for (let z = z0; z <= z1; z += step) {
      const sy = (z - cam.y) * cam.scale + h / 2;
      ctx.moveTo(0, sy); ctx.lineTo(w, sy);
    }
    ctx.stroke();
  }

  /* ================= 命中测试 ================= */

  function pickVertex(wx, wz) {
    const thr = 7 / cam.scale;
    let best = -1, bd = thr;
    for (let i = 0; i < map.vertices.length; i++) {
      const d = Math.hypot(V(i).x - wx, V(i).z - wz);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function pickThing(wx, wz) {
    let best = -1, bd = 1e9;
    for (let i = map.things.length - 1; i >= 0; i--) {
      const t = map.things[i];
      const T = THING_TYPES[t.type] || THING_TYPES.stalker;
      const d = Math.hypot(t.x - wx, t.z - wz) - T.r;
      if (d < 8 / cam.scale && d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function pickLine(wx, wz) {
    const thr = 5 / cam.scale;
    let best = -1, bd = thr;
    for (let i = 0; i < map.linedefs.length; i++) {
      const l = map.linedefs[i];
      const d = distToSeg(wx, wz, V(l.v1), V(l.v2));
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  function snapPos(wx, wz) {
    const s = +document.getElementById('snapSel').value;
    const vi = pickVertex(wx, wz);
    if (vi >= 0) return { x: V(vi).x, z: V(vi).z, vi };
    const li = pickLine(wx, wz);
    if (li >= 0) {                             // 吸附到线上:投影 + 网格化
      const l = map.linedefs[li];
      const p = segClosest(wx, wz, V(l.v1), V(l.v2));
      const q = s ? { x: Math.round(p.x / s) * s, z: Math.round(p.z / s) * s } : p;
      if (distToSeg(q.x, q.z, V(l.v1), V(l.v2)) < 1.5)
        return { x: q.x, z: q.z, li };
      return { x: p.x, z: p.z, li };
    }
    if (s) return { x: Math.round(wx / s) * s, z: Math.round(wz / s) * s };
    return { x: wx, z: wz };
  }

  /* ================= 交互 ================= */

  let mouseW = null;
  let panning = null;
  let dragging = null;        // {kind,i,offX,offZ,moved}
  let sectorDrag = null;      // {startY, floor0, ceil0, shift}

  const hintOf = {
    select: '单击选择(顶点 > 物件 > 线 > 扇区)· 拖动顶点/物件 · 选中扇区后上下拖 = 调地板高(Shift=天花)· Del 删除 · F 翻转选中线',
    draw: '单击落点(自动吸附顶点/线/网格)· 点击起点或 Enter 闭合建区 · Backspace 退点 · Esc 取消',
    vertex: '拖动顶点(网格吸附)· 双击线在该处插入顶点 · Del 删除顶点(连带其线)',
    thing: '单击空地放置当前物件 · 拖动移动 · Shift+拖动 = 转向 · Del 删除',
  };
  function setMode(m) {
    mode = m;
    path = [];
    for (const b of document.querySelectorAll('#modes .btn'))
      b.classList.toggle('active', b.dataset.mode === m);
    document.getElementById('stHint').textContent = hintOf[m];
    document.getElementById('helpBox').innerHTML = helpHTML[m];
    render2d();
  }
  const helpHTML = {
    select: '<b>选择模式</b>:点选顶点 / 物件 / 线 / 扇区后,右侧改属性。选中扇区在图内上下拖动可直调地板高度(按住 Shift 调天花)。Ctrl+右键 = 从该处进入 3D 预览。',
    draw: '<b>画区模式</b>:像 DoomBuilder 一样勾多边形轮廓,闭合即建扇区,边线自动与邻区缝合成双面门户。沿已有墙画可自然 T 接。',
    vertex: '<b>顶点模式</b>:拖动顶点微调轮廓;双击某条线可在落点处插入顶点把它一分为二。',
    thing: '<b>物件模式</b>:左列表选类型,地图上单击放置;出生点必须恰好一个。',
  };

  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('pointerdown', e => {
    try { cv.setPointerCapture(e.pointerId); } catch (err) {}
    const wx = s2wx(e.offsetX), wz = s2wz(e.offsetY);
    if (e.button === 2 || e.button === 1) {
      if (e.ctrlKey && e.button === 2) { open3D({ x: wx, z: wz }); return; }
      panning = { sx: e.offsetX, sy: e.offsetY, cx: cam.x, cy: cam.y };
      return;
    }
    if (mode === 'draw') { drawClick(wx, wz); return; }
    if (mode === 'thing') {
      const ti = pickThing(wx, wz);
      if (ti >= 0) {
        sel = { kind: 'thing', i: ti };
        pushUndo();
        dragging = { kind: 'thing', i: ti, moved: false };
      } else {
        pushUndo();
        const p = snapPos(wx, wz);
        map.things.push({ type: thingType, x: p.x, z: p.z, angle: 0 });
        sel = { kind: 'thing', i: map.things.length - 1 };
      }
      changed();
      return;
    }
    // 选择 / 顶点模式
    const vi = pickVertex(wx, wz);
    if (vi >= 0) {
      sel = { kind: 'vertex', i: vi };
      pushUndo();
      dragging = { kind: 'vertex', i: vi, moved: false };
      changed();
      return;
    }
    const ti = pickThing(wx, wz);
    if (ti >= 0) {
      sel = { kind: 'thing', i: ti };
      pushUndo();
      dragging = { kind: 'thing', i: ti, moved: false };
      changed();
      return;
    }
    const li = pickLine(wx, wz);
    const si = sectorAt(wx, wz);
    if (li >= 0) { sel = { kind: 'line', i: li }; changed(); return; }
    if (sel && sel.kind === 'sector' && sel.i === si) {   // 拖已选扇区调高度
      sectorDrag = { sy: e.offsetY, floor0: map.sectors[si].floorH, ceil0: map.sectors[si].ceilH, shift: e.shiftKey };
      pushUndo();
      return;
    }
    if (si >= 0) { sel = { kind: 'sector', i: si }; changed(); return; }
    sel = null;
    changed();
  });

  cv.addEventListener('pointermove', e => {
    const wx = s2wx(e.offsetX), wz = s2wz(e.offsetY);
    mouseW = { x: wx, z: wz };
    document.getElementById('stPos').textContent =
      `${Math.round(wx)}, ${Math.round(wz)} · 扇区 ${sectorAt(wx, wz)}`;
    if (panning) {
      cam.x = panning.cx - (e.offsetX - panning.sx) / cam.scale;
      cam.y = panning.cy - (e.offsetY - panning.sy) / cam.scale;
      render2d();
      return;
    }
    if (dragging) {
      const p = snapPos(wx, wz);
      if (dragging.kind === 'vertex') {
        const v = map.vertices[dragging.i];
        if (pickVertex(wx, wz) !== dragging.i) { v.x = p.x; v.z = p.z; }
        dragging.moved = true;
      } else {
        const t = map.things[dragging.i];
        if (e.shiftKey) t.angle = Math.round(Math.atan2(wz - t.z, wx - t.x) / Math.PI * 180);
        else { t.x = p.x; t.z = p.z; }
        dragging.moved = true;
      }
      changed();
      return;
    }
    if (sectorDrag) {
      const s = map.sectors[sel.i];
      const d = (e.offsetY - sectorDrag.sy) / cam.scale * 1.5;
      const s0 = +document.getElementById('snapSel').value || 8;
      const val = v => Math.round(v / s0) * s0;
      if (sectorDrag.shift || e.shiftKey) s.ceilH = val(sectorDrag.ceil0 - d);
      else s.floorH = val(sectorDrag.floor0 - d);
      changed();
      return;
    }
    if (mode === 'draw') render2d();
  });

  window.addEventListener('pointerup', () => {
    panning = null;
    dragging = null;
    sectorDrag = null;
  });

  cv.addEventListener('dblclick', e => {
    const wx = s2wx(e.offsetX), wz = s2wz(e.offsetY);
    if (mode === 'vertex' || mode === 'select') {
      const li = pickLine(wx, wz);
      if (li >= 0 && pickVertex(wx, wz) < 0) {
        pushUndo();
        splitLine(li, segClosest(wx, wz, V(map.linedefs[li].v1), V(map.linedefs[li].v2)));
        changed();
      }
    }
  });

  cv.addEventListener('wheel', e => {
    e.preventDefault();
    const wx = s2wx(e.offsetX), wz = s2wz(e.offsetY);
    cam.scale = Math.max(0.02, Math.min(4, cam.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    cam.x = wx - (e.offsetX - cv.width / 2) / cam.scale;
    cam.y = wz - (e.offsetY - cv.height / 2) / cam.scale;
    render2d();
  }, { passive: false });

  function drawClick(wx, wz) {
    const p = snapPos(wx, wz);
    // 点到起点(或路径中已有顶点)→ 闭合
    if (path.length >= 3) {
      const v0 = V(path[0]);
      if (Math.hypot(v0.x - p.x, v0.z - p.z) < 8 / cam.scale) { closePath(); return; }
    }
    let vi;
    if (p.vi != null) {
      vi = p.vi;
      if (path.length >= 3 && vi === path[0]) { closePath(); return; }
      if (path.includes(vi)) { AC.toast('路径不能自交(回到已有中间点)'); return; }
    } else if (p.li != null) {
      vi = splitLine(p.li, p);                 // 在线上落点 = T 接,先切线再用新顶点
    } else {
      vi = addVertex(p.x, p.z);
    }
    path.push(vi);
    render2d();
  }

  function closePath() {
    if (path.length < 3) { AC.toast('至少 3 个顶点', true); return; }
    pushUndo();
    const si = createSectorFromPath(path);
    path = [];
    if (si >= 0) {
      sel = { kind: 'sector', i: si };
      AC.toast('已创建扇区 ' + si + ',右侧可调高度/颜色');
    }
    changed();
  }

  /* ================= 删除 / 键盘 ================= */

  function deleteSelection() {
    if (!sel) return;
    pushUndo();
    if (sel.kind === 'thing') map.things.splice(sel.i, 1);
    else if (sel.kind === 'vertex') {
      const vi = sel.i;
      for (let i = map.linedefs.length - 1; i >= 0; i--) {
        const l = map.linedefs[i];
        if (l.v1 === vi || l.v2 === vi) map.linedefs.splice(i, 1);
      }
      map.vertices.splice(vi, 1);
      for (const l of map.linedefs) {          // 重排顶点下标
        if (l.v1 > vi) l.v1--;
        if (l.v2 > vi) l.v2--;
      }
      cleanOrphans();
    } else if (sel.kind === 'line') {
      map.linedefs.splice(sel.i, 1);
      cleanOrphans();
    } else if (sel.kind === 'sector') {
      const si = sel.i;
      map.sectors.splice(si, 1);
      for (const l of map.linedefs) {
        if (l.front === si) l.front = -1;
        if (l.back === si) l.back = -1;
        if (l.front > si) l.front--;
        if (l.back > si) l.back--;
      }
      for (let i = map.linedefs.length - 1; i >= 0; i--)
        if (map.linedefs[i].front < 0 && map.linedefs[i].back < 0) map.linedefs.splice(i, 1);
      cleanOrphans();
    }
    sel = null;
    changed();
  }
  function cleanOrphans() {                    // 删除不在线上的顶点
    const used = new Set();
    for (const l of map.linedefs) { used.add(l.v1); used.add(l.v2); }
    for (let i = map.vertices.length - 1; i >= 0; i--)
      if (!used.has(i)) {
        map.vertices.splice(i, 1);
        for (const l of map.linedefs) { if (l.v1 > i) l.v1--; if (l.v2 > i) l.v2--; }
        used.clear();
        for (const l of map.linedefs) { used.add(l.v1); used.add(l.v2); }
      }
  }

  window.addEventListener('keydown', e => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? doRedo() : doUndo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
    switch (e.key) {
      case '1': setMode('select'); return;
      case '2': setMode('draw'); return;
      case '3': setMode('vertex'); return;
      case '4': setMode('thing'); return;
      case 'p': case 'P': open3D(); return;
      case 'Escape':
        if (mode === 'draw' && path.length) { path = []; render2d(); }
        else { sel = null; changed(); }
        return;
      case 'Enter': if (mode === 'draw') closePath(); return;
      case 'Backspace':
        if (mode === 'draw' && path.length) { e.preventDefault(); path.pop(); render2d(); }
        return;
      case 'Delete': deleteSelection(); return;
      case 'f': case 'F':
        if (sel && sel.kind === 'line') {
          pushUndo();
          const l = map.linedefs[sel.i];
          const t = l.v1; l.v1 = l.v2; l.v2 = t;
          const s = l.front; l.front = l.back; l.back = s;
          changed();
        }
        return;
      case 'g': case 'G': fitView(); return;
    }
  });

  document.querySelectorAll('#modes .btn').forEach(b =>
    b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.getElementById('btnUndo').addEventListener('click', doUndo);
  document.getElementById('btnRedo').addEventListener('click', doRedo);
  document.getElementById('snapSel').addEventListener('change', render2d);
  document.getElementById('mapName').addEventListener('change', e => {
    map.name = e.target.value.trim() || '未命名地图'; changed();
  });

  /* ================= 属性面板 ================= */

  const propsHost = document.getElementById('props');
  const row = (label, ...kids) => {
    const r = AC.el('div', { class: 'prow' });
    r.append(AC.el('label', {}, label), ...kids);
    return r;
  };
  const num = (get, set, live) => {
    const i = AC.el('input', { type: 'number', value: get() });
    const apply = () => set(parseFloat(i.value) || 0);
    i.addEventListener('change', () => { pushUndo(); apply(); changed(); });
    if (live) i.addEventListener('input', apply);
    return i;
  };

  function renderProps() {
    propsHost.textContent = '';
    const title = document.getElementById('propTitle');
    if (!sel) {
      title.textContent = '地图';
      const fog = AC.el('input', { type: 'color', value: map.meta.fog });
      fog.addEventListener('input', () => { map.meta.fog = fog.value; changed(); });
      propsHost.append(
        row('雾色', fog),
        row('雾距', num(() => map.meta.fogD, v => map.meta.fogD = Math.max(200, v), true)),
        AC.el('div', { class: 'kv' },
          `顶点 ${map.vertices.length} · 线 ${map.linedefs.length} · 扇区 ${map.sectors.length} · 物件 ${map.things.length}`),
        AC.el('div', { class: 'kv', style: 'margin-top:8px;' },
          '选择左图中的元素编辑属性;G 键缩放至全图。'));
      return;
    }
    if (sel.kind === 'vertex') {
      title.textContent = '顶点 ' + sel.i;
      const v = map.vertices[sel.i];
      propsHost.append(
        row('X', num(() => v.x, x => v.x = x, true)),
        row('Z', num(() => v.z, z => v.z = z, true)),
        AC.el('div', { class: 'foot' },
          AC.el('button', { class: 'btn danger', onclick: deleteSelection }, '删除顶点')));
      return;
    }
    if (sel.kind === 'line') {
      title.textContent = '线 ' + sel.i;
      const l = map.linedefs[sel.i];
      propsHost.append(
        AC.el('div', { class: 'kv' },
          `顶点 ${l.v1} → ${l.v2} · 前=扇区${l.front} 后=${l.back}`),
        AC.el('div', { class: 'kv' }, '单面线(只有前侧)= 墙;双面线 = 两个扇区间的过渡。'),
        AC.el('div', { class: 'foot' },
          AC.el('button', { class: 'btn', onclick: () => {
            pushUndo();
            const t = l.v1; l.v1 = l.v2; l.v2 = t;
            const s = l.front; l.front = l.back; l.back = s;
            changed();
          } }, '翻转(F)'),
          AC.el('button', { class: 'btn', onclick: () => {
            pushUndo();
            splitLine(sel.i, { x: (V(l.v1).x + V(l.v2).x) / 2, z: (V(l.v1).z + V(l.v2).z) / 2 });
            changed();
          } }, '中点分割'),
          AC.el('button', { class: 'btn danger', onclick: deleteSelection }, '删除')));
      return;
    }
    if (sel.kind === 'sector') {
      title.textContent = '扇区 ' + sel.i;
      const s = map.sectors[sel.i];
      const edges = sectorEdges(sel.i);
      const loops = sectorLoops(sel.i);
      const col = (key) => {
        const i = AC.el('input', { type: 'color', value: s[key] });
        i.addEventListener('input', () => { s[key] = i.value; changed(); });
        return i;
      };
      const sky = AC.el('input', { type: 'checkbox' });
      sky.checked = !!s.sky;
      sky.addEventListener('change', () => { pushUndo(); s.sky = sky.checked; changed(); });
      propsHost.append(
        AC.el('canvas', { class: 'sectPrev', id: 'sectPrev' }),
        row('地板高', num(() => s.floorH, v => s.floorH = v, true)),
        row('天花高', num(() => s.ceilH, v => s.ceilH = v, true)),
        row('光照', num(() => s.light, v => s.light = Math.max(0, Math.min(255, v)), true)),
        row('地板色', col('floorC')),
        row('天花色', col('ceilC')),
        row('墙面色', col('wallC')),
        row('天空顶', sky),
        AC.el('div', { class: 'kv' }, `边 ${edges.length} · ${loops ? '边界闭合' : '边界不闭合!'}`),
        AC.el('div', { class: 'foot' },
          AC.el('button', { class: 'btn danger', onclick: deleteSelection }, '删除扇区')));
      drawSectPrev();
      return;
    }
    // thing
    title.textContent = '物件';
    const t = map.things[sel.i];
    const T = THING_TYPES[t.type];
    const typeSel = AC.el('select');
    for (const k in THING_TYPES) {
      typeSel.append(AC.el('option', { value: k }, THING_TYPES[k].name));
    }
    typeSel.value = t.type;
    typeSel.addEventListener('change', () => { pushUndo(); t.type = typeSel.value; changed(); });
    propsHost.append(
      row('类型', typeSel),
      row('X', num(() => t.x, v => t.x = v, true)),
      row('Z', num(() => t.z, v => t.z = v, true)),
      row('朝向°', num(() => t.angle, v => t.angle = v, true)),
      AC.el('div', { class: 'foot' },
        AC.el('button', { class: 'btn', onclick: () => { pushUndo(); t.angle = (t.angle + 45) % 360; changed(); } }, '↻ +45°'),
        AC.el('button', { class: 'btn danger', onclick: deleteSelection }, '删除')));
  }

  function drawSectPrev() {    // 扇区高度剖面预览
    const c = document.getElementById('sectPrev');
    if (!c || !sel || sel.kind !== 'sector') return;
    const s = map.sectors[sel.i];
    const g = c.getContext('2d');
    g.fillStyle = '#0b0b0e';
    g.fillRect(0, 0, c.width, c.height);
    const hMin = Math.min(s.floorH, 0) , hMax = Math.max(s.ceilH, 160);
    const yOf = v => c.height - 3 - (v - hMin) / (hMax - hMin || 1) * (c.height - 6);
    g.fillStyle = s.floorC;
    g.fillRect(0, yOf(s.floorH), c.width, c.height - yOf(s.floorH));
    if (!s.sky) { g.fillStyle = s.ceilC; g.fillRect(0, 0, c.width, yOf(s.ceilH)); }
    else { g.fillStyle = '#1a2340'; g.fillRect(0, 0, c.width, yOf(s.ceilH)); }
    g.fillStyle = 'rgba(255,255,255,.75)';
    g.fillRect(0, yOf(s.floorH), c.width, 1);
    if (!s.sky) g.fillRect(0, yOf(s.ceilH), c.width, 1);
  }

  /* ================= 物件面板 ================= */

  function renderPal() {
    const host = document.getElementById('thingPal');
    host.textContent = '';
    const counts = {};
    for (const t of map.things) counts[t.type] = (counts[t.type] || 0) + 1;
    for (const k in THING_TYPES) {
      const T = THING_TYPES[k];
      const it = AC.el('div', { class: 'thingItem' + (k === thingType ? ' sel' : '') },
        AC.el('span', { class: 'dot', style: 'background:' + T.color + ';' }),
        AC.el('span', { class: 'nm' }, T.name),
        AC.el('span', { class: 'ct' }, counts[k] ? '×' + counts[k] : ''));
      it.addEventListener('click', () => {
        thingType = k;
        setMode('thing');
        renderPal();
      });
      host.append(it);
    }
    document.getElementById('thingCount').textContent = map.things.length;
  }
  function updateCounts() {
    document.getElementById('stCounts').textContent =
      `V ${map.vertices.length} · L ${map.linedefs.length} · S ${map.sectors.length} · T ${map.things.length}`;
  }

  /* ================= 校验 ================= */

  function validate() { return FM.validate(map); }

  function showValidate() {
    const { errs, warns } = validate();
    const host = document.getElementById('valList');
    host.textContent = '';
    if (!errs.length && !warns.length)
      host.append(AC.el('div', { class: 'ok' }, '✔ 地图没有问题'));
    for (const e of errs) host.append(AC.el('div', { class: 'e' }, '✘ ' + e));
    for (const w of warns) host.append(AC.el('div', { class: 'w' }, '⚠ ' + w));
    return errs;
  }
  document.getElementById('btnCheck').addEventListener('click', showValidate);

  /* ================= 导入导出(格式与 AC1 互通)================= */

  const ioMenu = document.getElementById('ioMenu');
  const ioPop = AC.el('div', { class: 'pop' },
    AC.el('button', { class: 'btn', onclick: () => {
      ioPop.style.display = 'none';
      AC.download((map.name || 'fpsmap') + '.json', JSON.stringify(map, null, 1), 'application/json');
    } }, '导出 JSON'),
    AC.el('button', { class: 'btn', onclick: () => {
      ioPop.style.display = 'none';
      AC.pickFile('.json', 'text').then(f => {
        if (!f) return;
        try {
          const d = JSON.parse(f.data);
          if (d.format !== 'aether-fpsmap') throw new Error('不是 aether-fpsmap 文件');
          pushUndo();
          map = d;
          document.getElementById('mapName').value = map.name || '';
          fitView(); changed();
          AC.toast('已导入:' + f.name);
        } catch (err) { AC.toast('导入失败:' + err.message, true); }
      });
    } }, '导入 JSON'));
  ioPop.style.display = 'none';
  ioMenu.append(ioPop);
  document.getElementById('ioBtn').addEventListener('click', () =>
    ioPop.style.display = ioPop.style.display === 'none' ? 'flex' : 'none');
  ioMenu.addEventListener('pointerleave', () => ioPop.style.display = 'none');

  document.getElementById('btnNew').addEventListener('click', () => {
    AC.dialog((dlg, close) => {
      dlg.append(AC.el('h3', {}, '新建地图(丢弃当前内容)'));
      dlg.append(AC.el('div', { class: 'foot' },
        AC.el('button', { class: 'btn primary', onclick: () => {
          pushUndo(); buildExample();
          document.getElementById('mapName').value = map.name;
          sel = null; changed(); close();
        } }, '示例:堡垒广场'),
        AC.el('button', { class: 'btn', onclick: () => {
          pushUndo(); buildEmpty();
          document.getElementById('mapName').value = map.name;
          sel = null; changed(); close();
        } }, '空房间'),
        AC.el('button', { class: 'btn', onclick: close }, '取消')));
    });
  });

  /* ================= 3D 预览(软件渲染,自 AC1 原样搬运)================= */

  const P3W = 320, P3H = 200, P3CX = 160, P3CY = 100, P3F = 250;
  const colAng = new Float32Array(P3W), colCos = new Float32Array(P3W);
  for (let x = 0; x < P3W; x++) {
    colAng[x] = Math.atan((x - P3CX) / P3F);
    colCos[x] = Math.cos(colAng[x]);
  }

  function hexRGB(hex) {
    const m = /^#(..)(..)(..)/.exec(hex || '#000000');
    return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  }

  function open3D(spawnAt) {
    const errs = showValidate();
    if (errs.length) { AC.toast('地图有 ' + errs.length + ' 处错误,先修复再预览', true); return; }
    const start = spawnAt || (() => {
      const p = map.things.find(t => t.type === 'player1');
      return p ? { x: p.x, z: p.z, angle: p.angle } : { x: 0, z: 0, angle: 0 };
    })();
    const s0 = sectorAt(start.x, start.z);
    if (s0 < 0) { AC.toast('出生位置不在扇区内', true); return; }

    const P = {
      x: start.x, z: start.z, feet: map.sectors[s0].floorH, vy: 0,
      yaw: Math.PI / 2 - (start.angle || 0) * Math.PI / 180,
      pitch: 0, fly: false, grounded: true,
    };
    const keys = new Set();

    const ov = AC.el('div', { class: 'overlay' });
    const dlg = AC.el('div', { class: 'dlg' });
    dlg.style.maxWidth = '1020px';
    const cv3 = AC.el('canvas', { width: P3W, height: P3H,
      style: 'width:min(94vw,960px);aspect-ratio:320/200;image-rendering:pixelated;display:block;background:#000;border-radius:4px;cursor:crosshair;' });
    const hud = AC.el('div', { class: 'hud3d', style: 'text-align:center;margin-top:6px;' });
    dlg.append(AC.el('h3', {}, '3D 预览 · ' + (map.name || '')), cv3, hud,
      AC.el('div', { class: 'foot' },
        AC.el('button', { class: 'btn danger', id: 'p3end' }, '结束预览')));
    ov.append(dlg);
    ov.addEventListener('pointerdown', e => { if (e.target === ov) end3D(); });
    document.body.append(ov);
    document.getElementById('p3end').addEventListener('click', end3D);

    const ctx3 = cv3.getContext('2d');
    const img = ctx3.createImageData(P3W, P3H);
    const px32 = new Uint32Array(img.data.buffer);
    const depth = new Float32Array(P3W * P3H);
    const fogRGB = hexRGB(map.meta.fog);
    const FOGD = map.meta.fogD || 2600;
    const running = { on: true };
    let raf = 0, lastT = performance.now(), fps = 0, fpsT = 0, fpsN = 0;

    cv3.addEventListener('click', () => {
      if (document.pointerLockElement !== cv3) {
        try {
          const rq = cv3.requestPointerLock({ unadjustedMovement: true });
          if (rq && rq.catch) rq.catch(() => { try { cv3.requestPointerLock(); } catch (e2) {} });
        } catch (err) { try { cv3.requestPointerLock(); } catch (e3) {} }
      }
    });
    const onMouse = e => {
      if (document.pointerLockElement === cv3) {
        P.yaw += (e.movementX || 0) * 0.0032;
        P.pitch = Math.max(-1.1, Math.min(1.1, P.pitch - (e.movementY || 0) * 0.0026));
      }
    };
    const onKey3 = e => {
      const codes = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
        'Space', 'KeyF', 'KeyR', 'KeyE', 'KeyQ'];
      if (!codes.includes(e.code)) {
        if (e.code === 'Escape' && document.pointerLockElement !== cv3) end3D();
        return;
      }
      if (e.code === 'Space') e.preventDefault();
      if (e.type === 'keydown') {
        keys.add(e.code);
        if (e.code === 'KeyF') P.fly = !P.fly;
        if (e.code === 'KeyR') { P.x = start.x; P.z = start.z; P.vy = 0; }
      } else keys.delete(e.code);
    };
    document.addEventListener('mousemove', onMouse);
    window.addEventListener('keydown', onKey3);
    window.addEventListener('keyup', onKey3);

    function end3D() {
      if (!running.on) return;
      running.on = false;
      cancelAnimationFrame(raf);
      if (document.pointerLockElement === cv3) document.exitPointerLock();
      document.removeEventListener('mousemove', onMouse);
      window.removeEventListener('keydown', onKey3);
      window.removeEventListener('keyup', onKey3);
      window.__P3 = null;
      ov.remove();
    }

    /* —— 移动与碰撞 —— */
    function move(dt) {
      const sp = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 420 : 250) * dt;
      let fx = 0, fz = 0;
      const dx = Math.sin(P.yaw), dz = Math.cos(P.yaw);
      if (keys.has('KeyW') || keys.has('ArrowUp')) { fx += dx; fz += dz; }
      if (keys.has('KeyS') || keys.has('ArrowDown')) { fx -= dx; fz -= dz; }
      if (keys.has('KeyA') || keys.has('ArrowLeft')) { fx += dz; fz -= dx; }
      if (keys.has('KeyD') || keys.has('ArrowRight')) { fx -= dz; fz += dx; }
      const l = Math.hypot(fx, fz);
      if (l > 0) { fx /= l; fz /= l; }
      tryMove(fx * sp, fz * sp);
      if (P.fly) {
        let vy = 0;
        if (keys.has('KeyE') || keys.has('Space')) vy = 260 * dt;
        if (keys.has('KeyQ')) vy = -260 * dt;
        P.feet += vy;
        const sec = curSector();
        if (sec >= 0) {
          const s = map.sectors[sec];
          P.feet = Math.max(s.floorH, Math.min(s.ceilH - PH, P.feet));
        }
      } else {
        const sec = curSector();
        const g = sec >= 0 ? map.sectors[sec].floorH : P.feet;
        if (P.grounded && keys.has('Space')) { P.vy = 252; P.grounded = false; }
        P.vy -= 780 * dt;
        P.feet += P.vy * dt;
        if (P.feet <= g) { P.feet = g; P.vy = 0; P.grounded = true; }
        else P.grounded = false;
        if (sec >= 0) {
          const s = map.sectors[sec];
          if (P.feet + PH > s.ceilH) { P.feet = s.ceilH - PH; P.vy = Math.min(0, P.vy); }
        }
      }
    }
    function curSector() { return sectorAt(P.x, P.z); }
    function tryMove(dx, dz) {
      const nx = P.x + dx, nz = P.z + dz;
      // 圆 vs 阻挡线推离
      let px2 = nx, pz2 = nz;
      for (let iter = 0; iter < 3; iter++) {
        let hit = false;
        for (const l of map.linedefs) {
          const a = V(l.v1), b = V(l.v2);
          const d = distToSeg(px2, pz2, a, b);
          if (d > PR) continue;
          const my = sectorAt(px2, pz2);
          const myS = my >= 0 ? map.sectors[my] : null;
          const other = my === l.front ? l.back : my === l.back ? l.front : -1;
          const oS = other >= 0 ? map.sectors[other] : null;
          let solid = false;
          if (l.front < 0 || l.back < 0) solid = true;               // 单面墙
          else if (oS && myS) {
            if (oS.floorH - P.feet > STEP) solid = true;             // 对面地板太高
            if (Math.min(myS.ceilH, oS.ceilH) - Math.max(myS.floorH, oS.floorH) < PH) solid = true;
          } else solid = true;
          if (!solid) continue;
          hit = true;
          const cp = segClosest(px2, pz2, a, b);
          let ux = px2 - cp.x, uz = pz2 - cp.z;
          const ul = Math.hypot(ux, uz) || 1;
          ux /= ul; uz /= ul;
          const push = PR - d + 0.1;
          px2 += ux * push; pz2 += uz * push;
        }
        if (!hit) break;
      }
      // 障碍物(油桶)
      for (const t of map.things) {
        const T = THING_TYPES[t.type];
        if (T.kind !== 'block') continue;
        const dx2 = px2 - t.x, dz2 = pz2 - t.z;
        const d = Math.hypot(dx2, dz2), rr = T.r + PR;
        if (d < rr && d > 0.001) { px2 = t.x + dx2 / d * rr; pz2 = t.z + dz2 / d * rr; }
      }
      if (sectorAt(px2, pz2) >= 0) { P.x = px2; P.z = pz2; }
    }

    /* —— 渲染 —— */
    function render3d(time) {
      const eyeY = P.feet + EYE;
      const horizon = P3CY + Math.tan(P.pitch) * P3F;
      const sectors = map.sectors;
      const camSec = curSector();
      depth.fill(Infinity);

      for (let x = 0; x < P3W; x++) {
        const ca = P.yaw + colAng[x];
        const dx = Math.sin(ca), dz = Math.cos(ca);
        const cInv = 1 / colCos[x];          // 前向距离 → 单位射线距离
        if (camSec < 0) {                    // 虚空:整列天空
          drawSkyCol(x, 0, P3H - 1, horizon, ca);
          continue;
        }
        let sec = camSec;
        let t0 = 1;
        let solid = false;
        for (let iter = 0; iter < 80 && !solid; iter++) {
          const S = sectors[sec];
          const fH = S.floorH, cH = S.ceilH, sLight = S.light;
          const sky = S.sky;
          // 找最近边界交点
          let bestT = Infinity, bestLine = -1;
          for (let li = 0; li < map.linedefs.length; li++) {
            const l = map.linedefs[li];
            if (l.front !== sec && l.back !== sec) continue;
            const a = V(l.v1), b = V(l.v2);
            const ex = b.x - a.x, ez = b.z - a.z;
            const den = dx * ez - dz * ex;
            if (den > -1e-9 && den < 1e-9) continue;
            const rx = a.x - P.x, rz = a.z - P.z;
            const t = (rx * ez - rz * ex) / den;
            if (t <= t0 + 0.01 || t >= bestT) continue;
            const s = (rx * dz - rz * dx) / den;
            if (s < 0 || s > 1) continue;
            bestT = t; bestLine = li;
          }
          const tEnd = bestT === Infinity ? 50000 : bestT;
          // 地板 / 天花跨度 [t0, tEnd](天空天花画天空像素)
          if (sky) drawFlat(x, t0, tEnd, cH, null, sLight, false, horizon, eyeY, cInv, ca);
          else drawFlat(x, t0, tEnd, cH, S._cC || (S._cC = hexRGB(S.ceilC)), sLight, false, horizon, eyeY, cInv, ca);
          drawFlat(x, t0, tEnd, fH, S._fC || (S._fC = hexRGB(S.floorC)), sLight, true, horizon, eyeY, cInv, ca);
          if (bestLine < 0) break;
          const l = map.linedefs[bestLine];
          const other = l.front === sec ? l.back : l.front;
          const wC = S._wC || (S._wC = hexRGB(S.wallC));
          if (other < 0) {                    // 实心墙
            drawWallCol(x, bestT, fH, cH, wC, sLight, horizon, eyeY, cInv);
            solid = true;
            break;
          }
          const O = sectors[other];
          const oF = O.floorH, oC = O.ceilH;
          if (oC - oF < 1) {                  // 对面实心:整面墙
            drawWallCol(x, bestT, fH, cH, wC, sLight, horizon, eyeY, cInv);
            solid = true;
            break;
          }
          if (oF > fH) drawWallCol(x, bestT, fH, Math.min(oF, cH), wC, sLight, horizon, eyeY, cInv);
          if (oC < cH) drawWallCol(x, bestT, Math.max(oC, fH), cH, wC, sLight, horizon, eyeY, cInv);
          t0 = bestT;
          sec = other;
        }
      }

      // 精灵(物件)
      const rgtX = Math.cos(P.yaw), rgtZ = -Math.sin(P.yaw);    // 右向量
      const sprites = [];
      for (let i = 0; i < map.things.length; i++) {
        const t = map.things[i];
        if (t.type === 'player1') continue;
        const T = THING_TYPES[t.type];
        const rx = t.x - P.x, rz = t.z - P.z;
        const fwd = rx * Math.sin(P.yaw) + rz * Math.cos(P.yaw);
        if (fwd < 8) continue;
        const right = rx * rgtX + rz * rgtZ;
        const sx = P3CX + right / fwd * P3F;
        if (sx < -80 || sx > P3W + 80) continue;
        sprites.push({ t, T, fwd, sx, sec: sectorAt(t.x, t.z) });
      }
      sprites.sort((a, b) => b.fwd - a.fwd);
      for (const sp of sprites) {
        const s = sp.sec >= 0 ? map.sectors[sp.sec] : null;
        const bob = sp.T.kind === 'item'
          ? Math.sin(time / 400 + sp.t.x * 0.1) * 3 + 6 : 0;
        const bottom = (s ? s.floorH : 0) + bob;
        const top = bottom + sp.T.h;
        const yB = horizon - (bottom - eyeY) * P3F / sp.fwd;
        const yT = horizon - (top - eyeY) * P3F / sp.fwd;
        const halfW = sp.T.r / sp.fwd * P3F;
        if (yT >= P3H || yB < 0) continue;
        const x0 = Math.max(0, Math.ceil(sp.sx - halfW)), x1 = Math.min(P3W - 1, Math.floor(sp.sx + halfW));
        const y0 = Math.max(0, Math.ceil(yT)), y1 = Math.min(P3H - 1, Math.floor(yB - 0.001));
        if (x1 < x0 || y1 < y0) continue;
        const light = s ? s.light : 160;
        const c = hexRGB(sp.T.color);
        const eyeC = sp.T.eye ? hexRGB(sp.T.eye) : null;
        const fogK = Math.min(1, sp.fwd / FOGD);
        for (let x = x0; x <= x1; x++) {
          const u = (x - sp.sx) / (halfW || 1);
          const tUnit = sp.fwd / colCos[x];
          for (let y = y0; y <= y1; y++) {
            const v = (y - yT) / (yB - yT || 1);        // 0 顶 → 1 底
            let col = null;
            if (sp.T.kind === 'enemy') {
              if (u * u + (v * 2 - 1) * (v * 2 - 1) > 1) continue;    // 椭圆身
              if (eyeC && Math.abs(v - 0.38) < 0.10 && Math.abs(Math.abs(u) - 0.34) < 0.14)
                col = eyeC;
              else col = c;
            } else if (sp.T.kind === 'block') {          // 油桶
              if (Math.abs(u) > 0.82) continue;
              col = (Math.abs(v - 0.3) < 0.05 || Math.abs(v - 0.55) < 0.05 || Math.abs(v - 0.8) < 0.05)
                ? [c[0] * 0.55, c[1] * 0.55, c[2] * 0.55] : c;
            } else {                                    // 物品:菱形/十字
              const du = Math.abs(u), dv = Math.abs(v - 0.55) * 1.6;
              if (du + dv > 0.62) continue;
              if (sp.t.type === 'medkit' && Math.abs(u) < 0.32 && (Math.abs(v - 0.42) < 0.06 || Math.abs(v - 0.55) < 0.06))
                col = [240, 240, 240];
              else col = c;
            }
            const di = y * P3W + x;
            if (tUnit >= depth[di]) continue;
            depth[di] = tUnit;
            const b = (0.4 + light / 255 * 0.75) * (1 - fogK * 0.92);
            px32[di] = 0xFF000000 |
              (Math.min(255, col[2] * b + fogRGB[2] * fogK) << 16) |
              (Math.min(255, col[1] * b + fogRGB[1] * fogK) << 8) |
              Math.min(255, col[0] * b + fogRGB[0] * fogK);
          }
        }
      }

      // 准星 + HUD
      for (let i = -3; i <= 3; i++) {
        if (Math.abs(i) !== 3) {
          px32[(P3CY | 0) * P3W + P3CX + i] = 0xFF88FFAA;
          px32[((P3CY + i) | 0) * P3W + P3CX] = 0xFF88FFAA;
        }
      }
      ctx3.putImageData(img, 0, 0);
      hud.textContent = `(${P.x | 0}, ${P.z | 0}) 扇区 ${curSector()} · ${
        P.fly ? '飞行(F 切换, Q/E 降升)' : '行走(F 切换, Space 跳)'} · ${fps | 0} fps — 点击画面锁定鼠标视角 · Esc 结束`;
    }

    /* 列内平面(地板/天花)投影:前向距离制;color=null 且非地板 = 天空天花 */
    function drawFlat(x, t0, t1, h, color, light, isFloor, horizon, eyeY, cInv, ca) {
      const eyeDiff = isFloor ? eyeY - h : h - eyeY;
      if (eyeDiff <= 0.01) return;
      const sign = isFloor ? 1 : -1;
      // y(t) = horizon + sign * eyeDiff*F*cInv / t,近端离地平线更远
      const yA = horizon + sign * eyeDiff * P3F * cInv / t0;
      const yB = horizon + sign * eyeDiff * P3F * cInv / t1;
      let y0 = Math.max(0, Math.ceil(Math.min(yA, yB)));
      let y1 = Math.min(P3H - 1, Math.floor(Math.max(yA, yB)));
      const b0 = 0.4 + light / 255 * 0.75;
      const isSky = !isFloor && color === null;
      for (let y = y0; y <= y1; y++) {
        const dh = (y - horizon) * sign;
        if (dh <= 0) continue;
        const tF = eyeDiff * P3F / dh;              // 前向距离
        const t = tF * cInv;                        // 单位射线距离
        if (t < t0 || t > t1) continue;
        const di = y * P3W + x;
        if (isSky) {
          if (t >= depth[di]) continue;
          depth[di] = t;
          px32[di] = skyPixel(x, y, horizon, ca);
          continue;
        }
        if (t >= depth[di]) continue;
        depth[di] = t;
        const fogK = Math.min(1, Math.pow(tF / FOGD, 1.4));
        const b = b0 * (1 - fogK * 0.92);
        px32[di] = 0xFF000000 |
          (Math.min(255, color[2] * b + fogRGB[2] * fogK) << 16) |
          (Math.min(255, color[1] * b + fogRGB[1] * fogK) << 8) |
          Math.min(255, color[0] * b + fogRGB[0] * fogK);
      }
    }

    function drawSkyCol(x, y0, y1, horizon, ca) {
      for (let y = y0; y <= y1; y++) px32[y * P3W + x] = skyPixel(x, y, horizon, ca);
    }
    function skyPixel(x, y, horizon, ca) {
      const f = Math.max(0, Math.min(1, y / (horizon + 1)));
      const r = 14 * f + 4 * (1 - f), g = 20 * f + 6 * (1 - f), b = 40 * f + 12 * (1 - f);
      const su = (ca * 220) | 0, sv = y | 0;
      if (((su * 73 + sv * 131) & 1023) < 14)
        return 0xFFd8dce8;
      return 0xFF000000 | ((b | 0) << 16) | ((g | 0) << 8) | (r | 0);
    }

    function drawWallCol(x, t, hBot, hTop, color, light, horizon, eyeY, cInv) {
      if (hTop <= hBot) return;
      const k = P3F * cInv / t;                    // 前向距离制(与平面投影一致)
      const yB = horizon + (eyeY - hBot) * k;
      const yT = horizon - (hTop - eyeY) * k;
      let y0 = Math.max(0, Math.ceil(yT)), y1 = Math.min(P3H - 1, Math.floor(yB));
      if (y1 < y0) return;
      const tF = t / cInv;
      const fogK = Math.min(1, Math.pow(tF / FOGD, 1.4));
      const b0 = (0.4 + light / 255 * 0.75) * (1 - fogK * 0.92);
      for (let y = y0; y <= y1; y++) {
        const di = y * P3W + x;
        if (t >= depth[di]) continue;      // 已被更近的平面/精灵覆盖
        depth[di] = t;
        const vFrac = (y - yT) / (yB - yT || 1);
        const b = b0 * (1.04 - 0.14 * vFrac);       // 顶部略亮,近地略暗
        px32[di] = 0xFF000000 |
          (Math.min(255, color[2] * b + fogRGB[2] * fogK) << 16) |
          (Math.min(255, color[1] * b + fogRGB[1] * fogK) << 8) |
          Math.min(255, color[0] * b + fogRGB[0] * fogK);
      }
    }

    function loop(now) {
      if (!running.on) return;
      raf = requestAnimationFrame(loop);
      const dt = Math.min(0.05, (now - lastT) / 1000);
      lastT = now;
      fpsN++;
      if (now - fpsT > 500) { fps = fpsN * 1000 / (now - fpsT); fpsT = now; fpsN = 0; }
      move(dt);
      render3d(now);
    }
    window.__P3 = {                  // 调试钩子:手动推帧 / 读取相机
      P,
      frame(dt) { move(dt || 0.016); render3d(performance.now()); },
      end: end3D,
    };
    raf = requestAnimationFrame(loop);
  }
  document.getElementById('btnPlay').addEventListener('click', () => open3D());

  /* ================= 启动 ================= */

  (function init() {
    const draft = AC.draft.load(DRAFT_KEY);
    if (draft && draft.format === 'aether-fpsmap' && Array.isArray(draft.vertices)) {
      map = draft;
      AC.toast('已恢复上次草稿');
    } else {
      buildExample();
    }
    window.__FPSMAP = map;                    // 调试钩子
    window.__FPSCAM = cam;
    window.__FPSEDIT = { get map() { return map; }, set map(m) { map = m; }, validate };
    document.getElementById('mapName').value = map.name || '';
    setMode('select');
    resize();
    renderProps();
    renderPal();
    updateCounts();
    showValidate();
    setTimeout(fitView, 50);
  })();
})();
