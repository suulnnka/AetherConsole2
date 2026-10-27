/*
 * tools/editor-common.js — 编辑器共用工具(AC2 版,自 AC1 搬运)
 * 提供:DOM 构建、toast、文件下载/读取、索引色画布渲染(ANSI 256 色)、
 *       草稿存取、卡带源文件抓取(试玩用)。
 * 依赖:页面需先加载 js/core/ansi.js(AC2.ANSI);无模块,file:// 下除 fetch 外可用。
 */
(function () {
  'use strict';

  /* 编辑器脚本异常落到 window.__lastErr,便于控制台/自动化排查 */
  window.addEventListener('error', e => {
    try { window.__lastErr = String(e.message) + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0); } catch (err) {}
  });

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'style') n.style.cssText = attrs[k];
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    }
    for (const kid of kids) if (kid != null) n.append(kid);
    return n;
  }

  function toast(msg, opts) {
    const o = typeof opts === 'object' ? opts : { err: opts === true, ms: opts };
    let host = document.getElementById('toasts');
    if (!host) { host = el('div', { id: 'toasts' }); document.body.append(host); }
    const t = el('div', { class: 'toast' + (o.err ? ' err' : '') }, msg);
    host.append(t);
    setTimeout(() => t.remove(), o.ms || 2600);
    return t;
  }

  function download(name, data, mime) {
    const blob = data instanceof Blob ? data
      : new Blob([data], { type: mime || 'application/octet-stream' });
    const a = el('a', { href: URL.createObjectURL(blob), download: name });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }

  function pickFile(accept, asText) {
    return new Promise((resolve) => {
      const inp = el('input', { type: 'file', accept });
      inp.addEventListener('change', () => {
        const f = inp.files[0];
        if (!f) return resolve(null);
        const r = new FileReader();
        r.onload = () => resolve({ name: f.name, data: r.result });
        if (asText === 'text') r.readAsText(f); else r.readAsArrayBuffer(f);
      });
      inp.click();
    });
  }

  /* —— ANSI 256 色表(编辑器渲染统一走主机唯一色彩空间;惰性构建,容忍先于 ansi.js 加载)—— */
  let _rgb = null, _lut = null;
  function buildTables() {
    if (_lut) return;
    const t = (window.AC2 && AC2.ANSI && AC2.ANSI.rgbTable) ? AC2.ANSI.rgbTable : null;
    if (!t) throw new Error('editor-common 需要 js/core/ansi.js(AC2.ANSI)');
    _rgb = new Array(256);
    for (let i = 0; i < 256; i++) _rgb[i] = [t[i * 3], t[i * 3 + 1], t[i * 3 + 2]];
    _lut = new Uint32Array(256).fill(0xFF000000);
    _rgb.forEach((c, i) => { _lut[i] = 0xFF000000 | (c[2] << 16) | (c[1] << 8) | c[0]; });
  }

  /* —— 索引色画布:数据(u8,每像素一个 ANSI 下标)→ ImageData —— */
  function renderIndexed(canvas, data, w, h) {
    buildTables();
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const px = new Uint32Array(img.data.buffer);
    for (let i = 0; i < data.length; i++) px[i] = _lut[data[i]];
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /* —— 卡带源文件抓取(编辑器试玩 = 现场重打包真实 .aec)—— */
  async function fetchFiles(base, paths) {
    const out = [];
    for (const p of paths) {
      const r = await fetch(base + p);
      if (!r.ok) throw new Error('抓取失败 ' + base + p + '(HTTP ' + r.status +
        ')——请用本地 HTTP 服务打开工具页(如 python -m http.server)');
      out.push({ path: p, data: new Uint8Array(await r.arrayBuffer()) });
    }
    return out;
  }

  /* —— 草稿(localStorage,自动保存)—— */
  const draft = {
    save(key, obj) {
      try { localStorage.setItem(key, JSON.stringify(obj)); return true; }
      catch (e) { return false; }
    },
    load(key) {
      try {
        const s = localStorage.getItem(key);
        return s ? JSON.parse(s) : null;
      } catch (e) { return null; }
    },
    clear(key) { try { localStorage.removeItem(key); } catch (e) {} },
  };

  /* —— 通用小件 —— */
  function dialog(build) {  // build(dlg) 自行填充内容;返回关闭函数
    const ov = el('div', { class: 'overlay' });
    const dlg = el('div', { class: 'dlg' });
    ov.append(dlg);
    ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
    document.body.append(ov);
    function close() { ov.remove(); }
    build(dlg, close);
    return close;
  }

  const api = {
    el, toast, download, pickFile, dialog,
    renderIndexed, fetchFiles, draft,
  };
  Object.defineProperty(api, 'ansiLut', { get() { buildTables(); return _lut; } });
  Object.defineProperty(api, 'ansiRGB', { get() { buildTables(); return _rgb; } });
  window.AC = api;
})();
