import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { brotliDecompressSync } from "node:zlib";

import { exportMiniGame, inspectBundle } from "../src/exporter.mjs";
import { MANIFEST_NAME } from "../src/output_guard.mjs";
import { ExportError, listFiles, loadSupportMatrix, sha256 } from "../src/util.mjs";
import { DEFOLD_RELEASES, DEFOLD_VERSION, DEFOLD_VERSIONS } from "./helpers/bundle_fixture.mjs";
import { engineStandInWasm, moduleWithCode } from "./helpers/wasm_builder.mjs";
import { APP_ID, PLATFORMS, makeWorkspace } from "./helpers/workspace.mjs";

const EXPECTED_FILES = [
  ".defold-mini-game-export.json",
  "adapter.js",
  "engine/archive/game0.arcd.bin",
  "engine/archive/game0.arci.bin",
  "engine/archive/game0.dmanifest.bin",
  "engine/archive/game0.projectc.bin",
  "engine/archive/game0.public.der.bin",
  "engine/archive/game1.arcd.bin",
  "engine/dmengine.wasm.br",
  "engine/game.js",
  "game.js",
  "game.json",
  "js/boot_config.js",
  "js/bridge.js",
  "js/defold_engine.js",
  "js/idb_store.js",
  "js/loader.js",
  "js/platform_runtime.js",
  "project.config.json",
];

function bootConfig(outputDir) {
  const source = readFileSync(join(outputDir, "js/boot_config.js"), "utf8");
  return JSON.parse(source.slice(source.indexOf("{"), source.lastIndexOf("};") + 1));
}

for (const platform of PLATFORMS) {
  test(`exports the expected package for ${platform}`, (t) => {
    const workspace = makeWorkspace(t);
    const result = workspace.export(platform);
    const output = workspace.outputDir(platform);

    const expected = platform === "wechat" ? [...EXPECTED_FILES, "project.private.config.json"].sort() : EXPECTED_FILES;
    assert.deepEqual(listFiles(output), expected);
    assert.equal(result.platform, platform);
    assert.deepEqual(result.warnings, []);

    const gameJson = JSON.parse(readFileSync(join(output, "game.json"), "utf8"));
    const field = loadSupportMatrix().platformContracts[platform].subpackageField;
    assert.deepEqual(gameJson[field], [{ root: "engine/", name: "engine" }]);
    assert.equal(gameJson.deviceOrientation, "portrait");
    for (const other of ["subpackages", "subPackages"].filter((name) => name !== field)) {
      assert.equal(other in gameJson, false, `${platform} must not declare ${other}`);
    }

    const project = JSON.parse(readFileSync(join(output, "project.config.json"), "utf8"));
    assert.equal(project.appid, APP_ID);
    assert.equal(project.projectname, "HelloMiniGame");
    assert.equal(project.compileType, "game");

    const entry = readFileSync(join(output, "game.js"), "utf8");
    assert.match(entry, new RegExp(`requirePlatform\\("${platform}"`));
    assert.ok(entry.indexOf('import "./js/boot_config"') < entry.indexOf('import "./adapter"'));

    const config = bootConfig(output);
    assert.equal(config.platform, platform);
    assert.equal(config.exeName, "HelloMiniGame");
    assert.equal(config.engineVersion, DEFOLD_VERSION);
    assert.deepEqual(config.wasm.candidates, ["engine/dmengine.wasm.br"]);
    assert.equal(config.engineSubpackage, "engine");
    assert.equal(config.bridgeAbi, loadSupportMatrix().bridgeAbi);
  });
}

test("the packaged engine binary is the bundle's binary, Brotli-compressed", (t) => {
  const workspace = makeWorkspace(t);
  workspace.export("wechat");
  const packed = readFileSync(join(workspace.outputDir("wechat"), "engine/dmengine.wasm.br"));
  assert.ok(brotliDecompressSync(packed).equals(readFileSync(join(workspace.bundleDir, "HelloMiniGame.wasm"))));
});

