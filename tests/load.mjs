/* tests/load.mjs — Node 端加载 AC2 纯 JS 模块(与浏览器同源文件) */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export function load(...rels) {
  for (const rel of rels) {
    const src = readFileSync(join(root, rel), 'utf8');
    // 间接 eval 使脚本运行在全局作用域(与浏览器 <script> 一致)
    (0, eval)(src);
  }
  return globalThis.AC2;
}

export const ROOT = root;
