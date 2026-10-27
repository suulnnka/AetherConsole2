/* js/core/packer.js — 打包核心(§13.5):文件夹即项目,自动识别 → 段压缩 → 容器组装
 * 浏览器与 Node 共用(纯函数,files = [{path, data}])。
 * 项目结构约定:
 *   cart.json   {id,title,version,mode,sampling}
 *   cover.png | cover.bin(1024B ANSI)
 *   main.ajs | code/*.ajs(多文件按文件名序拼接)
 *   font.afnt
 *   gfx/*.til(tileset)/ gfx/*.map(MAP2)/ gfx/*.bm2 / gfx/*.vec / gfx/*.json(→data)
 *   audio/*.aud(JSON)
 *   data/*(自由只读数据)
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};

  const EXT_TYPE = {
    '.ajs': 'code', '.til': 'tiles', '.map': 'maps', '.bm2': 'bitmaps', '.vec': 'vectors',
    '.aud': 'audio', '.afnt': 'font', '.json': 'data', '.bin': 'data', '.dat': 'data', '.txt': 'data'
  };

  function parseCartJson(files) {
    const cj = files.find(f => f.path.toLowerCase() === 'cart.json');
    let m = {};
    if (cj) { try { m = JSON.parse(new TextDecoder().decode(cj.data)); } catch (e) { throw new Error('cart.json 解析失败: ' + e.message); } }
    let id = String(m.id || '').toUpperCase();
    if (!id && !cj) id = 'AC2TEMP1';  // 无 cart.json:整体用默认 manifest(§13.5 缺失项给默认值)
    if (!/^[A-Z0-9]{8}$/.test(id)) throw new Error('游戏 ID 必须为 8 字符 [A-Z0-9](cart.json: "id")');
    return {
      id,
      title: String(m.title || id),
      version: m.version | 0 || 1,
      mode: Number(m.mode) === 2 ? 2 : 1,
      sampling: ['auto', 'nearest', 'smooth'].includes(m.sampling) ? m.sampling : 'auto',
      raw: m
    };
  }

  async function buildFromFiles(files, opts) {
    opts = opts || {};
    const { Cart } = AC2;
    const manifest = parseCartJson(files);
    const rel = (f) => f.path.replace(/\\/g, '/');

    // 封面
    let cover = null;
    const covBin = files.find(f => rel(f).toLowerCase() === 'cover.bin');
    if (covBin) {
      if (covBin.data.length !== 1024) throw new Error('cover.bin 必须 1024B');
      cover = covBin.data;
    } else {
      const covPng = files.find(f => rel(f).toLowerCase() === 'cover.png');
      if (covPng) cover = await quantizePng32(covPng.data); // 浏览器 canvas / Node 无则报错
    }
    if (!cover) throw new Error('缺封面:需要 cover.png 或 cover.bin(32×32)');

    // 代码:main.ajs 或 code/*.ajs
    const codeFiles = [];
    const main = files.find(f => rel(f).toLowerCase() === 'main.ajs');
    if (main) codeFiles.push(main);
    for (const f of files) {
      const r = rel(f);
      if (r.toLowerCase().startsWith('code/') && r.toLowerCase().endsWith('.ajs')) codeFiles.push(f);
    }
    if (!codeFiles.length) throw new Error('缺代码:需要 main.ajs 或 code/*.ajs');
    codeFiles.sort((a, b) => rel(a).localeCompare(rel(b)));
    let code = '';
    for (const f of codeFiles) code += new TextDecoder().decode(f.data) + '\n;\n';

    const segments = [{ type: 'code', name: codeFiles.map(f => rel(f)).join('+'), data: new TextEncoder().encode(code) }];

    // 资源段
    for (const f of files) {
      const r = rel(f);
      const low = r.toLowerCase();
      if (low === 'cart.json' || low === 'cover.bin' || low === 'cover.png' || low === 'main.ajs') continue;
      if (low.startsWith('code/') && low.endsWith('.ajs')) continue;
      const ext = low.slice(low.lastIndexOf('.'));
      if (ext === '.til') {
        // .til 头带 kind(0=bg,1=obj)
        const dv = new DataView(f.data.buffer, f.data.byteOffset, f.data.byteLength);
        const kind = dv.getUint8(6);  // TIL2: magic4 + count2 + kind1(byte6)
        segments.push({ type: kind === 1 ? 'tilesobj' : 'tilesbg', name: r, data: f.data });
      } else {
        const t = EXT_TYPE[ext] || 'data';
        segments.push({ type: t, name: r, data: f.data });
      }
    }

    // 组装 + 预算报告
    const bytes = await Cart.build({
      id: manifest.id, title: manifest.title, version: manifest.version, mode: manifest.mode,
      sampling: manifest.sampling, segments, obfuscate: !!opts.obfuscate, cover
    });

    // 报告:各段压缩前后
    const detail = [];
    let rawSum = 0, compSum = 64 + 1024 + segments.length * 16;
    const Comp = AC2.Comp;
    for (const s of segments) {
      const comp = await Comp.compress(s.data);
      const use = comp.length < s.data.length * 0.95 ? comp : null;
      detail.push({ name: s.name || '(meta)', type: s.type, raw: s.data.length, comp: use ? use.length : s.data.length, compressed: !!use });
      rawSum += s.data.length;
      compSum += use ? use.length : s.data.length;
    }
    const report = {
      id: manifest.id, title: manifest.title, version: manifest.version, mode: manifest.mode,
      obfuscated: !!opts.obfuscate, segments: detail, rawTotal: rawSum, cartBytes: bytes.length,
      limit: Cart.LIMIT, ok: bytes.length <= Cart.LIMIT, margin: Cart.LIMIT - bytes.length,
      warnings: []
    };
    if (!report.ok) {
      const big = detail.slice().sort((a, b) => b.raw - a.raw)[0];
      const msg = '超限:卡带 ' + bytes.length + 'B > 256KB;最大段 ' + (big && big.name) + '(' + (big && big.raw) + 'B)';
      report.warnings.push(msg);
      const err = new Error(msg);
      err.report = report;
      throw err;   // 256KB 硬上限:超限拒绝出品(§11.1)
    }
    return { bytes, report, manifest };
  }

  async function quantizePng32(pngBytes) {
    if (typeof document === 'undefined') throw new Error('Node 构建请用 cover.bin(32×32 ANSI 原始 1024B)');
    const blob = new Blob([pngBytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('cover.png 无法解码')); img.src = url; });
    const cv = document.createElement('canvas');
    cv.width = 32; cv.height = 32;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, 32, 32);
    const id = ctx.getImageData(0, 0, 32, 32);
    URL.revokeObjectURL(url);
    const out = new Uint8Array(1024);
    for (let i = 0; i < 1024; i++) {
      const a = id.data[i * 4 + 3];
      out[i] = a < 96 ? 16 : AC2.ANSI.fromRgbFast(id.data[i * 4], id.data[i * 4 + 1], id.data[i * 4 + 2]);
    }
    return out;
  }

  // 装带冒烟(无头内核跑 N 帧,§13.5 校验)
  async function smoke(bytes, frames) {
    frames = frames || 90;
    const cart = await AC2.Cart.load(bytes);
    const M = new AC2.Machine({ bios: false });
    let err = null;
    M.onError = (e) => { err = e; };
    try { M.bootCart(cart); } catch (e) { return { ok: false, error: String(e.message || e), stage: 'boot' }; }
    if (err) return { ok: false, error: err.message, stage: 'init', stack: err.stack };
    for (let i = 0; i < frames; i++) {
      M.step();
      if (M.halted) return { ok: false, error: M.error.message, stage: 'frame ' + M.error.frame, stack: M.error.stack };
    }
    return { ok: true, frames, logicMs: M.stats.logicMs, drawMs: M.stats.drawMs, audioMs: M.stats.audioMs };
  }

  // 游戏 ID 登记(本地 registry 防冲突,§13.5)
  const Registry = {
    _st() {
      if (typeof localStorage !== 'undefined') return localStorage;
      if (!this._mem) this._mem = new Map();
      return {
        getItem: (k) => this._mem.has(k) ? this._mem.get(k) : null,
        setItem: (k, v) => { this._mem.set(k, String(v)); },
        removeItem: (k) => { this._mem.delete(k); }
      };
    },
    all() { try { return JSON.parse(this._st().getItem('ac2.registry') || '[]'); } catch (e) { return []; } },
    check(id, version) {
      const hit = this.all().find(r => r.id === id);
      if (!hit) return null;
      if (version <= hit.version) return 'ID ' + id + ' 已登记 v' + hit.version + '(重复或更低)';
      return null;
    },
    register(id, title, version) {
      const all = this.all().filter(r => r.id !== id);
      all.push({ id, title, version, when: Date.now() || 0 });
      this._st().setItem('ac2.registry', JSON.stringify(all));
    },
    remove(id) { this._st().setItem('ac2.registry', JSON.stringify(this.all().filter(r => r.id !== id))); }
  };

  AC2.Packer = { buildFromFiles, smoke, Registry, EXT_TYPE };
})();
