/* js/tools/debugger.js — 模拟器即调试器(§13.6/M11)
 * 同一程序:收起面板即纯运行器,展开即全功能调试器。
 * 运行控制(含步退)/断点(行/API)/状态视图(VRAM/OAM/ARAM/音频/性能)/虚拟手柄/录制回放/导出。
 */
(function () {
  'use strict';
  const { ANSI, Mulaw } = AC2;
  const $ = (id) => document.getElementById(id);

  const KEYMAP = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
    KeyZ: 'a', KeyJ: 'a', KeyX: 'b', KeyK: 'b', Space: 'b', Enter: 'start'
  };

  const dbg = {
    machine: null, shell: null,
    speed: 1,
    running: true,
    frames: [],
    recording: false,
    replaying: false,
    lastT: 0,
    keys: {},
    curTab: 'src',
    showPanel: true,
    preMulaw: false
  };

  function log(line, cls) {
    const el = $('log');
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = line;
    el.appendChild(div);
    while (el.children.length > 300) el.removeChild(el.firstChild);
    el.scrollTop = 1e9;
  }

  // ---------- 主循环(固定步长,速度倍率 ≤8) ----------
  function tick(now) {
    requestAnimationFrame(tick);
    if (now - dbg.lastT < 15.5) { render(); return; }
    dbg.lastT = now;
    const m = dbg.machine;
    if (!m) { render(); return; }
    const steps = (m.paused || m.breakHit || m.halted) ? 0 : dbg.speed;
    for (let i = 0; i < steps; i++) {
      m.input.pushInput(sampleInput());
      m.step();
      if (dbg.recording) dbg.frames.push(m.fb.slice());
      if (dbg.replaying && m.input.replay && m.input.replay.i >= (m.input.replay.frames.length)) { dbg.replaying = false; log('回放结束'); }
      if (m.breakHit || m.halted) break;
    }
    if (m.breakHit && !dbg._bpLogged) {
      dbg._bpLogged = true;
      log('⏸ 断点 @' + m.breakHit.type + ' ' + m.breakHit.info + ' (frame ' + m.breakHit.frame + ')', 'warn');
      refreshAll();
    }
    render();
    updateHud();
  }

  function sampleInput() {
    const k = dbg.keys;
    return {
      keys: { up: !!k.up, down: !!k.down, left: !!k.left, right: !!k.right, a: !!k.a, b: !!k.b, start: !!k.start },
      x: 120, y: 88, dx: 0, dy: 0
    };
  }

  function render() {
    const m = dbg.machine;
    if (!m) return;
    const cv = $('scr');
    const ctx = cv.getContext('2d');
    const img = ctx.getImageData(0, 0, 240, 176);
    const u32 = new Uint32Array(img.data.buffer);
    for (let i = 0; i < m.fb.length; i++) {
      const c = m.fb[i];
      u32[i] = (0xFF << 24) | (ANSI.rgbTable[c * 3 + 2] << 16) | (ANSI.rgbTable[c * 3 + 1] << 8) | ANSI.rgbTable[c * 3];
    }
    ctx.putImageData(img, 0, 0);
    // OAM 覆盖视图
    if (dbg.curTab === 'oam' && m.mode === 1) {
      ctx.strokeStyle = '#00ffff';
      for (let i = 0; i < 128; i++) {
        const s = m.m1.oam[i];
        if (!s.vis) continue;
        const size = s.big ? 16 : 8;
        ctx.globalAlpha = s.prio >= 2 ? 1 : 0.55;
        ctx.strokeRect(s.x + 0.5, s.y + 0.5, size - 1, size - 1);
      }
      ctx.globalAlpha = 1;
    }
  }

  function updateHud() {
    const m = dbg.machine;
    const s = m.stats;
    $('hud').innerHTML =
      'state <b>' + m.state + (m.paused ? '(paused)' : '') + (m.breakHit ? '(BREAK)' : '') + (m.halted ? '(HALT)' : '') + '</b>' +
      ' mode <b>' + m.mode + '</b> frame <b>' + m.frameCount + '</b>' +
      ' 逻辑 <b>' + s.logicMs.toFixed(2) + '</b> 合成 <b>' + s.drawMs.toFixed(2) + '</b> 音频 <b>' + s.audioMs.toFixed(2) + 'ms</b>' +
      ' 超帧率 <b>' + (s.overRate * 100).toFixed(1) + '%</b>' +
      ' 每线丢弃 <b>' + m.m1.droppedLines + '</b> 快照 <b>' + m.snapshots.length + '</b>';
  }

  // ---------- 装载 ----------
  async function loadCartBytes(bytes, label) {
    const m = new AC2.Machine({});
    m._snapOn = true;
    m.onError = (e) => {
      log('✗ 停机 @frame ' + e.frame + ': ' + e.message, 'err');
      if (e.stack) log(e.stack.split('\n').slice(0, 6).join('\n'), 'err');
      m.audio && m.audio.stopAll();
    };
    let cart;
    try {
      cart = await AC2.Cart.load(bytes);
    } catch (e) {
      log('卡带装载失败: ' + e.message, 'err');
      return;
    }
    m.bootCart(cart);
    dbg.machine = m;
    dbg.frames = [];
    log('装入 ' + cart.id + ' "' + cart.title + '" v' + cart.version + ' mode' + cart.mode + (label ? ' (' + label + ')' : ''));
    // 调试钩子
    m.debugHooks.onApiCall = (name) => {
      m.haltByBp('api', name);
      dbg._bpLogged = false;
    };
    m.debugHooks.onLineBp = (line) => {
      m.haltByBp('line', 'L' + line);
      dbg._bpLogged = false;
    };
    m.biosPrint = undefined; // 保留默认实现
    // 源码面板
    const codeSeg = cart.seg('code', 0);
    dbg.src = codeSeg ? new TextDecoder().decode(codeSeg.data) : '(无 code 段)';
    renderSource();
    refreshAll();
  }

  // ---------- 源码 + 行断点 ----------
  function renderSource() {
    const el = $('srcView');
    el.innerHTML = '';
    const lines = (dbg.src || '').split('\n');
    lines.forEach((line, i) => {
      const n = i + 1;
      const row = document.createElement('div');
      row.className = 'srcLine';
      const num = document.createElement('span');
      num.className = 'ln';
      num.textContent = n;
      const mark = document.createElement('span');
      mark.className = 'bpmk';
      if (dbg.machine && dbg.machine.debugHooks.bpLines.has(n)) mark.classList.add('on');
      mark.textContent = dbg.machine && dbg.machine.debugHooks.bpLines.has(n) ? '●' : '·';
      mark.onclick = () => {
        const set = dbg.machine.debugHooks.bpLines;
        set.has(n) ? set.delete(n) : set.add(n);
        renderSource();
      };
      row.appendChild(num);
      row.appendChild(mark);
      const code = document.createElement('span');
      code.textContent = line.length > 200 ? line.slice(0, 200) + '…' : line;
      row.appendChild(code);
      el.appendChild(row);
    });
  }

  // ---------- 状态视图 ----------
  function drawTilesInto(cv, colors, mask, count) {
    const cols = Math.min(32, Math.max(1, Math.ceil(Math.sqrt(count) * 2)));
    const rows = Math.ceil(count / cols);
    const z = 2;
    cv.width = cols * 8 * z; cv.height = rows * 8 * z;
    cv.style.width = cv.width + 'px';
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#111'; ctx.fillRect(0, 0, cv.width, cv.height);
    for (let t = 0; t < count && t < 1024; t++) {
      for (let y = 0; y < 8; y++) {
        const mrow = mask[t * 8 + y];
        for (let x = 0; x < 8; x++) {
          if (!(mrow & (1 << x))) {
            ctx.fillStyle = ANSI.css(colors[t * 64 + y * 8 + x]);
            ctx.fillRect(((t % cols) * 8 + x) * z, (((t / cols) | 0) * 8 + y) * z, z, z);
          }
        }
      }
    }
  }

  function refreshVRAM() {
    const m = dbg.machine;
    if (!m) return;
    drawTilesInto($('vramBg'), m.m1.bg.colors, m.m1.bg.mask, Math.min(m.m1.bg.count, 256));
    drawTilesInto($('vramObj'), m.m1.obj.colors, m.m1.obj.mask, Math.min(m.m1.obj.count, 256));
    // 位图池
    const pool = $('vramBmps');
    pool.innerHTML = '';
    for (const [id, bm] of m.m2.bitmaps) {
      const wrap = document.createElement('div');
      wrap.className = 'col';
      const cv = document.createElement('canvas');
      cv.className = 'pixel';
      const z = Math.max(1, Math.min(4, Math.floor(96 / Math.max(bm.w, bm.h))));
      cv.width = bm.w * z; cv.height = bm.h * z;
      cv.style.width = cv.width + 'px';
      const ctx = cv.getContext('2d');
      for (let y = 0; y < bm.h; y++) for (let x = 0; x < bm.w; x++) {
        if (!bm.tmask[y * bm.w + x]) {
          ctx.fillStyle = ANSI.css(bm.px[y * bm.w + x]);
          ctx.fillRect(x * z, y * z, z, z);
        }
      }
      wrap.appendChild(cv);
      const lbl = document.createElement('span');
      lbl.className = 'muted';
      lbl.textContent = id + ' ' + bm.w + '×' + bm.h;
      wrap.appendChild(lbl);
      pool.appendChild(wrap);
    }
  }

  function refreshOAM() {
    const m = dbg.machine;
    if (!m) return;
    const tb = $('oamTable').querySelector('tbody');
    tb.innerHTML = '';
    let n = 0;
    for (let i = 0; i < 128; i++) {
      const s = m.m1.oam[i];
      if (!s.vis) continue;
      if (++n > 40) { 
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="7" class="muted">… 仅示前 40 个可见精灵(共 ${n - 1}+)</td>`;
        tb.appendChild(tr); break;
      }
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i}</td><td>${s.x}</td><td>${s.y}</td><td>${s.tile}</td><td>${s.big ? 16 : 8}</td><td>${s.fh}${s.fv}</td><td>${s.prio}</td>`;
      tb.appendChild(tr);
    }
    if (!n) tb.innerHTML = '<tr><td colspan="7" class="muted">无可见精灵</td></tr>';
  }

  function refreshAudio() {
    const m = dbg.machine;
    if (!m || !m.audio) return;
    // 通道表
    const tb = $('chTable').querySelector('tbody');
    tb.innerHTML = '';
    for (let i = 0; i < 8; i++) {
      const c = m.audio.chans[i];
      const lv = (m.audio.levels || [])[i] || 0;
      const tb2 = c.timbre ? (c.timbre.family + (c.timbre.model ? ':' + c.timbre.model : c.timbre.wave ? ':w' + c.timbre.wave : '')) : '-';
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${i}</td><td>${c.role || '-'}</td><td>${tb2}</td><td>${(lv * 100) | 0}%</td><td>${c.voice.active ? 'ON' : '·'}</td>`;
      tb.appendChild(tr);
    }
    // 波形(μ律前/后可切,§13.6)
    const cv = $('audioScope');
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.strokeStyle = dbg.preMulaw ? '#6ecf8e' : '#7aa2f7';
    ctx.beginPath();
    if (dbg.preMulaw) {
      const lin = m.audio.linearTap;
      for (let x = 0; x < cv.width; x++) {
        const v = lin[(x) % lin.length];
        const y = cv.height / 2 - v * cv.height / 2;
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
    } else {
      const b = m.audio.lastOutput;
      for (let x = 0; x < cv.width; x++) {
        const v = Mulaw.DEC[b[x % b.length]];
        const y = cv.height / 2 - v * cv.height / 2;
        x ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      }
    }
    ctx.stroke();
    $('aramStat').textContent = 'ARAM ' + (m.audio.aramBytes) + ' / 32768 B · 音色 ' + m.audio.timbres.length + '/64 · pattern ' + m.audio.patterns.length + ' · music ' + m.audio.musics.length + ' · ' + (m.audio.playing ? 'BGM▶' : 'BGM·');
  }

  function refreshPerf() {
    const m = dbg.machine;
    if (!m) return;
    const cv = $('perfChart');
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cv.width, cv.height);
    const hist = m.stats.history;
    const scale = cv.height / 20;
    for (let i = 0; i < hist.length; i++) {
      const x = Math.floor(i * cv.width / 240);
      const [l, d, a] = hist[i];
      let y = cv.height;
      ctx.fillStyle = '#7aa2f7'; const hl = Math.min(cv.height, l * scale); ctx.fillRect(x, y - hl, 1, hl); y -= hl;
      ctx.fillStyle = '#d8a657'; const hd = Math.min(y, d * scale); ctx.fillRect(x, y - hd, 1, hd); y -= hd;
      ctx.fillStyle = '#e06c75'; const ha = Math.min(y, a * scale); ctx.fillRect(x, y - ha, 1, ha);
    }
    // 16.67ms 预算线
    ctx.strokeStyle = '#6ecf8e';
    ctx.beginPath(); ctx.moveTo(0, cv.height - 16.67 * scale); ctx.lineTo(cv.width, cv.height - 16.67 * scale); ctx.stroke();
  }

  function refreshLogs() {
    const m = dbg.machine;
    if (!m) return;
    const el = $('cartLog');
    el.innerHTML = '';
    for (const e of m.printLog.slice(-100)) {
      const div = document.createElement('div');
      div.textContent = 'f' + e.frame + ' ' + e.line;
      el.appendChild(div);
    }
    el.scrollTop = 1e9;
  }

  function refreshAll() {
    refreshVRAM(); refreshOAM(); refreshAudio(); refreshPerf(); refreshLogs();
  }

  // ---------- 导出 ----------
  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function exportPng() {
    $('scr').toBlob((b) => download(b, 'ac2-frame-' + dbg.machine.frameCount + '.png'));
  }
  function exportGif() {
    if (!dbg.frames.length) return log('无录制帧', 'err');
    const frames = dbg.frames.filter((_, i) => i % 2 === 0).map(f => ({ delayCs: 4, indices: f }));
    log('GIF 编码中:' + frames.length + ' 帧…');
    setTimeout(() => {
      try {
        const gif = AC2.encodeGif(240, 176, ANSI.rgbTable, frames);
        download(new Blob([gif], { type: 'image/gif' }), 'ac2-rec.gif');
        log('GIF ' + (gif.length / 1024).toFixed(1) + 'KB 导出');
      } catch (e) { log('GIF 失败: ' + e.message, 'err'); }
    }, 30);
  }

  // ---------- UI 绑定 ----------
  const hasDOM = typeof window !== 'undefined' && typeof document !== 'undefined';
  if (hasDOM) window.addEventListener('DOMContentLoaded', () => {
    // 画布
    const cv = $('scr');
    cv.width = 240; cv.height = 176;
    cv.style.width = '480px'; cv.style.height = '352px';

    // 键盘(§9.1 映射)
    window.addEventListener('keydown', (e) => {
      const k = KEYMAP[e.code];
      if (k) { dbg.keys[k] = true; e.preventDefault(); }
    });
    window.addEventListener('keyup', (e) => {
      const k = KEYMAP[e.code];
      if (k) { dbg.keys[k] = false; e.preventDefault(); }
    });
    // 虚拟手柄面板(点击注入,§13.6)
    document.querySelectorAll('#vpad button').forEach(b => {
      const k = b.dataset.k;
      const on = (e) => { dbg.keys[k] = true; e.preventDefault(); };
      const off = (e) => { dbg.keys[k] = false; e.preventDefault(); };
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointerleave', off);
    });

    // 运行控制
    $('btnRun').onclick = () => {
      const m = dbg.machine; if (!m) return;
      if (m.breakHit) { m.resumeFromBp(); dbg._bpLogged = false; }
      m.paused = false; m.halted = m.halted;
      if (m.halted) { log('已停机(异常)——请复位', 'warn'); }
    };
    $('btnPause').onclick = () => { if (dbg.machine) dbg.machine.paused = true; };
    $('btnReset').onclick = () => {
      const m = dbg.machine; if (!m) return;
      const bytes = AC2.Lib.bytes(m.cart.id);
      if (bytes) loadCartBytes(bytes, 'reset'); else m.resetCart();
      dbg.frames = [];
    };
    $('btnStepF').onclick = () => {
      const m = dbg.machine; if (!m || m.halted) return;
      if (m.breakHit) m.resumeFromBp();
      m.paused = true;
      m.input.pushInput(sampleInput());
      m.step();
      if (dbg.recording) dbg.frames.push(m.fb.slice());
      refreshAll();
    };
    $('btnStepB').onclick = () => {   // 步退:状态快照
      const m = dbg.machine; if (!m) return;
      const snap = m.snapshots.pop();
      if (!snap) return log('无快照可回退', 'warn');
      m.restoreSnapshot(snap);
      if (m.snapshots.length) m.snapshots.pop(); // 恢复到该快照后再弹一个 = 显示前一帧
      refreshAll();
    };
    $('speed').oninput = (e) => { dbg.speed = +e.target.value; };

    // 面板收开
    $('btnPanel').onclick = () => {
      dbg.showPanel = !dbg.showPanel;
      $('dbgPanel').style.display = dbg.showPanel ? '' : 'none';
      $('btnPanel').textContent = dbg.showPanel ? '▶ 收起面板(纯运行器)' : '◀ 展开面板(调试器)';
    };

    // Tab
    document.querySelectorAll('input[name=dtab]').forEach(r => r.onchange = () => {
      dbg.curTab = r.value;
      for (const p of document.querySelectorAll('.dpane')) p.style.display = 'none';
      $('dpane-' + r.value).style.display = '';
      render();
    });

    // 装载
    $('btnOpen').onclick = () => $('file').click();
    $('file').onchange = async (e) => {
      const f = e.target.files[0];
      if (f) await loadCartBytes(new Uint8Array(await f.arrayBuffer()), f.name);
      e.target.value = '';
    };
    // 库
    const libSel = $('libSel');
    const refreshLib = () => {
      libSel.innerHTML = '<option value="">— 卡带库 —</option>';
      for (const it of AC2.Lib.list()) {
        const o = document.createElement('option');
        o.value = it.id; o.textContent = it.title + ' (' + it.id + ')';
        libSel.appendChild(o);
      }
    };
    refreshLib();
    libSel.onchange = async () => {
      if (!libSel.value) return;
      const bytes = AC2.Lib.bytes(libSel.value);
      if (bytes) await loadCartBytes(bytes, 'library');
    };
    $('btnLibRefresh').onclick = refreshLib;

    // API 断点列表
    const APIS = ['save', 'load', 'setMode', 'loadTiles', 'loadMap', 'setTile', 'setSprite', 'scroll',
      'loadBitmap', 'loadVector', 'blit', 'triTex', 'pset', 'text', 'poly',
      'playTrack', 'stopTrack', 'playSfx', 'note'];
    const apiHost = $('apiBps');
    for (const name of APIS) {
      const lb = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.onchange = () => {
        const m = dbg.machine; if (!m) return;
        cb.checked ? m.debugHooks.apiBreaks.add(name) : m.debugHooks.apiBreaks.delete(name);
        log('API 断点 ' + name + ' ' + (cb.checked ? 'on' : 'off'));
      };
      lb.appendChild(cb);
      lb.appendChild(document.createTextNode(' ' + name + '  '));
      apiHost.appendChild(lb);
    }

    // 音频视图切换
    $('preMulaw').onchange = (e) => { dbg.preMulaw = e.target.checked; };

    // 输入录制/回放
    $('btnRec').onclick = () => {
      const m = dbg.machine; if (!m) return;
      m.input.recorder = { frames: [] };
      dbg.recording = true;
      log('▶ 输入录制中(每帧快照输入流)…');
    };
    $('btnRecStop').onclick = () => {
      const m = dbg.machine; if (!m) return;
      dbg.recording = false;
      const n = m.input.recorder ? m.input.recorder.frames.length : 0;
      log('■ 录制结束:' + n + ' 帧');
    };
    $('btnReplay').onclick = () => {
      const m = dbg.machine; if (!m || !m.input.recorder) return log('先录制', 'warn');
      // 确定性回放:复位卡带 + 种子随机 → 逐帧一致(§13.6)
      const bytes = AC2.Lib.bytes(m.cart.id);
      const rec = m.input.recorder.frames;
      const doReplay = () => {
        m.input.replay = { frames: rec, i: 0, oneShot: true };
        dbg.replaying = true;
        log('⟲ 回放 ' + rec.length + ' 帧');
      };
      if (bytes) loadCartBytes(bytes, 'replay').then(doReplay); else { m.resetCart(); doReplay(); }
    };
    // GIF 录屏
    $('btnGifRec').onclick = () => { dbg.recording = true; dbg.frames = []; log('● GIF 录屏中(≤60s,每 2 帧采样)…'); };
    $('btnGifStop').onclick = () => { dbg.recording = false; exportGif(); };
    // 导出
    $('btnPng').onclick = exportPng;
    $('btnSavExport').onclick = () => {
      const m = dbg.machine; if (!m) return;
      const key = m.saveKey();
      const raw = m.storage.getItem(key);
      if (!raw) return log('无存档', 'warn');
      download(new Blob([AC2.bytesFromB64(raw)]), m.cart.id + '.sav');
    };
    $('btnSavImport').onclick = () => $('savFile').click();
    $('savFile').onchange = async (e) => {
      const m = dbg.machine;
      const f = e.target.files[0];
      if (f && m && m.cart) {
        m.storage.setItem('ac2.save.' + m.cart.id, AC2.b64FromBytes(new Uint8Array(await f.arrayBuffer())));
        log('.sav 导入完成');
      }
      e.target.value = '';
    };

    // 周期刷新状态面板
    setInterval(() => { if (dbg.showPanel) refreshAll(); }, 250);

    requestAnimationFrame(tick);
    log('模拟器即调试器就绪(T14):装载 .aec 或从卡带库选择。收起面板 = 纯运行器。');
  });

  AC2.Debugger = { dbg, loadCartBytes };
})();
