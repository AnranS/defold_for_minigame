<h1 align="center">Defold Mini Game</h1>

<p align="center">
  <strong>把 Defold 打出的 HTML5 包，一条命令转成微信、抖音与 TikTok 小游戏工程。</strong>
</p>

<p align="center">
  <a href="docs/QUICK_START_zh.md">快速开始</a> ·
  <a href="docs/USAGE_zh.md">使用指南</a> ·
  <a href="docs/API_zh.md">Lua SDK</a> ·
  <a href="docs/ARCHITECTURE.md">架构</a> ·
  <a href="docs/RESEARCH_zh.md">调研与设计依据</a> ·
  <a href="README.md">English</a>
</p>

<p align="center">
  <img src="docs/images/banner-zh.svg" width="860" alt="Defold 打出的 HTML5 包经过 defold-minigame export 一条命令，变成微信、抖音或 TikTok 的小游戏工程" />
</p>

> [!WARNING]
> **当前是 v0.1.0 实验版，还没有在任何开发者工具或真机上运行过。**
> 已经验证的是：200 多项自动化测试（包括在模拟的微信、抖音、TikTok 宿主里启动导出的包），以及对 Defold 1.14.0 和 1.14.1 官方引擎的静态核对。
> 没有验证的是：真实引擎在小游戏运行时里的实际表现。上线前必须自己过开发者工具和真机这两关。详见[验证状态](#验证状态)。

<table>
  <tr>
    <td align="center" width="25%"><h3>不用自编引擎</h3><sub>直接用 Defold 官方 HTML5 引擎，不需要 Emscripten，也不需要定制引擎模板</sub></td>
    <td align="center" width="25%"><h3>3 个平台</h3><sub>微信、抖音、TikTok Native，同一个 HTML5 包导出</sub></td>
    <td align="center" width="25%"><h3>44 个 SDK 函数</h3><sub>Lua 模块 <code>minigame</code>，另可透传宿主的任意接口</sub></td>
    <td align="center" width="25%"><h3>0 个依赖</h3><sub>导出工具只需要 Node.js 20+，没有 npm 依赖</sub></td>
  </tr>
</table>

## 它做了什么

Defold 的 HTML5 包是给浏览器用的：`dmloader.js` 操作 DOM、用 XHR 下载资源，引擎胶水假设有 `window`、`document`、IndexedDB 和 `eval`。小游戏运行时这些都没有。Defold Mini Game 做三件事把它们接上：

- **导出**：读取 HTML5 包，校验引擎二进制用到的 WebAssembly 特性，把 `dmloader.js` 和引擎胶水原样放进一个作用域模块，生成 `game.js`、`game.json`、引擎分包和各平台的工程配置。
- **运行时适配**：在 `wx`、`tt` 或 `TTMinis.game` 之上提供引擎需要的画布、触摸、键盘、网络、音频和存档。
- **Lua SDK**：`minigame` 模块调用登录、存储、分享、广告、支付等平台能力，在编辑器和桌面端调用也不会报错。

<p align="center">
  <img src="docs/images/architecture-zh.svg" width="860" alt="导出时：读取 HTML5 包、校验、把 dmloader.js 和引擎胶水合成进一个作用域模块、生成主包和 engine 分包。运行时自上而下四层：你的游戏、原样运行的 Defold 引擎、本项目的适配层、宿主 wx、tt 或 TTMinis.game" />
</p>

## 快速开始

需要 Node.js 20 或更高版本，以及一个 Defold HTML5 包。

1. **在 Defold 里打包**：`Project > Bundle > HTML5 Application`，架构只勾 `wasm-web`，Variant 选 Release。
2. **导出**：

   ```bash
   git clone https://github.com/AnranS/defold_for_minigame.git
   node defold_for_minigame/bin/defold-minigame.mjs export \
     --bundle  path/to/bundle/MyGame \
     --platform wechat \
     --appid   wx0123456789abcdef \
     --output  ../minigame-wechat
   ```

3. **运行**：用微信或抖音开发者工具打开输出目录。TikTok 在输出目录里执行 `ttmg init` 和 `ttmg dev`。

要调用平台能力，把本仓库加为 Defold 库依赖，再把 `/minigame/minigame.go` 放进启动 collection：

```lua
local minigame = require "minigame.minigame"

minigame.login(function(code, err)
    if not err then print("login code", code) end
end)

minigame.storage_set("level", "5")
minigame.show_toast("Level " .. minigame.storage_get("level", "1"))
```

**[带说明的分步教程 →](docs/QUICK_START_zh.md)**

## 平台

| 平台 | 运行时 API | `game.json` 分包字段 | 总包上限 | 状态 |
|---|---|---|---|---|
| 微信小游戏 | `wx` | `subpackages` | 30 MB | 🧪 实验：仅模拟宿主测试 |
| 抖音小游戏 | `tt` | `subPackages` | 20 MB | 🧪 实验：仅模拟宿主测试 |
| TikTok Mini Game Native | `TTMinis.game` | `subpackages` | 30 MB | 🧪 实验：仅模拟宿主测试，需要 TikTok 43.4.0+ |

主包上限都是 4 MB。用 Defold 1.14.1 官方引擎导出的空项目，主包约 0.42 MB，引擎分包约 0.92 MB（引擎二进制从 2.89 MB 压到 0.92 MB），其余是你的游戏资源。

<p align="center">
  <img src="docs/images/package-zh.svg" width="860" alt="主包只有入口、配置、适配层和引擎模块，约 0.42 MB；engine 分包里是 Brotli 压缩后的官方引擎和游戏归档" />
</p>

## 支持的 Defold 版本

| Defold | 引擎 SHA1 | 加载器 | 静态核对 | 真实引擎运行 | 开发者工具 | 真机 |
|---|---|---|---|---|---|---|
| **`1.14.1`**（最新） | `ee283d4dad9f` | 会话式 | ✅ | ⬜ | ⬜ | ⬜ |
| `1.14.0` | `d295ed4edff2` | 旧式 | ✅ | ⬜ | ⬜ | ⬜ |

Defold 在 1.14.1 重写了 HTML5 加载器的启动流程，所以运行时里有两条启动路径，测试对两条都覆盖。

导出不绑定版本号：每次导出都会检查 `dmloader.js` 和引擎胶水的结构是否符合预期，不符合就停下并说明缺了什么。不在表里的版本可以导出，但会给出警告。[`support-matrix.json`](support-matrix.json) 是这些数值的唯一事实源。

## 验证状态

| 层级 | 内容 | 状态 |
|---|---|---|
| 单元测试 | wasm 特性扫描、包校验、引擎模块合成、导出事务、命令行 | ✅ 自动化 |
| 模拟宿主 | 真实的 Defold 1.14.0 和 1.14.1 `dmloader.js` 加引擎替身，在模拟的 `wx`、`tt`、`TTMinis.game` 里启动、触摸、键盘、存档、音频、网络 | ✅ 自动化 |
| Lua 联调 | LuaJIT 运行 `minigame.lua`，对接真实的 JS 桥 | ✅ 自动化 |
| 静态核对 | Defold 1.14.0 和 1.14.1 官方引擎胶水和二进制：结构、WebAssembly 特性、严格模式编译 | ✅ 已做 |
| 真实引擎运行 | 用 Defold 构建的真实游戏包启动 | ⬜ 未做 |
| 开发者工具 | 微信、抖音开发者工具，`ttmg dev` | ⬜ 未做 |
| 真机 | iOS、Android | ⬜ 未做 |

引擎替身是测试里代替 Emscripten 胶水的一段 JavaScript，它按真实胶水的约定工作，但不是真实引擎。所以模拟宿主测试能证明适配层自身的逻辑是自洽的，不能证明真实引擎能跑。

## 已知限制

- **TikTok 默认没有引擎声音**：Defold 的混音器每个音频块新建一个 AudioBuffer 和 BufferSource，这种用法在 godot_for_minigame 的真机测试里让 TikTok 客户端崩溃过，所以默认关闭。请用 `minigame.inner_audio()` 播放，或自担风险用 `--engine-audio on` 打开。
- **资源只能放在包里**：游戏归档随引擎分包下发，不支持从 CDN 加载，受平台总包上限约束。
- **`html5.run()` 不能执行 JavaScript**：小游戏禁用 `eval`，这个函数只用来和 `minigame` 模块通信。
- **老 iOS 需要 WebGL1 着色器**：引擎在 iOS 15.2 以下会自己退回 WebGL1；Defold 1.14.1 起默认不打包 WebGL1 着色器，需要在 `game.project` 里设置 `shader.exclude_gles_sm100 = 0`。
- **带 JS 库的原生扩展没有验证**：扩展的 JS 代码会和引擎胶水一起放进作用域模块，但没有测试过。
- **没有编辑器集成**：导出是命令行工具，Defold 编辑器里没有菜单项。
- **示例工程没有构建过**：仓库根目录的 Defold 示例工程是手写的，这台机器没有 Defold 构建工具，没有验证它能通过构建。

完整的兼容性说明见[使用指南](docs/USAGE_zh.md)。

## 文档导航

| 我想要…… | 文档 |
|---|---|
| 导出第一个游戏 | [快速开始](docs/QUICK_START_zh.md) |
| 了解每个选项和平台差异 | [使用指南](docs/USAGE_zh.md) |
| 查找 SDK 函数 | [Lua SDK 参考](docs/API_zh.md) |
| 理解导出和运行时的设计 | [架构](docs/ARCHITECTURE.md) |
| 了解为什么这样设计 | [调研与设计依据](docs/RESEARCH_zh.md) |
| 发布新版本、认证新的 Defold 版本 | [发布流程](docs/RELEASING.md) |

`website/` 目录把这些文档生成为静态站点：`node website/build.mjs` 输出到 `website/dist`，`node website/serve.mjs` 在本机预览，并打印访问地址（从 4780 端口开始，被别的程序占用时自动换下一个）。它同样没有任何依赖。仓库开启 GitHub Pages 之后，`deploy-pages` 工作流会从 `main` 分支自动发布。

## 参与贡献

提交前运行 `./scripts/test.sh`（需要 Node.js 20+；装了 LuaJIT 会多跑 Lua 联调测试）。它会跑测试、检查 API 参考和 `docs/images/` 里的图是否与来源一致，并构建和检查官网。图由 `scripts/generate_diagrams.mjs` 生成，要改图请改这个脚本，不要直接改 SVG。平台差异应当留在 `PlatformRuntime` 和 Lua 桥之后，不要在业务代码里直接判断 `wx` 或 `tt`。

## 许可证

[MIT](LICENSE)。导出产物里的 Defold 引擎文件保留 Defold License，见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。运行时的平台检测和导出事务设计改编自 [godot_for_minigame](https://github.com/AnranS/godot_for_minigame)。
