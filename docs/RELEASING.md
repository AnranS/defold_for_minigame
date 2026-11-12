# Release process

A release is a tag on `main`. Tags are immutable: decide the version, validate
that exact commit, then tag.

## 1. Choose and apply the version

The version lives in five places that must agree; `test/support_matrix.test.mjs`
and `test/skill.test.mjs` fail when they do not.

| File | Field |
|---|---|
| `support-matrix.json` | `toolVersion` |
| `package.json` | `version` |
| `minigame/minigame.lua` | `M.VERSION` |
| `.claude-plugin/plugin.json` | `version` |
| `skills/defold-minigame/SKILL.md` | `metadata.version`, and the sentence that names the version |

The install addresses in the READMEs, the quick starts, and the usage guides
name the tag: `archive/refs/tags/v<version>.zip` for the Defold library and
`git clone --branch v<version>` for the exporter. Change them in the commit
that changes the version; the same test fails when one is left behind.

The agent skill names the tag in the same addresses, and its reference files
are copies of the documents: run `node scripts/generate_skill_references.mjs`
after the documents change. Claude Code gives the plugin's users an update
only when the version in `plugin.json` changes, so a release is what delivers
a changed skill to them. The agent guides (`docs/AI_AGENTS*.md`) clone the
tag as well.

Bump `bridgeAbi` in `support-matrix.json`, `BRIDGE_ABI_VERSION` in
`runtime/common/js/platform_runtime.js`, and `M.ABI` in `minigame/minigame.lua`
together whenever the Lua ⇄ JS protocol changes. A game built with the old Lua
module then disables its SDK calls instead of misbehaving.

## 2. Validate the exact release source

```bash
./scripts/test.sh
```

This runs the test suite, checks that `docs/API.md` and `docs/API_zh.md` match
the Lua source and that the figures in `docs/images/` match their generator,
and builds and checks the website.

After changing `support-matrix.json`, the Lua module's doc comments, or a
figure, regenerate the files that are derived from them:

```bash
node scripts/generate_api_docs.mjs
node scripts/generate_diagrams.mjs
```

Then, for every Defold version the release claims in `support-matrix.json`:

```bash
node scripts/verify_engine.mjs --version <version> --sha1 <engine sha1>
```

Set a validation level to `verified` only for a check that was run on that
version for this release:

| Level | How it is earned |
|---|---|
| `staticContract`, `wasmFeatureScan` | `scripts/verify_engine.mjs` passes |
| `devtool.<platform>` | a bundle built by that Defold version runs in that platform's developer tool: WeChat DevTools, Douyin DevTools, `ttmg dev` |
| `realDevice.<platform>` | the export runs on an iOS and an Android phone in that platform's app |

Every `verified` developer-tool level needs an entry under `hostRuns` with the
date, the tool and its version, the Defold version and engine SHA1, what was
run, and the result, in English and in Chinese. A run on phones also lists
their systems under `devices`, and a `realDevice` level is `verified` exactly
when a recorded run names both `iOS` and `Android`.
`test/support_matrix.test.mjs` fails when a claim has no record or a record
has no claim. A platform's
`devtoolCompile` is `verified` once any run in its tool is recorded, and its
`supportTier` moves from `experimental` only after `devtoolCompile` and
`realDevice` are both verified.

### Running in WeChat DevTools

The API test app in the repository root is the release check. Build it with the
`bob.jar` of the Defold version under test, export it, and let it run every
unattended test:

```bash
node bin/defold-minigame.mjs build --project . --bob <bob.jar> --java <java> \
  --platform wechat --appid <app id> --assets example/assets \
  --subpackage extras=example/extras --output <project>
node scripts/devtools_probe.mjs inject --project <project> --label apitest \
  --storage apitest.autorun=1 --capture 30000 --finish 32000
# open <project> in WeChat DevTools and wait for the run to finish, then:
node scripts/devtools_probe.mjs collect --label apitest --out <evidence folder> \
  --storage "<DevTools profile>/WeappSimulator/WeappFileSystem/<user>/<app id>/usr"
node scripts/devtools_probe.mjs remove --project <project>
```

The collected console log must end with `[apitest] done pass=<n> fail=0`, and
the collected frames must show the list. Things to know:

- A project path the tool has not seen opens in tourist mode, where
  subpackages do not load. Use a real App ID and a path the tool knows.
- Export into a project that is closed in the tool, or compile again
  afterwards. A project that is open while its files change can start on a mix
  of old and new files; the loader then stops with an archive size mismatch.
- The simulator runs at about one frame per second while the tool's window is
  in the background. Give a run more time, or keep the window in front.
