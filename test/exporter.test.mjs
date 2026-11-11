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
