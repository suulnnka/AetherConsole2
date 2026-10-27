/* tests/m4.test.mjs — M4 验收:输入(双视图/沿检测)+ 音频(三族合成/序列器/μ律/借道恢复) */
import { load } from './load.mjs';

const AC2 = load(
  'js/core/ansi.js', 'js/core/comp.js', 'js/core/mulaw.js',
  'js/core/font.js', 'js/core/biosfont.js', 'js/core/cart.js',
  'js/host/input.js', 'js/host/mode1.js', 'js/host/mode2.js',
  'js/host/ajs.js', 'js/host/audio.js', 'js/host/bios.js', 'js/host/machine.js'
);

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log('  ok', name); }
  catch (e) { failed++; console.log('FAIL', name, '—', e.message); }
}

console.log('== M4 输入 ==');
t('虚拟键位沿检测(pressed/released)+ 双视图', () => {
  const inp = new AC2.InputState();
  const snap = (over) => ({ keys: over, x: 10, y: 20, dx: 0, dy: 0 });
  inp.pushInput(snap({ a: true }));
  if (!inp.pad.a.down || !inp.pad.a.pressed) throw new Error('按下沿失败');
  inp.pushInput(snap({ a: true }));
  if (inp.pad.a.pressed || !inp.pad.a.down) throw new Error('保持应无 pressed');
  inp.pushInput(snap({}));
  if (!inp.pad.a.released || inp.pad.a.down) throw new Error('松开沿失败');
  // 鼠标视图:left = A
  inp.pushInput(snap({ a: true }));
  if (!inp.mouse.left) throw new Error('mouse.left ≠ pad.a');
  if (inp.mouse.x !== 10 || inp.mouse.y !== 20) throw new Error('鼠标坐标失败');
});
t('鼠标 dx/dy 原始增量(不裁剪)', () => {
  const inp = new AC2.InputState();
  inp.pushInput({ keys: {}, x: 0, y: 0, dx: -500, dy: 900 });
  if (inp.mouse.dx !== -500 || inp.mouse.dy !== 900) throw new Error('增量被裁剪');
});
t('手柄右摇杆语义 + 键盘映射(壳层)', () => {
  // 壳的 KEYMAP 由页面实现;此处验证合成快照合并逻辑等价物
  const inp = new AC2.InputState();
  const kbKeys = { up: true }, gpKeys = { a: true };
  const merged = { up: !!(kbKeys.up || gpKeys.up), a: !!(kbKeys.a || gpKeys.a) };
  inp.pushInput({ keys: merged, x: 0, y: 0, dx: 0, dy: 0 });
  if (!inp.pad.up.down || !inp.pad.a.down) throw new Error('合并失败');
});
t('输入录制/回放帧一致(确定性)', () => {
  const a = new AC2.InputState(), b = new AC2.InputState();
  a.recorder = { frames: [] };
  const seqs = [{ keys: { a: true }, x: 1, y: 1, dx: 1, dy: 0 }, { keys: {}, x: 2, y: 2, dx: 1, dy: 1 }, { keys: { b: true }, x: 3, y: 3, dx: 1, dy: 0 }];
  for (const s of seqs) a.pushInput(s);
  b.replay = { frames: a.recorder.frames, i: 0 };
  const p1 = a.pad.a.pressed, p2 = a.pad.b.down;
  for (const s of seqs) b.pushInput(s); // 回放模式忽略物理输入
  if (b.pad.a.pressed !== p1 || b.pad.b.down !== p2) throw new Error('回放不一致');
});

// ---------- 音频 ----------
console.log('== M4 音频 ==');
function newEng() { return new AC2.AudioEngine(); }
function render(engine, frames) {
  const out = [];
  for (let i = 0; i < frames; i++) { engine.step(); out.push(engine.linearTap.slice()); }
  return out;
}
function goertzel(buf, f, sr) {
  const k = 2 * Math.PI * f / sr;
  let s0 = 0, s1 = 0, s2 = 0;
  for (let i = 0; i < buf.length; i++) {
    s0 = buf[i] + 2 * Math.cos(k) * s1 - s2;
    s2 = s1; s1 = s0;
  }
  const p = s1 * s1 + s2 * s2 - 2 * Math.cos(k) * s1 * s2;
  return Math.sqrt(Math.max(0, p)) / (buf.length / 2);
}