- The probe is silent by default. `--audible` lets the sound through.
- `bob.jar` needs the JDK named in the Defold manual: OpenJDK 25 for 1.14.
- Without `--subpackage extras=example/extras` the three tests of the game's
  own subpackage are skipped, and the run does not cover them.

### Running in Douyin DevTools

The same app, exported with `--platform douyin` and the same options, with the
probe injected the same way. Import the folder in Douyin DevTools as a mini
game. The run is read from the tool's console, which must show
`[apitest] done pass=<n> fail=0`, and from a screenshot of the simulator.

Douyin DevTools ships a command-line tool, `douyinide`, that does this without
the window:

```bash
douyinide open-project-window --path <project> --type microgame
douyinide get-project-windows-info                         # the window id
douyinide miniapp-get-console-messages --window-id <id>
douyinide miniapp-image-screenshot --window-id <id> --file-name <png>
douyinide miniapp-tap --window-id <id> --x <x> --y <y>     # a tap reaches a button
douyinide miniapp-swipe --window-id <id> --start-x <x> --start-y <y> --move <x>,<y> --end-x <x> --end-y <y>
```

Things to know:

- The tool rewrites `project.config.json` when it opens the project. Later
  exports into the folder keep that file; see the usage guide.
- After an export into an open project, clear the compile cache
  (`douyinide debug-clear-cache --type compile-cache`) and compile again
  (`douyinide simulator-compile`).
- The console lists a repeated message once. A test that is run a second time
  with the same result adds no line; look at the screen instead.
- `miniapp-tap` presses and releases within one frame. That is the case the
  adapter holds the release for, so send at least one such tap per release.

### Running through ttmg dev

TikTok has no simulator: `ttmg dev` compiles the export, serves a page with a
QR code, and the game runs in the TikTok app on the phone that scans it. One
run is therefore the developer-tool level and a device at once.

```bash
node bin/defold-minigame.mjs build --project . --bob <bob.jar> --java <java> \
  --platform tiktok --appid <client key> --assets example/assets \
  --subpackage extras=example/extras --output <project>
cd <project> && ttmg dev --client-key <client key>
```

Tap "Run all" on an iPhone and on an Android phone, and record what the list
shows. Things to know:

- There is no probe for this run; the result is what the screen shows.
- The engine mixer is off, so the engine's sound test is skipped, and reading
  a file from the subpackage is skipped because the file system is off limits.
- TikTok has no `onShareAppMessage`; the share-content test is skipped.
- Record the phone models, the system versions and the TikTok version. The run
  of 2026-11-11 did not.

### Running on WeChat and Douyin phones

The preview of the developer tool puts an export on a phone. Use the export
without the probe, tap "Run all" on an iPhone and on an Android phone, and
record what the list shows together with the phone models, the system versions
and the app version. The runs of 2026-11-11 recorded the result only.

Without Defold installed, `node scripts/fetch_example_bundle.mjs --example
sprite/flip --out <folder>` assembles a real HTML5 bundle from one of the
examples on defold.com. Those examples are built with whatever Defold the site
was last built with, which may be a pre-release; a run with one is recorded
under `hostRuns` with its channel and does not verify a released version.

## 3. Certify a new Defold version

1. Run `scripts/verify_engine.mjs --version <new>`. If it reports a contract
   mismatch, Defold changed its HTML5 loader: read the diff of `dmloader.js`
   between the two tags before touching anything.
2. Copy the new `dmloader.js` template to `test/fixtures/defold-<version>/`
   and add the release to `DEFOLD_RELEASES` in `test/helpers/bundle_fixture.mjs`.
   The host tests then run against it automatically.
3. Add the entry the script printed to `support-matrix.json`.

## 4. Tag and publish

```bash
git tag v<version>
git push origin v<version>
gh release create v<version> --title "v<version>" --notes-file <notes>
```

Tag the commit CI passed on. GitHub builds the source archive of a tag by
itself, and that archive is what a Defold project depends on, so there is no
package to build. The release notes say what was verified where and what is
known not to work, as `support-matrix.json` records it.

Pushing to `main` deploys the website through `.github/workflows/deploy-pages.yml`
once GitHub Pages is enabled for the repository (Settings > Pages > Source:
GitHub Actions). Until then a push only builds and checks the site; running the
workflow by hand publishes regardless. The workflow runs `./scripts/test.sh`
first, because the home page says the automated tests pass. After the tag is public, export one game from a fresh
clone of the tag and open it in a developer tool, and build a Defold project
that takes the Lua module from the tag's archive.