test("--no-brotli ships the binary as is and says so", (t) => {
  const workspace = makeWorkspace(t);
  const result = workspace.export("douyin", { brotli: false });
  const output = workspace.outputDir("douyin");
  assert.ok(existsSync(join(output, "engine/dmengine.wasm")));
  assert.ok(!existsSync(join(output, "engine/dmengine.wasm.br")));
  assert.deepEqual(bootConfig(output).wasm.candidates, ["engine/dmengine.wasm"]);
  assert.ok(result.warnings.some((warning) => /not Brotli-compressed/.test(warning)));
});

test("archive pieces are copied byte for byte under a whitelisted extension", (t) => {
  const workspace = makeWorkspace(t, { archiveSize: 7000 });
  workspace.export("tiktok");
  const output = workspace.outputDir("tiktok");
  const config = bootConfig(output);
  for (const file of config.archive) {
    const data = Buffer.concat(file.pieces.map((piece) => {
      assert.match(piece.path, /^engine\/archive\/[A-Za-z0-9._-]+\.bin$/);
      return readFileSync(join(output, piece.path));
    }));
    assert.equal(data.length, file.size);
    assert.ok(data.equals(workspace.bundle.archive.get(file.name)), file.name);
  }
  assert.deepEqual(config.archive.find((file) => file.name === "game.arcd").pieces.map((piece) => piece.offset), [0, 4200]);
});

test("the manifest lists every file with its size and hash", (t) => {
  const workspace = makeWorkspace(t);
  const result = workspace.export("wechat");
  const output = workspace.outputDir("wechat");
  const manifest = JSON.parse(readFileSync(join(output, MANIFEST_NAME), "utf8"));
  assert.deepEqual(manifest, result.manifest);
  assert.equal(manifest.generator, "defold-minigame");
  assert.equal(manifest.platform, "wechat");
  assert.equal(manifest.engine.defoldVersion, DEFOLD_VERSION);
  assert.equal(manifest.engine.inSupportMatrix, true);
  assert.deepEqual(manifest.managed, [MANIFEST_NAME, "adapter.js", "engine", "game.js", "game.json", "js",
    "project.config.json", "project.private.config.json"]);
  const onDisk = listFiles(output).filter((file) => file !== MANIFEST_NAME);
  assert.deepEqual(manifest.artifacts.map((artifact) => artifact.path), onDisk);
  for (const artifact of manifest.artifacts) {
    const data = readFileSync(join(output, artifact.path));
    assert.equal(data.length, artifact.size);
    assert.equal(sha256(data), artifact.sha256);
  }
});

test("options reach game.json and the boot configuration", (t) => {
  const workspace = makeWorkspace(t, { highDpi: true });
  workspace.export("wechat", {
    orientation: "landscape", name: "我的 \"游戏\"", heapSizeMb: 96, pixelRatio: 1.5, maxPixelRatio: 3,
    engineAudio: "off", persistence: "storage", loadingText: "", engineArguments: ["--config=x"],
  });
  const output = workspace.outputDir("wechat");
  assert.equal(JSON.parse(readFileSync(join(output, "game.json"), "utf8")).deviceOrientation, "landscape");
  assert.equal(JSON.parse(readFileSync(join(output, "project.config.json"), "utf8")).projectname, "我的 \"游戏\"");
  const config = bootConfig(output);
  assert.equal(config.heapSizeBytes, 96 * 1024 * 1024);
  assert.equal(config.pixelRatio, 1.5);
  assert.equal(config.maxPixelRatio, 3);
  assert.equal(config.highDpi, true);
  assert.equal(config.engineAudio, "off");
  assert.equal(config.persistence, "storage");
  assert.equal(config.loadingText, "");
  assert.deepEqual(config.extraEngineArguments, ["--config=x"]);
});

test("auto orientation follows the project's display size", (t) => {
  const workspace = makeWorkspace(t, { width: 1280, height: 720 });
  assert.equal(workspace.export("douyin").orientation, "landscape");
});

