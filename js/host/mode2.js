/* js/host/mode2.js — 模式2:自由光栅模式(固件光栅化库,§6.4)
 * 帧缓冲 240×176 × 8bit ANSI 索引;无混合,透明 = 位图/字形的 1bit "不画"标志(§6.6)。
 * 全局 2×3 仿射矩阵 + 栈,作用于除 pset 外的一切图元;角度单位 1/256 圆。
 * 采样自适应(§6.4.4/T7):放大/等比 → 最近邻;缩小 → 区域平均(装载期预生成 mip 链)。
 * 矢量:装载期光栅化为位图缓存(1bit 透明),运行期按位图绘制。
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};
  const W = 240, H = 176;
  const { ANSI } = AC2;

  const IDENT = [1, 0, 0, 1, 0, 0];
  function matMul(m, n) { // m ∘ n:先作用 n 再 m
    return [
      m[0] * n[0] + m[2] * n[1],
      m[1] * n[0] + m[3] * n[1],
      m[0] * n[2] + m[2] * n[3],
      m[1] * n[2] + m[3] * n[3],
      m[0] * n[4] + m[2] * n[5] + m[4],
      m[1] * n[4] + m[3] * n[5] + m[5]
    ];
  }
  function matInv(m) {
    const det = m[0] * m[3] - m[1] * m[2];
    if (!det) return null;
    const id = 1 / det;
    return [
      m[3] * id, -m[1] * id,
      -m[2] * id, m[0] * id,
      (m[2] * m[5] - m[3] * m[4]) * id, (m[1] * m[4] - m[0] * m[5]) * id
    ];
  }
  function isIdent(m) { return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0; }

  // 位图:mip 链(2× 区域平均,透明按覆盖 ≥50% 判定,色取不透明均值再量化回 ANSI)
  function buildMips(bm) {
    const mips = [bm];
    let cur = bm;
    while (cur.w > 1 && cur.h > 1) {
      const w = cur.w >> 1, h = cur.h >> 1;
      const px = new Uint8Array(w * h), tm = new Uint8Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let r = 0, g = 0, b = 0, cov = 0;
        for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
          const s = (y * 2 + j) * cur.w + x * 2 + i;
          if (!cur.tmask[s]) {
            const c = cur.px[s];
            r += ANSI.rgbTable[c * 3]; g += ANSI.rgbTable[c * 3 + 1]; b += ANSI.rgbTable[c * 3 + 2];
            cov++;
          }
        }
        const d = y * w + x;
        if (cov >= 2) {
          px[d] = ANSI.fromRgbFast(r / cov, g / cov, b / cov);
          tm[d] = 0;
        } else {
          px[d] = 0; tm[d] = 1;
        }
      }
      cur = { w, h, px, tmask: tm };
      mips.push(cur);
    }
    return mips;
  }

  function parseBM2(data, off) {
    off = off || 0;
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (dv.getUint32(off, true) !== 0x20324D42) throw new Error('BM2 magic 错误'); // "BM2 " LE
    const w = dv.getUint16(off + 4, true), h = dv.getUint16(off + 6, true);
    if (w < 1 || h < 1 || w > 4096 || h > 4096) throw new Error('BM2 尺寸非法');
    const n = w * h;
    const px = new Uint8Array(n);
    px.set(data.subarray(off + 8, off + 8 + n));
    const stride = (w + 7) >> 3;
    const tmask = new Uint8Array(n);
    for (let y = 0; y < h; y++) {
      const mrow = off + 8 + n + y * stride;
      for (let x = 0; x < w; x++) {
        tmask[y * w + x] = (data[mrow + (x >> 3)] >> (x & 7)) & 1;
      }
    }
    return { w, h, px, tmask, byteLen: 8 + n + stride * h };
  }

  function createMode2(machine) {
    const bitmaps = new Map();      // id → {w,h,px,tmask,mips}
    let mat = IDENT.slice();
    const stack = [];
    let sampling = 'auto';          // manifest 覆盖

    const m2 = {
      bitmaps,
      get matrix() { return mat; },
      setSampling(s) { sampling = s; },
      get sampling() { return sampling; }
    };

    function reset() {
      bitmaps.clear();
      mat = IDENT.slice();
      stack.length = 0;
      machine.fb.fill(0);
    }
    m2.reset = reset;

    m2.frameStart = () => {};

    // ---- 资源 ----
    m2.loadBitmap = (id, seg, off) => {
      const data = seg && seg.data ? seg.data : seg;
      const bm = parseBM2(data, off);
      bm.mips = buildMips(bm);
      bitmaps.set(id, bm);
      return bm;
    };
    m2.loadBitmapRaw = (id, bm) => { bm.mips = buildMips(bm); bitmaps.set(id, bm); return bm; };
    m2.bitmap = (id) => bitmaps.get(id);
    m2.unload = (id) => bitmaps.delete(id);

    // 矢量:装载期光栅化为位图缓存(§6.4.2)
    m2.loadVector = (id, seg, off) => {
      const data = seg && seg.data ? seg.data : seg;
      const vec = JSON.parse(new TextDecoder().decode(off ? data.subarray(off) : data));
      const bm = rasterizeVector(vec, bitmaps);
      bm.mips = buildMips(bm);
      bitmaps.set(id, bm);
      return bm;
    };

    // ---- 变换 ----
    m2.setMatrix = (m) => { mat = [m[0], m[1], m[2], m[3], m[4], m[5]]; };
    m2.push = () => { stack.push(mat.slice()); };
    m2.pop = () => { if (stack.length) mat = stack.pop(); };
    m2.identity = () => { mat = IDENT.slice(); };
    m2.translate = (x, y) => { mat = matMul(mat, [1, 0, 0, 1, x, y]); };
    m2.scale = (sx, sy) => { mat = matMul(mat, [sx, 0, 0, sy == null ? sx : sy, 0, 0]); };
    m2.rotate = (ang256) => { // 1/256 圆;后调用先作用于几何(canvas 语义)
      const a = ang256 * Math.PI * 2 / 256;
      mat = matMul(mat, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]);
    };

    // ---- 基础图元 ----
    m2.clear = (color) => { machine.fb.fill(color == null ? 0 : color & 0xFF); };
    m2.pset = (x, y, c) => {
      x |= 0; y |= 0;
      if (x >= 0 && x < W && y >= 0 && y < H) machine.fb[y * W + x] = c & 0xFF;
    };
    m2.pget = (x, y) => {
      x |= 0; y |= 0;
      return (x >= 0 && x < W && y >= 0 && y < H) ? machine.fb[y * W + x] : 0;
    };

    function plotBrush(x, y, c, wd) {
      const fb = machine.fb, off = (wd - 1) >> 1;
      const x0 = Math.max(0, (x | 0) - off), x1 = Math.min(W - 1, (x | 0) - off + wd - 1);
      const y0 = Math.max(0, (y | 0) - off), y1 = Math.min(H - 1, (y | 0) - off + wd - 1);
      for (let yy = y0; yy <= y1; yy++) {
        const row = yy * W;
        for (let xx = x0; xx <= x1; xx++) fb[row + xx] = c;
      }
    }

    m2.line = (x0, y0, x1, y1, c, wd) => {
      wd = Math.max(1, Math.min(4, (wd || 1) | 0));
      c &= 0xFF;
      let p0 = xf(x0, y0), p1 = xf(x1, y1);
      // 变换下宽度按比例放大(保持视觉一致)
      const sc = Math.hypot(mat[0], mat[1]) || 1;
      const bw = Math.max(1, Math.min(8, Math.round(wd * sc)));
      x0 = Math.round(p0[0]); y0 = Math.round(p0[1]); x1 = Math.round(p1[0]); y1 = Math.round(p1[1]);
      let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
      let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (; ;) {
        plotBrush(x0, y0, c, bw);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    };

    m2.rect = (x, y, w, h, c, fill) => {
      c &= 0xFF;
      if (isIdent(mat)) {
        const fb = machine.fb;
        const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
        const x1 = Math.min(W, Math.round(x + w)), y1 = Math.min(H, Math.round(y + h));
        if (fill) {
          for (let yy = y0; yy < y1; yy++) fb.fill(c, yy * W + x0, yy * W + x1);
        } else {
          const yb = Math.max(0, y1 - 1), xb = Math.max(0, x1 - 1);
          for (let xx = x0; xx < x1; xx++) { if (y0 < H) fb[y0 * W + xx] = c; if (y1 - 1 < H && y1 - 1 >= 0) fb[(y1 - 1) * W + xx] = c; }
          for (let yy = y0; yy < y1; yy++) { if (x0 < W) fb[yy * W + x0] = c; if (xb < W) fb[yy * W + xb] = c; }
        }
        return;
      }
      const pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
      if (fill) m2.poly(pts, { color: c });
      else {
        for (let i = 0; i < 4; i++) {
          const a = pts[i], b = pts[(i + 1) % 4];
          m2.line(a[0], a[1], b[0], b[1], c, 1);
        }
      }
    };

    // 多边形纹理填充:扇形三角化 + 对象空间 UV(§6.4.3"面可带纹理")
    function fillPolyTex(pts, opt) {
      const tex = bitmaps.get(opt.tex);
      if (!tex) return;
      const uo = opt.uv0 || [0, 0], us = opt.uvScale || 1;
      for (let i = 1; i + 1 < pts.length; i++) {
        m2.triTex(pts[0], pts[i], pts[i + 1],
          [uo[0] + pts[0][0] * us, uo[1] + pts[0][1] * us],
          [uo[0] + pts[i][0] * us, uo[1] + pts[i][1] * us],
          [uo[0] + pts[i + 1][0] * us, uo[1] + pts[i + 1][1] * us],
          opt.tex);
      }
    }

    // 扫描线多边形填充(变换后顶点,even-odd)
    m2.poly = (ptsIn, opt) => {
      opt = opt || {};
      const pts = ptsIn.map(p => xf(p[0], p[1]));
      if (opt.tex) { fillPolyTex(pts, opt); return; }
      const c = (opt.color != null ? opt.color : 15) & 0xFF;
      const fb = machine.fb;
      let minY = Infinity, maxY = -Infinity;
      for (const p of pts) { minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); }
      const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H - 1, Math.ceil(maxY));
      const n = pts.length;
      const xs = [];
      for (let y = y0; y <= y1; y++) {
        xs.length = 0;
        const cy = y + 0.5;
        for (let i = 0; i < n; i++) {
          const a = pts[i], b = pts[(i + 1) % n];
          if ((a[1] <= cy && b[1] > cy) || (b[1] <= cy && a[1] > cy)) {
            xs.push(a[0] + (cy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
          }
        }
        xs.sort((p, q) => p - q);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const sx = Math.max(0, Math.round(xs[i])), ex = Math.min(W - 1, Math.round(xs[i + 1]) - 1);
          const row = y * W;
          for (let x = sx; x <= ex; x++) fb[row + x] = c;
        }
      }
    };

    // 纹理映射三角形(仿射 UV,类 PS1;§6.4.3)
    m2.triTex = (p0, p1, p2, uv0, uv1, uv2, texId) => {
      const tex = bitmaps.get(texId);
      if (!tex) return;
      const q0 = xf(p0[0], p0[1]), q1 = xf(p1[0], p1[1]), q2 = xf(p2[0], p2[1]);
      // UV → 屏幕仿射求解(以 q0 为原点)
      const e1x = q1[0] - q0[0], e1y = q1[1] - q0[1], e2x = q2[0] - q0[0], e2y = q2[1] - q0[1];
      const u1 = uv1[0] - uv0[0], v1 = uv1[1] - uv0[1], u2 = uv2[0] - uv0[0], v2 = uv2[1] - uv0[1];
      const det = e1x * e2y - e1y * e2x;
      if (Math.abs(det) < 1e-9) return;
      const id = 1 / det;
      // du/dx 等:u = u0 + A*(x-q0x) + B*(y-q0y)
      const A = (u1 * e2y - u2 * e1y) * id, B = (u2 * e1x - u1 * e2x) * id;
      const C = (v1 * e2y - v2 * e1y) * id, D = (v2 * e1x - v1 * e2x) * id;
      // mip 选择:纹素/像素 面积比
      let level = 0;
      if (sampling !== 'nearest') {
        const dens = Math.hypot(A, B) + Math.hypot(C, D); // 每像素 UV 步长量级
        const r = dens * 0.5;
        level = Math.max(0, Math.min(tex.mips.length - 1, Math.floor(Math.log2(r + 1e-9))));
        if (sampling === 'nearest') level = 0;
      }
      const tp = tex.mips[level];
      const mipScale = tex.w / tp.w;
      const minX = Math.max(0, Math.floor(Math.min(q0[0], q1[0], q2[0])));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(q0[0], q1[0], q2[0])));
      const minY = Math.max(0, Math.floor(Math.min(q0[1], q1[1], q2[1])));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(q0[1], q1[1], q2[1])));
      const fb = machine.fb;
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const fx = x + 0.5 - q0[0], fy = y + 0.5 - q0[1];
          const b1 = fx * e2y - fy * e2x;   // 相对边 q1
          const b2 = fy * e1x - fx * e1y;   // 相对边 q2
          const b0 = det - b1 - b2;
          const s = det > 0 ? 1 : -1;
          if (b0 * s >= 0 && b1 * s >= 0 && b2 * s >= 0) {
            let u = (uv0[0] + A * fx + B * fy) / mipScale, v = (uv0[1] + C * fx + D * fy) / mipScale;
            // clamp/repeat(§6.4.3)
            if (u < 0 || u >= tp.w) { if (optRepeat(texId)) u = ((u % tp.w) + tp.w) % tp.w; else u = u < 0 ? 0 : tp.w - 1; }
            if (v < 0 || v >= tp.h) { if (optRepeat(texId)) v = ((v % tp.h) + tp.h) % tp.h; else v = v < 0 ? 0 : tp.h - 1; }
            const sIdx = ((v | 0) * tp.w + (u | 0));
            if (!tp.tmask[sIdx]) fb[y * W + x] = tp.px[sIdx];
          }
        }
      }
    };
    const repeatSet = new Set();
    m2.setRepeat = (id, on) => { on ? repeatSet.add(id) : repeatSet.delete(id); };
    function optRepeat(id) { return repeatSet.has(id); }

    // blit:任意角度旋转 + XY 缩放 + 翻转;自适应采样(§6.4.4)
    // 语义:(x,y) = 位图左上角;rot 绕枢轴(默认位图中心,opt.cx/cy 源坐标)旋转;缩放/翻转后左上角仍在 (x,y) 基准系
    m2.blit = (id, x, y, opt) => {
      const bm = bitmaps.get(id);
      if (!bm) return;
      opt = opt || {};
      const rot = opt.rot || 0;
      const sx = opt.sx == null ? 1 : opt.sx, sy = opt.sy == null ? (opt.sx == null ? 1 : opt.sx) : opt.sy;
      const cx = opt.cx == null ? bm.w / 2 : opt.cx;
      const cy = opt.cy == null ? bm.h / 2 : opt.cy;
      // 局部链:T(x,y) ∘ T(p) ∘ R ∘ T(-p) ∘ S ∘ F(p 为枢轴先经 S)
      let local = [1, 0, 0, 1, 0, 0];
      if (opt.flip) local = matMul([-1, 0, 0, 1, bm.w, 0], local);   // 盒内水平镜像
      if (opt.fv) local = matMul([1, 0, 0, -1, 0, bm.h], local);     // 盒内垂直镜像
      local = matMul([sx, 0, 0, sy, 0, 0], local);        // S ∘ F
      if (rot) {
        const a = rot * Math.PI * 2 / 256;
        const px = cx * sx, py = cy * sy;                 // 缩放后的枢轴位置
        local = matMul([1, 0, 0, 1, px, py], matMul(
          [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0],
          matMul([1, 0, 0, 1, -px, -py], local)));
      }
      local = matMul([1, 0, 0, 1, x, y], local);          // T(x,y)
      const M = matMul(mat, local);
      drawBlitTransformed(bm, M, id);
    };

    function drawBlitTransformed(bm, M, id) {
      const inv = matInv(M);
      if (!inv) return;
      const det = Math.abs(M[0] * M[3] - M[1] * M[2]); // 目标像素/源像素 面积比
      // 采样策略:目标 ≥ 源(放大/等比)→ 最近邻;缩小 → 区域平均(走 mip)
      let level = 0;
      if (sampling !== 'nearest') {
        const shrink = 1 / Math.max(det, 1e-9); // 源/目标
        if (shrink > 1) level = Math.max(0, Math.min(bm.mips.length - 1, Math.round(Math.log2(shrink))));
        if (sampling === 'nearest') level = 0;
        if (sampling === 'smooth') level = Math.max(level, 1); // 强制平滑时至少用一级 mip
      }
      const tp = bm.mips[level];
      const tw = tp.w, th = tp.h;
      const mipScale = bm.w / tp.w;   // 原图 → 当前 mip 的坐标换算
      // 目标包围盒:变换后四角(原图坐标系)
      const corners = [[0, 0], [bm.w, 0], [bm.w, bm.h], [0, bm.h]];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const c of corners) {
        const px = M[0] * c[0] + M[2] * c[1] + M[4];
        const py = M[1] * c[0] + M[3] * c[1] + M[5];
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
      const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(W - 1, Math.ceil(maxX));
      const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H - 1, Math.ceil(maxY));
      const fb = machine.fb;
      const rep = optRepeat(id);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const fx = x + 0.5, fy = y + 0.5;
          let u = (inv[0] * fx + inv[2] * fy + inv[4]) / mipScale;
          let v = (inv[1] * fx + inv[3] * fy + inv[5]) / mipScale;
          if (u < 0 || u >= tw || v < 0 || v >= th) {
            if (!rep) continue;
            u = ((u % tw) + tw) % tw; v = ((v % th) + th) % th;
          }
          const si = (v | 0) * tw + (u | 0);
          if (!tp.tmask[si]) fb[y * W + x] = tp.px[si];
        }
      }
    }

    // 直接位块(恒等矩阵快路径)
    m2.blitFast = (id, x, y) => {
      const bm = bitmaps.get(id);
      if (!bm) return;
      const fb = machine.fb;
      const x0 = Math.max(0, x | 0), y0 = Math.max(0, y | 0);
      const x1 = Math.min(W, (x | 0) + bm.w), y1 = Math.min(H, (y | 0) + bm.h);
      for (let yy = y0; yy < y1; yy++) {
        const sy = yy - y;
        const row = yy * W;
        for (let xx = x0; xx < x1; xx++) {
          const si = sy * bm.w + (xx - x);
          if (!bm.tmask[si]) fb[row + xx] = bm.px[si];
        }
      }
    };

    // ---- 文本(§7.4:14×14 网格,步进 12) ----
    m2.text = (x, y, str, opt) => {
      opt = opt || {};
      const color = (opt.color != null ? opt.color : 15) & 0xFF;
      const scale = opt.scale || 1;
      const font = machine.fonts[opt.font || (machine.fonts.cart ? 'cart' : 'bios')] || machine.fonts.bios;
      str = String(str);
      const simple = isIdent(mat) && scale === Math.round(scale);
      let cx = x;
      for (let i = 0; i < str.length; i++) {
        const cp = str.codePointAt(i);
        if (cp > 0xFFFF) i++;
        const g = font.get(cp) || font.get(63) || font.get(32);
        if (!g) { cx += 12 * scale; continue; }
        if (simple) {
          drawGlyphSimple(g, cx, y, color, scale);
        } else {
          drawGlyphTransformed(g, cx, y, color, scale);
        }
        cx += 12 * scale;
      }
    };

    function drawGlyphSimple(g, x, y, color, scale) {
      const fb = machine.fb;
      // 网格:列 0..13(0-1 入侵区),行 0..13(12-13 尾部区);原点 = 网格列 2 行 0
      const gx0 = x - 2 * scale, gy0 = y;
      const X0 = Math.max(0, gx0), X1 = Math.min(W, gx0 + 14 * scale);
      const Y0 = Math.max(0, gy0), Y1 = Math.min(H, gy0 + 14 * scale);
      for (let yy = Y0; yy < Y1; yy++) {
        const gry = ((yy - gy0) / scale) | 0;
        const bits = g[gry];
        if (!bits) continue;
        const row = yy * W;
        for (let xx = X0; xx < X1; xx++) {
          const gcl = ((xx - gx0) / scale) | 0;
          if ((bits >> gcl) & 1) fb[row + xx] = color;
        }
      }
    }

    function drawGlyphTransformed(g, x, y, color, scale) {
      // 网格 → 屏幕:先缩放到 scale(网格原点 = (x-2s, y)),再走全局矩阵
      const M = matMul(mat, [scale, 0, 0, scale, x - 2 * scale, y]);
      const inv = matInv(M);
      if (!inv) return;
      const corners = [[0, 0], [14, 0], [14, 14], [0, 14]];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const c of corners) {
        const px = M[0] * c[0] + M[2] * c[1] + M[4];
        const py = M[1] * c[0] + M[3] * c[1] + M[5];
        minX = Math.min(minX, px); maxX = Math.max(maxX, px);
        minY = Math.min(minY, py); maxY = Math.max(maxY, py);
      }
      const x0 = Math.max(0, Math.floor(minX)), x1 = Math.min(W - 1, Math.ceil(maxX));
      const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(H - 1, Math.ceil(maxY));
      const fb = machine.fb;
      for (let yy = y0; yy <= y1; yy++) {
        for (let xx = x0; xx <= x1; xx++) {
          const fx = xx + 0.5, fy = yy + 0.5;
          const u = inv[0] * fx + inv[2] * fy + inv[4];
          const v = inv[1] * fx + inv[3] * fy + inv[5];
          if (u < 0 || u >= 14 || v < 0 || v >= 14) continue;
          if ((g[v | 0] >> (u | 0)) & 1) fb[yy * W + xx] = color;
        }
      }
    }

    function xf(x, y) {
      return [mat[0] * x + mat[2] * y + mat[4], mat[1] * x + mat[3] * y + mat[5]];
    }

    // ---- 矢量光栅化(装载期,§6.4.2) ----
    function rasterizeVector(vec, pool) {
      const w = vec.w | 0, h = vec.h | 0;
      const px = new Uint8Array(w * h), tmask = new Uint8Array(w * h).fill(1);
      const mark = new Uint8Array(w * h); // 1 = 覆盖
      // 展平路径(贝塞尔 12 段)
      const polys = [];
      for (const path of vec.paths) {
        const pts = [];
        let cx = 0, cy = 0;
        for (const seg of path.d) {
          const k = seg[0];
          if (k === 'm') { cx = seg[1]; cy = seg[2]; pts.push([cx, cy]); }
          else if (k === 'l') { cx = seg[1]; cy = seg[2]; pts.push([cx, cy]); }
          else if (k === 'q') {
            const x1 = seg[1], y1 = seg[2], x2 = seg[3], y2 = seg[4];
            for (let i = 1; i <= 12; i++) {
              const t = i / 12, mt = 1 - t;
              pts.push([mt * mt * cx + 2 * mt * t * x1 + t * t * x2, mt * mt * cy + 2 * mt * t * y1 + t * t * y2]);
            }
            cx = x2; cy = y2;
          }
        }
        if (pts.length >= 3) polys.push({ pts, path });
      }
      // 扫描线填充(even-odd)
      for (const { pts, path } of polys) {
        if (path.fill == null && !path.tex) continue;
        const xs = [];
        for (let y = 0; y < h; y++) {
          xs.length = 0;
          const cy = y + 0.5;
          const n = pts.length;
          for (let i = 0; i < n; i++) {
            const a = pts[i], b = pts[(i + 1) % n];
            if ((a[1] <= cy && b[1] > cy) || (b[1] <= cy && a[1] > cy)) {
              xs.push(a[0] + (cy - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
            }
          }
          xs.sort((p, q) => p - q);
          for (let i = 0; i + 1 < xs.length; i += 2) {
            const s = Math.max(0, Math.round(xs[i])), e = Math.min(w - 1, Math.round(xs[i + 1]) - 1);
            for (let x = s; x <= e; x++) mark[y * w + x] = 1;
          }
        }
      }
      // 着色
      for (const { pts, path } of polys) {
        const color = path.fill;
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!mark[i]) continue;
          let c = color;
          if (path.tex) {
            const tex = pool.get(path.tex);
            if (tex) {
              const u = Math.min(tex.w - 1, (x * (path.texScale || 1)) | 0);
              const v = Math.min(tex.h - 1, (y * (path.texScale || 1)) | 0);
              const si = v * tex.w + u;
              if (tex.tmask[si]) continue;
              c = tex.px[si];
            }
          }
          if (c == null) continue;
          px[i] = c & 0xFF; tmask[i] = 0;
        }
      }
      // 描边
      for (const { pts, path } of polys) {
        if (path.stroke == null) continue;
        const c = path.stroke & 0xFF, wd = path.width || 1;
        const drawLn = (x0, y0, x1, y1) => {
          let dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
          let sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1, err = dx + dy;
          let guard = 1e6;
          while (guard-- > 0) {
            for (let j = 0; j < wd; j++) for (let i = 0; i < wd; i++) {
              const xx = (x0 | 0) + i, yy = (y0 | 0) + j;
              if (xx >= 0 && xx < w && yy >= 0 && yy < h) { px[yy * w + xx] = c; tmask[yy * w + xx] = 0; }
            }
            if (x0 === x1 && y0 === y1) break;
            const e2 = 2 * err;
            if (e2 >= dy) { err += dy; x0 += sx; }
            if (e2 <= dx) { err += dx; y0 += sy; }
          }
        };
        for (let i = 0; i + 1 < pts.length; i++) drawLn(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
        if (path.close && pts.length > 2) drawLn(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]);
      }
      return { w, h, px, tmask };
    }

    reset();
    return m2;
  }

  AC2.createMode2 = createMode2;
  AC2.M2Math = { matMul, matInv };
})();
