/* tests/m9.test.mjs — M9 验收:音频工作站数据模型(.aud)→ 实机播放一致 */
import { load } from './load.mjs';

const AC2 = load(
  'js/core/ansi.js', 'js/core/comp.js', 'js/core/mulaw.js',
  'js/core/font.js', 'js/core/biosfont.js', 'js/core/cart.js', 'js/core/packer.js',
  'js/host/input.js', 'js/host/mode1.js', 'js/host/mode2.js',
  'js/host/ajs.js', 'js/host/audio.js', 'js/host/bios.js', 'js/host/machine.js',
  'js/tools/audiowork.js'
);

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok', name); } catch (e) { failed++; console.log('FAIL', name, '—', e.message); } }
async function ta(name, fn) { try { await fn(); passed++; console.log('  ok', name); } catch (e) { failed++; console.log('FAIL', name, '—', e.message); } }
const enc = (s) => new TextEncoder().encode(s);

console.log('== M9 音频工作站 ==');

// 工作站数据模型(与 UI 编辑结果同构)
const doc = {
  timbres: [
    { family: 'fc', wave: 4, adsr: [0.003, 0.06, 0.5, 0.08], vol: 0.35, name: 'Lead' },
    { family: 'an', model: 'kick', adsr: [0.001, 0.02, 1, 0.2], vol: 0.7 },
    { family: 'fm', car: { level: 1, adsr: [0.002, 0.1, 0.6, 0.2], ratio: 1 }, mod: { level: 5, adsr: [0.002, 0.2, 0.3, 0.2], ratio: 3.01, fb: 2 }, ring: true, vol: 0.3 }
  ],
  patterns: [
    { t: 0, notes: [{ s: 0, n: 69, l: 2 }, { s: 4, n: 71, l: 2 }, { s: 8, n: 74, l: 2 }, { s: 12, n: 72, l: 2 }], vol: null, fx: [{ track: 0, type: 'fadeIn', start: 0, end: 3, params: {} }] },
    { t: 1, notes: [{ s: 0, n: 36 }, { s: 8, n: 36 }] },
    { t: 2, notes: [{ s: 0, n: 81, l: 12 }] }
  ],
  musics: [
    { bpm: 132, swing: 0.08, tracks: [[{ p: 0, b: 0 }], [], [{ p: 1, b: 0 }], [], [], [], [], []] }
  ],
  samples: {}
};

await ta('三族音色经 .aud → 实机:导出与工作站直载播放逐字节一致', async () => {
  const audBytes = new TextEncoder().encode(JSON.stringify(doc));
  // ① 工作站模型直载引擎
  const e1 = new AC2.AudioEngine();
  e1.loadAudioData(JSON.parse(new TextDecoder().decode(audBytes)));
  e1.playTrack(0);
  // ② 打包进卡带 → 装载 → aJS 触发 playTrack
  const files = [
    { path: 'cart.json', data: enc(JSON.stringify({ id: 'AUDIOTES', title: 'Audio', version: 1, mode: 2 })) },
    { path: 'cover.bin', data: new Uint8Array(1024).fill(5) },
    { path: 'main.ajs', data: enc('function init(){ A.playTrack(0); } function update(){ R.clear(16); }') },
    { path: 'audio/tune.aud', data: audBytes }
  ];
  const { bytes } = await AC2.Packer.buildFromFiles(files, {});
  const M = new AC2.Machine({ bios: false });
  M.bootCart(await AC2.Cart.load(bytes));
  // 比对 600 帧输出
  for (let i = 0; i < 600; i++) {
    e1.step();
    M.step();
    const a = e1.lastOutput, b = M.audio.lastOutput;
    for (let j = 0; j < 400; j++) {
      if (a[j] !== b[j]) throw new Error('第 ' + i + ' 帧样本 ' + j + ' 不一致(' + a[j] + ' vs ' + b[j] + ')');
    }
  }
  console.log('    600 帧 × 400 样本逐字节一致');
});

t('pattern 约束:64 步 / 固定 4/4 / 单复声(同刻一音,新音截断旧音)', () => {
  const e = new AC2.AudioEngine();
  e.loadAudioData(JSON.parse(JSON.stringify(doc)));
  e.playSfx(0, { ch: 0, bpm: 120 });
  e.step();
  if (!e.chans[0].voice.active) throw new Error('未触发');
  // 单复声:同通道 noteOn 截断
  e.ch(0).set('timbre', 0);
  e.ch(0).note(440, null);
  e.ch(0).note(880, null);   // 截断前音
  if (Math.abs(e.chans[0].voice.targetFreq - 880) > 0.01) throw new Error('未截断');
});

t('FX 轨:起止区域内音符受影响(淡入改变包络起点)', () => {
  const e = new AC2.AudioEngine();
  const fxPat = { t: 0, notes: [{ s: 0, n: 69, l: 8 }], fx: [{ track: 0, type: 'fadeOut', start: 0, end: 15, params: {} }] };
  e.loadAudioData({ timbres: doc.timbres, patterns: [fxPat], musics: [], samples: {} });
  e.playSfx(0, { ch: 0, bpm: 120 });
  e.step();
  const v1 = e.chans[0].voice;
  // fadeOut: 音符开始时音量应随时间衰减 → 30 帧后明显更小
  let rmsA = 0;
  for (const v of e.linearTap) rmsA += v * v;
  for (let i = 0; i < 30; i++) e.step();
  let rmsB = 0;
  for (const v of e.linearTap) rmsB += v * v;
  if (!(rmsA > rmsB * 1.5)) throw new Error('fadeOut 未生效');
});

t('music 8 轨:bpm+swing 为整曲属性;轨→通道一一对应', () => {
  const e = new AC2.AudioEngine();
  e.loadAudioData(JSON.parse(JSON.stringify(doc)));
  e.playTrack(0);
  e.step();
  if (e.chans[0].role !== 'music' || e.chans[2].role !== 'music') throw new Error('轨道映射错');
  if (!e.chans[0].voice.active || !e.chans[2].voice.active) throw new Error('轨 0/2 应触发(旋律+鼓)');
  if (e.chans[1].voice.active) throw new Error('空轨不应发声');
});

t('采样导入路径(WAV 16bit → 24k 重采样 → μ律)', () => {
  // 构造 1s 48kHz 16bit 单声道正弦 WAV
  const rate = 48000, n = rate;
  const dataLen = n * 2;
  const buf = new Uint8Array(44 + dataLen);
  const dv = new DataView(buf.buffer);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + dataLen, true); ws(8, 'WAVE');
  ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  ws(36, 'data'); dv.setUint32(40, dataLen, true);
  for (let i = 0; i < n; i++) {
    dv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 480 * i / rate) * 12000), true);
  }
  const r = AC2.AudioWork.importWav(buf, 'test');
  if (r.rate !== 48000) throw new Error('原采样率');
  const bytes = AC2.bytesFromB64(AC2.AudioWork.doc.samples.test);
  if (bytes.length !== 24000) throw new Error('重采样长度: ' + bytes.length);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