test("validates options before touching the disk", (t) => {
  const workspace = makeWorkspace(t);
  const base = { bundleDir: workspace.bundleDir, platform: "wechat", appId: APP_ID, outputDir: workspace.outputDir("x") };
  const cases = [
    [{ platform: "steam" }, /unknown platform 'steam'/],
    [{ appId: "  " }, /App ID is required/],
    [{ outputDir: undefined }, /output directory is required/],
    [{ bundleDir: undefined }, /bundle directory is required/],
    [{ outputDir: join(workspace.bundleDir, "out") }, /must not contain one another/],
    [{ outputDir: dirname(workspace.bundleDir) }, /must not contain one another/],
    [{ orientation: "sideways" }, /unknown orientation/],
    [{ heapSizeMb: 8 }, /heap size must be between/],
    [{ pixelRatio: 9 }, /pixel ratio must be/],
    [{ engineAudio: "loud" }, /unknown engine audio mode/],
    [{ persistence: "cloud" }, /unknown persistence mode/],
    [{ brotliQuality: 12 }, /Brotli quality/],
  ];
  for (const [override, pattern] of cases) {
    assert.throws(() => exportMiniGame({ ...base, ...override }), (error) => {
      assert.ok(error instanceof ExportError, `${JSON.stringify(override)} → ${error}`);
      assert.match(error.message, pattern);
      return true;
    });
  }
  assert.ok(!existsSync(workspace.outputDir("x")));
});

test("refuses an engine that uses a blocked WebAssembly feature, unless it is allowed", (t) => {
  const simd = moduleWithCode([0xfd, 0x0c, ...new Array(16).fill(0), 0x1a]);
  const workspace = makeWorkspace(t, { wasm: simd });
  assert.throws(() => workspace.export("wechat"), (error) => {
    assert.ok(error instanceof ExportError);
    assert.match(error.message, /SIMD/);
    assert.match(error.hint, /--allow-wasm-feature/);
    return true;
  });
  assert.ok(!existsSync(workspace.outputDir("wechat")));
  const result = workspace.export("wechat", { allowWasmFeatures: ["simd"] });
  assert.ok(result.warnings.some((warning) => /allowed explicitly/.test(warning)));
});

test("warns about an engine version that is not in the support matrix", (t) => {
  const workspace = makeWorkspace(t, { engineVersion: "1.99.0" });
  const result = workspace.export("wechat");
  assert.ok(result.warnings.some((warning) => /Defold 1\.99\.0 is not in the support matrix/.test(warning)));
  assert.equal(result.manifest.engine.inSupportMatrix, false);
});

test("enforces the platform's package limits", (t) => {
  // Douyin allows 20 MB in total; WeChat and TikTok allow 30 MB.
  const workspace = makeWorkspace(t, { archiveSize: 21 * 1024 * 1024 });
  assert.throws(() => workspace.export("douyin"), /above the 20\.00 MB limit of Douyin Mini Game/);
  assert.ok(!existsSync(workspace.outputDir("douyin")));
  assert.equal(workspace.export("wechat").platform, "wechat");
  const raised = workspace.export("douyin", { totalLimitMb: 30 });
  assert.equal(raised.sizes.limits.total, 30 * 1024 * 1024);
  assert.ok(raised.sizes.main < 4 * 1024 * 1024);
  assert.ok(raised.sizes.engineSubpackage > 21 * 1024 * 1024);
});

test("re-exporting replaces the exporter's files and keeps everything else", (t) => {
  const workspace = makeWorkspace(t);
  const output = workspace.outputDir("wechat");
  workspace.export("wechat");
  writeFileSync(join(output, "notes.txt"), "mine");
  mkdirSync(join(output, "cloudfunctions"));
  writeFileSync(join(output, "cloudfunctions", "index.js"), "// mine");

  const second = workspace.export("wechat", { orientation: "landscape", brotli: false });
  assert.equal(second.orientation, "landscape");
  assert.equal(readFileSync(join(output, "notes.txt"), "utf8"), "mine");
  assert.equal(readFileSync(join(output, "cloudfunctions", "index.js"), "utf8"), "// mine");
  assert.ok(existsSync(join(output, "engine/dmengine.wasm")));
  assert.ok(!existsSync(join(output, "engine/dmengine.wasm.br")), "files of the previous export are gone");
  assert.deepEqual(readdirSync(dirname(output)).filter((entry) => /\.(lock|staging|backup)/.test(entry)), []);
});

