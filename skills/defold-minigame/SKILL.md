---
name: defold-minigame
description: Export a Defold game as a WeChat, Douyin, or TikTok mini game with the defold-minigame exporter, and use its minigame Lua SDK for login, storage, sharing, ads, payment, host audio, and subpackages. Use when the user wants a Defold project to run as a mini game (微信小游戏, 抖音小游戏, TikTok Mini Game), mentions defold-minigame or defold_for_minigame, hits an export error or a start-up failure in WeChat DevTools, Douyin DevTools, or ttmg, or writes Lua that calls minigame functions.
license: MIT
metadata:
  version: "0.1.0"
---

# Defold Mini Game

The `defold-minigame` exporter turns the HTML5 bundle Defold builds into a project folder that WeChat DevTools, Douyin DevTools, or TikTok's `ttmg` opens. It uses the stock Defold engine, so nothing is compiled. The game reaches the host's features, such as login, ads, and sharing, through a Lua module named `minigame`.

This skill describes version 0.1.0, which is experimental. The repository's test app has run on phones on all three platforms; the user's game has not.

## Rules

1. **Do not invent an App ID.** `--appid` takes the App ID from the platform's console, or the Client Key on TikTok. Ask the user for it. `wx0123456789abcdef` in the documents is a placeholder. Pass the real value on the command line; do not write it into the game's source files.
2. **One export targets one platform.** Three platforms are three exports into three folders.
3. **Do not edit what the exporter wrote.** In the output folder, `game.js`, `game.json`, `adapter.js`, `js/`, `engine/`, `assets/`, and the subpackage folders belong to the exporter, and the next export stops when one of them was changed by hand. Change the game or the options and export again. `--force` throws such changes away, so use it only when the user agrees.
4. **An export that succeeds has not run.** Only a developer tool or a phone shows whether the game starts. Report what was run and where, and say plainly when nothing was.
5. **Do not make a refusal go away with a flag.** `--allow-wasm-feature` and `--allow-missing-bridge` export something the host will most likely not load. Read the reason the export printed and fix that.
6. **Ask before you download or change tools.** bob.jar, a JDK, and the developer tools are the user's to install. Do not switch on a developer tool's service port or any other security setting yourself.

## 1. Find the exporter

The exporter is `bin/defold-minigame.mjs` in the tool's repository. It needs Node.js 20 or later and has no npm dependencies. Use the first of these that applies, and read `<exporter>` below as that command:

1. **It came with this skill.** The skill is part of a checkout, or of the Claude Code plugin, when the repository's `bin/defold-minigame.mjs` is two folders above the folder this file is in. That folder can be a symbolic link, and `node` does not follow a link in a path that contains `..`, so resolve it first and run `node` with the absolute path:

   ```bash
   root=$(cd -P "<folder of this file>/../.." && pwd) && ls "$root/bin/defold-minigame.mjs"
   ```
2. **The user has a checkout.** Ask where, or look for a `defold_for_minigame` folder beside the game project: `node <checkout>/bin/defold-minigame.mjs`.
3. **Neither.** Run the released version from GitHub; npm downloads it once and keeps it:

   ```bash
   npx --yes github:AnranS/defold_for_minigame#v0.1.0 --version
   ```

   To have the files on disk instead, clone the release:

   ```bash
   git clone --branch v0.1.0 --depth 1 https://github.com/AnranS/defold_for_minigame.git
   ```

`<exporter> --version` prints the version and `<exporter> --help` every option. The exporter and the Lua module in the game must be the same version, because the two speak one bridge protocol.

## 2. Check the project

Read `game.project` before the first export:

| Setting | What to look for |
|---|---|
| `[display]` `width`, `height` | Decide portrait or landscape; `--orientation` overrides |
| `[display]` `high_dpi` | `1` for a sharp picture on phones; without it the canvas is created at 1× |
| `[html5]` `heap_size` | The default is 256 MB, a lot for a low-end phone. Set what the game needs; `--heap-size` overrides at export |
| `[shader]` `exclude_gles_sm100` | `0` when the game has to run on iOS below 15.2, where the engine falls back to WebGL 1 |

Things a mini game does not have: JavaScript through `html5.run()`, WebAssembly threads, SIMD, and exceptions (a custom engine may use them; the stock one does not), physical keyboards, gamepads, and editor hot reload.

