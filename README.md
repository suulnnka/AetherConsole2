# AetherConsole 2

网页上的梦幻主机(240×176 · ANSI 256 色 · aJS 沙箱 · 256KB 卡带),`../AetherConsole` 的重制版。

> **状态:M0–M12 全部完成(M10 代码编辑器按 T16 暂缓);AC1 全部 11 款游戏已移植(8 款模式1);AC1 魔塔/FPS 两款地图编辑器已搬运进工具链。** 113 项自动化验收测试全部通过(`tests/`);纯 JS 实现、零构建、浏览器直接打开即用(v0.9:段压缩为 raw DEFLATE)。

## 直接开始

| 页面 | 说明 |
|---|---|
| [index.html](index.html) | **主机**:SEGA 式开机 → 封面游戏库菜单;拖入/导入 `.aec` 即玩 |
| [tools/index.html](tools/index.html) | **工具链七件**:图像 / 字体 / 音频 / 打包 / 模拟器即调试器 / **魔塔编辑器**(现场重打包 .aec 试玩) / **3D FPS 地图编辑器**(扇区几何 + 软件 3D 漫游预览);代码编辑器暂缓 T16 |
| [demos/m1.html](demos/m1.html) · [m2](demos/m2.html) · [m4](demos/m4.html) | 里程碑演示:双层卷轴+128 精灵 / 旋转·纹理·矢量 / 输入+音频 |
| [carts/dist/](carts/dist) | 示例卡带:**jumpman / rockblaster**(M12 原生)+ **AC1 移植 11 款**:魔塔、打砖块、深洞下落、像素冲刺、星雨弹幕、圆球排球、整理收纳、夜之幸存者、Aether GP、穿门飞行、苍白城堡(fps,已修正左右反转)——在主页导入即可玩 |

## 一台"规格定死"的虚拟游戏机

模式1 是类 SFC 的硬件精灵/地图层(8bit ANSI 直存,无调色板),模式2 是固件级自由光栅(位图/矢量/任意旋转/纹理映射);游戏用 aJS(标准 JS 源码 + 主机注入环境)编写,打进压缩后 ≤256KB、带 32×32 封面的 `.aec` 卡带;BIOS 有开机动画与游戏库菜单;音频 24kHz/8bit μ律,音色三族(PICO-8 / 2op FM / 808·909·303);存档每游戏 2048B。

## 文档

- [docs/spec.md](docs/spec.md) —— 规格说明书(v0.9,唯一事实来源,含变更记录)
- [docs/api.md](docs/api.md) —— aJS API 总表与文件格式速查
- [docs/progress.md](docs/progress.md) —— 里程碑验收记录(M1–M12 全绿)
- [docs/bench-m3.md](docs/bench-m3.md) —— 官方基准套件参考帧耗时表

## 开发

```bash
node tests/core.test.mjs && … tests/m1..m12   # 验收测试(无头)
node build/gen-assets.mjs && node build/gen-ac1-ports.mjs && node build/build-carts.mjs   # 重建全部 13 张卡带(含冒烟)
```

游戏项目结构(打包环境自动识别):`cart.json` + `cover.png/bin` + `main.ajs|code/` + `font.afnt` + `gfx/(.til/.map/.bm2)` + `audio/(.aud)` + `data/`。