test("refuses to adopt a folder it did not create", (t) => {
  const workspace = makeWorkspace(t);
  const output = workspace.outputDir("wechat");
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, "game.js"), "// someone else's game");
  assert.throws(() => workspace.export("wechat"), /not empty and was not created by defold-minigame/);
  assert.equal(readFileSync(join(output, "game.js"), "utf8"), "// someone else's game");
});

test("refuses to discard hand edits inside its own paths unless forced", (t) => {
  const workspace = makeWorkspace(t);
  const output = workspace.outputDir("wechat");
  workspace.export("wechat");
  writeFileSync(join(output, "js", "extra.js"), "// added by hand");
  assert.throws(() => workspace.export("wechat"), /js\/extra\.js was not written by the exporter/);
  writeFileSync(join(output, "game.json"), "{}");
  assert.throws(() => workspace.export("wechat"), /game\.json was modified after the last export/);

  workspace.export("wechat", { force: true });
  assert.ok(!existsSync(join(output, "js", "extra.js")));
  assert.notEqual(readFileSync(join(output, "game.json"), "utf8"), "{}");
});

test("stops when an earlier export left a lock or a staging folder behind", (t) => {
  const workspace = makeWorkspace(t);
  const output = workspace.outputDir("wechat");
  workspace.export("wechat");
  writeFileSync(`${output}.lock`, "");
  assert.throws(() => workspace.export("wechat"), /an earlier export did not finish/);
});

test("a failed export leaves the previous export intact", (t) => {
  const workspace = makeWorkspace(t);
  const output = workspace.outputDir("wechat");
  workspace.export("wechat");
  const before = Object.fromEntries(listFiles(output).map((file) => [file, sha256(readFileSync(join(output, file)))]));
  // Corrupt the bundle so the next export fails during preflight.
  writeFileSync(join(workspace.bundleDir, "HelloMiniGame.wasm"), engineStandInWasm({ shared: true }));
  assert.throws(() => workspace.export("wechat"));
  const after = Object.fromEntries(listFiles(output).map((file) => [file, sha256(readFileSync(join(output, file)))]));
  assert.deepEqual(after, before);
  assert.deepEqual(readdirSync(dirname(output)).filter((entry) => /\.(lock|staging|backup)/.test(entry)), []);
});

test("inspectBundle reports without writing", (t) => {
  const workspace = makeWorkspace(t);
  const inspection = inspectBundle(workspace.bundleDir);
  assert.equal(inspection.bundle.exeName, "HelloMiniGame");
  assert.equal(inspection.policy.ok, true);
  assert.equal(inspection.engineRecord.defoldVersion, DEFOLD_VERSION);
  assert.deepEqual(readdirSync(workspace.root).sort(), ["bundle", "user"]);
});

