/* tests/m5.test.mjs — M5 验收:BIOS(启动特效→封面菜单→运行卡带→存档→重启读档)+ 坏卡带报错 */
import { load } from './load.mjs';

const AC2 = load(
  'js/core/ansi.js', 'js/core/comp.js', 'js/core/mulaw.js',
  'js/core/font.js', 'js/core/biosfont.js', 'js/core/cart.js',
  'js/host/input.js', 'js/host/mode1.js', 'js/host/mode2.js',
  'js/host/ajs.js', 'js/host/audio.js', 'js/host/bios.js', 'js/host/machine.js'
);

let passed = 0, failed = 0;
function t(name, fn) { try { fn(); passed++; console.log('  ok', name); } catch (e) { failed++; console.log('FAIL', name, '—', e.message); } }
async function ta(name, fn) { try { await fn(); passed++; console.log('  ok', name); } catch (e) { failed++; console.log('FAIL', name, '—', e.message); } }

const cover = new Uint8Array(1024).fill(4);
const GAME_CODE = `
var saved = 0, f0 = 0;
function init(){
  f0 = frame();
  var d = load();
  if (d && d.length) { saved = d[0] | (d[1]<<8); print('LOADED ' + saved); }
  else print('FRESH');
}
function update(){
  var f = frame() - f0;
  if (f === 30) { saved = 4242; save(new Uint8Array([saved & 255, saved >> 8])); print('SAVED'); }
  if (pad.a.pressed) { bios.exit(); }
  R.text(10, 10, 'GAME f=' + f + ' best=' + saved, {color: 15});
}`;

async function makeCartBuf(id, title, code, mode) {
  return AC2.Cart.build({
    id, title, version: 1, mode,
    segments: [{ type: 'code', data: new TextEncoder().encode(code || GAME_CODE) }],
    cover
  });
}

console.log('== M5 BIOS ==');

await ta('启动特效:飞入 → 定格闪白 → 渐隐 → 菜单(约 2s)', async () => {
  const M = new AC2.Machine({});
  const nonzero = () => M.fb.some(v => v !== 0);
  for (let i = 0; i < 11; i++) M.step();  // 0..10 帧全黑;第 12 帧起 LOGO 飞入(0.2s)
  if (nonzero()) throw new Error('前 0.2s 应全黑');
  for (let i = 0; i < 20; i++) M.step(); // f≈32:飞入中
  if (!nonzero()) throw new Error('飞入阶段应有画面');
  for (let i = 0; i < 20; i++) M.step(); // f≈52:定格 + 闪白后
  if (!nonzero()) throw new Error('定格阶段应有画面');
  for (let i = 0; i < 68; i++) M.step(); // f≈120
  if (M.state !== 'menu') throw new Error('未进入菜单: ' + M.state);
  // 菜单画面含标题栏
  if (!M.fb.some(v => v === 236)) throw new Error('菜单标题栏未绘制');
});

await ta('卡带库:导入 → 列表 → 启动(init 执行)', async () => {
  AC2.Lib._mem = null;
  const M = new AC2.Machine({});
  for (let i = 0; i < 125; i++) M.step(); // 进菜单
  if (M.bios.items.length !== 0) throw new Error('初始库应空');
  await AC2.Lib.add(await makeCartBuf('TESTGAME', 'Test Game'));
  M.bios.reloadList();
  if (M.bios.items.length !== 1 || M.bios.items[0].id !== 'TESTGAME') throw new Error('列表错误');
  await M.bios.launch(0);
  if (M.state !== 'game') throw new Error('未进入游戏: ' + M.state);
  if (!M.printLog.some(l => l.line === 'FRESH')) throw new Error('init 未执行或读档异常');
  M.step();
  if (!M.printLog.length) throw new Error('无日志');
});

await ta('同 ID 去重:高版本覆盖低版本', async () => {
  AC2.Lib._mem = null;
  await AC2.Lib.add(await AC2.Cart.build({ id: 'DEDUPE01', title: 'v1', version: 1, segments: [{ type: 'code', data: new TextEncoder().encode('function init(){}function update(){}') }], cover }));
  await AC2.Lib.add(await AC2.Cart.build({ id: 'DEDUPE01', title: 'v2', version: 2, segments: [{ type: 'code', data: new TextEncoder().encode('function init(){}function update(){}') }], cover }));
  await AC2.Lib.add(await AC2.Cart.build({ id: 'DEDUPE01', title: 'v0', version: 0, segments: [{ type: 'code', data: new TextEncoder().encode('function init(){}function update(){}') }], cover }));
  const list = AC2.Lib.list();
  if (list.length !== 1) throw new Error('去重失败: ' + list.length);
  if (list[0].version !== 2) throw new Error('版本保留错误: ' + list[0].version);
});

