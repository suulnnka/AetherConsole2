# AC2 里程碑验收记录

> M0 于 2026-10-26 批准开工(老板指示:完成项目至 M12,M10 不做)。
> 每项验收以自动化测试为准:`node tests/<m>.test.mjs`(全量 98 项通过);另附浏览器人工核验项。
> v0.9 变更:段压缩由 LZ4 改为 raw DEFLATE(两端内置,压缩率更高,老板指示)。

| 里程碑 | 内容 | 验收结果 |
|---|---|---|
| **M1** | 显示内核 + 模式1 + 帧时序 | `tests/m1.test.mjs` 8 项 ✓:双 BG 优先级(BG0<精灵01<BG1<精灵23)、透明位、滚动回绕(横/竖)、H/V 翻转、16×16 四 tile 展开、每线 32 上限(40 同行精灵 → 逐线丢弃 64 行)、帧首自动清 OAM、128 精灵满屏合成 **0.26ms/帧**;模式切换清 VRAM/OAM ✓;demo [demos/m1.html](../demos/m1.html)(双层数据卷轴 + 128 精灵 + 同行 40 带演示丢弃计数) |
| **M2** | 模式2 光栅化 + 模式切换 | `tests/m2.test.mjs` 12 项 ✓:点线面、1:1/放大(最近邻)/缩小(box 平均量化出中间色)/90°/45° 旋转、盒内翻转、纹理三角(仿射 UV + 透明镂空)、矢量光栅化缓存、矩阵栈、文本(12px 步进/倍率)、切换清位图池;性能:满屏 blit **0.12ms**、旋转 blit **0.16ms**、大三角纹理 <1ms;demo [demos/m2.html](../demos/m2.html)(纹理立方体/矢量星/自适应采样对照/切换按钮) |
| **M3** | aJS 环境 + 基准套件 | `tests/m3.test.mjs` 6 项 ✓:生命周期、**18 项宿主能力全部不可达**(DOM/网络/真实时间/eval/Function/计时器…)、构造式逃逸阻断、异常停机(保画面/onError/停机后不推进)、rng 确定性、API 冻结;[docs/bench-m3.md](bench-m3.md):粒子 2000 0.06ms / 满 OAM 0.23ms / 旋转 blit 0.35ms / 纹理三角×60 1.04ms,全部远低于 16.67ms 预算 |
| **M4** | 输入 + 音频 | `tests/m4.test.mjs` 13 项 ✓:沿检测/双视图/dx-dy 不裁剪/录制回放一致;音频:440Hz Goertzel 频谱验证、FC 8 波形(白/粉噪、金属噪、S&H)全出声、2op FM 调制/环形可闻差异、模拟族 7 件衰减正确、序列器步进/8 轨编排、SFX 借道归还、μ律=编码(线性)、逐字节确定性、采样器变调;demo [demos/m4.html](../demos/m4.html) |
| **M5** | BIOS + 卡带装载 + 存档 | `tests/m5.test.mjs` 8 项 ✓:开机特效时序(0.2s 黑→0.6s 飞入带拖影→定格闪白+jingle→抖动渐隐≈2s)、库导入/列表/启动、同 ID 高版本去重、**存档闭环(SAVED→重启 LOADED)**、坏卡带 CRC 报错不崩、Start+Left 暂停冻结(逻辑/音频)、bios.exit、bios.text 两模式;入口 [index.html](../index.html) |
| **M6** | .aec 定稿 + 打包环境 | `tests/m6.test.mjs` 7 项 ✓:自动识别六类内容、code/ 多文件按序拼接、**标准+混淆双出品均可装载运行**(混淆卡源码不可直读)、超限拒绝出品并报最大段、坏代码卡被冒烟拦截、ID 登记防冲突、manifest 缺省值;工具 [tools/pack.html](../tools/pack.html)(拖文件夹/预算面板/冒烟/导入库),Node 构建 `build/build-carts.mjs` |
| **M7** | 图像编辑器 | `tests/m7.test.mjs` 6 项 ✓:8×8/16×16 导出 TIL2、16×16 四 tile 内核展开、MAP2/COL1 往返、**16×16 图块笔刷占 4 格**、自由绘制 BM2/封面、端到端(编辑器产物→打包→内核显示+数据段读取);工具 [tools/image.html](../tools/image.html)(三模式/PNG 导入 FS/Bayer 量化/抖动笔刷/洋葱皮/动画预览/草稿自动保存) |
| **M8** | 字体编辑器 | `tests/m8.test.mjs` 3 项 ✓:14×14 三区(左 2 入侵/下 2 尾部)、中文码点 + AFNT v2 往返、**入卡带游戏内生效而 BIOS 恒内置**;工具 [tools/font.html](../tools/font.html)(三区着色/预览条/试排/紧凑行高对照/导入导出) |
| **M9** | 音频工作站 | `tests/m9.test.mjs` 5 项 ✓:三族音色经 .aud → 实机 **600 帧×400 样本逐字节一致**、pattern 约束(64 步/单复声新音截断)、FX 轨起止生效、music 8 轨 bpm+swing 整曲属性、WAV→24k 重采样→μ律;工具 [tools/audio.html](../tools/audio.html)(音色三族面板/键盘试奏/钢琴卷帘+音量+2FX 轨/8 轨编排/电平表+示波器 μ律前后可切) |
| **M10** | 代码编辑器 | **暂缓(T16)**,恢复时机另定;工作流 = 任意文本编辑器 `.ajs` → 打包自动收集 → 冒烟/调试器兜错 |
| **M11** | 模拟器即调试器 | `tests/m11.test.mjs` 6 项 ✓:行断点(编译期插桩 `__bp`,挂起/恢复)、API 断点(save)、步退快照、**输入录制→回放 60 帧哈希逐帧一致**、GIF89a 结构化校验(10 帧)、无钩子纯运行器;工具 [tools/emulator.html](../tools/emulator.html)(运行控制/源码·API 断点/VRAM·OAM·ARAM·性能视图/虚拟手柄/录放/PNG·GIF·.sav 导出;**收面板即纯运行器**) |
| **M12** | 示例卡带 ×2 | `tests/m12.test.mjs` 5 项 ✓:**Jumpman**(模式1 平台跳跃:物理/跳跃/金币/OAM 精灵/存档读回/BGM)6.2KB;**Rock Blaster**(模式2 旋转射击:任意旋转/推进/射击/击碎分裂/死亡存高分)5.6KB;两卡均 **≤256KB**、60fps(平均帧耗时 0.02–0.05ms)、混淆出品可玩;构建:`node build/gen-assets.mjs && node build/build-carts.mjs`(全程工具链格式),产物 `carts/dist/*.aec` |