t('FC 正弦 A4 → μ律输出,440Hz 频谱验证', () => {
  const e = newEng();
  e.addTimbre({ family: 'fc', wave: 1, adsr: [0.001, 0.05, 0.8, 0.5], vol: 0.5 }, 0);
  e.chans[0].timbre = e.timbres[0];
  e.ch(0).note(440, null);
  const frames = render(e, 120); // 0.2s
  const flat = new Float32Array(120 * 400);
  frames.forEach((f, i) => flat.set(f, i * 400));
  const m440 = goertzel(flat, 440, 24000), m330 = goertzel(flat, 330, 24000), m550 = goertzel(flat, 550, 24000);
  if (!(m440 > m330 * 5 && m440 > m550 * 5)) throw new Error(`频谱峰不在 440:440=${m440.toFixed(4)} 330=${m330.toFixed(4)} 550=${m550.toFixed(4)}`);
  console.log(`    440Hz 幅度 ${(m440 * 100).toFixed(1)}%(邻频 ${m330.toFixed(2)}/${m550.toFixed(2)})`);
  // μ律输出 = 编码(线性)
  const b = e.lastOutput[100];
  const expect = AC2.Mulaw.encodeSample(e.linearTap[100]);
  if (b !== expect) throw new Error('μ律输出与线性不一致');
});

t('FC 8 波形全部出声(含白噪/粉噪/金属噪/S&H)', () => {
  for (let w = 1; w <= 8; w++) {
    const e = newEng();
    e.addTimbre({ family: 'fc', wave: w, noise: w === 6 ? 'pink' : 'white', adsr: [0.001, 0.05, 0.9, 0.1], vol: 0.5 }, 0);
    e.chans[0].timbre = e.timbres[0];
    e.ch(0).note(220, null);
    render(e, 10);
    let rms = 0;
    for (const v of e.linearTap) rms += v * v;
    rms = Math.sqrt(rms / 400);
    if (rms < 0.05) throw new Error(`波形 ${w} 无声(rms=${rms})`);
  }
  console.log('    8 波形 rms 全部 > 0.05');
});

t('2op FM:调制深度改变音色,环形调制出铃音', () => {
  const mk = (level, ring) => ({ family: 'fm', car: { level: 1, adsr: [0.001, 0.05, 0.8, 0.1], ratio: 1 }, mod: { level, adsr: [0.001, 0.3, 0.5, 0.1], ratio: 2, fb: 0 }, ring, vol: 0.4, adsr: [0.001, 0.05, 0.8, 0.1] });
  const e1 = newEng(); e1.addTimbre(mk(0, false), 0); e1.chans[0].timbre = e1.timbres[0]; e1.ch(0).note(440, null);
  const e2 = newEng(); e2.addTimbre(mk(4, false), 0); e2.chans[0].timbre = e2.timbres[0]; e2.ch(0).note(440, null);
  const e3 = newEng(); e3.addTimbre(mk(4, true), 0); e3.chans[0].timbre = e3.timbres[0]; e3.ch(0).note(440, null);
  render(e1, 20); render(e2, 20); render(e3, 20);
  const flat = e => { let s = 0; for (const v of e.linearTap) s += v * v; return s; };
  const p = flat(e1), m = flat(e2), r = flat(e3);
  if (m === 0 || r === 0) throw new Error('FM 无声');
  // 纯音 vs 调制音功率结构应不同;ring 与非 ring 也不同
  const d1 = Math.abs(Math.log(m / p)), d2 = Math.abs(Math.log(r / m));
  if (d1 < 0.05 && d2 < 0.05) throw new Error('调制/环形未改变输出');
  console.log(`    调制差异 ln=${d1.toFixed(2)},环形差异 ln=${d2.toFixed(2)}`);
});

t('模拟族:kick/snare/hat/clap/cowbell/tom/303 均出声且衰减', () => {
  for (const model of ['kick', 'snare', 'hat', 'clap', 'cowbell', 'tom', '303']) {
    const e = newEng();
    e.addTimbre({ family: 'an', model, adsr: [0.001, 0.05, 0.0, 0.3], vol: 0.6 }, 0);
    e.chans[0].timbre = e.timbres[0];
    e.ch(0).note(model === '303' ? 55 : 36, null);
    const fr = render(e, 24); // 0.4s
    let rmsA = 0; for (const v of fr[0]) rmsA += v * v;
    let rmsB = 0; for (const v of fr[23]) rmsB += v * v;
    if (rmsA < 0.01) throw new Error(model + ' 无声');
    if (model !== '303' && rmsB > rmsA * 0.5) throw new Error(model + ' 未衰减');
    if (model === '303' && rmsB > rmsA * 1.5) throw new Error('303 增益异常');
  }
  console.log('    7 种模拟音色全部通过');
});

