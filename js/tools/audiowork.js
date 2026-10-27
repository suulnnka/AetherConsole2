/* js/tools/audiowork.js — 音频工作站(§13.4):音色(三族)/ pattern(横向钢琴卷帘)/ music(8 轨)
 * 数据模型与主机 audio 段完全同构:.aud = {timbres, patterns, musics, samples}
 * 试听走完整 24kHz → μ律 链路(所闻即所得)。
 */
(function () {
  'use strict';
  const { ANSI, Mulaw } = AC2;
  const $ = (id) => document.getElementById(id);
  const midiHz = AC2.midiHz;

  const doc = {  // 工作站文档(草稿自动保存)
    timbres: [],
    patterns: [],
    musics: [],
    samples: {}
  };

  // ---------- 试听引擎(μ律链路) ----------
  const player = {
    engine: null, ctx: null, node: null, queue: [], timer: null,
    ensure() {
      if (this.engine) return;
      this.engine = new AC2.AudioEngine();
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ sampleRate: 24000 });
      this.node = this.ctx.createScriptProcessor(2048, 0, 1);
      this.node.onaudioprocess = (ev) => {
        const out = ev.outputBuffer.getChannelData(0);
        let n = 0;
        while (n < out.length) {
          if (!this.queue.length) { out.fill(0, n); break; }
          const blk = this.queue.shift();
          const take = Math.min(out.length - n, blk.length);
          out.set(blk.subarray(0, take), n);
          n += take;
          if (take < blk.length) this.queue.unshift(blk.subarray(take));
        }
      };
      this.node.connect(this.ctx.destination);
      this.timer = setInterval(() => this.pump(), 1000 / 60);
    },
    pump() {
      if (!this.engine) return;
      this.engine.step();
      const b = this.engine.lastOutput;
      const f = new Float32Array(b.length);
      for (let i = 0; i < b.length; i++) f[i] = Mulaw.DEC[b[i]];
      this.queue.push(f);
      while (this.queue.length > 20) this.queue.shift();
      updateMeters();
    },
    loadDoc() { this.ensure(); this.engine.stopAll(); this.engine.loadAudioData(doc); },
    resume() { this.ensure(); if (this.ctx.state === 'suspended') this.ctx.resume(); }
  };

  function updateMeters() {
    const cv = $('meters');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const lv = player.engine.levels || new Float32Array(8);
    for (let i = 0; i < 8; i++) {
      const h = Math.min(1, lv[i]) * (cv.height - 4);
      ctx.fillStyle = lv[i] > 0.85 ? '#e06c75' : lv[i] > 0.5 ? '#d8a657' : '#6ecf8e';
      ctx.fillRect(4 + i * 14, cv.height - 2 - h, 10, h);
    }
    // 波形(μ律解码后)
    const w = $('scope');
    const c2 = w.getContext('2d');
    c2.fillStyle = '#000'; c2.fillRect(0, 0, w.width, w.height);
    c2.strokeStyle = '#7aa2f7';
    c2.beginPath();
    const lin = player.engine.linearTap;
    for (let x = 0; x < w.width; x++) {
      const v = lin[(x * 2) % lin.length] || 0;
      const y = w.height / 2 - v * w.height / 2;
      x ? c2.lineTo(x, y) : c2.moveTo(x, y);
    }
    c2.stroke();
  }

  // ---------- 音色编辑 ----------
  const timbreUI = {
    sel: 0,
    renderList() {
      const list = $('tList');
      list.innerHTML = '';
      doc.timbres.forEach((t, i) => {
        const b = document.createElement('button');
        const fam = { fc: 'FC', fm: 'FM', an: 'AN', smp: 'SMP' }[t.family] || '?';
        b.textContent = fam + (i + 1) + ' ' + (t.name || '');
        if (i === this.sel) b.classList.add('primary');
        b.onclick = () => { this.sel = i; this.render(); };
        list.appendChild(b);
      });
    },
    render() {
      this.renderList();
      const host = $('tParams');
      host.innerHTML = '';
      const t = doc.timbres[this.sel];
      if (!t) { host.innerHTML = '<div class="muted">← 新建一件音色</div>'; return; }
      const mk = (label, type, val, oninput, attrs) => {
        const wrap = document.createElement('label');
        wrap.textContent = label + ' ';
        let el;
        if (type === 'select') {
          el = document.createElement('select');
          for (const o of attrs.options) {
            const opt = document.createElement('option');
            opt.value = o[0]; opt.textContent = o[1];
            el.appendChild(opt);
          }
          el.value = val;
          el.onchange = () => oninput(el.value);
        } else if (type === 'check') {
          el = document.createElement('input');
          el.type = 'checkbox';
          el.checked = !!val;
          el.onchange = () => oninput(el.checked);
          wrap.textContent = label + ' ';
          wrap.prepend(el);
          host.appendChild(wrap);
          return;
        } else {
          el = document.createElement('input');
          el.type = type;
          el.value = val;
          if (attrs && attrs.min != null) { el.min = attrs.min; el.max = attrs.max; el.step = attrs.step || 1; }
          el.oninput = () => oninput(type === 'number' || type === 'range' ? +el.value : el.value);
        }
        wrap.appendChild(el);
        host.appendChild(wrap);
        return el;
      };
      const row = () => { const d = document.createElement('div'); d.className = 'row'; host.appendChild(d); return d; };
      const addTo = (parent) => ({
        mk: (label, type, val, oninput, attrs) => {
          const wrap = document.createElement('label');
          wrap.textContent = label + ' ';
          let el;
          if (type === 'select') {
            el = document.createElement('select');
            for (const o of attrs.options) { const opt = document.createElement('option'); opt.value = o[0]; opt.textContent = o[1]; el.appendChild(opt); }
            el.value = val;
            el.onchange = () => oninput(el.value);
          } else if (type === 'check') {
            el = document.createElement('input'); el.type = 'checkbox'; el.checked = !!val;
            el.onchange = () => oninput(el.checked);
            wrap.textContent = ' ' + label; wrap.prepend(el);
          } else {
            el = document.createElement('input'); el.type = type; el.value = val;
            if (attrs && attrs.min != null) { el.min = attrs.min; el.max = attrs.max; el.step = attrs.step || 0.01; }
            el.oninput = () => oninput((type === 'number' || type === 'range') ? +el.value : el.value);
          }
          wrap.appendChild(el);
          parent.appendChild(wrap);
        }
      });

      let r = row(); let ui = addTo(r);
      ui.mk('名称', 'text', t.name || '', v => { t.name = v; });
      ui.mk('族', 'select', t.family, v => { t.family = v; this.render(); }, {
        options: [['fc', 'PICO-8 FC 系'], ['fm', '2op FM(世嘉 MS 系)'], ['an', '模拟 808/909/303'], ['smp', '采样器']]
      });

      if (t.family === 'fc') {
        r = row(); ui = addTo(r);
        ui.mk('波形(8 种固定,T15)', 'select', t.wave || 2, v => { t.wave = +v; }, {
          options: [[1, '正弦'], [2, '方波'], [3, '脉冲'], [4, '锯齿'], [5, '三角'], [6, '噪声'], [7, '金属噪'], [8, 'S&H']]
        });
        ui.mk('噪声颜色', 'select', t.noise || 'white', v => { t.noise = v; }, { options: [['white', '白噪'], ['pink', '粉噪']] });
        ui.mk('占空比', 'range', t.duty == null ? 0.5 : t.duty, v => { t.duty = v; }, { min: 0.05, max: 0.95, step: 0.05 });
      } else if (t.family === 'fm') {
        t.car = t.car || { level: 1, adsr: [0.005, 0.1, 0.6, 0.2], ratio: 1 };
        t.mod = t.mod || { level: 3, adsr: [0.005, 0.2, 0.4, 0.2], ratio: 2, fb: 0 };
        r = row(); ui = addTo(r);
        ui.mk('载波电平', 'range', t.car.level, v => { t.car.level = v; }, { min: 0, max: 2 });
        ui.mk('载波倍率', 'number', t.car.ratio, v => { t.car.ratio = v; }, { min: 0.5, max: 16, step: 0.5 });
        ui.mk('调制深度', 'range', t.mod.level, v => { t.mod.level = v; }, { min: 0, max: 12 });
        ui.mk('调制倍率(0.5–8)', 'number', t.mod.ratio, v => { t.mod.ratio = v; }, { min: 0.5, max: 8, step: 0.5 });
        ui.mk('反馈 0–7', 'number', t.mod.fb || 0, v => { t.mod.fb = v; }, { min: 0, max: 7, step: 1 });
        ui.mk('环形调制(T13)', 'check', t.ring, v => { t.ring = v; });
      } else if (t.family === 'an') {
        r = row(); ui = addTo(r);
        ui.mk('型号', 'select', t.model || 'kick', v => { t.model = v; }, {
          options: [['kick', '808 Kick'], ['snare', 'Snare'], ['hat', 'Hi-Hat 闭'], ['ohat', 'Hi-Hat 开'], ['clap', 'Clap'], ['cowbell', 'Cowbell'], ['tom', 'Tom'], ['crash', 'Crash'], ['ride', 'Ride'], ['303', 'TB-303 贝斯'], ['kit', '鼓组映射(按音高)']]
        });
        if (t.model === '303' || t.model === 'kit') {
          ui.mk('303 波形', 'select', t.w303 || 'saw', v => { t.w303 = v; }, { options: [['saw', '锯齿'], ['square', '方波']] });
          ui.mk('截止', 'number', t.cutoff303 || 400, v => { t.cutoff303 = v; }, { min: 60, max: 4000, step: 20 });
          ui.mk('谐振', 'range', t.res == null ? 6 : t.res, v => { t.res = v; }, { min: 0.5, max: 12 });
          ui.mk('包络量', 'range', t.envMod == null ? 3 : t.envMod, v => { t.envMod = v; }, { min: 0, max: 6 });
          ui.mk('衰减 s', 'number', t.decay303 || 0.25, v => { t.decay303 = v; }, { min: 0.05, max: 1 });
        }
      } else if (t.family === 'smp') {
        r = row(); ui = addTo(r);
        const names = Object.keys(doc.samples);
        ui.mk('采样块', 'select', t.sample || (names[0] || ''), v => { t.sample = v; }, { options: names.map(n => [n, n]) });
        ui.mk('回放速率', 'number', t.rate || 1, v => { t.rate = v; }, { min: 0.25, max: 8, step: 0.25 });
      }

      // 公共:ADSR / filter / glide / vib / vol
      t.adsr = t.adsr || [0.005, 0.08, 0.6, 0.15];
      r = row(); ui = addTo(r);
      ui.mk('A', 'number', t.adsr[0], v => { t.adsr[0] = v; }, { min: 0.001, max: 2, step: 0.001 });
      ui.mk('D', 'number', t.adsr[1], v => { t.adsr[1] = v; }, { min: 0.001, max: 2, step: 0.001 });
      ui.mk('S', 'range', t.adsr[2], v => { t.adsr[2] = v; }, { min: 0, max: 1 });
      ui.mk('R', 'number', t.adsr[3], v => { t.adsr[3] = v; }, { min: 0.001, max: 3, step: 0.001 });
      r = row(); ui = addTo(r);
      ui.mk('音量', 'range', t.vol == null ? 0.5 : t.vol, v => { t.vol = v; }, { min: 0, max: 1 });
      ui.mk('滑音 s', 'number', t.glide || 0, v => { t.glide = v; }, { min: 0, max: 1, step: 0.01 });
      t.vib = t.vib || { rate: 6, depth: 0 };
      ui.mk('颤音率', 'number', t.vib.rate, v => { t.vib.rate = v; }, { min: 0, max: 20 });
      ui.mk('颤音深', 'number', t.vib.depth, v => { t.vib.depth = v; }, { min: 0, max: 1, step: 0.01 });
      r = row(); ui = addTo(r);
      t.filter = t.filter || { type: 'lp', cutoff: 12000, q: 0.7 };
      ui.mk('滤波类型', 'select', t.filter.type, v => { t.filter.type = v; }, { options: [['lp', 'LP'], ['hp', 'HP'], ['bp', 'BP']] });
      ui.mk('截止 Hz', 'number', t.filter.cutoff, v => { t.filter.cutoff = v; }, { min: 50, max: 12000, step: 50 });
      ui.mk('Q', 'range', t.filter.q, v => { t.filter.q = v; }, { min: 0.1, max: 12 });
    },
    tryNote(freq) {
      player.resume();
      player.loadDoc();
      const e = player.engine;
      e.ch(7).set('timbre', this.sel);
      e.ch(7).note(freq, 0.35);
    }
  };

  // ---------- pattern:横向钢琴卷帘(§13.4②) ----------
  const patUI = {
    sel: 0,
    // 音高轴:乐器为模拟族时显示鼓件名(§8.2)
    pitchRows() {
      const pat = doc.patterns[this.sel];
      const t = doc.timbres[pat && pat.t] || {};
      if (t.family === 'an' && (t.model === 'kit' || ['kick', 'snare', 'hat', 'ohat', 'clap', 'cowbell', 'tom', 'crash', 'ride'].includes(t.model))) {
        return [36, 38, 39, 42, 46, 45, 56, 49, 51].map(n => ({ n, label: { 36: 'Kick', 38: 'Snare', 39: 'Clap', 42: 'Hat', 46: 'OHat', 45: 'Tom', 56: 'Cowbl', 49: 'Crash', 51: 'Ride' }[n] }));
      }
      const rows = [];
      for (let n = 96; n >= 36; n--) { // C2..C7
        const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
        rows.push({ n, label: names[n % 12] + (Math.floor(n / 12) - 1) });
      }
      return rows;
    },
    render() {
      const selEl = $('patSel');
      selEl.innerHTML = '';
      doc.patterns.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = 'pattern ' + i + ' · ' + (doc.timbres[p.t] ? (doc.timbres[p.t].name || ('T' + p.t)) : '?');
        selEl.appendChild(opt);
      });
      if (this.sel >= doc.patterns.length) this.sel = Math.max(0, doc.patterns.length - 1);
      selEl.value = this.sel;
      $('patTimbre').innerHTML = '';
      doc.timbres.forEach((t, i) => {
        const opt = document.createElement('option');
        opt.value = i; opt.textContent = (t.name || ('T' + i)) + ' [' + t.family + ']';
        $('patTimbre').appendChild(opt);
      });
      const pat = doc.patterns[this.sel];
      if (pat) $('patTimbre').value = pat.t;
      this.renderRoll();
      this.renderFX();
    },
    renderRoll() {
      const pat = doc.patterns[this.sel];
      const cv = $('roll');
      const rows = this.pitchRows();
      const ROW_H = 11, STEP_W = 13, HEAD = 34;
      cv.width = HEAD + 64 * STEP_W;
      cv.height = rows.length * ROW_H + 46; // 卷帘 + 音量轨 + 2 FX 轨
      const ctx = cv.getContext('2d');
      ctx.font = '9px monospace';
      // 键盘列
      rows.forEach((r, i) => {
        ctx.fillStyle = /#/.test(r.label) ? '#20202a' : '#2a2a34';
        ctx.fillRect(0, i * ROW_H, HEAD, ROW_H - 1);
        ctx.fillStyle = '#8f8fa0';
        ctx.fillText(r.label, 2, i * ROW_H + 9);
        // 网格
        for (let s = 0; s < 64; s++) {
          ctx.fillStyle = (s % 16 === 0) ? '#23232e' : (s % 4 === 0 ? '#1d1d26' : '#191922');
          ctx.fillRect(HEAD + s * STEP_W, i * ROW_H, STEP_W - 1, ROW_H - 1);
        }
      });
      if (!pat) return;
      // 音符
      const rowIndex = {};
      rows.forEach((r, i) => rowIndex[r.n] = i);
      ctx.fillStyle = '#7aa2f7';
      for (const note of pat.notes || []) {
        const ri = rowIndex[note.n];
        if (ri == null) continue;
        ctx.fillStyle = note.v != null && note.v < 0.6 ? '#3d5f8f' : '#7aa2f7';
        ctx.fillRect(HEAD + note.s * STEP_W, ri * ROW_H, Math.max(1, (note.l || 1)) * STEP_W - 2, ROW_H - 2);
      }
      // 三条横向轨道:音量 + FX×2(卷帘下方,老板定)
      const trackY = rows.length * ROW_H + 4;
      const labels = ['VOL', 'FX1', 'FX2'];
      labels.forEach((lb, k) => {
        ctx.fillStyle = '#15151d';
        ctx.fillRect(HEAD, trackY + k * 14, 64 * STEP_W, 12);
        ctx.fillStyle = '#8f8fa0';
        ctx.fillText(lb, 4, trackY + k * 14 + 9);
      });
      // 音量轨值
      if (pat.vol) {
        ctx.fillStyle = '#6ecf8e';
        for (let s = 0; s < 64; s++) {
          const v = pat.vol[s];
          if (v != null) ctx.fillRect(HEAD + s * STEP_W, trackY + 12 - Math.round(v * 10), STEP_W - 2, Math.round(v * 10));
        }
      }
      // FX 区域
      (pat.fx || []).forEach((f, i) => {
        const k = f.track == null ? i : f.track;
        ctx.fillStyle = ['rgba(216,166,87,0.7)', 'rgba(224,108,117,0.7)'][k % 2];
        ctx.fillRect(HEAD + f.start * STEP_W, trackY + k * 14, (f.end - f.start + 1) * STEP_W - 1, 12);
        ctx.fillStyle = '#000';
        ctx.fillText(f.type.slice(0, 5), HEAD + f.start * STEP_W + 2, trackY + k * 14 + 9);
      });
      this._geom = { ROW_H, STEP_W, HEAD, trackY, rowsN: rows.length };
    },
    renderFX() {
      const pat = doc.patterns[this.sel];
      const host = $('fxList');
      host.innerHTML = '';
      if (!pat) return;
      pat.fx = pat.fx || [];
      for (let k = 0; k < 2; k++) {
        const f = pat.fx.find(x => (x.track == null ? pat.fx.indexOf(x) : x.track) === k);
        const div = document.createElement('div');
        div.className = 'row';
        div.innerHTML = `<span class="muted">FX${k + 1}:</span>`;
        const sel = document.createElement('select');
        for (const [v, lb] of [['', '— 无 —'], ['pitchLfo', '音高 LFO'], ['pitchUp', '向上滑'], ['pitchDown', '向下滑'], ['volLfo', '音量 LFO'], ['fadeIn', '淡入'], ['fadeOut', '淡出'], ['filter', 'filter(替换音色)'], ['arp', '琶音'], ['pwm', '脉宽(FX)']]) {
          const o = document.createElement('option'); o.value = v; o.textContent = lb; sel.appendChild(o);
        }
        sel.value = f ? f.type : '';
        sel.onchange = () => {
          if (!sel.value) { pat.fx = pat.fx.filter(x => x !== f); this.renderRoll(); return; }
          if (!f) { pat.fx.push({ track: k, type: sel.value, start: 0, end: 15, params: {} }); }
          else f.type = sel.value;
          this.renderRoll(); this.renderFX();
        };
        div.appendChild(sel);
        if (f) {
          const st = document.createElement('input');
          st.type = 'number'; st.min = 0; st.max = 63; st.value = f.start; st.style.width = '52px';
          st.oninput = () => { f.start = Math.max(0, Math.min(63, +st.value)); this.renderRoll(); };
          const en = document.createElement('input');
          en.type = 'number'; en.min = 0; en.max = 63; en.value = f.end; en.style.width = '52px';
          en.oninput = () => { f.end = Math.max(f.start, Math.min(63, +en.value)); this.renderRoll(); };
          div.appendChild(document.createTextNode(' 起')); div.appendChild(st);
          div.appendChild(document.createTextNode(' 止')); div.appendChild(en);
          const rate = document.createElement('input');
          rate.type = 'number'; rate.value = (f.params && f.params.rate) || 4; rate.style.width = '52px';
          rate.oninput = () => { f.params = f.params || {}; f.params.rate = +rate.value; };
          div.appendChild(document.createTextNode(' 率')); div.appendChild(rate);
        }
        host.appendChild(div);
      }
    },
    click(e, rightBtn) {
      const pat = doc.patterns[this.sel];
      if (!pat || !this._geom) return;
      const r = $('roll').getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const { ROW_H, STEP_W, HEAD, trackY, rowsN } = this._geom;
      const step = Math.floor((x - HEAD) / STEP_W);
      if (y < rowsN * ROW_H) {
        if (step < 0 || step > 63) return;
        const ri = Math.floor(y / ROW_H);
        const row = this.pitchRows()[ri];
        if (!row) return;
        if (rightBtn) {
          pat.notes = (pat.notes || []).filter(n => !(n.n === row.n && n.s <= step && step < n.s + (n.l || 1)));
        } else {
          const ex = (pat.notes || []).find(n => n.n === row.n && n.s <= step && step < n.s + (n.l || 1));
          if (ex) ex.l = ((ex.l || 1) % 8) + 1;  // 反复点同音加长
          else (pat.notes = pat.notes || []).push({ s: step, n: row.n, l: 2, v: 1 });
          pat.notes.sort((a, b) => a.s - b.s);
        }
      } else {
        // 下方三轨:音量(循环 1/0.5/0)+ FX 区域起止
        const k = Math.floor((y - trackY) / 14);
        if (step < 0 || step > 63) return;
        if (k === 0) {
          pat.vol = pat.vol || new Array(64).fill(null);
          const cur = pat.vol[step];
          pat.vol[step] = cur == null ? 1 : (cur === 1 ? 0.5 : (cur === 0.5 ? null : 1));
        } else {
          const fi = k - 1;
          let f = (pat.fx || []).find(x => (x.track == null ? pat.fx.indexOf(x) : x.track) === fi);
          if (!f && rightBtn) return;
          if (!f) { f = { track: fi, type: 'fadeIn', start: step, end: Math.min(63, step + 7), params: {} }; (pat.fx = pat.fx || []).push(f); }
          else {
            if (step < f.start || step > f.end) { f.start = step; f.end = Math.min(63, step + 7); }
            else { f.end = step; if (f.end < f.start) { const t = f.start; f.start = f.end; f.end = t; } }
          }
          this.renderFX();
        }
      }
      this.renderRoll();
      saveDraft();
    },
    play(bpm) {
      player.resume();
      player.loadDoc();
      player.engine.playSfx(this.sel, { ch: 0, bpm: bpm || +$('patBpm').value });
      // 循环播放:SFX 一次 4 小节;到尾重触发
      const totalFrames = Math.ceil((60 / (+$('patBpm').value)) * 4 * 60);
      let n = 0;
      clearInterval(this._loopTimer);
      this._loopTimer = setInterval(() => {
        n++;
        if (!player.engine.sfxPlaying.length && n > 2) { player.engine.playSfx(this.sel, { ch: 0, bpm: +$('patBpm').value }); n = 0; }
        // 播放头
        const pat = doc.patterns[this.sel];
        if (pat && this._geom) {
          this.renderRoll();
        }
      }, 1000 / 60);
    },
    stop() { clearInterval(this._loopTimer); player.engine && player.engine.stopAll(); this.renderRoll(); }
  };

  // ---------- music:8 轨拖 pattern(§13.4③) ----------
  const musUI = {
    sel: 0,
    render() {
      const selEl = $('musSel');
      selEl.innerHTML = '';
      doc.musics.forEach((m, i) => {
        const opt = document.createElement('option');
        opt.value = i; opt.textContent = 'music ' + i + ' · ' + (m.bpm || 120) + 'bpm';
        selEl.appendChild(opt);
      });
      if (this.sel >= doc.musics.length) this.sel = Math.max(0, doc.musics.length - 1);
      selEl.value = this.sel;
      const m = doc.musics[this.sel];
      if (m) { $('musBpm').value = m.bpm || 120; $('musSwing').value = m.swing || 0; $('musLoop').value = m.loop != null ? m.loop : 16; }
      this.renderGrid();
    },
    renderGrid() {
      const m = doc.musics[this.sel];
      const cv = $('musGrid');
      const BARS = 16, W = 76, H = 20;
      cv.width = 60 + BARS * W;
      cv.height = 8 * H + 20;
      const ctx = cv.getContext('2d');
      ctx.font = '10px monospace';
      ctx.fillStyle = '#8f8fa0';
      for (let b = 0; b < BARS; b++) ctx.fillText('b' + (b + 1), 58 + b * W, 10);
      for (let t = 0; t < 8; t++) {
        ctx.fillStyle = '#8f8fa0';
        ctx.fillText('tr' + (t + 1), 22, 14 + t * H);
        for (let b = 0; b < BARS; b++) {
          const slot = m && m.tracks[t] && m.tracks[t].find(s => s.b === b);
          ctx.fillStyle = slot ? '#2d4a6e' : '#1b1b23';
          ctx.fillRect(56 + b * W, 14 + t * H, W - 3, H - 3);
          if (slot) {
            ctx.fillStyle = '#cfcfda';
            ctx.fillText('p' + slot.p, 60 + b * W, 14 + t * H + 13);
          }
        }
      }
      // 循环点
      if (m && m.loop != null) {
        ctx.strokeStyle = '#e06c75';
        ctx.beginPath();
        ctx.moveTo(56 + m.loop * W + 0.5, 8);
        ctx.lineTo(56 + m.loop * W + 0.5, 14 + 8 * H);
        ctx.stroke();
      }
    },
    click(e) {
      const m = doc.musics[this.sel];
      if (!m) return;
      const r = $('musGrid').getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const bar = Math.floor((x - 56) / 76);
      const tr = Math.floor((y - 14) / 20);
      if (bar < 0 || bar > 15 || tr < 0 || tr > 7) return;
      m.tracks[tr] = m.tracks[tr] || [];
      const ex = m.tracks[tr].find(s => s.b === bar);
      if (ex) {
        ex.p = (ex.p + 1) % Math.max(1, doc.patterns.length);   // 点击递增 pattern;右键删除
      } else {
        if (!doc.patterns.length) return;
        m.tracks[tr].push({ p: 0, b: bar });
      }
      this.renderGrid();
      saveDraft();
    },
    remove(e) {
      const m = doc.musics[this.sel];
      if (!m) return;
      const r = $('musGrid').getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const bar = Math.floor((x - 56) / 76);
      const tr = Math.floor((y - 14) / 20);
      if (bar < 0 || bar > 15 || tr < 0 || tr > 7) return;
      m.tracks[tr] = (m.tracks[tr] || []).filter(s => s.b !== bar);
      this.renderGrid();
      saveDraft();
    },
    play() {
      player.resume();
      player.loadDoc();
      player.engine.playTrack(this.sel);
    },
    stop() { player.engine && player.engine.stopAll(); }
  };

  // ---------- .aud 导入导出 ----------
  function exportAud() {
    // 音轨乐器同步(音色索引即 pattern.t)
    return new TextEncoder().encode(JSON.stringify({
      timbres: doc.timbres,
      patterns: doc.patterns,
      musics: doc.musics,
      samples: doc.samples
    }));
  }
  function importAud(bytes) {
    const d = JSON.parse(new TextDecoder().decode(bytes));
    doc.timbres = d.timbres || [];
    doc.patterns = d.patterns || [];
    doc.musics = d.musics || [];
    doc.samples = d.samples || {};
    timbreUI.render(); patUI.render(); musUI.render();
  }

  // ---------- WAV 导入(外部 wav → 24k 重采样 → μ律) ----------
  function importWav(bytes, name) {
    // 最小 WAV 解析:PCM 8/16/24/32 + float32
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (dv.getUint32(0, false) !== 0x52494646) throw new Error('非 WAV');
    let pos = 12, fmt = null, data = null;
    while (pos + 8 <= bytes.length) {
      const id = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      const sz = dv.getUint32(pos + 4, true);
      if (id === 'fmt ') {
        fmt = {
          audioFormat: dv.getUint16(pos + 8, true),
          ch: dv.getUint16(pos + 10, true),
          rate: dv.getUint32(pos + 12, true),
          bits: dv.getUint16(pos + 22, true)
        };
      } else if (id === 'data') {
        data = bytes.subarray(pos + 8, pos + 8 + sz);
      }
      pos += 8 + sz + (sz & 1);
    }
    if (!fmt || !data) throw new Error('WAV 缺 fmt/data');
    // 解码为单声道 float
    const { audioFormat, ch, bits } = fmt;
    const n = Math.floor(data.length / (bits / 8)) / ch | 0;
    const mono = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = 0;
      for (let c = 0; c < ch; c++) {
        const j = (i * ch + c) * (bits / 8) | 0;
        if (audioFormat === 3 && bits === 32) v += dv.getFloat32(data.byteOffset + j, true);
        else if (bits === 16) v += dv.getInt16(data.byteOffset + j, true) / 32768;
        else if (bits === 8) v += (data[j] - 128) / 128;
        else if (bits === 24) v += ((data[j] | data[j + 1] << 8 | data[j + 2] << 16) << 8) / 2147483648;
        else if (bits === 32) v += dv.getInt32(data.byteOffset + j, true) / 2147483648;
      }
      mono[i] = v / ch;
    }
    // 线性重采样到 24k
    const outN = Math.round(n * 24000 / fmt.rate);
    const res = new Float32Array(outN);
    for (let i = 0; i < outN; i++) {
      const p = i * fmt.rate / 24000;
      const i0 = p | 0, i1 = Math.min(n - 1, i0 + 1), f = p - i0;
      res[i] = mono[i0] * (1 - f) + mono[i1] * f;
    }
    doc.samples[name] = AC2.b64FromBytes(Mulaw.encodeBlock(res));
    return { name, seconds: (outN / 24000).toFixed(2), rate: fmt.rate };
  }

  // ---------- 草稿 ----------
  function saveDraft() {
    try { localStorage.setItem('aw.draft', JSON.stringify(doc)); } catch (e) { }
  }
  function loadDraft() {
    try {
      const d = JSON.parse(localStorage.getItem('aw.draft') || 'null');
      if (d && d.timbres) {
        doc.timbres = d.timbres; doc.patterns = d.patterns || []; doc.musics = d.musics || []; doc.samples = d.samples || {};
      }
    } catch (e) { }
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
    loadDraft();
    if (!doc.timbres.length) {
      doc.timbres.push({ family: 'fc', wave: 4, adsr: [0.003, 0.08, 0.5, 0.08], vol: 0.35, name: 'Lead' });
      doc.timbres.push({ family: 'fc', wave: 5, adsr: [0.004, 0.1, 0.4, 0.08], vol: 0.4, name: 'Bass' });
      doc.timbres.push({ family: 'an', model: 'kick', adsr: [0.001, 0.02, 1, 0.2], vol: 0.7, name: 'Kick' });
    }
    if (!doc.patterns.length) doc.patterns.push({ t: 0, notes: [] });
    if (!doc.musics.length) doc.musics.push({ bpm: 120, swing: 0, tracks: [[], [], [], [], [], [], [], []] });

    // Tab
    document.querySelectorAll('input[name=tab]').forEach(r => r.onchange = () => {
      for (const p of ['paneTimbre', 'panePattern', 'paneMusic']) $(p).style.display = 'none';
      $('pane' + r.value[0].toUpperCase() + r.value.slice(1)).style.display = '';
    });

    // 音色
    timbreUI.render();
    $('tNew').onclick = () => {
      if (doc.timbres.length >= 64) return alert('音色库 ≤64 件(§8.3)');
      doc.timbres.push({ family: 'fc', wave: 2, adsr: [0.005, 0.08, 0.6, 0.15], vol: 0.4, name: 'New' });
      timbreUI.sel = doc.timbres.length - 1;
      timbreUI.render(); saveDraft();
    };
    // 键盘试奏(Z S X D C V G B H N J M → C4..E5)
    const KEYNOTES = { KeyZ: 60, KeyS: 61, KeyX: 62, KeyD: 63, KeyC: 64, KeyV: 65, KeyG: 66, KeyB: 67, KeyH: 68, KeyN: 69, KeyJ: 70, KeyM: 71, Comma: 72 };
    window.addEventListener('keydown', (e) => {
      if (e.repeat || document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'SELECT') return;
      const n = KEYNOTES[e.code];
      if (n != null) { timbreUI.tryNote(midiHz(n)); e.preventDefault(); }
      if (e.code === 'Digit1') timbreUI.tryNote(midiHz(36));
    });

    // pattern
    patUI.render();
    $('patSel').onchange = () => { patUI.sel = +$('patSel').value; patUI.render(); };
    $('patTimbre').onchange = () => { doc.patterns[patUI.sel].t = +$('patTimbre').value; patUI.render(); saveDraft(); };
    $('patNew').onclick = () => {
      doc.patterns.push({ t: 0, notes: [] });
      patUI.sel = doc.patterns.length - 1;
      patUI.render(); saveDraft();
    };
    $('roll').addEventListener('mousedown', (e) => { patUI.click(e, e.button === 2); e.preventDefault(); });
    $('roll').addEventListener('contextmenu', (e) => e.preventDefault());
    $('patPlay').onclick = () => patUI.play();
    $('patStop').onclick = () => patUI.stop();
    $('patBpm').oninput = () => saveDraft();

    // music
    musUI.render();
    $('musSel').onchange = () => { musUI.sel = +$('musSel').value; musUI.render(); };
    $('musNew').onclick = () => {
      doc.musics.push({ bpm: 120, swing: 0, tracks: [[], [], [], [], [], [], [], []] });
      musUI.sel = doc.musics.length - 1;
      musUI.render(); saveDraft();
    };
    $('musBpm').oninput = () => { const m = doc.musics[musUI.sel]; if (m) { m.bpm = +$('musBpm').value; saveDraft(); } };
    $('musSwing').oninput = () => { const m = doc.musics[musUI.sel]; if (m) { m.swing = +$('musSwing').value; saveDraft(); } };
    $('musLoop').oninput = () => { const m = doc.musics[musUI.sel]; if (m) { m.loop = +$('musLoop').value; musUI.renderGrid(); saveDraft(); } };
    $('musGrid').addEventListener('mousedown', (e) => { e.button === 2 ? musUI.remove(e) : musUI.click(e); e.preventDefault(); });
    $('musGrid').addEventListener('contextmenu', (e) => e.preventDefault());
    $('musPlay').onclick = () => musUI.play();
    $('musStop').onclick = () => musUI.stop();

    // 导入导出
    $('exportAud').onclick = () => download(exportAud(), 'audio.aud');
    $('importAud').onclick = () => $('audFile').click();
    $('audFile').onchange = async (e) => {
      const f = e.target.files[0];
      if (f) {
        try { importAud(new Uint8Array(await f.arrayBuffer())); } catch (err) { alert('导入失败: ' + err.message); }
      }
      e.target.value = '';
    };
    $('importWav').onclick = () => $('wavFile').click();
    $('wavFile').onchange = async (e) => {
      const f = e.target.files[0];
      if (f) {
        try {
          const name = f.name.replace(/\.wav$/i, '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 12);
          const info = importWav(new Uint8Array(await f.arrayBuffer()), name);
          alert('采样导入:' + info.name + '(' + info.seconds + 's,原 ' + info.rate + 'Hz → 24k μ律)');
          timbreUI.render();
          saveDraft();
        } catch (err) { alert('WAV 导入失败: ' + err.message); }
      }
      e.target.value = '';
    };
    setInterval(saveDraft, 15000);
  });

  AC2.AudioWork = { doc, player, timbreUI, patUI, musUI, exportAud, importAud, importWav };
})();
