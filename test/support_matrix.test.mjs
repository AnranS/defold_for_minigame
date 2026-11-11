/**
 * support-matrix.json is the single source of truth for versions, platform
 * contracts, and how far each of them has been validated. These tests fail
 * when the code, the Lua module, or the documents say something else.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { renderApi } from "../scripts/generate_api_docs.mjs";
import { readLuaApi } from "../scripts/lib/lua_api.mjs";
import { detectLoaderGeneration, LOADER_GENERATIONS } from "../src/engine_module.mjs";
import { MANIFEST_SCHEMA } from "../src/output_guard.mjs";
import { getPlatform, PLATFORM_NAMES } from "../src/platforms.mjs";
import { loadSupportMatrix, REPO_ROOT } from "../src/util.mjs";
import { BLOCKING_FEATURES } from "../src/wasm_features.mjs";
import { DEFOLD_RELEASES, FIXTURES, readLoaderTemplate } from "./helpers/bundle_fixture.mjs";

const matrix = loadSupportMatrix();
const read = (path) => readFileSync(join(REPO_ROOT, path), "utf8");
const pkg = JSON.parse(read("package.json"));
const lua = read("minigame/minigame.lua");
const platformRuntime = read("runtime/common/js/platform_runtime.js");

const READMES = ["README.md", "README_zh.md"];
const DOCUMENTS = [
  ...READMES,
  "THIRD_PARTY_NOTICES.md",
  ...readdirSync(join(REPO_ROOT, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`),
];

function constant(source, pattern, what) {
  const match = pattern.exec(source);
  assert.ok(match, `${what} was not found`);
  return match[1];
}

test("the tool version is the same everywhere it is written", () => {
  assert.match(matrix.toolVersion, /^\d+\.\d+\.\d+$/);
  assert.equal(pkg.version, matrix.toolVersion, "package.json version");
  assert.equal(constant(lua, /^M\.VERSION = "([^"]+)"$/m, "M.VERSION in minigame.lua"), matrix.toolVersion);
  for (const file of READMES) {
    assert.ok(read(file).includes(`v${matrix.toolVersion}`), `${file} does not name v${matrix.toolVersion}`);
  }
});

test("both sides of the Lua bridge speak the ABI in the matrix", () => {
  assert.ok(Number.isInteger(matrix.bridgeAbi) && matrix.bridgeAbi >= 1);
  assert.equal(Number(constant(platformRuntime, /^const BRIDGE_ABI_VERSION = (\d+);$/m, "BRIDGE_ABI_VERSION")), matrix.bridgeAbi);
  assert.equal(Number(constant(lua, /^M\.ABI = (\d+)$/m, "M.ABI in minigame.lua")), matrix.bridgeAbi);
});

test("the runtime and manifest schemas match the matrix", () => {
  assert.equal(Number(constant(platformRuntime, /^const RUNTIME_SCHEMA_VERSION = (\d+);$/m, "RUNTIME_SCHEMA_VERSION")), matrix.runtimeSchema);
  assert.equal(MANIFEST_SCHEMA, matrix.outputManifestSchema);
});

test("every platform has a contract, a runtime entry, and the same values in the exporter", () => {
  assert.deepEqual(Object.keys(matrix.platformContracts).sort(), [...PLATFORM_NAMES].sort());
  for (const name of PLATFORM_NAMES) {
    const contract = matrix.platformContracts[name];
    for (const field of ["displayName", "apiNamespace", "nativeWebAssembly", "subpackageField", "devtool", "supportTier"]) {
      assert.equal(typeof contract[field], "string", `${name}.${field}`);
    }
    const limits = contract.packageLimitsBytes;
    assert.ok(Number.isInteger(limits.main) && Number.isInteger(limits.total) && limits.main <= limits.total, `${name} limits`);
    assert.ok(["fs", "storage", "memory"].includes(contract.defaults.persistence), `${name} persistence`);
    assert.equal(typeof contract.defaults.engineAudio, "boolean", `${name} engineAudio`);

    const platform = getPlatform(name);
    assert.equal(platform.apiNamespace, contract.apiNamespace);
    assert.equal(platform.subpackageField, contract.subpackageField);
    assert.deepEqual(platform.limits, limits);
    assert.deepEqual(platform.defaults, contract.defaults);

    for (const file of ["game.js", "game.json.template", "project.config.json.template"]) {
      assert.ok(existsSync(join(REPO_ROOT, "runtime", name, file)), `runtime/${name}/${file}`);
    }
    // The subpackage key is spelled differently per platform; the template must use the matrix's spelling.
    const template = read(`runtime/${name}/game.json.template`);
    assert.ok(template.includes(`"${contract.subpackageField}"`), `runtime/${name}/game.json.template uses ${contract.subpackageField}`);
    const other = contract.subpackageField === "subpackages" ? "subPackages" : "subpackages";
    assert.ok(!template.includes(`"${other}"`), `runtime/${name}/game.json.template must not use ${other}`);
    assert.ok(platformRuntime.includes(contract.nativeWebAssembly), `platform_runtime.js knows ${contract.nativeWebAssembly}`);
  }
});

test("validation levels use the agreed words, and a tier is not ahead of its evidence", () => {
  for (const [name, contract] of Object.entries(matrix.platformContracts)) {
    assert.deepEqual(Object.keys(contract.validation).sort(), ["devtoolCompile", "exportSmoke", "realDevice", "simulatedHost"], name);
    for (const [level, value] of Object.entries(contract.validation)) {
      assert.ok(["automated", "verified", "not-run"].includes(value), `${name}.${level} = ${value}`);
    }
    assert.ok(["experimental", "supported"].includes(contract.supportTier), `${name}.supportTier`);
    if (contract.supportTier !== "experimental") {
      assert.equal(contract.validation.devtoolCompile, "verified", `${name} is ${contract.supportTier} without a developer-tool run`);
      assert.equal(contract.validation.realDevice, "verified", `${name} is ${contract.supportTier} without a device run`);
    }
  }
  for (const engine of matrix.engines) {
    assert.deepEqual(
      Object.keys(engine.validation).sort(),
      ["devtool", "realDevice", "simulatedHost", "staticContract", "wasmFeatureScan"],
      engine.defoldVersion,
    );
    for (const [level, value] of Object.entries(engine.validation)) {
      assert.ok(["verified", "not-run"].includes(value), `${engine.defoldVersion}.${level} = ${value}`);
    }
  }
});

test("no listed engine needs a custom build", () => {
  assert.equal(matrix.requiresCustomEngineBuild, false);
  for (const engine of matrix.engines) {
    assert.deepEqual(engine.wasm.blockingFeatures, [], engine.defoldVersion);
    for (const feature of engine.wasm.features) {
      assert.ok(!BLOCKING_FEATURES.includes(feature), `${engine.defoldVersion} lists the blocking feature ${feature}`);
    }
    assert.equal(engine.architecture, "wasm-web");
  }
});

test("every engine in the matrix has its real loader vendored for the host tests, and the reverse", () => {
  const versions = matrix.engines.map((engine) => engine.defoldVersion);
  assert.equal(new Set(versions).size, versions.length, "a Defold version is listed twice");
  assert.deepEqual([...versions].sort(), Object.keys(DEFOLD_RELEASES).sort());

  for (const engine of matrix.engines) {
    const release = DEFOLD_RELEASES[engine.defoldVersion];
    assert.match(engine.engineSha1, /^[0-9a-f]{40}$/);
    assert.equal(release.sdkSha1, engine.engineSha1, `${engine.defoldVersion}: sha1 in test/helpers/bundle_fixture.mjs`);
    assert.equal(release.loaderGeneration, engine.loaderGeneration, `${engine.defoldVersion}: loader generation in the fixtures`);
    assert.ok(engine.loaderGeneration in LOADER_GENERATIONS, `${engine.defoldVersion}: unknown loader generation`);
    assert.ok(existsSync(join(FIXTURES, `defold-${engine.defoldVersion}`, "dmloader.template.js")));
    // What the matrix says about the loader is what the exporter detects in the real file.
    assert.equal(detectLoaderGeneration(readLoaderTemplate(engine.defoldVersion)), engine.loaderGeneration);
    assert.match(engine.analysedOn, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test("the READMEs state what the matrix states", () => {
  const functions = readLuaApi().count;
  for (const file of READMES) {
    const text = read(file);
    const lines = text.split("\n");
    for (const engine of matrix.engines) {
      const row = lines.find((line) => line.startsWith("|") && line.includes(`\`${engine.defoldVersion}\``));
      assert.ok(row, `${file}: no table row for Defold ${engine.defoldVersion}`);
      assert.ok(row.includes(`\`${engine.engineSha1.slice(0, 12)}\``), `${file}: engine sha1 of ${engine.defoldVersion}`);
      // One mark for the static check, three open boxes for the levels that have not been run.
      const done = ["staticContract", "wasmFeatureScan"].every((level) => engine.validation[level] === "verified");
      const open = ["simulatedHost", "devtool", "realDevice"].filter((level) => engine.validation[level] !== "verified").length;
      assert.equal((row.match(/✅/g) || []).length, (done ? 1 : 0) + (3 - open), `${file}: ticks for ${engine.defoldVersion}`);
      assert.equal((row.match(/⬜/g) || []).length, (done ? 0 : 1) + open, `${file}: open boxes for ${engine.defoldVersion}`);
    }
    for (const contract of Object.values(matrix.platformContracts)) {
      const row = lines.find((line) => line.startsWith("|") && line.includes(`| \`${contract.apiNamespace}\` |`));
      assert.ok(row, `${file}: no table row for ${contract.apiNamespace}`);
      assert.ok(row.includes(`\`${contract.subpackageField}\``), `${file}: subpackage field of ${contract.apiNamespace}`);
      assert.ok(row.includes(`${contract.packageLimitsBytes.total / 1048576} MB`), `${file}: total limit of ${contract.apiNamespace}`);
      if (contract.minimumClientVersion) assert.ok(row.includes(contract.minimumClientVersion), `${file}: minimum client version`);
      if (contract.supportTier === "experimental") assert.ok(row.includes("🧪"), `${file}: ${contract.apiNamespace} is experimental`);
    }
    assert.ok(new RegExp(`\\b${functions} (SDK functions|个 SDK 函数)`).test(text), `${file}: the SDK has ${functions} functions`);
  }
});

test("every document that counts the SDK functions has the right number", () => {
  const functions = readLuaApi().count;
  let found = 0;
  for (const file of DOCUMENTS) {
    for (const match of read(file).matchAll(/(\d+) (?:SDK functions|functions\b|个 SDK 函数|个函数)/g)) {
      // Counts of other things ("225 个方法") use other words and are not matched.
      assert.equal(Number(match[1]), functions, `${file}: "${match[0]}"`);
      found += 1;
    }
  }
  assert.ok(found >= 6, `expected the count in the READMEs, quick starts, and API references; found ${found}`);
});

test("the documents point at the repository named in package.json", () => {
  assert.equal(pkg.repository.type, "git");
  const repository = pkg.repository.url.replace(/\.git$/, "");
  assert.match(repository, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  const others = new Set(["https://github.com/AnranS/godot_for_minigame", "https://github.com/defold/defold"]);
  let own = 0;
  for (const file of DOCUMENTS) {
    for (const [address] of read(file).matchAll(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+/g)) {
      const bare = address.replace(/\.git$/, "");
      if (bare === repository) own += 1;
      else assert.ok(others.has(bare), `${file}: ${address} is neither this repository nor a known reference`);
    }
  }
  assert.ok(own >= 4, "the quick starts and READMEs tell the reader where to clone from");
});

test("the API reference is generated from the Lua module and is current", () => {
  assert.equal(read("docs/API.md"), renderApi("en"), "docs/API.md is stale; run node scripts/generate_api_docs.mjs");
  assert.equal(read("docs/API_zh.md"), renderApi("zh"), "docs/API_zh.md is stale; run node scripts/generate_api_docs.mjs");

  const api = readLuaApi();
  const zh = JSON.parse(read("scripts/lib/api_zh.json"));
  const names = api.groups.flatMap((group) => group.functions.map((record) => record.name));
  assert.deepEqual(Object.keys(zh.functions).sort(), [...names].sort(), "scripts/lib/api_zh.json: one description per function");
  assert.deepEqual(Object.keys(zh.methods).sort(), api.methods.map((record) => record.name).sort());
  for (const group of api.groups) assert.ok(zh.groups[group.title], `scripts/lib/api_zh.json: no translation for the group "${group.title}"`);
  for (const record of [...api.groups.flatMap((group) => group.functions), ...api.methods]) {
    assert.ok(record.description.length > 0, `${record.signature} has no doc comment`);
  }
});

test("the package ships what it lists and depends on nothing", () => {
  assert.ok(existsSync(join(REPO_ROOT, pkg.bin["defold-minigame"])));
  for (const entry of pkg.files) assert.ok(existsSync(join(REPO_ROOT, entry)), `package.json files: ${entry}`);
  assert.equal(pkg.dependencies, undefined, "the exporter has no npm dependencies");
  assert.equal(pkg.devDependencies, undefined, "the tests and the site have no npm dependencies");
  assert.equal(pkg.engines.node, ">=20");
});