## AC1 游戏移植(追加交付)

AC1 全部 11 款游戏移植至 AC2(`carts/` 下各目录,产物 `carts/dist/*.aec`),`tests/ac1ports.test.mjs` 14 项 ✓:

| 游戏 | ID | 模式 | 移植要点 |
|---|---|---|---|
| Magic Tower | MAGICTW1 | **1** | 11×11×16px 地形全进 BG 地图;17 怪+仙子+物品走 OAM;战斗公式照搬;RLE 差异存档(≤2048B)|
| Breakout | BREAKOU1 | **1** | 砖/挡板/球/碎屑走 OAM(40 砖 2 血);速度动力学/连击/震屏;边框星野 BG |
| Deep Drop | DEEPDROP | **1** | 平台写进循环 BG 地图(竖向卷动换行);五种平台类型;PERFECT 连击;BG1 顶部尖刺 |
| Pixel Dash | PIXELDS1 | **1** | 障碍/浮台/坑全在 BG0 世界地图;BG1 视差天空;二段跳/滑铲/土狼时间 |
| Starfall | STARFAL1 | **1** | 星野 BG 卷动;敌波/Boss 三阶段/擦弹;弹幕上限 100(OAM 预算内)|
| Puff Volley | PUFFVOL1 | **1** | 球场/球网 BG;圆球兽精灵(跳姿换 tile);AI 轨迹预测;15 分制 |
| Tidy Up! | TIDYUP01 | **1** | 地板/货架双屏两张 BG 地图;机器人+物品走 OAM;S/A/B/C 评级 |
| Night Survivor | NIGHTSV1 | **1** | 循环棋盘 BG;5 武器 7 被动/升级三选一/Boss;实体上限适配 OAM |
| Aether GP | AETHERG1 | 2 | 扫描线透视路面 R.rect 逐行;检查点续时/擦身加分/三主题 |
| Gate Runner | GATERUN1 | 2 | 3D 方环门/网格 R.line 投影;鼠标+键盘转向;8 关+RANK |
| Pale Citadel | PALECTL1 | 2 | z-buffer 软件多边形光栅城市;**左右平移反转已修正**(AC1 按"右"实际向左) |

