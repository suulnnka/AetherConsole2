/* tests/m2.test.mjs — M2 验收(模式2):点线面、位图 blit(旋转/缩放/翻转/自适应采样)、
 * 纹理映射三角形、矢量光栅化缓存、矩阵栈、文本、模式切换 */
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

const M = new AC2.Machine({});
M.setMode(2);
const R = M.R;
const at = (x, y) => M.fb[y * 240 + x];

// BM2 位图构造
function bm2(w, h, fill) {
  const n = w * h, stride = (w + 7) >> 3;
  const buf = new Uint8Array(8 + n + stride * h);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x20324D42, true); // "BM2 "
  dv.setUint16(4, w, true); dv.setUint16(6, h, true);
  for (let i = 0; i < n; i++) buf[8 + i] = fill(i % w, (i / w) | 0);
  return buf;
}

console.log('== M2 模式2 ==');
t('clear/pset/pget', () => {
  R.clear(100);
  R.pset(10, 10, 42);
  if (at(10, 10) !== 42) throw new Error('pset 失败');
  if (R.pget(10, 10) !== 42) throw new Error('pget 失败');
  if (at(0, 0) !== 100) throw new Error('clear 失败');
});

t('line(Bresenham + 宽度)/rect/poly', () => {
  R.clear(0);
  R.line(5, 5, 100, 5, 9, 2);
  if (at(50, 5) !== 9 || at(50, 6) !== 9) throw new Error('line 宽度失败');
  R.rect(10, 20, 30, 10, 11, true);
  if (at(20, 25) !== 11) throw new Error('rect fill 失败');
  R.poly([[50, 30], [80, 30], [65, 50]], { color: 13 });
  if (at(65, 31) !== 13) throw new Error('poly fill 失败');
  if (at(65, 55) !== 0) throw new Error('poly 越界写入');
});

t('blit 1:1 与放大(最近邻,硬边无新色)', () => {
  R.clear(0);
  const seg = { data: bm2(8, 8, (x, y) => ((x < 4) ? 9 : 12)) }; // 左红右蓝
  R.loadBitmap('t1', seg);
  R.blit('t1', 10, 10);
  if (at(12, 12) !== 9 || at(16, 12) !== 12) throw new Error('1:1 blit 失败');
  // 放大 4×:左半全红右半全蓝(最近邻,不产生新色)
  R.blit('t1', 30, 10, { sx: 4, sy: 4 });
  if (at(31, 11) !== 9) throw new Error('放大左失败');
  if (at(60, 40) !== 12) throw new Error('放大右失败');
  if (at(44, 30) !== 9 || at(48, 30) !== 12) throw new Error('放大中缝失败');
});

t('blit 缩小(区域平均 box → 紫色量化)', () => {
  R.clear(0);
  // 8×8:左 4 列纯红(9=255,0,0),右 4 列纯蓝(12=0,0,255);缩到 2×2 → 每格平均 (128,0,128) → ANSI 5
  R.blit('t1', 10, 60, { sx: 0.25, sy: 0.25 });
  if (at(10, 60) !== 5) throw new Error('缩小平均失败: got ' + at(10, 60) + ' 应为 5(#800080)');
});

t('blit 旋转 90°(1/256 圆单位)与任意角', () => {
  R.clear(0);
  const seg = { data: bm2(8, 8, (x, y) => (x < 2 && y < 2) ? 10 : ((x >= 6 && y >= 6) ? 13 : 8)) };
  R.loadBitmap('t2', seg);
  R.blit('t2', 100, 60, { rot: 64 }); // 90° 绕中心 (104,64):TL 角(rel -4..-3,-4..-3)→(3..4,-4..-3)
  if (at(108, 60) !== 10 && at(107, 60) !== 10) throw new Error('旋转 90° TL→TR 失败: ' + at(108, 60) + '/' + at(107, 60));
  if (at(101, 66) !== 13 && at(102, 66) !== 13) throw new Error('旋转 90° BR→BL 失败: ' + at(101, 66));
  // 45°:菱形(顶点在中心 (164,94) 上方 ≈5.66px)
  R.clear(0);
  R.blit('t2', 160, 90, { rot: 32 });
  if (at(163, 89) === 0 && at(164, 89) === 0) throw new Error('45° 顶部失败');
  if (at(164, 99) !== 0) throw new Error('45° 底部越界失败');
});

t('翻转 flip/fv', () => {
  R.clear(0);
  R.blit('t2', 10, 100, { flip: true }); // 左右翻:TL 角红 → TR
  if (at(16, 100) !== 10) throw new Error('flip 失败');
  if (at(10, 106) !== 13) throw new Error('flip 对角失败');
});

