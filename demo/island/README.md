# 捏一座岛

用手指在海上捏出一座会生活的小岛。这是 [defold_for_minigame](../../README_zh.md) 的演示游戏：Defold 1.14.1 写成，
Lua SDK 用的是 v0.1.0 的库依赖，用仓库里的导出工具导出成微信、抖音、TikTok 小游戏。目前只在微信开发者工具里运行过。

## 现在有什么

- **捏**：抬高、压低、抹平、圆滑，范围 5 档、力度 3 档；七种地表；小河和湖泊；撤销 40 步。
- **放**：6 种房子、6 种植物、11 种装饰、小路。数量可选，默认一次放 1 个；放不下的地方会说明原因；“整理”一键清掉泡水和悬空的东西。
- **自己变好看**：房子挨着放连成一排并共用屋顶，门朝路，长烟囱，水边长码头；路过水搭木桥，路口和路灯自己出现；岸边是沙滩、礁石和浪花。
- **生活**：房子挨着路就有岛民搬来，散步、钓鱼、发呆，点一下会说话；小船、海鸥、炊烟、萤火虫，夜里窗户亮灯。
- **天色**：昼夜滑条，四季，晴、雨、雾、雪、彩虹。
- **长期**：15 个任务逐步解锁，每个任务都能“帮我做”；岛屿等级；57 项图鉴；3 个岛位；岛屿码复制和粘贴。
- **拍照**：6 个滤镜、4 种画框。目前只是取景，保存要靠截屏。
- **镜头**：“移动”和“旋转”两个单指模式，双指平移、缩放、旋转，可以贴到地面看细节。

还没有的：移轴、延时和四季拼图、把照片存进相册、排行榜、评论区自动带岛屿码、每周主题挑战。

## 目录

| 路径 | 内容 |
|---|---|
| `island/world.lua` | 岛：高度、地表、路、物件，编辑、存档、岛屿码 |
| `island/build.lua` | 把岛变成三角形，以及“放下去自动变好看”的规则 |
| `island/life.lua` | 岛民、船、海鸥、风车，和烟、云、雨雪、萤火虫、彩虹 |
| `island/sky.lua` `progress.lua` `catalog.lua` `demo.lua` | 天色、进度、目录数据、自动搭岛（“帮我做”和测试用） |
| `island/models.lua` | Blender 导出的模型，由 `tools/blender_models.py` 生成，不要手改 |
| `main/game.script` | 镜头、点选、工具、存档，把上面这些接到引擎上 |
| `main/hud.gui_script` | 界面和触摸 |
| `materials/` `render/` | 三套材质（实体、水、半透明）和渲染脚本 |
| `test/run.lua` | 纯逻辑测试 |

## 常用命令

```bash
luajit test/run.lua                 # 逻辑测试，不需要引擎

# 改了界面文字之后：把用到的汉字写进字体配置（字体里没有的字会报错）
python3 tools/update_font.py

# 改了模型之后：用 Blender 重新导出。加上 ISLAND_PREVIEW 会顺带渲一张所有模型的总览图
/Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/blender_models.py
ISLAND_PREVIEW=/tmp/models.png /Applications/Blender.app/Contents/MacOS/Blender -b --factory-startup -P tools/blender_models.py

# 重新合成背景音乐
python3 tools/make_bgm.py

# 构建并导出成小游戏工程（平台取 wechat、douyin、tiktok），放进 output/
node ../../bin/defold-minigame.mjs build --project . --bob <bob.jar> \
  --platform wechat --appid <app id> --output output/wechat

# TikTok 上引擎默认不出声，背景音乐改由宿主播放器播放，所以要把音频文件带进包里
node ../../bin/defold-minigame.mjs build --project . --bob <bob.jar> \
  --platform tiktok --appid <client key> --assets assets/audio --output output/tiktok
```

`output/` 里是导出的小游戏工程，带着各平台的 App ID，不进版本库。

## 自动搭岛的场景

游戏启动时会读宿主存储里的 `island.demo`，这是给自动检查和录屏用的，平时没有这个键：

- `build`：直接从一座搭好的岛开始，不存档。
- `film`：没有界面，岛自己一步步长出来，镜头环绕、推近，天色走到夜晚。这个场景按固定步长运行，每一帧
  游戏时间正好走 1/30 秒，所以每次重放的画面完全一样。官网上的视频就是这样录的：`scripts/devtools_probe.mjs`
  的 `--capture-frames` 把每一帧按原始大小从画布取出（模拟器一次会话只能写约 200 MB，所以分段录，每段 36 帧），
  再用 ffmpeg 合成 30 帧每秒的视频。

## 素材

- 字体：站酷快乐体（ZCOOL KuaiLe），SIL Open Font License 1.1，见 `assets/fonts/OFL.txt`。
- 模型：43 个，全部由 `tools/blender_models.py` 在 Blender 里生成：房子、植物、庄稼、装饰、木桥、岛民、帆船、风车叶片。
- 音乐：由 `tools/make_bgm.py` 合成。
