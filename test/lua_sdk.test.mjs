import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";

import { REPO_ROOT } from "../src/util.mjs";
import { runtimeRealm } from "./helpers/runtime_realm.mjs";
import { makeWorkspace } from "./helpers/workspace.mjs";

// Defold runs Lua 5.1 semantics (LuaJIT on most platforms), so LuaJIT is the
// faithful interpreter for the SDK. Without it these tests are skipped.
const LUAJIT = ["luajit", "lua5.1", "lua"].find((name) => spawnSync(name, ["-v"]).status === 0) || null;
const skip = LUAJIT ? false : "no LuaJIT or Lua 5.1 interpreter is installed";

/**
 * Runs a Lua scenario. In "bridge" mode every html5.run() call is answered by
 * `answer(code)`; a negative sleep asks the test to act on the host.
 */
function runLua({ mode, scenario, answer, onSignal, env = {} }) {
  return new Promise((resolve, reject) => {
    const child = spawn(LUAJIT, [join("test", "lua", "harness.lua"), mode, join("test", "lua", scenario)], {
      cwd: REPO_ROOT, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"],
    });
    const logs = [];
    let stderr = "";
    let results = null;
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const reply = (line) => child.stdin.write(`${line}\n`);
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.startsWith(">")) {
        try {
          reply(`ok ${answer(line.slice(1))}`);
        } catch (error) {
          reply(`err ${String(error.message).replace(/\n/g, " ")}`);
        }
      } else if (line.startsWith("~")) {
        const millis = Number(line.slice(1));
        if (millis < 0) { onSignal(); reply("done"); } else setTimeout(() => reply("done"), millis);
      } else if (line.startsWith("# ")) {
        logs.push(line.slice(2));
      } else if (line.startsWith("DONE ")) {
        results = JSON.parse(line.slice(5));
      }
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 || results === null) {
        reject(new Error(`luajit exited with ${code}: ${stderr || "(no output)"}`));
        return;
      }
      resolve({ results: Array.isArray(results) ? results : [], logs });
    });
  });
}

function assertAllPassed(results, minimum) {
  const failed = results.filter((result) => !result.ok).map((result) => `${result.name}: ${result.detail}`);
  assert.deepEqual(failed, []);
  assert.ok(results.length >= minimum, `expected at least ${minimum} checks, ran ${results.length}`);
}

for (const platform of ["wechat", "douyin", "tiktok"]) {
  test(`minigame.lua drives the real bridge in a simulated ${platform} host`, { skip }, async (t) => {
    // This realm loads single runtime modules, not an exported package, so
    // the subpackage the scenario asks for is answered by a stand-in.
    const host = runtimeRealm(t, platform, {
      extendApi(api) {
        api.loadSubpackage = (options) => {
          const listeners = [];
          // In the engine, Lua registers its progress listener in the same
          // call that starts the download. Here each bridge command crosses a
          // pipe, so the stand-in waits for the listener before it reports.
          const started = Date.now();
          const report = () => {
            if (listeners.length === 0 && Date.now() - started < 2000) { setTimeout(report, 2); return; }
            for (const progress of [50, 100]) listeners.forEach((listener) => listener({ progress }));
            options.success({ errMsg: "loadSubpackage:ok" });
          };
          setTimeout(report, 2);
          return { onProgressUpdate(listener) { listeners.push(listener); } };
        };
      },
    });
    const { createBridge } = host.require("js/bridge.js");
    const { PlatformRuntime } = host.require("js/platform_runtime.js");
    const bridge = createBridge(PlatformRuntime, { toolVersion: "test", engineAudio: true, persistence: "fs", pixelRatio: 1 });

    const { results, logs } = await runLua({
      mode: "bridge",
      scenario: "scenario_host.lua",
      env: { EXPECTED_PLATFORM: platform },
      answer: (code) => bridge.run(code),
      onSignal: () => { host.hide(); host.show(); },
    });
    assertAllPassed(results, 56);
    assert.ok(host.warnings().some((line) => /\[DefoldMiniGame\]\[lua\] \[minigame\] callback failed: .*boom/.test(line)),
      "a failing callback is logged in the host console, where a release build can show it");
    assert.ok(!logs.some((line) => /callback failed/.test(line)), "and not printed a second time");
    assert.equal(host.crashed, null);
    assert.equal({ ...host.state.shareHandler() }.title, "Play with me");
    assert.equal(host.state.clipboard, "copied text");
    assert.equal(bridge.pending, 0, "the queue is drained");
  });
}

