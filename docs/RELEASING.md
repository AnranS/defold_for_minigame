# Release process

A release is a tag on `main`. Tags are immutable: decide the version, validate
that exact commit, then tag.

## 1. Choose and apply the version

The version lives in three places that must agree; `test/support_matrix.test.mjs`
fails when they do not.

| File | Field |
|---|---|
| `support-matrix.json` | `toolVersion` |
| `package.json` | `version` |
| `minigame/minigame.lua` | `M.VERSION` |

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
| `simulatedHost` | a real bundle built by that Defold version boots in the simulated hosts. There is no harness for this yet: the simulated hosts have no WebGL, so only the engine stand-in runs in them today |
| `devtool` | the export runs in the WeChat and Douyin developer tools and under `ttmg dev` |
| `realDevice` | the export runs on an iOS and an Android phone |

Platform `supportTier` moves from `experimental` only after `devtool` and
`realDevice` are verified for that platform.

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
```

Pushing to `main` deploys the website through `.github/workflows/deploy-pages.yml`
once GitHub Pages is enabled for the repository (Settings > Pages > Source:
GitHub Actions). Until then a push only builds and checks the site; running the
workflow by hand publishes regardless. The workflow runs `./scripts/test.sh`
first, because the home page says the automated tests pass. After the tag is public, export one game from a fresh
clone of the tag and open it in a developer tool.