共同处理:240×180→240×176;AC1 RGB565 调色板 → ANSI 256 量化(资产由 `build/gen-ac1-ports.mjs` 生成);迷你字体 HUD → bios.text;localStorage → 2048B save API。
附带修复:aJS 调试插桩在"循环体换行"处误插语句的 bug(`js/host/ajs.js` 续行过滤补 `)` 尾)。

## AC1 编辑器搬运(追加交付)

魔塔与 3D FPS 两款地图编辑器自 AC1 `tools/` 搬运至 AC2 工具链(`tools/mtedit.html`、`tools/fpsedit.html`),`tests/editors.test.mjs` 7 项 ✓:

**魔塔编辑器**(`tools/mtedit.html` + `js/tools/mtedit.js`)
- 图块/精灵图标直接解析 `carts/magictower` 的 TIL2 + pal.json 渲染,与游戏逐像素一致(BG 2×2 拼 16×16,实体走 OBJ tile + mask 透明)
- 楼层管理(2..21 层)/绘制(左键画·右键吸管·拖刷)/快捷挖房间/怪物数值表/校验(楼梯配对·入口 BFS·钥匙收支)/导入导出(JSON + 字符画文本,格式 `aether-mt` v1 与 AC1 互通)/草稿自动保存
- **试玩 = 现场重打包真卡带**:编辑数据写进 data 段(MAPS/MON 覆盖,`carts/magictower/main.ajs` 支持覆盖)→ `AC2.Packer.buildFromFiles` 产 .aec → `Machine({bios:false}).bootCart` 直启,试玩前后备份/恢复存档槽
- 魔塔卡带侧去掉 21 层硬编码(persist/warp/goFloor 改随 `MAPS.length`),自定义层数的塔也能跑

**3D FPS 地图编辑器**(`tools/fpsedit.html` + `js/tools/fpsedit.js` + `js/tools/fpsmap-core.js`)
- Doom 风格扇区模型(顶点/线/扇区/物件)完整搬运:画多边形自动建区、十字/T 接自动切分、空侧偶奇缝合、吞没线删除
- 几何与校验下沉为纯模块 `fpsmap-core.js`(浏览器与 Node 共用),编辑器与测试走同一实现
- 软件渲染 3D 预览原样搬运:门户列光线投射 + 地板/天花投影 + 深度缓冲精灵 + 雾效,指针锁定漫游/重力/台阶/飞行
- 导入导出保持 `aether-fpsmap` v1(与 AC1 编辑器文件互通)

**顺带修复的既有 bug**
- `js/host/ajs.js` 行断点插桩:续行判定剥行注释后未去尾随空格,`x = [ // 注释` 之类代码会被插坏(M11 调试器同样受益)
- AC1 魔塔编辑器撤销快照浅拷贝行数组导致"画后即失效"(AC2 版深拷贝修复)
- `tools/editor-common.js` ANSI 色表改为惰性构建(修复先于 ansi.js 加载时全黑)

## 复现

```bash
node tests/core.test.mjs   # 核心库(ansi/deflate/μ律/字体/卡带)
node tests/m1.test.mjs … tests/m12.test.mjs   # 各里程碑(无 M10)
node tests/ac1ports.test.mjs                  # AC1 移植 11 款验收
node tests/editors.test.mjs                   # 编辑器搬运验收
node build/gen-assets.mjs && node build/gen-ac1-ports.mjs && node build/build-carts.mjs   # 重建全部卡带
```

浏览器:直接打开 `index.html`(主机)/`tools/index.html`(工具链)—— 零构建,file:// 即用。
