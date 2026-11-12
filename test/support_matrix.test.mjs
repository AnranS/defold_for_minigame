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
  // What an AI coding agent reads instead of the documents; test/skill.test.mjs covers the rest of it.
  "skills/defold-minigame/SKILL.md",
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

test("the documents install the released version, not whatever main holds", () => {
  // The Lua module and the runtime an export writes speak one bridge ABI, so
  // both come from the same tag. A version bump has to move these addresses.
  const tag = `v${matrix.toolVersion}`;
  const repository = pkg.repository.url.replace(/\.git$/, "");
  const library = `${repository}/archive/refs/tags/${tag}.zip`;
  const clone = `git clone --branch ${tag} --depth 1 ${repository}.git`;

  for (const file of [...READMES, "docs/QUICK_START.md", "docs/QUICK_START_zh.md", "docs/USAGE.md", "docs/USAGE_zh.md"]) {
    assert.ok(read(file).includes(library), `${file} does not give the library address of ${tag}`);
  }
  for (const file of [...READMES, "docs/QUICK_START.md", "docs/QUICK_START_zh.md"]) {
    assert.ok(read(file).includes(clone), `${file} does not clone ${tag}`);
  }
  for (const file of DOCUMENTS) {
    const text = read(file);
    for (const match of text.matchAll(/archive\/refs\/tags\/(v[0-9.]+)\.zip|git clone --branch (v[0-9.]+)/g)) {
      assert.equal(match[1] || match[2], tag, `${file} names another version: ${match[0]}`);
    }
    // The moving address is only ever offered beside the pinned one.
    if (text.includes("refs/heads/main")) assert.ok(text.includes(library), `${file} offers main without the released version`);
    for (const line of text.split("\n")) {
      if (/git clone(?! --branch)/.test(line) && line.includes(repository)) assert.fail(`${file} clones without a version: ${line.trim()}`);
    }
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
      ["devtool", "realDevice", "staticContract", "wasmFeatureScan"],
      engine.defoldVersion,
    );
    for (const level of ["staticContract", "wasmFeatureScan"]) {
      assert.ok(["verified", "not-run"].includes(engine.validation[level]), `${engine.defoldVersion}.${level}`);
    }
    // A developer tool and a device are a platform's: each level is kept per platform.
    for (const level of ["devtool", "realDevice"]) {
      assert.deepEqual(Object.keys(engine.validation[level]).sort(), [...PLATFORM_NAMES].sort(), `${engine.defoldVersion}.${level}`);
      for (const [name, value] of Object.entries(engine.validation[level])) {
        assert.ok(["verified", "not-run"].includes(value), `${engine.defoldVersion}.${level}.${name} = ${value}`);
      }
    }
  }
});