test("--assets copies loose files into the main package and warns about extensions hosts drop", (t) => {
  const workspace = makeWorkspace(t);
  const assets = join(workspace.root, "loose");
  mkdirSync(join(assets, "audio"), { recursive: true });
  writeFileSync(join(assets, "audio", "bgm.mp3"), Buffer.from([1, 2, 3]));
  writeFileSync(join(assets, "share.png"), Buffer.from([4]));
  writeFileSync(join(assets, "notes.psd"), Buffer.from([5]));
  writeFileSync(join(assets, ".DS_Store"), Buffer.from([6]));

  const result = workspace.export("tiktok", { assetsDir: assets });
  const output = workspace.outputDir("tiktok");
  assert.deepEqual(listFiles(join(output, "assets")), ["audio/bgm.mp3", "notes.psd", "share.png"]);
  assert.deepEqual([...readFileSync(join(output, "assets/audio/bgm.mp3"))], [1, 2, 3]);
  assert.ok(result.manifest.managed.includes("assets"));
  assert.ok(result.warnings.some((warning) => /not on the upload whitelist.*\.psd/.test(warning)));
  assert.ok(!result.warnings.some((warning) => /\.mp3|\.png/.test(warning)));

  // Removing a file from the source removes it from the next export.
  unlinkSync(join(assets, "notes.psd"));
  const again = workspace.export("tiktok", { assetsDir: assets });
  assert.deepEqual(listFiles(join(output, "assets")), ["audio/bgm.mp3", "share.png"]);
  assert.deepEqual(again.warnings, []);

  assert.throws(() => workspace.export("tiktok", { assetsDir: join(workspace.root, "nope") }), /assets directory does not exist/);
  assert.throws(() => workspace.export("tiktok", { assetsDir: output }), /must not contain one another/);
});

for (const defoldVersion of DEFOLD_VERSIONS) {
  test(`records which loader design a Defold ${defoldVersion} bundle uses`, (t) => {
    const workspace = makeWorkspace(t, { defoldVersion });
    const result = workspace.export("wechat");
    const generation = DEFOLD_RELEASES[defoldVersion].loaderGeneration;
    assert.equal(result.report.engineModule.loaderGeneration, generation);
    assert.equal(result.manifest.engine.loaderGeneration, generation);
    assert.equal(result.manifest.engine.defoldVersion, defoldVersion);
    assert.equal(result.manifest.engine.inSupportMatrix, true);
    assert.equal(bootConfig(workspace.outputDir("wechat")).loaderGeneration, generation);
    assert.deepEqual(result.warnings, []);
    const engine = readFileSync(join(workspace.outputDir("wechat"), "js/defold_engine.js"), "utf8");
    assert.ok(engine.includes(`generation: "${generation}"`));
  });
}

test("the developer tool's project files keep what the tool wrote into them", (t) => {
  const workspace = makeWorkspace(t);
  const output = workspace.outputDir("douyin");
  workspace.export("douyin");
  const file = join(output, "project.config.json");
  const written = JSON.parse(readFileSync(file, "utf8"));

  // Douyin's developer tool writes the file again, on one line, when it opens the project.
  writeFileSync(file, JSON.stringify(written));
  assert.deepEqual(workspace.export("douyin").warnings, []);

  // Every developer tool stores what is changed in its project settings there.
  writeFileSync(file, JSON.stringify({
    ...written,
    projectname: "Renamed in the tool",
    setting: { urlCheck: true, es6: written.setting.es6, localPlugins: false },
    addedByTheTool: { any: "thing" },
  }));
  workspace.export("douyin", { appId: "tt-another-app" });
  let kept = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(kept.appid, "tt-another-app", "the App ID is the export's");
  assert.equal(kept.compileType, "game");
  assert.equal(kept.projectname, "Renamed in the tool");
  assert.deepEqual(kept.addedByTheTool, { any: "thing" });
  assert.equal(kept.setting.urlCheck, true, "a setting changed in the tool stays changed");
  assert.equal(kept.setting.localPlugins, false);
  assert.equal(kept.setting.minified, written.setting.minified, "a setting the file lost gets the export's default");

  // A name given to the export is the name.
  workspace.export("douyin", { name: "Named by the export" });
  kept = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(kept.projectname, "Named by the export");
  assert.equal(kept.setting.urlCheck, true);

  // --force goes back to the export's own file.
  workspace.export("douyin", { force: true });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), written);

  // A file that is no longer JSON cannot be kept; the export says that it replaced it.
  writeFileSync(file, "{ broken");
  const replaced = workspace.export("douyin");
  assert.ok(replaced.warnings.some((warning) => /project\.config\.json was not valid JSON and was written anew/.test(warning)), replaced.warnings.join("; "));
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), written);

  // The rest of the export is still guarded.
  writeFileSync(join(output, "game.json"), "{}");
  assert.throws(() => workspace.export("douyin"), /game\.json was modified after the last export/);
});

