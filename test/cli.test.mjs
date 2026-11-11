import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { bobArguments, buildBundle, locateBundle } from "../src/bob.mjs";
import { main, parseArguments } from "../src/cli.mjs";
import { REPO_ROOT, loadSupportMatrix } from "../src/util.mjs";
import { DEFOLD_VERSION, makeBundle } from "./helpers/bundle_fixture.mjs";
import { APP_ID, makeWorkspace } from "./helpers/workspace.mjs";

function run(argv) {
  const out = [];
  const err = [];
  const code = main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("parses flags, values, inline values, and repeatable options", () => {
  const { positional, options } = parseArguments([
    "export", "--bundle", "b", "--platform=wechat", "--engine-arg", "--a", "--engine-arg=--b", "--no-brotli",
  ]);
  assert.deepEqual(positional, ["export"]);
  assert.equal(options["--bundle"], "b");
  assert.equal(options["--platform"], "wechat");
  assert.deepEqual(options["--engine-arg"], ["--a", "--b"]);
  assert.deepEqual(
    parseArguments(["export", "--subpackage", "levels=res/levels", "--subpackage=voices=/abs/a=b"]).options["--subpackage"],
    ["levels=res/levels", "voices=/abs/a=b"],
  );
  assert.equal(options["--no-brotli"], true);
  assert.throws(() => parseArguments(["--nope"]), /unknown option --nope/);
  assert.throws(() => parseArguments(["--bundle"]), /--bundle needs a value/);
});

test("prints the version from the support matrix and the help text", () => {
  assert.deepEqual(run(["--version"]), { code: 0, out: loadSupportMatrix().toolVersion, err: "" });
  const help = run(["--help"]);
  assert.equal(help.code, 0);
  for (const word of ["export", "build", "inspect", "--platform", "wechat | douyin | tiktok", "--appid"]) {
    assert.ok(help.out.includes(word), word);
  }
  assert.equal(run([]).code, 2);
});

test("export writes a project and prints the sizes and next steps", (t) => {
  const workspace = makeWorkspace(t);
  const result = run(["export", "--bundle", workspace.bundleDir, "--platform", "wechat", "--appid", APP_ID,
    "--output", workspace.outputDir("wechat"), "--brotli-quality", "4"]);
  assert.equal(result.code, 0, result.err);
  assert.ok(result.out.includes(`Exported HelloMiniGame (Defold ${DEFOLD_VERSION}) for WeChat Mini Game`));
  assert.match(result.out, /main package\s+\d/);
  assert.match(result.out, /html5\.run\s+bridged to the minigame Lua module/);
  assert.match(result.out, /Open .* in WeChat DevTools/);
  // What is said about validation follows the support matrix, platform by platform.
  const verified = loadSupportMatrix().platformContracts.wechat.validation.devtoolCompile === "verified";
  assert.match(result.out, verified ? /have run in the simulator of WeChat DevTools, and on no phone yet/ : /simulated host only/);
  assert.ok(existsSync(join(workspace.outputDir("wechat"), "game.json")));
});

test("--subpackage name=dir adds a subpackage and the summary lists it", (t) => {
  const workspace = makeWorkspace(t);
  const levels = join(workspace.root, "my levels=1");
  mkdirSync(levels);
  writeFileSync(join(levels, "map.json"), "{}");
  const base = ["export", "--bundle", workspace.bundleDir, "--platform", "douyin", "--appid", APP_ID,
    "--output", workspace.outputDir("douyin"), "--brotli-quality", "4"];

  const result = run([...base, "--subpackage", `levels=${levels}`]);
  assert.equal(result.code, 0, result.err);
  // The name ends at the first "="; the rest is the folder, whatever it contains.
  assert.match(result.out, /subpackage\s+levels\s+\d+ B in 2 files/);
  assert.ok(existsSync(join(workspace.outputDir("douyin"), "levels/map.json")));
  const game = JSON.parse(readFileSync(join(workspace.outputDir("douyin"), "game.json"), "utf8"));
  assert.deepEqual(game.subPackages.map((entry) => entry.name), ["engine", "levels"]);

  const json = run([...base, "--subpackage", `levels=${levels}`, "--json"]);
  assert.equal(JSON.parse(json.out).sizes.subpackages.levels > 0, true);

  for (const value of ["levels", "=dir", "levels="]) {
    const wrong = run([...base, "--subpackage", value]);
    assert.equal(wrong.code, 2, value);
    assert.match(wrong.err, /--subpackage expects <name>=<dir>/);
  }
  const reserved = run([...base, "--subpackage", `engine=${levels}`]);
  assert.equal(reserved.code, 1);
  assert.match(reserved.err, /used by the export itself/);
  assert.ok(run(["--help"]).out.includes("--subpackage <name>=<dir>"));
});

test("TikTok next steps name ttmg, and --json prints machine-readable output", (t) => {
  const workspace = makeWorkspace(t);
  const text = run(["export", "--bundle", workspace.bundleDir, "--platform", "tiktok", "--appid", "client-key",
    "--output", workspace.outputDir("tiktok"), "--brotli-quality", "4"]);
  assert.match(text.out, /ttmg init/);
  assert.match(text.out, /simulated host only/);
  const json = run(["export", "--bundle", workspace.bundleDir, "--platform", "douyin", "--appid", "tt1",
    "--output", workspace.outputDir("douyin"), "--brotli-quality", "4", "--json"]);
  const parsed = JSON.parse(json.out);
  assert.equal(parsed.platform, "douyin");
  assert.equal(parsed.report.engineModule.evalSites, 1);
});

test("export errors are reported with a hint and exit code 1; usage errors with 2", (t) => {
  const workspace = makeWorkspace(t);
  const missing = run(["export", "--bundle", workspace.bundleDir, "--platform", "wechat", "--output", workspace.outputDir("w")]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /error: an App ID is required/);
  assert.match(missing.err, /hint: /);
  assert.equal(run(["export", "--platform", "wechat"]).code, 2);
  assert.equal(run(["frobnicate"]).code, 2);
  assert.equal(run(["inspect"]).code, 2);
});

test("inspect describes a bundle and writes nothing", (t) => {
  const workspace = makeWorkspace(t);
  const result = run(["inspect", "--bundle", workspace.bundleDir]);
  assert.equal(result.code, 0);
  assert.match(result.out, /Executable\s+HelloMiniGame/);
  assert.match(result.out, /Support matrix\s+listed/);
  assert.match(result.out, /Result\s+exportable/);
  const json = JSON.parse(run(["inspect", "--bundle", workspace.bundleDir, "--json"]).out);
  assert.equal(json.policy.ok, true);
  assert.equal(json.inSupportMatrix, true);
});

test("the executable entry point works as a process", () => {
  const result = spawnSync(process.execPath, [join(REPO_ROOT, "bin", "defold-minigame.mjs"), "--version"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), loadSupportMatrix().toolVersion);
});

test("bob arguments request a single-threaded release HTML5 bundle", () => {
  const args = bobArguments({ bobJar: "/x/bob.jar", projectDir: "/p", bundleOutput: "/o", extraArguments: ["--verbose"] });
  assert.deepEqual(args, ["-jar", "/x/bob.jar", "--root", "/p", "--archive", "--platform", "wasm-web",
    "--architectures", "wasm-web", "--variant", "release", "--bundle-output", "/o", "--verbose", "resolve", "build", "bundle"]);
});

test("build runs bob.jar, finds the bundle it wrote, and exports it", (t) => {
  const workspace = makeWorkspace(t);
  const project = join(workspace.root, "project");
  mkdirSync(project);
  writeFileSync(join(project, "game.project"), "[project]\ntitle = Hello\n");
  const jar = join(workspace.root, "bob.jar");
  writeFileSync(jar, "not a real jar");

  const seen = [];
  const bundleDir = buildBundle({
    projectDir: project, bobJar: jar, bundleOutput: join(workspace.root, "bob-out"), java: "/opt/java",
    spawn(command, args, options) {
      seen.push({ command, args, cwd: options.cwd });
      // bob writes <bundle-output>/<Project Title>/
      makeBundle({ directory: join(args[args.indexOf("--bundle-output") + 1], "Hello") });
      return { status: 0 };
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].command, "/opt/java");
  assert.equal(seen[0].cwd, project);
  assert.equal(bundleDir, join(workspace.root, "bob-out", "Hello"));
  assert.equal(locateBundle(bundleDir), bundleDir);
});

test("build reports a missing project, a missing jar, and a failing bob", (t) => {
  const workspace = makeWorkspace(t);
  const project = join(workspace.root, "project");
  mkdirSync(project);
  const jar = join(workspace.root, "bob.jar");
  const output = join(workspace.root, "bob-out");
  assert.throws(() => buildBundle({ projectDir: project, bobJar: jar, bundleOutput: output }), /no game\.project/);
  writeFileSync(join(project, "game.project"), "[project]\n");
  assert.throws(() => buildBundle({ projectDir: project, bobJar: jar, bundleOutput: output }), /bob\.jar was not found/);
  writeFileSync(jar, "");
  assert.throws(() => buildBundle({ projectDir: project, bobJar: jar, bundleOutput: output, spawn: () => ({ status: 3 }) }),
    /bob\.jar exited with status 3/);
  assert.throws(() => buildBundle({ projectDir: project, bobJar: jar, bundleOutput: output, spawn: () => ({ error: new Error("ENOENT") }) }),
    /could not start java/);
  assert.throws(() => buildBundle({ projectDir: project, bobJar: jar, bundleOutput: output, spawn: () => ({ status: 0 }) }),
    /no HTML5 bundle was found/);
});

test("the build command goes from a project folder to an exported package", (t) => {
  const workspace = makeWorkspace(t);
  const project = join(workspace.root, "project");
  mkdirSync(project);
  writeFileSync(join(project, "game.project"), "[project]\ntitle = Hello\n");
  const jar = join(workspace.root, "bob.jar");
  writeFileSync(jar, "");
  // A stand-in for `java`: copies a prepared bundle to where bob would write it.
  const prepared = makeBundle({ directory: join(workspace.root, "prepared", "Hello") });
  const fakeJava = join(workspace.root, "fake-java.sh");
  writeFileSync(fakeJava, [
    "#!/bin/sh",
    "out=\"\"",
    "while [ $# -gt 0 ]; do",
    "  if [ \"$1\" = \"--bundle-output\" ]; then out=\"$2\"; fi",
    "  shift",
    "done",
    `mkdir -p "$out" && cp -R "${join(workspace.root, "prepared", "Hello")}" "$out/Hello"`,
    "",
  ].join("\n"));
  chmodSync(fakeJava, 0o755);

  const result = run(["build", "--project", project, "--bob", jar, "--java", fakeJava, "--platform", "wechat",
    "--appid", APP_ID, "--output", workspace.outputDir("wechat"), "--brotli-quality", "4"]);
  assert.equal(result.code, 0, result.err);
  assert.match(result.err, /running: .*fake-java\.sh -jar/);
  assert.match(result.out, /Exported HelloMiniGame/);
  assert.equal(JSON.parse(readFileSync(join(workspace.outputDir("wechat"), "project.config.json"), "utf8")).appid, APP_ID);
  assert.ok(prepared.directory);
});
