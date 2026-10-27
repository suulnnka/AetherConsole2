/* build/build-carts.mjs — Node 端构建:.aec 出品(与浏览器打包工具同一核心 Packer)
 * 用法:node build/build-carts.mjs <项目目录> <输出.aec> [--obf]
 * 缺省:构建 carts/ 下全部子目录 → carts/dist/
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { load } from '../tests/load.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

load(
  'js/core/ansi.js', 'js/core/comp.js', 'js/core/mulaw.js',
  'js/core/font.js', 'js/core/biosfont.js', 'js/core/cart.js', 'js/core/packer.js',
  'js/host/input.js', 'js/host/mode1.js', 'js/host/mode2.js',
  'js/host/ajs.js', 'js/host/audio.js', 'js/host/bios.js', 'js/host/machine.js'
);
const AC2 = globalThis.AC2;

function walk(dir, base, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, base ? base + '/' + name : name, out);
    else out.push({ path: base ? base + '/' + name : name, data: new Uint8Array(readFileSync(p)) });
  }
}

async function buildOne(srcDir, outFile, obf) {
  const files = [];
  walk(srcDir, '', files);
  const { bytes, report } = await AC2.Packer.buildFromFiles(files, { obfuscate: obf });
  writeFileSync(outFile, bytes);
  const lines = [
    `▸ ${relative(root, srcDir)} → ${relative(root, outFile)}`,
    `  ID ${report.id} v${report.version} · mode ${report.mode} · ${report.obfuscated ? '混淆' : '标准'}出品`,
    `  卡带 ${report.cartBytes} B / ${report.limit} B(余 ${report.margin} B)${report.ok ? '' : ' · 超限!'}`,
    ...report.segments.map(s => `  · ${s.name.padEnd(28)} ${s.type.padEnd(9)} ${String(s.raw).padStart(7)} → ${String(s.comp).padStart(7)}${s.compressed ? '' : ' (存原文)'}`)
  ];
  console.log(lines.join('\n'));
  if (!report.ok) throw new Error('超过 256KB 上限');
  const smoke = await AC2.Packer.smoke(bytes, 120);
  console.log(smoke.ok ? `  冒烟 ✓ 120 帧(logic ${smoke.logicMs.toFixed(2)}ms / draw ${smoke.drawMs.toFixed(2)}ms)` : `  冒烟 ✗ @${smoke.stage}: ${smoke.error}`);
  if (!smoke.ok) throw new Error('冒烟失败');
  return { bytes, report };
}

const args = process.argv.slice(2);
if (args.length >= 2) {
  const obf = args.includes('--obf');
  await buildOne(args[0], args[1], obf);
} else {
  // 构建 carts/ 全部子目录
  const cartsDir = join(root, 'carts');
  const dist = join(cartsDir, 'dist');
  mkdirSync(dist, { recursive: true });
  let fail = 0;
  for (const name of readdirSync(cartsDir)) {
    const p = join(cartsDir, name);
    if (!statSync(p).isDirectory() || name === 'dist') continue;
    try {
      await buildOne(p, join(dist, name + '.aec'), false);
    } catch (e) { console.error('  构建/冒烟失败:', e.message); fail++; }
  }
  process.exit(fail ? 1 : 0);
}
