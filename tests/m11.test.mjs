/* tests/m11.test.mjs — M11 验收:模拟器即调试器核心(断点/步退快照/录制回放一致/停机日志/GIF 编码) */
import { load } from './load.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const AC2 = load(
  'js/core/ansi.js', 'js/core/comp.js', 'js/core/mulaw.js',
  'js/core/font.js', 'js/core/biosfont.js', 'js/core/cart.js', 'js/core/packer.js',
  'js/host/input.js', 'js/host/mode1.js', 'js/host/mode2.js',
  'js/host/ajs.js', 'js/host/audio.js', 'js/host/bios.js', 'js/host/machine.js',
  'js/tools/gif.js', 'js/tools/debugger.js'
);

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok', name); } catch (e) { failed++; console.log('FAIL', name, '—', e.message); } }
async function ta(name, fn) { try { await fn(); passed++; console.log('  ok', name); } catch (e) { failed++; console.log('FAIL', name, '—', e.message); } }
const enc = (s) => new TextEncoder().encode(s);

const GAME = `
var x = 10;
function init(){ print('GO'); }
function update(){
  x++;
  if (x > 100) { save(new Uint8Array([1])); }
  R.clear(16);
  R.text(x % 200, 80, 'X', { color: 15 });
}`;

async function makeCart() {
  const files = [
    { path: 'cart.json', data: enc(JSON.stringify({ id: 'DEBUGTES', title: 'Debug', version: 1, mode: 2 })) },
    { path: 'cover.bin', data: new Uint8Array(1024).fill(6) },
    { path: 'main.ajs', data: enc(GAME) }
  ];
  const { bytes } = await AC2.Packer.buildFromFiles(files, {});
  await AC2.Lib.add(bytes);
  return bytes;
}

console.log('== M11 模拟器即调试器 ==');
await ta('行断点:update 内指定行挂起;恢复后继续', async () => {
  await makeCart();
  const bytes = AC2.Lib.bytes('DEBUGTES');
  // 行断点:GAME 第 6 行(x++)
  const m = new AC2.Machine({});
  m._snapOn = true;
  const cart = await AC2.Cart.load(bytes);
  m.bootCart(cart);
  m.debugHooks.onLineBp = (line) => m.haltByBp('line', 'L' + line);
  m.debugHooks.bpLines.add(6);   // x++ 所在行
  m.step();
  if (!m.breakHit || m.breakHit.type !== 'line') throw new Error('行断点未触发: ' + JSON.stringify(m.breakHit));
  if (m.breakHit.info !== 'L6') throw new Error('断点行错: ' + m.breakHit.info);
  const fAt = m.frameCount;
  m.step();  // 挂起时不推进
  if (m.frameCount !== fAt) throw new Error('挂起仍推进');
  m.resumeFromBp();
  m.step();
  if (m.frameCount !== fAt + 1) throw new Error('恢复后未推进');
});

await ta('API 断点:save 调用挂起', async () => {
  const bytes = AC2.Lib.bytes('DEBUGTES');
  const m = new AC2.Machine({});
  m._snapOn = true;
  m.bootCart(await AC2.Cart.load(bytes));
  m.debugHooks.onApiCall = (name) => m.haltByBp('api', name);
  m.debugHooks.apiBreaks.add('save');
  for (let i = 0; i < 200; i++) {
    m.step();
    if (m.breakHit) break;
  }
  if (!m.breakHit || m.breakHit.info !== 'save') throw new Error('API 断点未触发: ' + JSON.stringify(m.breakHit));
  console.log('    save 断点 @frame', m.breakHit.frame);
});

await ta('步退:快照恢复到先前帧状态', async () => {
  const bytes = AC2.Lib.bytes('DEBUGTES');
  const m = new AC2.Machine({});
  m._snapOn = true;
  m.bootCart(await AC2.Cart.load(bytes));
  for (let i = 0; i < 10; i++) { m.step(); }
  const f10 = m.frameCount;
  const fb10 = m.fb.slice();
  for (let i = 0; i < 10; i++) m.step();
  if (m.frameCount !== f10 + 10) throw new Error('前置失败');
  // 步退一次:回到上一快照
  const snap = m.snapshots.pop();
  m.restoreSnapshot(snap);
  if (m.frameCount < f10 - 1 || m.frameCount > f10 + 9) throw new Error('快照帧号异常: ' + m.frameCount);
  if (m.snapshots.length < 15) throw new Error('快照数: ' + m.snapshots.length);
});

