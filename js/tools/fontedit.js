/* js/tools/fontedit.js — 字体编辑器(§13.3):14×14 三区网格,预览条 + 试排,AFNT v2 导出 */
(function () {
  'use strict';
  const { ANSI } = AC2;
  const $ = (id) => document.getElementById(id);

  const ZONE_MAIN = '#2a2a34', ZONE_INV = '#3a2a3a', ZONE_TAIL = '#2a3a3a';
  const state = {
    font: null,          // AC2.Font
    cp: 65,
    zoom: 18,
    grid: new Uint16Array(14)   // 当前编辑字形(14bit 行)
  };

  function glyphRows(font, cp) {
    return font.get(cp) || new Uint16Array(14);
  }

  function loadGlyph() {
    state.grid = glyphRows(state.font, state.cp).slice();
  }
  function storeGlyph() {
    state.font.set(state.cp, state.grid.slice());
  }

  function renderEditor() {
    const z = state.zoom;
    const cv = $('glyph');
    cv.width = 14 * z; cv.height = 14 * z;
    const ctx = cv.getContext('2d');
    // 三区底色:列 0-1 入侵区(紫)、行 12-13 尾部区(青)、主区(灰)—— 三区着色区分(§13.3)
    for (let y = 0; y < 14; y++) for (let x = 0; x < 14; x++) {
      ctx.fillStyle = x < 2 ? ZONE_INV : (y >= 12 ? ZONE_TAIL : ZONE_MAIN);
      ctx.fillRect(x * z, y * z, z, z);
    }
    ctx.fillStyle = '#e8e8f0';
    for (let y = 0; y < 14; y++) for (let x = 0; x < 14; x++) {
      if ((state.grid[y] >> x) & 1) ctx.fillRect(x * z + 1, y * z + 1, z - 2, z - 2);
    }
    // 基线/行高参考线:主区底 y=12(步进边界),基线 y=9
    ctx.strokeStyle = 'rgba(122,162,247,0.5)';
    ctx.beginPath();
    ctx.moveTo(0, 12 * z + 0.5); ctx.lineTo(cv.width, 12 * z + 0.5);
    ctx.moveTo(2 * z + 0.5, 0); ctx.lineTo(2 * z + 0.5, cv.height);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(110,207,142,0.35)';
    ctx.beginPath(); ctx.moveTo(0, 9 * z + 0.5); ctx.lineTo(cv.width, 9 * z + 0.5); ctx.stroke();
  }

  // 上下文预览条:相邻字符连排,展示入侵/尾部溢出(§13.3)
  function renderPreview() {
    const cps = state.font.codepoints();
    const idx = Math.max(0, cps.indexOf(state.cp));
    const neighbors = cps.slice(Math.max(0, idx - 6), idx + 7);
    const str = String.fromCodePoint(...neighbors);
    renderTextCanvas($('preview'), str, 2, 250);
    renderTextCanvas($('testStr'), $('testInput').value || 'AVype 测试 0123', 2, 15);
    renderTextCanvas($('testTight'), $('testInput').value || 'AVype 测试 0123', 2, 15, true);
  }

  function renderTextCanvas(cv, str, scale, color, tight) {
    const lineH = tight ? 12 : 14;
    const lines = String(str).split('\n');
    const w = Math.max(60, Math.max(...lines.map(l => l.length)) * 12 * scale + 8);
    const h = lines.length * lineH * scale + 8;
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = ANSI.css(color);
    let y = 4;
    for (const line of lines) {
      let x = 4;
      for (const ch of line) {
        const g = state.font.get(ch.codePointAt(0));
        if (g) {
          for (let gy = 0; gy < 14; gy++) {
            const bits = g[gy];
            if (!bits) continue;
            for (let gx = 0; gx < 14; gx++) {
              if ((bits >> gx) & 1) ctx.fillRect((x - 2 * scale) + gx * scale, y + gy * scale, scale, scale);
            }
          }
        }
        x += 12 * scale;
      }
      y += lineH * scale;
    }
    cv.style.width = (w * 2) + 'px';
    cv.style.height = (h * 2) + 'px';
  }

  function renderList() {
    const list = $('glyphList');
    list.innerHTML = '';
    const cps = state.font.codepoints();
    const frag = document.createDocumentFragment();
    for (const cp of cps) {
      const b = document.createElement('button');
      const ch = String.fromCodePoint(cp);
      b.textContent = cp === 32 ? '␠' : cp > 126 ? ch : ch;
      b.title = 'U+' + cp.toString(16).toUpperCase().padStart(4, '0');
      if (cp === state.cp) b.classList.add('primary');
      b.onclick = () => {
        storeGlyph();
        state.cp = cp;
        loadGlyph();
        renderEditor(); renderList(); renderPreview();
      };
      frag.appendChild(b);
    }
    list.appendChild(frag);
    $('cpLabel').textContent = 'U+' + state.cp.toString(16).toUpperCase().padStart(4, '0') + ' (' + state.cp + ')';
  }

  function download(buf, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([buf]));
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  const hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (hasDOM) window.addEventListener('DOMContentLoaded', () => {
    state.font = AC2.Font.fromBuiltin();
    // 恢复草稿
    try {
      const d = JSON.parse(localStorage.getItem('fe.draft') || 'null');
      if (d && d.glyphs) {
        for (const g of d.glyphs) state.font.set(g[0], Uint16Array.from(g[1]));
      }
    } catch (e) { }
    loadGlyph();
    renderEditor(); renderList(); renderPreview();

    // 编辑
    const cv = $('glyph');
    let drawing = false;
    const paint = (e) => {
      const r = cv.getBoundingClientRect();
      const z = state.zoom;
      const x = Math.floor((e.clientX - r.left) / z), y = Math.floor((e.clientY - r.top) / z);
      if (x < 0 || y < 0 || x >= 14 || y >= 14) return;
      const bit = e.buttons === 2 ? 0 : 1;
      if (bit) state.grid[y] |= (1 << x); else state.grid[y] &= ~(1 << x);
      renderEditor();
    };
    cv.addEventListener('mousedown', (e) => { drawing = true; paint(e); e.preventDefault(); });
    cv.addEventListener('mousemove', (e) => { if (drawing) paint(e); });
    window.addEventListener('mouseup', () => {
      if (drawing) {
        storeGlyph();
        renderList(); renderPreview();
        try {
          localStorage.setItem('fe.draft', JSON.stringify({
            glyphs: state.font.codepoints().map(cp => [cp, Array.from(state.font.get(cp))])
          }));
        } catch (e) { }
      }
      drawing = false;
    });
    cv.addEventListener('contextmenu', (e) => e.preventDefault());

    // 工具
    $('clearGlyph').onclick = () => { state.grid = new Uint16Array(14); storeGlyph(); renderEditor(); renderPreview(); };
    $('shiftL').onclick = () => { for (let y = 0; y < 14; y++) state.grid[y] = ((state.grid[y] << 1) & 0x3FFF); storeGlyph(); renderEditor(); renderPreview(); };
    $('shiftR').onclick = () => { for (let y = 0; y < 14; y++) state.grid[y] = state.grid[y] >> 1; storeGlyph(); renderEditor(); renderPreview(); };
    $('shiftU').onclick = () => { for (let y = 0; y < 13; y++) state.grid[y] = state.grid[y + 1]; state.grid[13] = 0; storeGlyph(); renderEditor(); renderPreview(); };
    $('shiftD').onclick = () => { for (let y = 13; y > 0; y--) state.grid[y] = state.grid[y - 1]; state.grid[0] = 0; storeGlyph(); renderEditor(); renderPreview(); };

    // 码点
    $('addCp').onclick = () => {
      const v = parseInt($('newCp').value.replace(/^u\+/i, ''), 16);
      if (!isNaN(v) && v > 0) {
        if (!state.font.has(v)) state.font.set(v, new Uint16Array(14));
        state.cp = v;
        loadGlyph();
        renderEditor(); renderList(); renderPreview();
      }
    };
    $('delCp').onclick = () => {
      if (state.cp < 32 || state.cp > 126) { state.font.map.delete(state.cp); state.cp = 65; loadGlyph(); renderEditor(); renderList(); renderPreview(); }
    };
    $('testInput').oninput = () => renderPreview();

    // 导入/导出
    $('exportAfnt').onclick = () => download(state.font.serialize(), 'font.afnt');
    $('importAfnt').onclick = () => $('afntFile').click();
    $('afntFile').onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        state.font = AC2.Font.parse(new Uint8Array(await f.arrayBuffer()));
        state.cp = 65;
        loadGlyph();
        renderEditor(); renderList(); renderPreview();
      } catch (err) { alert('导入失败: ' + err.message); }
      e.target.value = '';
    };
    $('resetBios').onclick = () => {
      state.font = AC2.Font.fromBuiltin();
      state.cp = 65;
      loadGlyph(); renderEditor(); renderList(); renderPreview();
    };
  });

  AC2.FontEdit = { state, loadGlyph, storeGlyph };
})();