t('纹理映射三角形(仿射 UV + 透明镂空)', () => {
  R.clear(0);
  // 纹理:8×8 左红右蓝,但 (7,0) 透明(镂空)
  const seg = { data: bm2(8, 8, (x, y) => ((x < 4) ? 9 : 12)) };
  const px = seg.data;
  px[8 + 0 * 8 + 7] = 0; px[8 + 8 + 0] |= (1 << 7); // (7,0) 透明
  R.loadBitmap('tex', seg);
  R.triTex([50, 120], [50 + 64, 120], [50, 120 + 64], [0, 0], [8, 0], [0, 8], 'tex');
  // (50,120) 附近 → UV≈(0,0) 红
  if (at(53, 123) !== 9) throw new Error('triTex UV 原点失败: ' + at(53, 123));
  // 右端 → UV≈(8,0) 蓝(但 UV 采样 7 附近 → 蓝或透明);取 (100,123):u≈5.9 → 蓝
  if (at(100, 123) !== 12) throw new Error('triTex 右端失败: ' + at(100, 123));
  // 对角线外不画(该行三角形只到 x≈59)
  if (at(100, 175) !== 0) throw new Error('triTex 越界失败');
});

t('矢量:路径填充 + 描边,装载期光栅化为位图缓存', () => {
  R.clear(0);
  const vec = JSON.stringify({
    w: 20, h: 20,
    paths: [
      { d: [['m', 2, 2], ['l', 18, 2], ['l', 18, 18], ['l', 2, 18]], close: true, fill: 30, stroke: 39, width: 1 }
    ]
  });
  const seg = { data: new TextEncoder().encode(vec) };
  R.loadVector('v1', seg);
  R.blit('v1', 150, 120);
  if (at(160, 130) !== 30) throw new Error('矢量填充失败');
  if (at(152, 122) !== 39) throw new Error('矢量描边失败(路径 2,2): ' + at(152, 122));
  if (at(150, 120) !== 0) throw new Error('矢量外应透明');
});

t('矩阵栈:translate/rotate/push/pop 作用于图元', () => {
  R.clear(0);
  R.push();
  R.translate(120, 40);
  R.rotate(64); // 90°
  R.line(0, 0, 30, 0, 15, 1); // 旋转后变成竖线
  R.pop();
  if (at(120, 60) !== 15) throw new Error('矩阵旋转线失败');
  if (at(140, 40) === 15 && at(120, 60) !== 15) throw new Error('矩阵未生效');
  // pop 后矩阵还原
  R.line(0, 0, 10, 0, 15, 1);
  if (at(5, 0) !== 15) throw new Error('pop 还原失败');
});

t('文本:BIOS 字体(12px 步进,透明位镂空,倍率)', () => {
  R.clear(0);
  R.text(4, 4, 'A!', { color: 15 });
  // 'A' 的字形主体在主区;非空字符必有像素
  let cnt = 0;
  for (let y = 0; y < 14; y++) for (let x = 0; x < 24; x++) if (at(4 + x, 4 + y) === 15) cnt++;
  if (cnt < 10) throw new Error('文本像素过少: ' + cnt);
  R.text(4, 100, 'AC', { color: 9, scale: 2 });
  let cnt2 = 0;
  for (let y = 0; y < 30; y++) for (let x = 0; x < 48; x++) if (at(4 + x, 100 + y) === 9) cnt2++;
  if (cnt2 < cnt * 3) throw new Error('2× 文本像素应约 4×: ' + cnt2 + ' vs ' + cnt);
});

t('模式切换清 VRAM(位图池清空)且模式1互斥', () => {
  R.loadBitmap('keep', { data: bm2(4, 4, () => 9) });
  if (!R.bitmap('keep')) throw new Error('位图应在');
  M.setMode(1);
  M.setMode(2);
  if (R.bitmap('keep')) throw new Error('切换后位图池应清空');
});

t('性能:满屏 blit / 旋转 blit / 纹理三角形', () => {
  const seg = { data: bm2(240, 176, (x, y) => ((x ^ y) & 8 ? 9 : 12)) };
  R.loadBitmap('big', seg);
  let t0 = performance.now(), n = 0;
  for (let i = 0; i < 60; i++) { R.blit('big', 0, 0); n++; }
  let dt1 = (performance.now() - t0) / n;
  t0 = performance.now(); n = 0;
  for (let i = 0; i < 60; i++) { R.blit('big', 120, 88, { rot: (i * 7) & 255 }); n++; }
  let dt2 = (performance.now() - t0) / n;
  const tex = R.bitmap('tex');
  t0 = performance.now(); n = 0;
  for (let i = 0; i < 60; i++) {
    R.triTex([10, 10], [200, 20], [120, 160], [0, 0], [8, 0], [0, 8], 'tex');
    n++;
  }
  let dt3 = (performance.now() - t0) / n;
  console.log(`    满屏 blit ${dt1.toFixed(3)}ms · 满屏旋转 blit ${dt2.toFixed(3)}ms · 大三角纹理 ${dt3.toFixed(3)}ms`);
  if (dt1 > 4 || dt2 > 8) throw new Error('模式2 性能不达标');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