test("WeChat's private project file is the developer tool's as well", (t) => {
  const workspace = makeWorkspace(t);
  const output = workspace.outputDir("wechat");
  workspace.export("wechat");
  const file = join(output, "project.private.config.json");
  const written = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...written, setting: { ...written.setting, urlCheck: false }, libVersion: "3.9.0" }, null, 4));
  workspace.export("wechat");
  const kept = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(kept.libVersion, "3.9.0");
  assert.equal(kept.setting.urlCheck, false);
  assert.equal(kept.appid, APP_ID);
});

for (const platform of PLATFORMS) {
  test(`--subpackage turns a folder into a subpackage the game loads when it wants it (${platform})`, (t) => {
    const workspace = makeWorkspace(t);
    const levels = join(workspace.root, "levels");
    mkdirSync(join(levels, "music"), { recursive: true });
    writeFileSync(join(levels, "music", "boss.mp3"), Buffer.alloc(3000, 7));
    writeFileSync(join(levels, "map.json"), "{}");
    writeFileSync(join(levels, ".DS_Store"), "x");
    const voices = join(workspace.root, "voices");
    mkdirSync(voices);
    writeFileSync(join(voices, "hello.wav"), Buffer.alloc(500, 1));
    writeFileSync(join(voices, "game.js"), "// the game's own entry for this subpackage\n");

    const plain = workspace.export(platform);
    const result = workspace.export(platform, {
      subpackages: [{ name: "levels", dir: levels }, { name: "voices", dir: voices }],
    });
    const output = workspace.outputDir(platform);

    // The files are in the package, under the subpackage's name; hidden files stay out.
    assert.deepEqual(listFiles(join(output, "levels")), ["game.js", "map.json", "music/boss.mp3"]);
    assert.equal(readFileSync(join(output, "levels/music/boss.mp3")).length, 3000);
    // Hosts load a subpackage by running its game.js. One is written unless the folder brings its own.
    assert.match(readFileSync(join(output, "levels/game.js"), "utf8"), /subpackage/);
    assert.equal(readFileSync(join(output, "voices/game.js"), "utf8"), "// the game's own entry for this subpackage\n");

    // game.json declares them next to the engine, under the platform's spelling of the field.
    const game = JSON.parse(readFileSync(join(output, "game.json"), "utf8"));
    const field = platform === "douyin" ? "subPackages" : "subpackages";
    assert.deepEqual(game[field], [
      { root: "engine/", name: "engine" },
      { root: "levels/", name: "levels" },
      { root: "voices/", name: "voices" },
    ]);

    // They count towards the total, not towards the main package.
    const onDisk = (folder) => listFiles(join(output, folder))
      .reduce((sum, file) => sum + readFileSync(join(output, folder, file)).length, 0);
    assert.equal(result.sizes.subpackages.levels, onDisk("levels"));
    assert.equal(result.sizes.subpackages.levels, 3000 + 2 + readFileSync(join(output, "levels/game.js")).length);
    assert.equal(result.sizes.subpackages.voices, onDisk("voices"));
    assert.equal(result.sizes.engineSubpackage, onDisk("engine"));
    assert.equal(result.sizes.engineSubpackage, plain.sizes.engineSubpackage);
    assert.equal(
      result.sizes.total,
      result.sizes.main + result.sizes.engineSubpackage + result.sizes.subpackages.levels + result.sizes.subpackages.voices,
    );
    // The main package only grew by the two declarations and the list in the boot configuration.
    assert.ok(result.sizes.main > plain.sizes.main && result.sizes.main < plain.sizes.main + 400, `${result.sizes.main}`);
    assert.deepEqual(plain.sizes.subpackages, {});
    assert.deepEqual(result.report.subpackages, [
      { name: "levels", files: 3, bytes: result.sizes.subpackages.levels },
      { name: "voices", files: 2, bytes: result.sizes.subpackages.voices },
    ]);

    // The runtime is told which subpackages exist, and the folders belong to the export.
    assert.deepEqual(bootConfig(output).subpackages, ["levels", "voices"]);
    assert.deepEqual(bootConfig(workspace.outputDir(platform)).engineSubpackage, "engine");
    assert.ok(result.manifest.managed.includes("levels") && result.manifest.managed.includes("voices"));

    // Exporting again without one of them removes its folder.
    workspace.export(platform, { subpackages: [{ name: "levels", dir: levels }] });
    assert.ok(existsSync(join(output, "levels/map.json")));
    assert.ok(!existsSync(join(output, "voices")));
    assert.deepEqual(JSON.parse(readFileSync(join(output, "game.json"), "utf8"))[field].map((entry) => entry.name), ["engine", "levels"]);
  });
}