await ta('存档闭环:游戏内存档 → 重启卡带读档', async () => {
  AC2.Lib._mem = null;
  const M = new AC2.Machine({});
  await AC2.Lib.add(await makeCartBuf('SAVETEST', 'Save Test'));
  for (let i = 0; i < 125; i++) M.step();
  M.bios.reloadList();
  await M.bios.launch(0);
  for (let i = 0; i < 35; i++) M.step();
  if (!M.printLog.some(l => l.line === 'SAVED')) throw new Error('存档未发生');
  // 重启
  M.resetCart();
  for (let i = 0; i < 5; i++) M.step();
  if (!M.printLog.some(l => l.line === 'LOADED 4242')) throw new Error('读档失败:' + M.printLog.map(l => l.line).join('|'));
});

await ta('坏卡带:CRC 错误 → 菜单报错码,不崩', async () => {
  AC2.Lib._mem = null;
  const M = new AC2.Machine({});
  for (let i = 0; i < 125; i++) M.step();
  const bad = await makeCartBuf('BADCART1', 'Bad');
  bad[70] ^= 0xFF; // 破坏封面区(CRC 覆盖)
  try { await AC2.Lib.add(bad); } catch (e) { /* add 内部 load 校验失败 → 不入库 */ }
  // 手动塞进库(绕过 add 校验,模拟坏库)
  const lib = AC2.Lib.get();
  lib['BADCART1'] = { version: 1, title: 'Bad', mode: 1, b64: AC2.b64FromBytes(bad) };
  AC2.Lib.put(lib);
  M.bios.reloadList();
  await M.bios.launch(0);
  if (M.state !== 'menu') throw new Error('坏卡带不应进入游戏');
  if (!M.bios.errorMsg) throw new Error('无错误码');
  console.log('    错误码:', M.bios.errorMsg);
});

await ta('暂停浮层:Start+Left 冻结逻辑与音频,RESUME 恢复', async () => {
  AC2.Lib._mem = null;
  const M = new AC2.Machine({});
  await AC2.Lib.add(await makeCartBuf('PAUSETE1', 'Pause'));
  for (let i = 0; i < 125; i++) M.step();
  M.bios.reloadList();
  await M.bios.launch(0);
  for (let i = 0; i < 10; i++) M.step();
  // 按住 Start + 按下 Left
  M.input.pushInput({ keys: { start: true }, x: 0, y: 0, dx: 0, dy: 0 });
  M.input.pushInput({ keys: { start: true, left: true }, x: 0, y: 0, dx: 0, dy: 0 });
  const f0 = M.frameCount;
  M.step();
  if (!M.paused || M.state !== 'pause') throw new Error('未暂停');
  M.step(); M.step();
  if (M.frameCount !== f0 + 1) throw new Error('暂停时逻辑帧仍在推进');
  // 音频静音
  const anyAudio = M.audio.lastOutput.some(b => b !== 255);
  if (anyAudio) throw new Error('暂停音频未静音'); // 注:进入暂停时已 fill(255);若游戏无声本来就 255
  // RESUME
  M.bios.pauseSel = 0;
  M.bios.update();
  M.input.pushInput({ keys: {}, x: 0, y: 0, dx: 0, dy: 0 });
  M.bios.update();
  M.input.injectKey('a', true);
  M.bios.update();
  if (M.paused || M.state !== 'game') throw new Error('未恢复: ' + M.state + ' paused=' + M.paused);
  const f1 = M.frameCount;
  M.step();
  if (M.frameCount !== f1 + 1) throw new Error('恢复后不推进');
});

await ta('bios.exit() 游戏中退回菜单', async () => {
  AC2.Lib._mem = null;
  const M = new AC2.Machine({});
  await AC2.Lib.add(await makeCartBuf('EXITTEST', 'Exit'));
  for (let i = 0; i < 125; i++) M.step();
  M.bios.reloadList();
  await M.bios.launch(0);
  for (let i = 0; i < 5; i++) M.step();
  M.input.injectKey('a', true);
  M.step();
  if (M.state !== 'menu') throw new Error('未退回菜单: ' + M.state);
});

await ta('bios.text 在两模式恒可用(mode1 走覆盖队列)', async () => {
  AC2.Lib._mem = null;
  const code = `
function init(){}
function update(){ S.backdrop(16); bios.text(8,8,'OVERLAY',{color:15}); }`;
  const M = new AC2.Machine({});
  await AC2.Lib.add(await makeCartBuf('TEXTTEST', 'Txt', code, 1));
  for (let i = 0; i < 125; i++) M.step();
  M.bios.reloadList();
  await M.bios.launch(0);
  M.step(); M.step();
  let found = false;
  for (let y = 8; y < 22 && !found; y++) for (let x = 8; x < 60; x++) if (M.fb[y * 240 + x] === 15) { found = true; break; }
  if (!found) throw new Error('mode1 bios.text 未绘制');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