## 3. Get an HTML5 bundle

The exporter's input is the folder Defold writes for HTML5: `index.html`, `dmloader.js`, `<name>_wasm.js`, `<name>.wasm`, and `archive/`.

- **From the editor**, which the user does: **Project > Bundle > HTML5 Application**, architecture `wasm-web` only, variant Release.
- **From the command line**, with the `build` command in the next section. It runs bob.jar, so it needs a bob.jar of the project's Defold version and the JDK that version asks for, OpenJDK 25 for Defold 1.14. Defold publishes bob.jar with each release at `https://github.com/defold/defold/releases`.

`<exporter> inspect --bundle <dir>` reads a bundle and reports the engine version, the sizes, the WebAssembly features in use, and whether it can be exported. It writes nothing.

## 4. Export

```bash
<exporter> export --bundle <bundle dir> --platform wechat --appid <App ID> --output <output dir>
<exporter> build  --project <game dir> --bob <bob.jar> --platform wechat --appid <App ID> --output <output dir>
```

- `--platform` is `wechat`, `douyin`, or `tiktok`.
- `--output` is an empty folder, or one this tool exported into before. It cannot be inside the bundle, and the bundle cannot be inside it. Keep it outside the game project, or exclude it from the project with `.defignore`.
- Exit code `0` is success, `1` means the export was refused and printed the reason with a hint, `2` is a usage error. `--json` prints the result as JSON, for `export` and for `inspect`.
- The export checks the sizes and refuses when one is over: the main package is 4 MB on every platform, the total 30 MB on WeChat and TikTok and 20 MB on Douyin. The engine and the game archive go into a subpackage named `engine`, so the main package starts at about 0.42 MB.
- Loose files the game reaches by path, such as audio for the host's player, ship with `--assets <dir>` (inside the main package, under `assets/`) or with `--subpackage <name>=<dir>` (outside the 4 MB, loaded by the game when it needs them).
- Exporting into the same folder again is safe. `project.config.json` and `project.private.config.json` are the developer tool's after the first export, and a later export keeps what they hold.

Other options, such as `--name`, `--orientation`, `--heap-size`, `--pixel-ratio`, `--engine-audio`, `--persistence`, and `--total-limit-mb`, are in [references/usage.md](references/usage.md), section 3.

## 5. Use the Lua SDK

Needed only when the game calls the host: login, sharing, ads, payment, storage, the host's audio player, subpackages. A game that only has to run can skip it.

1. Add the library to the `[project]` section of `game.project`, the same version as the exporter. The number after `#` counts the project's dependencies from 0:

   ```text
   dependencies#0 = https://github.com/AnranS/defold_for_minigame/archive/refs/tags/v0.1.0.zip
   ```

   The user then runs **Project > Fetch Libraries** in the editor; the `build` command fetches it as part of the build.

2. Put the module's game object into the bootstrap collection. It delivers results and host events every frame:

   ```text
   instances {
     id: "minigame"
     prototype: "/minigame/minigame.go"
   }
   ```

3. Call it:

   ```lua
   local minigame = require "minigame.minigame"

   minigame.login(function(code, err)
       if err then
           minigame.log("login failed: " .. err, "error")
           return
       end
       -- send the code to the game's own server
   end)
   ```

What trips people up:

- **Callbacks.** The first argument is the result, `nil` on failure; the last is an error string, `nil` on success.
- **GUI scripts.** A callback runs in the script that calls `minigame.update()`. A GUI script whose callbacks touch its nodes calls `minigame.update()` in its own `update()`; without that the callback fails with "Node used in the wrong scene".
- **Logging.** A release build of the engine drops `print()`. Use `minigame.log(message, level)`.
- **Outside a mini game**, in the editor or a plain HTML5 build, `minigame.is_available()` is false, getters return defaults, and callbacks receive `"not running in a mini game"` at once. Calls need no platform check around them.
- **APIs without a wrapper** go through `minigame.call`, `minigame.call_sync`, `minigame.on`, and `minigame.create`; `minigame.has("apiName")` tells whether the host has one.
- **Payment and ads** take the host's own fields, which differ on every platform. Follow that platform's documentation for the options.

