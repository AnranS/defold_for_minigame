# 交给 AI 编程助手

仓库里带了一个 skill，在 [`skills/defold-minigame/`](../skills/defold-minigame/SKILL.md)。它是写给 AI 编程助手的操作手册：去哪里找导出器，导出前看工程的哪些设置，三个平台差在哪，Lua SDK 怎么接，启动日志停在某一行意味着什么。装上以后，直接对助手说“把这个 Defold 工程导出成微信小游戏”就行。

它用的是 Agent Skills 格式：一个目录，里面一份 `SKILL.md` 和几份参考文档。Claude Code、DeepSeek Harness（`dsh`）、Codex 这些读这种格式的工具都能用。

## 安装

skill 在 `main` 分支上，是 v0.1.0 发布之后加的，v0.1.0 的压缩包里没有。

### Claude Code

```text
/plugin install defold-minigame --marketplace AnranS/defold_for_minigame
```

Claude Code 2.1.275 之前的版本分两步：

```text
/plugin marketplace add AnranS/defold_for_minigame
/plugin install defold-minigame@defold-for-minigame
```

在终端里，把开头的 `/plugin` 换成 `claude plugin`。插件就是这个仓库本身，导出器随它一起装好，不用另外 clone。

### dsh、Codex 和其他工具

把 `skills/defold-minigame` 这个目录放进工具的 skill 目录，复制或软链接都可以：

| 工具 | 只在当前工程 | 所有工程 |
|---|---|---|
| DeepSeek Harness（`dsh`） | `<工程>/.dsh/skills/` 或 `<工程>/.agents/skills/` | `~/.dsh/skills/` 或 `~/.agents/skills/` |
| Codex | `<工程>/.agents/skills/` | `~/.agents/skills/` |
| Claude Code，不用插件时 | `<工程>/.claude/skills/` | `~/.claude/skills/` |

`~/.agents/skills/` 这一处，dsh 和 Codex 都读：

```bash
git clone --branch main --depth 1 https://github.com/AnranS/defold_for_minigame.git
mkdir -p ~/.agents/skills
ln -s "$PWD/defold_for_minigame/skills/defold-minigame" ~/.agents/skills/defold-minigame
```

- 软链接到 clone 下来的仓库，导出器就在 skill 旁边，助手不用再去下载；仓库 `git pull` 之后 skill 也跟着更新。
- 只复制 skill 目录也能用。助手找不到导出器时，会用 `npx` 直接运行已发布的版本，或者问你仓库在哪。
- dsh 只认一层目录：`defold-minigame` 要直接放在 skill 目录下面，不能再套一层。

### 通用安装器

读 Agent Skills 的工具很多，`skills` 这个命令行工具可以替你把 skill 装到它们各自的目录里：

```bash
npx skills add AnranS/defold_for_minigame
```

它会问装给哪些工具、装到当前工程还是用户目录。

### 哪些是实际验证过的

| 途径 | 情况 |
|---|---|
| Claude Code 插件 | 用 Claude Code 2.1.322 按上面那一行从 GitHub 装过：安装成功，识别出这一个 skill，随插件装下来的导出器可以运行 |
| dsh | 用 dsh 0.1.1-rc.2 自带的 skill 加载代码跑过：在 `<工程>/.agents/skills/`（软链接）和用户目录的 `skills/`（复制）里都能发现并读出，没有警告。没有跑过完整的会话 |
| Codex | 目录按它的文档写，没有实测 |
| `npx skills add` | 目录结构符合它文档里的发现规则，没有实测 |

## 怎么用

装好后新开一个会话，直接说要做什么：

- “把这个 Defold 工程导出成微信小游戏，App ID 是……”
- “抖音开发者工具里启动日志停在 1/5，帮我看看。”
- “给游戏加上登录和激励视频。”
- “TikTok 上没有声音，改成用宿主的播放器。”

助手会按任务自己用上这个 skill。想点名调用，在 Claude Code 里输入 `/defold-minigame`，在 Codex 里输入 `$defold-minigame`。

有几件事需要你来做，skill 里也是这样要求助手的：

- **App ID 由你提供。** 助手会问你要，不会自己编一个；TikTok 用的是 Client Key。
- **HTML5 包由你打，或者告诉它 bob.jar 在哪。** 在 Defold 编辑器里选 **Project > Bundle > HTML5 Application**，或者让助手用 `build` 命令调用 bob.jar。bob.jar、JDK 和开发者工具，助手不会不问就下载。
- **能不能跑，要在开发者工具或真机里看。** 导出成功不等于能运行。把控制台里 `[DefoldMiniGame]` 开头的日志贴给助手，它知道每一行意味着什么。
- **导出目录里的文件不手改。** 助手改的是游戏和导出参数，然后重新导出。

## 不安装也可以

让助手先读这份文件，再开始干活：

```text
https://github.com/AnranS/defold_for_minigame/blob/main/skills/defold-minigame/SKILL.md
```

## skill 里有什么

| 文件 | 内容 |
|---|---|
| `SKILL.md` | 六条规则，从找导出器到在开发者工具里运行的六个步骤，常见故障，三个平台的差别 |
| `references/quick-start.md` | [快速开始](QUICK_START_zh.md)的英文版 |
| `references/usage.md` | [使用指南](USAGE_zh.md)的英文版 |
| `references/api.md` | [Lua SDK 参考](API_zh.md)的英文版 |

`references/` 下的三份是从 `docs/` 里的文档生成的，不要手改。改了文档之后运行：

```bash
node scripts/generate_skill_references.mjs
```

测试会检查它们是不是最新的，也会检查 `SKILL.md` 里提到的命令行参数和 SDK 函数确实存在，版本号和平台限制与 `support-matrix.json` 一致。

## 更新和卸载

- Claude Code：`claude plugin update defold-minigame@defold-for-minigame`，卸载用 `claude plugin uninstall defold-minigame@defold-for-minigame`。
- 软链接安装的：在 clone 下来的仓库里 `git pull`；卸载就是删掉那个链接。
- 复制安装的：重新复制一遍；卸载就是删掉那个目录。