test("every claim of a run in a host has a recorded run, and the reverse", () => {
  assert.ok(Array.isArray(matrix.hostRuns));
  const versions = new Set(matrix.engines.map((engine) => engine.defoldVersion));
  for (const run of matrix.hostRuns) {
    assert.match(run.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(PLATFORM_NAMES.includes(run.platform), `host run on an unknown platform ${run.platform}`);
    assert.match(run.engineSha1, /^[0-9a-f]{40}$/);
    assert.ok(["stable", "beta", "alpha"].includes(run.channel));
    for (const field of ["host", "defoldVersion", "bundle", "result"]) assert.ok(String(run[field]).length > 3, `host run ${field}`);
    assert.ok(Array.isArray(run.checks) && run.checks.length > 0);
    assert.ok(run.zh && run.zh.bundle && run.zh.result, "a host run is described in Chinese as well");
    // A run on phones names the systems it ran on.
    if (run.devices !== undefined) {
      assert.ok(Array.isArray(run.devices) && run.devices.length > 0, "devices lists the phone systems of a run");
      for (const system of run.devices) assert.ok(["iOS", "Android"].includes(system), `unknown phone system ${system}`);
    }
    if (run.channel === "stable") {
      assert.ok(versions.has(run.defoldVersion), `a stable run of Defold ${run.defoldVersion}, which the matrix does not list`);
      const engine = matrix.engines.find((entry) => entry.defoldVersion === run.defoldVersion);
      assert.equal(engine.engineSha1, run.engineSha1);
      assert.equal(engine.validation.devtool[run.platform], "verified", `${run.defoldVersion} ran in the ${run.platform} tool`);
    }
  }
  // Nothing is "verified" on the strength of a claim alone.
  const ran = (version, platform) => matrix.hostRuns.some((run) => run.defoldVersion === version && run.platform === platform && run.channel === "stable");
  for (const engine of matrix.engines) {
    for (const [platform, value] of Object.entries(engine.validation.devtool)) {
      if (value === "verified") assert.ok(ran(engine.defoldVersion, platform), `${engine.defoldVersion} claims the ${platform} tool without a recorded run`);
    }
  }
  // A device is claimed exactly where a recorded run names an iOS and an Android phone.
  const onPhones = (version, platform) => matrix.hostRuns.some((run) => run.defoldVersion === version && run.platform === platform
    && run.channel === "stable" && ["iOS", "Android"].every((system) => (run.devices || []).includes(system)));
  for (const engine of matrix.engines) {
    for (const [platform, value] of Object.entries(engine.validation.realDevice)) {
      assert.equal(value === "verified", onPhones(engine.defoldVersion, platform), `${engine.defoldVersion}: realDevice.${platform} and the recorded runs disagree`);
    }
  }
  for (const [name, contract] of Object.entries(matrix.platformContracts)) {
    const anywhere = matrix.hostRuns.some((run) => run.platform === name);
    assert.equal(contract.validation.devtoolCompile === "verified", anywhere, `${name}: devtoolCompile and the recorded runs disagree`);
    const onDevice = matrix.engines.some((engine) => engine.validation.realDevice[name] === "verified");
    assert.equal(contract.validation.realDevice === "verified", onDevice, `${name}: realDevice and the engines disagree`);
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
  const SHORT = {
    "README.md": { wechat: "WeChat", douyin: "Douyin", tiktok: "TikTok" },
    "README_zh.md": { wechat: "微信", douyin: "抖音", tiktok: "TikTok" },
  };
  /** A level kept per platform is a tick, an open box, or a half mark that names where it holds. */
  const expectCell = (cell, level, names, what) => {
    const verified = Object.keys(level).filter((name) => level[name] === "verified");
    if (verified.length === Object.keys(level).length) {
      assert.ok(cell.startsWith("✅"), `${what}: expected a tick, found "${cell}"`);
    } else if (verified.length === 0) {
      assert.equal(cell, "⬜", what);
    } else {
      assert.ok(cell.startsWith("🟡"), `${what}: expected a half mark, found "${cell}"`);
      for (const name of Object.keys(level)) {
        assert.equal(cell.includes(names[name]), verified.includes(name), `${what}: ${names[name]} in "${cell}"`);
      }
    }
  };
  for (const file of READMES) {
    const text = read(file);
    const lines = text.split("\n");
    for (const engine of matrix.engines) {
      const row = lines.find((line) => line.startsWith("|") && line.includes(`\`${engine.defoldVersion}\``));
      assert.ok(row, `${file}: no table row for Defold ${engine.defoldVersion}`);
      const cells = row.split("|").map((cell) => cell.trim());
      assert.equal(cells.length, 8, `${file}: Defold, SHA1, loader, static check, developer tool, device`);
      assert.equal(cells[2], `\`${engine.engineSha1.slice(0, 12)}\``, `${file}: engine sha1 of ${engine.defoldVersion}`);
      const checked = ["staticContract", "wasmFeatureScan"].every((level) => engine.validation[level] === "verified");
      assert.equal(cells[4], checked ? "✅" : "⬜", `${file}: static check of ${engine.defoldVersion}`);
      expectCell(cells[5], engine.validation.devtool, SHORT[file], `${file}: developer tool for ${engine.defoldVersion}`);
      expectCell(cells[6], engine.validation.realDevice, SHORT[file], `${file}: device for ${engine.defoldVersion}`);
    }
    for (const contract of Object.values(matrix.platformContracts)) {
      const row = lines.find((line) => line.startsWith("|") && line.includes(`| \`${contract.apiNamespace}\` |`));
      assert.ok(row, `${file}: no table row for ${contract.apiNamespace}`);
      assert.ok(row.includes(`\`${contract.subpackageField}\``), `${file}: subpackage field of ${contract.apiNamespace}`);
      assert.ok(row.includes(`${contract.packageLimitsBytes.total / 1048576} MB`), `${file}: total limit of ${contract.apiNamespace}`);
      if (contract.minimumClientVersion) assert.ok(row.includes(contract.minimumClientVersion), `${file}: minimum client version`);
      if (contract.supportTier === "experimental") assert.ok(row.includes("🧪"), `${file}: ${contract.apiNamespace} is experimental`);
      // "Simulated hosts only" is said of exactly the platforms without a run in their tool.
      const onlySimulated = /simulated-host tests only|仅模拟宿主测试/.test(row);
      assert.equal(onlySimulated, contract.validation.devtoolCompile !== "verified", `${file}: status of ${contract.apiNamespace}`);
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

test("the API test app has a test for every function of the SDK", () => {
  const api = readLuaApi();
  const source = read("example/apitest.lua");
  const names = api.groups.flatMap((group) => group.functions.map((record) => record.name));
  const untested = names.filter((name) => !new RegExp(`minigame\\.${name}\\(`).test(source));
  assert.deepEqual(untested, [], "add a test to example/apitest.lua for each new SDK function");
});

test("the example project's files point at files that exist", () => {
  const project = read("game.project");
  assert.match(project, /^main_collection = \/example\/main\.collectionc$/m);
  assert.match(project, /^include_dirs = minigame$/m, "the repository is also the library a game depends on");
  for (const [file, pattern] of [
    ["example/main.collection", /prototype: "(\/[^"]+)"/g],
    ["example/apitest.go", /component: "(\/[^"]+)"/g],
    ["example/apitest.go", /sound: \\"(\/[^"\\]+)\\"/g],
    ["example/apitest.gui", /(?:script|font): "(\/example\/[^"]+)"/g],
  ]) {
    const references = [...read(file).matchAll(pattern)].map((match) => match[1]);
    assert.ok(references.length > 0, `${file}: no references found`);
    for (const reference of references) assert.ok(existsSync(join(REPO_ROOT, reference)), `${file} refers to ${reference}`);
  }
  // Folders that are not part of the Defold project are kept out of its build.
  for (const entry of read(".defignore").split("\n").filter(Boolean)) {
    assert.ok(entry.startsWith("/"), `.defignore: ${entry}`);
  }
  assert.ok(read(".defignore").includes("/test\n") && read(".defignore").includes("/website\n"));
});

test("no real App ID or client key is written into the repository", () => {
  // Examples and tests use one placeholder. A developer's own App ID belongs in
  // their command line, never in a file here: not in the test app, a document,
  // a test, or evidence copied from a developer tool.
  const PLACEHOLDER = "wx0123456789abcdef";
  const folders = ["bin", "demo", "docs", "example", "input", "minigame", "runtime", "scripts", "skills", "src", "test", "website", ".github", ".claude-plugin"];
  const files = ["README.md", "README_zh.md", "THIRD_PARTY_NOTICES.md", "game.project", "package.json", "support-matrix.json", ".defignore"];
  const walk = (directory) => readdirSync(join(REPO_ROOT, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    // Build products are not in the repository; an export made for trying the demo carries its maker's App ID.
    if (entry.isDirectory()) return ["dist", "node_modules", "output", "build", ".internal"].includes(entry.name) ? [] : walk(path);
    return /\.(png|wav|ico|ttf|mp4)$/.test(entry.name) ? [] : [path];
  });
  const found = [];
  for (const path of [...files, ...folders.flatMap(walk)]) {
    const text = read(path);
    // WeChat: wx + 16 hex; Douyin: tt + 16 hex; TikTok client keys: aw or sbaw + letters and digits.
    for (const [match] of text.matchAll(/\b(?:wx|tt)[0-9a-f]{16}\b|\b(?:sb)?aw[0-9a-z]{14,}\b/g)) {
      if (match !== PLACEHOLDER) found.push(`${path}: ${match}`);
    }
  }
  assert.deepEqual(found, []);
});

test("the package ships what it lists and depends on nothing", () => {
  assert.ok(existsSync(join(REPO_ROOT, pkg.bin["defold-minigame"])));
  for (const entry of pkg.files) assert.ok(existsSync(join(REPO_ROOT, entry)), `package.json files: ${entry}`);
  assert.equal(pkg.dependencies, undefined, "the exporter has no npm dependencies");
  assert.equal(pkg.devDependencies, undefined, "the tests and the site have no npm dependencies");
  assert.equal(pkg.engines.node, ">=20");
});