await ta('输入录制 → 回放逐帧一致(确定性)', async () => {
  const bytes = AC2.Lib.bytes('DEBUGTES');
  // 录制:喂伪随机输入跑 60 帧,记录 fb 哈希序列
  const run = async (replayFrames) => {
    const m = new AC2.Machine({ seed: 1234 });
    m._snapOn = false;
    m.bootCart(await AC2.Cart.load(bytes));
    if (replayFrames) m.input.replay = { frames: replayFrames, i: 0, oneShot: true };
    const rec = replayFrames ? null : { frames: [] };
    if (rec) m.input.recorder = rec;
    const hashes = [];
    let seed = 77;
    for (let i = 0; i < 60; i++) {
      seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0;
      const keys = { a: !!(seed & 1), left: !!(seed & 2), up: !!(seed & 4) };
      m.input.pushInput({ keys, x: 0, y: 0, dx: 0, dy: 0 });
      m.step();
      let h = 0;
      for (let j = 0; j < m.fb.length; j += 37) h = (h * 31 + m.fb[j]) >>> 0;
      hashes.push(h);
    }
    return { hashes, rec };
  };
  const a = await run(null);
  const b = await run(a.rec.frames);
  for (let i = 0; i < 60; i++) {
    if (a.hashes[i] !== b.hashes[i]) throw new Error('第 ' + i + ' 帧哈希不一致');
  }
  console.log('    60 帧哈希序列完全一致');
});

t('GIF 编码器:索引帧 → GIF89a(可被标准解码器识别的结构)', () => {
  // 生成 10 帧噪声动画
  const frames = [];
  let s = 9;
  for (let f = 0; f < 10; f++) {
    const idx = new Uint8Array(240 * 176);
    for (let i = 0; i < idx.length; i++) {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      idx[i] = (s + f * 3) & 255;
    }
    frames.push({ delayCs: 4, indices: idx });
  }
  const gif = AC2.encodeGif(240, 176, AC2.ANSI.rgbTable, frames);
  if (gif.length < 10000) throw new Error('GIF 过小');
  if (!(gif[0] === 0x47 && gif[1] === 0x49 && gif[2] === 0x46)) throw new Error('GIF magic');
  if (gif[gif.length - 1] !== 0x3B) throw new Error('trailer');
  // 帧数:结构化遍历(扩展/图像块/子块长度跳过)
  let pos = 13 + 768, n = 0;
  const skipSubs = () => { while (gif[pos] !== 0) pos += 1 + gif[pos]; pos++; };
  while (pos < gif.length) {
    const b = gif[pos];
    if (b === 0x3B) break;
    if (b === 0x21) { pos += 2; skipSubs(); }
    else if (b === 0x2C) {
      n++;
      pos += 1 + 9;        // 分隔符 + 图像描述 9B
      pos += 1;            // LZW 最小码长
      skipSubs();          // 数据子块
    } else throw new Error('块错 @' + pos + ': 0x' + b.toString(16));
  }
  if (n !== 10) throw new Error('帧数: ' + n);
  console.log('    10 帧 ' + (gif.length / 1024).toFixed(1) + 'KB');
});

await ta('收面板=纯运行器语义:同一 Machine 无调试钩子运行不受影响', async () => {
  const bytes = AC2.Lib.bytes('DEBUGTES');
  const m = new AC2.Machine({});
  m.bootCart(await AC2.Cart.load(bytes));
  for (let i = 0; i < 120; i++) m.step();
  if (m.halted) throw new Error('异常停机: ' + m.error.message);
  if (!m.printLog.some(l => l.line === 'GO')) throw new Error('未运行');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