test("--subpackage refuses names and folders that cannot work", (t) => {
  const workspace = makeWorkspace(t);
  const folder = join(workspace.root, "extra");
  mkdirSync(folder);
  writeFileSync(join(folder, "a.bin"), "a");
  const attempt = (subpackages) => () => workspace.export("wechat", { subpackages });
  for (const name of ["engine", "js", "assets", "Engine", "game.js"]) {
    assert.throws(attempt([{ name, dir: folder }]), /is used by the export itself/, name);
  }
  for (const name of ["", "with space", "a/b", "../up", ".hidden", "中文"]) {
    assert.throws(attempt([{ name, dir: folder }]), /subpackage name/, JSON.stringify(name));
  }
  assert.throws(attempt([{ name: "extra", dir: folder }, { name: "extra", dir: folder }]), /declared twice/);
  assert.throws(attempt([{ name: "extra", dir: join(workspace.root, "missing") }]), /does not exist/);
  assert.throws(attempt([{ name: "extra", dir: folder }, { name: "Extra", dir: folder }]), /declared twice/);
  assert.throws(attempt([{ name: "extra", dir: workspace.root }]), /must not contain one another/);
  assert.throws(attempt([{ name: "extra" }]), /needs a folder/);
  assert.throws(attempt("extra"), /list of \{ name, dir \}/);
  mkdirSync(join(workspace.root, "empty"));
  assert.throws(attempt([{ name: "empty", dir: join(workspace.root, "empty") }]), /has no files/);
  // Nothing was written by any of the attempts.
  assert.ok(!existsSync(workspace.outputDir("wechat")));
});

test("subpackages count towards the total limit and warn about extensions hosts drop", (t) => {
  const workspace = makeWorkspace(t);
  const big = join(workspace.root, "big");
  mkdirSync(big);
  writeFileSync(join(big, "video.mp4"), Buffer.alloc(900 * 1024));
  writeFileSync(join(big, "source.psd"), "x");
  const result = workspace.export("douyin", { subpackages: [{ name: "big", dir: big }] });
  assert.ok(result.warnings.some((warning) => /\.psd/.test(warning) && /upload whitelist/.test(warning)));
  assert.throws(
    () => workspace.export("douyin", { subpackages: [{ name: "big", dir: big }], totalLimitMb: 0.5 }),
    /above the .* limit/,
  );
});

test("the project's html5.max_pixel_ratio is the default cap; the command line overrides it", (t) => {
  const projectCap = makeWorkspace(t, { defoldVersion: "1.14.1", highDpi: true, minPixelRatio: 1.5, maxPixelRatio: 3 });
  projectCap.export("wechat");
  assert.equal(bootConfig(projectCap.outputDir("wechat")).maxPixelRatio, 3);
  assert.equal(bootConfig(projectCap.outputDir("wechat")).minPixelRatio, 1.5);
  projectCap.export("douyin", { maxPixelRatio: 1.5 });
  assert.equal(bootConfig(projectCap.outputDir("douyin")).maxPixelRatio, 1.5);

  const noCap = makeWorkspace(t, { defoldVersion: "1.14.1", highDpi: true });
  noCap.export("wechat");
  assert.equal(bootConfig(noCap.outputDir("wechat")).maxPixelRatio, 2, "2 when the project sets no cap");
});