Every function is in [references/api.md](references/api.md).

## 6. Run it

- **WeChat**: in WeChat DevTools choose **Mini Game > Import**, select the output folder, and enter the App ID of the export. The tourist mode cannot load subpackages, and the engine is in one, so a real App ID is needed.
- **Douyin**: import the output folder in Douyin DevTools as a mini game, with the App ID of the export.
- **TikTok**: the user runs `ttmg setup` and `ttmg login` once on their machine. Then, in the output folder, `ttmg init` with the Client Key and `ttmg dev`, which compiles the folder and shows a QR code to scan with TikTok on a phone, client version 43.4.0 or later. `ttmg dev --client-key <Client Key>` answers its question up front.

A start that works prints these lines to the console, ending with the fifth:

```text
[DefoldMiniGame][loader] 1/5 loading subpackage 'engine'
[DefoldMiniGame][loader] 5/5 the engine is running
```

A checkout also has `scripts/devtools_probe.mjs`, which collects the console log and pictures of a run in WeChat DevTools or Douyin DevTools without someone watching; its usage is at the top of the file. Take the probe out again before anything is uploaded.

## When something fails

| What you see | What it means |
|---|---|
| The export says the engine uses SIMD, threads, or exceptions | A custom engine or the threaded architecture. Bundle the regular `wasm-web` engine |
| The export says `dmloader.js does not match the layout` | This Defold version changed its loader. Checked versions are 1.14.0 and 1.14.1; report it with the version |
| The export stops and lists files that were edited or are unknown | Someone changed the exporter's files in the output folder. See rule 3 |
| The log stops at `1/5 loading subpackage 'engine'` | The subpackage did not load: tourist mode on WeChat, or the folder was not imported whole as a mini game |
| There is no `[DefoldMiniGame]` line at all | `game.js` did not run: wrong App ID, or the project type is not "mini game" |
| `archive file … is N bytes in the package, but the export recorded M` | The developer tool is running old files beside new ones. Compile again or clear its compile cache |
| The game starts and the screen stays black | Look for shader errors. On old iOS the WebGL 1 shaders were left out; see `exclude_gles_sm100` above |
| No sound on TikTok | Expected; see the next section |
| About one frame a second in a developer tool | Its window is in the background or covered |

More cases are in the FAQ at the end of [references/usage.md](references/usage.md) and in "When something goes wrong" in [references/quick-start.md](references/quick-start.md).

## The three platforms

| | WeChat | Douyin | TikTok |
|---|---|---|---|
| `--platform` | `wechat` | `douyin` | `tiktok` |
| `--appid` | App ID | App ID | Client Key |
| Developer tool | WeChat DevTools | Douyin DevTools | `ttmg` |
| Main package, total | 4 MB, 30 MB | 4 MB, 20 MB | 4 MB, 30 MB |
| `sys.save` writes to | files | files | key-value storage |
| Engine sound | on | on | off by default |

On Douyin the total is 30 MB for a game with virtual payment enabled: pass `--total-limit-mb 30`.

TikTok is not Douyin under another name, and three things differ there:

- **Sound.** `sound` components are silent, because the engine's way of playing audio crashed the client. Check `minigame.has_engine_audio()` and play through the host with `minigame.inner_audio("assets/audio/bgm.mp3", { loop = true })`; ship the files with `--assets` or `--subpackage`.
- **Files.** A game cannot touch the file system. Saves go to key-value storage, so keep them small, and the files of a subpackage are used through host APIs such as `minigame.inner_audio()`.
- **Sharing.** There is no way to set the share menu's content ahead of time: `minigame.set_share_content()` returns `false` and the reason. Call `minigame.share()`.

## References

- [references/quick-start.md](references/quick-start.md): the four steps from a Defold project to a running mini game, and what the start-up log says when it stops.
- [references/usage.md](references/usage.md): every option, what an export contains, the platform differences, saves, audio, input, display, network, package size and subpackages, exporting again, compatibility, supported Defold versions, and the FAQ.
- [references/api.md](references/api.md): every function of the `minigame` module.

The same documents are on the web, in English and Chinese, at `https://anrans.github.io/defold_for_minigame/`. Answer the user in their language whichever one these files are written in.