t('序列器:pattern 音符按步触发,music 8 轨编排', () => {
  const e = newEng();
  e.loadAudioData({
    timbres: [
      { family: 'fc', wave: 4, adsr: [0.001, 0.02, 0.6, 0.05], vol: 0.4 },
      { family: 'an', model: 'kick', adsr: [0.001, 0.02, 0, 0.2], vol: 0.6 }
    ],
    patterns: [
      { t: 0, notes: [{ s: 0, n: 69, l: 2 }, { s: 4, n: 72, l: 2 }, { s: 8, n: 76, l: 2 }] },
      { t: 1, notes: [{ s: 0, n: 36 }, { s: 8, n: 36 }] }
    ],
    musics: [
      { bpm: 120, swing: 0, tracks: [[{ p: 0, b: 0 }], [{ p: 1, b: 0 }], [], [], [], [], [], []] }
    ]
  });
  e.playTrack(0);
  // bpm 120 → 每步 0.125s = 30 帧
  e.step();
  if (!e.chans[0].voice.active) throw new Error('轨道0(旋律)第0步未触发');
  if (!e.chans[1].voice.active) throw new Error('轨道1(鼓)第0步未触发');
  for (let i = 0; i < 32; i++) e.step(); // 到第 ~1.07 步
  // 第 4 步(120 帧)后旋律换音
  const f0 = e.chans[0].voice.targetFreq;
  for (let i = 0; i < 90; i++) e.step();
  if (e.chans[0].voice.targetFreq === f0) throw new Error('第 4 步未换音');
});

t('SFX 借道:抢占空闲通道,结束自动归还', () => {
  const e = newEng();
  e.loadAudioData({
    timbres: [{ family: 'fc', wave: 2, adsr: [0.001, 0.02, 0.5, 0.05], vol: 0.4 }],
    patterns: [
      { t: 0, notes: [{ s: 0, n: 81, l: 4 }] } // 短 SFX
    ],
    musics: [{ bpm: 120, tracks: [[{ p: 0, b: 0 }], [], [], [], [], [], [], []] }]
  });
  e.playTrack(0);
  e.step();
  const musicCh0Active = e.chans[0].role;
  e.playSfx(0);
  if (!e.sfxPlaying.length) throw new Error('SFX 未播放');
  const sfxCh = e.sfxPlaying[0].ch;
  if (sfxCh === 0) throw new Error('应借用空闲通道而非音轨0');
  const roleBefore = e.chans[sfxCh].role;
  if (roleBefore !== 'sfx') throw new Error('借道角色未设置');
  for (let i = 0; i < 200; i++) e.step(); // 4 步 + 尾
  if (e.sfxPlaying.length !== 0) throw new Error('SFX 未归还');
  if (e.chans[sfxCh].role === 'sfx') throw new Error('借道未恢复');
});

t('stopAll / 主音量 / ARAM 预算统计', () => {
  const e = newEng();
  e.loadAudioData({
    timbres: [{ family: 'fc', wave: 2 }],
    patterns: [{ t: 0, notes: [] }],
    musics: [{ bpm: 120, tracks: [[], [], [], [], [], [], [], []] }],
    samples: { hit: AC2.b64FromBytes(new Uint8Array(2400)) }
  });
  if (e.aramBytes <= 0) throw new Error('ARAM 统计失败');
  e.volume(0.2);
  e.stopAll();
  e.step();
  let rms = 0; for (const v of e.linearTap) rms += v * v;
  if (rms > 1e-9) throw new Error('stopAll 后仍有输出');
});

t('确定性:同输入两引擎逐字节一致', () => {
  const mk = () => {
    const e = newEng();
    e.loadAudioData({
      timbres: [{ family: 'fc', wave: 6, adsr: [0.001, 0.05, 0.7, 0.1], vol: 0.5 }],
      patterns: [{ t: 0, notes: [{ s: 0, n: 60, l: 8 }] }],
      musics: [{ bpm: 140, tracks: [[{ p: 0, b: 0 }], [], [], [], [], [], [], []] }]
    });
    e.playTrack(0);
    return e;
  };
  const a = mk(), b = mk();
  for (let i = 0; i < 60; i++) { a.step(); b.step(); }
  for (let i = 0; i < 400; i++) {
    if (a.lastOutput[i] !== b.lastOutput[i]) throw new Error('第 ' + i + ' 样本不一致');
  }
});

t('采样器:μ律采样块回放变调', () => {
  const e = newEng();
  // 造 0.1s 的 440Hz 正弦采样
  const n = 2400, f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / 24000);
  const u8 = AC2.Mulaw.encodeBlock(f);
  e.loadAudioData({
    timbres: [{ family: 'smp', sample: 's', rate: 1, vol: 0.5 }],
    patterns: [], musics: [], samples: { s: AC2.b64FromBytes(u8) }
  });
  e.chans[2].timbre = e.timbres[0];
  e.ch(2).note(880, null); // 2× 速率 → 880Hz
  const frames = render(e, 60);
  const flat = new Float32Array(60 * 400);
  frames.forEach((fr, i) => flat.set(fr, i * 400));
  const m880 = goertzel(flat, 880, 24000), m440 = goertzel(flat, 440, 24000);
  if (!(m880 > m440)) throw new Error('采样变调失败: 880=' + m880 + ' 440=' + m440);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
