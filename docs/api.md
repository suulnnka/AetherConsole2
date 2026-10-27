# AC2 API 总表(aJS)

> 主机 API 随 M1 起维护(规格 §12.5)。aJS = 标准 JS 源码 + 主机注入环境;宿主能力(DOM/网络/真实时间/eval 等)以参数遮蔽,环境内不可达。
> 生命周期:`init()`(装载后一次)与 `update()`(每帧);异常未捕获 → 主机停机保画面。

## 全局绑定

| 绑定 | 说明 |
|---|---|
| `S` | 模式1 精灵模式 API(§6.3) |
| `R` | 模式2 光栅模式 API(§6.4) |
| `A` | 音频 API(§8.4) |
| `pad` / `mouse` | 输入双视图(§9.2) |
| `bios` | BIOS 服务(§7.5) |
| `cart` | 卡带只读视图:`id/title/version/mode/meta`、`seg(type, i)`、`segs(type)`、`data(type, i)` |
| `save(bytes)` / `load()` | 存档(≤2048B,帧末落盘;损坏返回 null,§10.2) |
| `frame()` | 帧计数(自装机起的全局唯一时钟) |
| `rng(seed?)` | 无参取 `[0,1)`;带种子重置(确定性回放的基础) |
| `print(...)` | 调试输出(调试设备控制台) |

段类型名:`meta code tilesbg tilesobj maps bitmaps vectors audio font data`。

## S — 模式1(类 SFC)

- 合成顺序:BG0 → 精灵 prio0/1 → BG1 → 精灵 prio2/3;tile 0 恒透明;**每帧首自动清 OAM**(写回法)。
- 16×16 精灵 = 4 连续 tile(TL,TR,BL,BR),索引取左上。
- 每扫描线最多 32 精灵,超出按 OAM 序逐线丢弃(`S.dropped` 计数)。

```js
S.loadTiles(dst, seg, tileIndex, n)   // dst:'bg'|'obj';seg=cart 段;自动识别 TIL2 头;tileIndex=目标起始索引
S.mapSize(layer, w, h)                // 32/64/128,条目 ≤16384
S.loadMap(layer, seg, off)            // MAP2 段(含 w/h)
S.setMap(layer, x, y, w, h, entries)  // 批量写
S.setTile(layer, x, y, entry)
S.entry(tile, fh, fv)                 // → u16 条目(tile 10bit|fh|fv)
S.scroll(layer, x, y)                 // 整像素,地图回绕
S.backdrop(c)                         // 底色寄存器(tile 0/透明像素露出)
S.setSprite(i, {x, y, tile, big, fh, fv, prio})
S.hide(i)
S.clear()                             // 滚动归零 + OAM 清空
```

## R — 模式2(自由光栅)

- 全局 2×3 仿射矩阵 + 栈(`push/pop`),作用于除 `pset` 外的一切图元;角度单位 **1/256 圆**。
- 采样自适应(§6.4.4):放大/等比最近邻,缩小区域平均(mip 链装载期预生成);manifest `sampling: auto|nearest|smooth` 覆盖。
- 无混合:透明 = 位图/字形 1bit"不画"标志(§6.6)。

```js
R.loadBitmap(id, seg, off)            // BM2 段
R.loadVector(id, seg, off)            // JSON 矢量,装载期光栅化为位图缓存
R.bitmap(id) / R.unload(id) / R.setRepeat(id, on)
R.clear(color?)
R.setMatrix(m) / R.push() / R.pop() / R.identity()
R.translate(x, y) / R.scale(sx, sy?) / R.rotate(ang256)
R.pset(x, y, c) / R.pget(x, y)
R.line(x0, y0, x1, y1, c, w?)         // Bresenham,宽 1–4
R.rect(x, y, w, h, c, fill)
R.poly(pts, {color, tex, uv0, uvScale})
R.triTex(p0, p1, p2, uv0, uv1, uv2, texId)  // 仿射纹理映射;透明位镂空
R.blit(id, x, y, {rot, sx, sy, flip, fv, cx, cy})
//   (x,y)=位图左上角;rot/scale 绕枢轴(默认位图中心;cx/cy 源坐标)
R.text(x, y, str, {color, scale, font:'bios'|'cart'})
```

## A — 音频(8ch / 24kHz / μ律)

```js
A.playTrack(n) / A.stopTrack()        // music n(BGM 级)
A.playSfx(n, {ch?})                   // pattern n;借空闲通道,结束自动归还
A.ch(i).set('volume', v)              // 也可 set('timbre', idx)
A.ch(i).note(freq, lenSec?)           // 通道直驱
A.volume(v) / A.stopAll()
```

音色/pattern/music 数据随卡带 audio 段(.aud JSON,工作站产出)。

## pad / mouse

```js
pad.up/down/left/right/a/b/start      // 各含 .down .pressed .released
mouse.left / mouse.right              // = A / B
mouse.x / mouse.y                     // 绝对(240×176 系,可屏外)
mouse.dx / mouse.dy                   // 每帧原始增量(不裁剪;右摇杆并入)
```

键盘映射(§9.1):方向/WASD;Z/J=A;X/K/Space=B;Enter=Start。手柄:十字=方向,A/B + R→A/L→B,右摇杆=鼠标。

## bios

```js
bios.text(x, y, str, {color, scale})  // 两模式恒可用;恒用 BIOS 内置字体
bios.reset() / bios.exit()            // 重启卡带 / 回系统菜单
bios.print(...)                       // = print
bios.cartridges() / bios.saveList(id)
```

游戏中 **Start + 左** → 暂停浮层(继续/重启/存档管理/退出)。

## 文件格式速查

| 格式 | 布局 |
|---|---|
| `.aec` | 头 64B("AEC2"·ver·flags(bit0 混淆/bit1 模式2)·ID[8]·ver u16·标题 32B·段数 u16·整卡 CRC u32·种子 10B)+ 封面 1024B(恒不压缩)+ 段表 16B/段(type·comp·clen·rlen·crc)+ 段数据(段级 raw DEFLATE;<5% 收益存原文) |
| `.til`(TIL2) | magic u32 · count u16 · kind u8(0=bg,1=obj)· rsv · 每 tile 72B(64 色索引 + 8 行透明位,bit=1 透明) |
| `.map`(MAP2) | magic u32 · w u16 · h u16 · 条目 u16 ×w*h(tile 10bit|fh bit10|fv bit11) |
| `.bm2` | magic "BM2 " · w u16 · h u16 · w*h 色索引 · 行遮罩(每行 ceil(w/8) 字节,bit=1 透明) |
| `.afnt`(AFNT v2) | magic · ver=2 u16 · count u16 · 码点 u32×n · 每字形 14 行 ×u16(bit=列,bit0=入侵区最左) |
| `.aud` | JSON `{timbres, patterns, musics, samples}`(patterns:64 步、单复声、音量轨+2 FX 轨;musics:8 轨、bpm+swing 整曲共有) |
| 碰撞(COL1) | magic · w u16 · h u16 · 每 tile 1bit 打包 |

## 调试设备专用(非 aJS)

`machine.debugHooks`:`apiBreaks`(API 名集合)、`bpLines`(行断点;aJS 编译期自动插桩 `__bp(n)`,无断点时零负担)、`onApiCall/onLineBp` 回调;`machine.snapshots`(步退快照环);`machine.stats`(逻辑/合成/音频耗时分解,超帧只告警)。
