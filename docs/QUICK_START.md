# Quick start

Four steps take a Defold project to a mini-game project a developer tool can open. One thing first: the real engine has run in the WeChat DevTools simulator, and nowhere else yet. The Douyin and TikTok tools and every real device are unverified, so step 4 may well turn up something worth reporting.

## What you need

| Requirement | Notes |
|---|---|
| Node.js 20 or later | The exporter has no npm dependencies |
| The Defold editor | To build the HTML5 bundle. Checked versions: 1.14.0 and 1.14.1 |
| A platform developer tool | WeChat DevTools, Douyin DevTools, or TikTok's `ttmg` |
| An App ID | From the platform console; for TikTok it is the Client Key |

## 1. Bundle for HTML5 in Defold

1. Open the project and choose **Project > Bundle > HTML5 Application**.
2. Keep `wasm-web` under **Architectures**. Mini-game runtimes have no WebAssembly threads, so the threaded (pthread) engine is of no use; if it is selected as well, the exporter ignores it and says so.
3. Set **Variant** to **Release**.
4. Pick an output folder and click **Create Bundle**.

You get a folder named after the project with `index.html`, `dmloader.js`, `<name>_wasm.js`, `<name>.wasm`, and `archive/`. That folder is the input of the next step.

> [!TIP]
> To check a bundle before exporting it, run `node bin/defold-minigame.mjs inspect --bundle <folder>`. It only reads, and reports the engine version, the sizes, and the WebAssembly features in use.

## 2. Export the mini-game project

```bash
git clone https://github.com/AnranS/defold_for_minigame.git
cd defold_for_minigame

node bin/defold-minigame.mjs export \
  --bundle   ~/bundles/MyGame \
  --platform wechat \
  --appid    wx0123456789abcdef \
  --output   ~/minigame/mygame-wechat
```

- `--platform` is `wechat`, `douyin`, or `tiktok`. One export targets one platform; export three times into three folders for all of them.
- `--output` must be empty, or a folder this tool exported into before. It cannot be inside the HTML5 bundle.
- The orientation follows the project's `display.width` and `display.height`; pass `--orientation portrait` or `landscape` to set it.

A successful export prints the size of each part:

```text
Exported MyGame (Defold 1.14.1) for WeChat Mini Game
  output          /Users/you/minigame/mygame-wechat
  orientation     portrait
  main package    422.2 KB of 4.00 MB
  engine package  3.25 MB (engine 922.5 KB from 2.89 MB, archive 2.35 MB)
  total           3.66 MB of 30.00 MB
  html5.run       bridged to the minigame Lua module
```

## 3. Add the Lua SDK (optional)

Skip this if you only want the game to run. Login, sharing, ads, and the other platform features need the `minigame` module.

1. Add this repository's archive URL to **Dependencies** in `game.project`, then choose **Project > Fetch Libraries**:

   ```text
   https://github.com/AnranS/defold_for_minigame/archive/refs/heads/main.zip
   ```

2. Add `/minigame/minigame.go` to your bootstrap collection. It delivers asynchronous results and host events every frame. A GUI script that uses `gui.*` in its callbacks also calls `minigame.update()` in its own `update()`.
3. Use it in a script:

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

   The same code runs in the editor without errors: `is_available()` returns false and the `login` callback receives `"not running in a mini game"` right away.

After changing scripts, bundle and export again. Exporting into the same folder is safe: the tool only replaces the files it wrote.

## 4. Run it in a developer tool

### WeChat

1. Open WeChat DevTools and choose **Mini Game > Import**.
2. Select the output folder and enter the App ID you exported with.
3. After compiling, the simulator should show the loading indicator and then the game.
4. For a phone, click **Preview** and scan the code. On iOS, enable the high-performance mode in the WeChat console; the exported `game.json` already sets the flag.

### Douyin

Import the output folder in Douyin DevTools with the App ID you exported with.

### TikTok

```bash
cd ~/minigame/mygame-tiktok
ttmg init     # with the Client Key you exported with
ttmg dev
```

Run `ttmg setup` and `ttmg login` once before the first use. TikTok needs client version 43.4.0 or later.

> [!IMPORTANT]
> On TikTok the engine's own sound is off by default, so `sound` components are silent. Play audio with `minigame.inner_audio()` and ship the files with `--assets`. The [usage guide](USAGE.md#8-audio) explains why.

## When something goes wrong

A failed start shows a dialog with the error, and the console lines that begin with `[DefoldMiniGame]` tell you where it stopped:

| The log stops at | Likely cause |
|---|---|
| `1/5 loading subpackage 'engine'` | The subpackage did not download; check the network panel and the subpackage declaration in `game.json` |
| `instantiating engine/dmengine.wasm.br` | The host does not support a WebAssembly feature the engine uses, or its base library is too old |
| `the engine glue is loaded; waiting for the runtime` | Engine initialisation did not finish; read the error after this line |
| No `[DefoldMiniGame]` line at all | `game.js` did not run; check the App ID and that the project type is "mini game" |
| `archive file … is N bytes in the package, but the export recorded M` | The developer tool is running old files next to new ones; compile again or clear its compile cache |

A report is easiest to act on when it includes the console log and the lines the export printed.

## Next

- [Usage guide](USAGE.md): every option, the platform differences, saves, audio, keyboard, package size.
- [Lua SDK reference](API.md): the 45 functions.
- [Architecture](ARCHITECTURE.md): how the exporter and the runtime work.
