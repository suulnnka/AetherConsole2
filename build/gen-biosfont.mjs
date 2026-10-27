/* build/gen-biosfont.mjs — 从 AC1 字体资产生成 AC2 BIOS 内置字体(AFNT v2 数据)
 * 用法:node build/gen-biosfont.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

// 载入 AC1 字体(G 表)
const src = readFileSync(join(root, '..', 'AetherConsole', 'tools', 'default-font.js'), 'utf8');
const fakeWin = {};
new Function('window', src)(fakeWin);
const G = fakeWin.DEFAULT_FONT.chars;

// 转换:14×14 网格,bit0 = 最左列(入侵区第 1 列)
// AC1:7 宽字形位于主区第 1..7 列(0 基),顶偏移为字形首行
const glyphs = [];
for (let cp = 32; cp <= 126; cp++) {
  const ch = String.fromCharCode(cp);
  const g = G[ch] || G['?'] || [1, '.......'];
  const rows = new Uint16Array(14);
  const top = g[0];
  for (let r = 0; r < g.length - 1 && r + top < 14; r++) {
    const s = g[1 + r];
    let bits = 0;
    for (let c = 0; c < 7 && c < s.length; c++) {
      if (s[c] === '#') bits |= 1 << (2 + 1 + c); // 列 = 2(入侵)+1(主区起)+c
    }
    rows[top + r] = bits;
  }
  glyphs.push({ cp, rows });
}

const cps = glyphs.map(g => g.cp);
const data = glyphs.map(g => Array.from(g.rows));
const out = `/* js/core/biosfont.js — BIOS 内置字体(ASCII 32–126,AFNT v2 数据)
 * 由 build/gen-biosfont.mjs 从 AC1 字体资产转换(规格 §7.4:主区 12×12 + 左 2 入侵 + 下 2 尾部)
 * 每字形 14 行 × u16,bit n = 第 n 列(bit0 = 入侵区最左列);行 0–11 主区,12–13 尾部区
 */
(function () {
  'use strict';
  const G = (typeof window !== 'undefined') ? window : globalThis;
  const AC2 = G.AC2 = G.AC2 || {};
  AC2.BiosFont = {
    codepoints: ${JSON.stringify(cps)},
    glyphs: ${JSON.stringify(data)}
  };
})();
`;
writeFileSync(join(root, 'js', 'core', 'biosfont.js'), out);
console.log('biosfont.js written:', glyphs.length, 'glyphs');