for (const platform of ["wechat", "douyin", "tiktok"]) {
  test(`the API test app's list runs against the bridge in a simulated ${platform} host`, { skip }, async (t) => {
    const host = runtimeRealm(t, platform, {
      extendApi(api) {
        // The app loads the subpackage the engine already came in; the host answers at once.
        api.loadSubpackage = (options) => {
          setTimeout(() => options.success({ errMsg: "loadSubpackage:ok" }), 2);
          return { onProgressUpdate() {} };
        };
      },
    });
    const { createBridge } = host.require("js/bridge.js");
    const { PlatformRuntime } = host.require("js/platform_runtime.js");
    const bridge = createBridge(PlatformRuntime, { toolVersion: "test", engineAudio: platform !== "tiktok", persistence: "fs", pixelRatio: 1 });
    const { results, logs } = await runLua({
      mode: "bridge",
      scenario: "scenario_apitest.lua",
      answer: (code) => bridge.run(code),
      onSignal: () => {},
    });
    assertAllPassed(results, 100);
    assert.ok(logs.some((line) => /^apitest pass=\d+ skip=\d+ info=\d+ fail=0$/.test(line)), logs.filter((line) => line.startsWith("apitest")).join("; "));
    // This bridge was not told about any subpackage of the game, so the app does not ask for one.
    assert.ok(logs.includes("skip subpackage_load exported without --subpackage extras=example/extras"), logs.join("\n"));
    assert.equal(host.crashed, null, "no test touches an API that ends the client");
  });
}

for (const platform of ["wechat", "douyin", "tiktok"]) {
  test(`the API test app loads and reads its extras subpackage in an exported ${platform} package`, { skip }, async (t) => {
    // The whole way: the folder goes through the exporter, the package boots
    // in the simulated host, and the app's tests talk to the loader's bridge.
    const workspace = makeWorkspace(t);
    const host = await workspace.run(platform, {
      exportOptions: {
        assetsDir: join(REPO_ROOT, "example", "assets"),
        subpackages: [{ name: "extras", dir: join(REPO_ROOT, "example", "extras") }],
      },
    });
    assert.deepEqual(host.calls.get("loadSubpackage"), [["engine"]], "starting the game leaves the extras where they are");

    const { results, logs } = await runLua({
      mode: "bridge",
      scenario: "scenario_apitest.lua",
      answer: (code) => host.bridge.run(code),
      onSignal: () => {},
    });
    assertAllPassed(results, 100);
    assert.ok(logs.some((line) => /^pass subpackage_load loaded 'extras', progress reached 100%$/.test(line)), logs.join("\n"));
    assert.ok(logs.includes(platform === "tiktok"
      ? "skip subpackage_read the host has no getFileSystemManager"
      : "pass subpackage_read read extras/note.txt: loaded from the extras subpackage"), logs.join("\n"));
    assert.ok(host.calls.get("loadSubpackage").some(([name]) => name === "extras"));
    assert.equal(host.crashed, null);
  });
}

test("two Lua states share one bridge without taking each other's results", { skip }, async (t) => {
  // Defold runs game object scripts and GUI scripts in separate Lua states by
  // default. Both poll the same bridge, so results have to find their owner.
  const host = runtimeRealm(t, "wechat");
  const { createBridge } = host.require("js/bridge.js");
  const { PlatformRuntime } = host.require("js/platform_runtime.js");
  const bridge = createBridge(PlatformRuntime, { toolVersion: "test", engineAudio: true, persistence: "fs", pixelRatio: 1 });
  const { results } = await runLua({
    mode: "bridge",
    scenario: "scenario_two_states.lua",
    answer: (code) => bridge.run(code),
    onSignal: () => { host.hide(); host.show(); },
  });
  assertAllPassed(results, 23);
  assert.equal(host.crashed, null);
});

test("every SDK call is safe on a platform without html5", { skip }, async () => {
  const { results } = await runLua({ mode: "native", scenario: "scenario_nohost.lua" });
  assertAllPassed(results, 30);
});

test("every SDK call is safe in a plain HTML5 build without the bridge", { skip }, async () => {
  const { results } = await runLua({ mode: "browser", scenario: "scenario_nohost.lua" });
  assertAllPassed(results, 30);
});

test("an ABI mismatch disables the SDK and explains why", { skip }, async (t) => {
  const host = runtimeRealm(t, "wechat");
  const { createBridge, HANDSHAKE_EXPRESSION } = host.require("js/bridge.js");
  const { PlatformRuntime } = host.require("js/platform_runtime.js");
  const bridge = createBridge(PlatformRuntime, {});
  const { results, logs } = await runLua({
    mode: "bridge",
    scenario: "scenario_nohost.lua",
    answer: (code) => {
      if (code !== HANDSHAKE_EXPRESSION) throw new Error("no command may be sent after a failed handshake");
      return JSON.stringify({ ...JSON.parse(bridge.run(code)), abi: 2 });
    },
  });
  assertAllPassed(results, 30);
  assert.ok(logs.some((line) => /bridge ABI 2 does not match this module's ABI 1/.test(line)));
});

test("the Lua module and the runtime agree on the handshake and the ABI", async (t) => {
  const { readFileSync } = await import("node:fs");
  const lua = readFileSync(join(REPO_ROOT, "minigame", "minigame.lua"), "utf8");
  const host = runtimeRealm(t, "wechat");
  const { HANDSHAKE_EXPRESSION, BRIDGE_BRAND } = host.require("js/bridge.js");
  const { BRIDGE_ABI_VERSION } = host.require("js/platform_runtime.js");
  assert.ok(lua.includes(`local HANDSHAKE = "${HANDSHAKE_EXPRESSION}"`));
  assert.ok(lua.includes(`local BRAND = "${BRIDGE_BRAND}"`));
  assert.match(lua, new RegExp(`\\nM\\.ABI = ${BRIDGE_ABI_VERSION}\\n`));
});
