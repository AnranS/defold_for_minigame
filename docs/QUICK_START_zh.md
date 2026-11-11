# 快速开始

从一个 Defold 工程到开发者工具里能打开的小游戏工程，一共四步。先说明一点：真实引擎目前跑过三处，微信开发者工具和抖音开发者工具的模拟器，以及 TikTok 通过 `ttmg dev` 在 iPhone 和 Android 手机上。微信和抖音的真机还没有验证，在那里第四步可能遇到需要反馈的问题。

## 准备

| 需要 | 说明 |
|---|---|
| Node.js 20 或更高 | 导出工具没有 npm 依赖，装了 Node.js 就能跑 |
| Defold 编辑器 | 用来打 HTML5 包。已核对的版本是 1.14.0 和 1.14.1 |
| 平台开发者工具 | 微信开发者工具、抖音开发者工具，或 TikTok 的 `ttmg` |
| App ID | 在各平台后台创建小游戏后得到；TikTok 用的是 Client Key |

## 1. 在 Defold 里打 HTML5 包

1. 打开工程，选择 **Project > Bundle > HTML5 Application**。
2. **Architectures** 里保留 `wasm-web`。小游戏运行时没有 WebAssembly 线程，用不上线程版（pthread）引擎；如果同时勾了线程版也没关系，导出时会忽略它并给出提示。
3. **Variant** 选 **Release**。
4. 选一个输出目录，点 **Create Bundle**。

打包完成后得到一个以工程名命名的文件夹，里面有 `index.html`、`dmloader.js`、`<工程名>_wasm.js`、`<工程名>.wasm` 和 `archive/`。下一步要用的就是这个文件夹。

> [!TIP]
> 想先确认这个包能不能导出，可以运行 `node bin/defold-minigame.mjs inspect --bundle <文件夹>`。它只读取，不写任何文件，会报告引擎版本、包体和用到的 WebAssembly 特性。

## 2. 导出小游戏工程

```bash
git clone https://github.com/AnranS/defold_for_minigame.git
cd defold_for_minigame

node bin/defold-minigame.mjs export \
  --bundle   ~/bundles/MyGame \
  --platform wechat \
  --appid    wx0123456789abcdef \
  --output   ~/minigame/mygame-wechat
```

- `--platform` 取 `wechat`、`douyin` 或 `tiktok`。一次导出只针对一个平台，三个平台要导三次，各用各的输出目录。
- `--output` 必须是空目录，或者是本工具之前导出过的目录。它不能放在 HTML5 包里面。
- 音频、图片这类游戏按路径读取的文件，可以加 `--subpackage 名字=目录` 做成分包，不占主包的 4 MB，见[使用指南](USAGE_zh.md#12-包体与分包)。
- 屏幕方向默认按工程的 `display.width` 和 `display.height` 判断，要指定就加 `--orientation portrait` 或 `landscape`。

导出成功后会打印各部分的大小：

```text
Exported MyGame (Defold 1.14.1) for WeChat Mini Game
  output          /Users/you/minigame/mygame-wechat
  orientation     portrait
  main package    422.2 KB of 4.00 MB
  engine package  3.25 MB (engine 922.5 KB from 2.89 MB, archive 2.35 MB)
  total           3.66 MB of 30.00 MB
  html5.run       bridged to the minigame Lua module
```

## 3. 接入 Lua SDK（可选）

只想让游戏跑起来可以跳过这一步。要调用登录、分享、广告这些平台能力，需要 `minigame` 模块。

1. 在 `game.project` 的 **Dependencies** 里加入本仓库的压缩包地址，然后 **Project > Fetch Libraries**：

   ```text
   https://github.com/AnranS/defold_for_minigame/archive/refs/heads/main.zip
   ```

2. 把 `/minigame/minigame.go` 加进启动 collection。它每帧替你派发异步结果和宿主事件。回调里要用 `gui.*` 的 GUI 脚本，还要在自己的 `update()` 里调用 `minigame.update()`。
3. 在脚本里使用：

   ```lua
   local minigame = require "minigame.minigame"

   function init(self)
       if minigame.is_available() then
           print("running on", minigame.platform())
       end
       minigame.login(function(code, err)
           if err then
               print("login failed:", err)
           else
               print("send this code to your server:", code)
           end
       end)
   end
   ```

   这段代码在编辑器里直接运行也不会报错：`is_available()` 返回 false，`login` 的回调立刻收到 `"not running in a mini game"`。

改完脚本后要重新打 HTML5 包、重新导出。重新导出到同一个目录是安全的，工具只替换自己写的文件。

## 4. 在开发者工具里运行

### 微信小游戏

1. 打开微信开发者工具，选择 **小游戏 > 导入项目**。
2. 目录选导出的输出目录，App ID 填和导出时一样的那个。
3. 编译后在模拟器里应当先看到“加载中”，然后是游戏画面。
4. 真机要点 **预览** 扫码。iOS 上需要在微信公众平台开通“高性能模式”，导出的 `game.json` 已经打开了对应的开关。

### 抖音小游戏

用抖音开发者工具导入输出目录，项目类型选小游戏，App ID 与导出时一致。工具打开工程时会重写 `project.config.json`，这不影响之后向同一个目录再次导出。

### TikTok Mini Game

```bash
cd ~/minigame/mygame-tiktok
ttmg init     # 用导出时填的同一个 Client Key
ttmg dev
```

第一次使用 `ttmg` 需要先 `ttmg setup` 和 `ttmg login`。`ttmg dev` 会编译输出目录并打开一个二维码页面，用手机上的 TikTok 扫码后游戏就在手机上运行；它启动时会让你选 Client Key，也可以用 `ttmg dev --client-key <Client Key>` 直接指定。TikTok 需要 43.4.0 或更高版本的客户端。

> [!IMPORTANT]
> TikTok 上引擎自带的声音默认是关的，`sound` 组件不会出声。要播放声音，请用 `minigame.inner_audio()`，并用 `--assets` 把音频文件带进包里。原因见[使用指南](USAGE_zh.md#8-音频)。

## 遇到问题

启动失败时，加载器会弹一个带错误信息的对话框，控制台里以 `[DefoldMiniGame]` 开头的日志会说明卡在哪一步：

| 日志停在 | 可能的原因 |
|---|---|
| `1/5 loading subpackage 'engine'` | 分包没下载成功，检查开发者工具的网络和 `game.json` 的分包声明 |
| `instantiating engine/dmengine.wasm.br` | 宿主不支持引擎用到的 WebAssembly 特性，或基础库版本太低 |
| `the engine glue is loaded; waiting for the runtime` | 引擎初始化没走完，看这一行后面的报错 |
| 没有任何 `[DefoldMiniGame]` 日志 | `game.js` 没执行，检查 App ID 和工程类型是不是“小游戏” |
| `archive file … is N bytes in the package, but the export recorded M` | 开发者工具在用新旧混杂的文件运行，重新编译一次或清掉它的编译缓存 |

把控制台日志和导出时打印的那几行信息一起反馈，最容易定位。

## 下一步

- [使用指南](USAGE_zh.md)：全部导出选项、三个平台的差异、存档、音频、键盘、包体。
- [Lua SDK 参考](API_zh.md)：45 个函数的说明。
- [架构](ARCHITECTURE.md)：导出和运行时是怎么工作的。
