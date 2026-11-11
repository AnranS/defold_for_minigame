import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { DEFOLD_RELEASES, DEFOLD_VERSIONS, PLATFORMS, makeWorkspace } from "./helpers/workspace.mjs";

const sum = (data) => data.reduce((total, byte) => (total + byte) >>> 0, 0);

for (const defoldVersion of DEFOLD_VERSIONS) for (const platform of PLATFORMS) {
  test(`boots the Defold ${defoldVersion} loader in a simulated ${platform} host`, async (t) => {
    const workspace = makeWorkspace(t, { archiveSize: 6000, defoldVersion });
    const host = await workspace.run(platform);
    const engine = host.engine;

    assert.equal(host.loader.state, "running");
    assert.equal(host.loader.loaderGeneration, DEFOLD_RELEASES[defoldVersion].loaderGeneration);
    assert.equal(engine.mainCalled, 1, "main() runs exactly once");
    assert.deepEqual([...engine.mainArgs], ["--verify-graphics-calls=false"], "the project's engine arguments are kept");
    assert.equal(engine.wasmResult, 41, "the binary was instantiated with the glue's imports");
    assert.deepEqual(host.calls.get("wasm.instantiate"), [["engine/dmengine.wasm.br"]]);
    assert.deepEqual(host.calls.get("loadSubpackage"), [["engine"]]);

    // The archive reaches the engine's file system byte for byte.
    assert.equal(engine.cwd, "/");
    for (const [name, data] of workspace.bundle.archive) {
      assert.deepEqual({ ...engine.archive[name] }, { size: data.length, sum: sum(data) }, name);
    }

    // The glue sees a browser, never Node.js or a module system.
    assert.equal(engine.env.web, true);
    assert.equal(engine.env.node, false);
    assert.equal(engine.env.worker, false);
    assert.equal(engine.env.hasRequire, false);
    assert.equal(engine.env.hasModuleObject, false);
    assert.equal(engine.env.hasFetch, false);
    assert.equal(engine.env.href, `https://${platform}.minigame.localhost/index.html`);
    assert.equal(engine.persistentRoot, "/data");
    assert.equal(engine.initialMemory, 268435456, "the project's heap size is kept by default");

    assert.deepEqual({ ...engine.gl }, {
      created: true, majorVersion: 2, iOSVersion: 16.5, isWebGL2: true, isWebGL1: false, stencil: true,
    });
    assert.equal(host.state.contextRequests.length, 1, "only the engine asks for a context");
    assert.equal(host.state.contextRequests[0].type, "webgl2");
    assert.equal(host.state.contextRequests[0].attributes.stencil, true, "with the engine's own attributes");

    // From 1.14.1 the engine asks the loader for the display scale; it must be the canvas ratio.
    assert.equal(engine.displayScale, defoldVersion === "1.14.0" ? null : host.adapter.pixelRatio);

    host.frame(5);
    assert.equal(engine.frames, 5);
    assert.deepEqual(host.errors(), []);
    assert.equal(host.crashed, null);
    assert.equal(host.state.loading[0].shown, true);
    assert.equal(host.state.loading.at(-1).shown, false, "the loading indicator is hidden once the engine runs");
  });
}

test("the WeChat and Douyin loading text is Chinese, TikTok's is English, and it can be disabled", async (t) => {
  const workspace = makeWorkspace(t);
  assert.match((await workspace.run("wechat")).state.loading[0].title, /^加载中/);
  assert.match((await workspace.run("tiktok")).state.loading[0].title, /^Loading/);
  const silent = await workspace.run("douyin", { exportOptions: { loadingText: "" } });
  assert.deepEqual(silent.state.loading, []);
});

test("heap size and extra engine arguments from the export reach the engine", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("wechat", { exportOptions: { heapSizeMb: 64, engineArguments: ["--config=bootstrap.debug=1"] } });
  assert.equal(host.engine.initialMemory, 64 * 1024 * 1024);
  assert.deepEqual([...host.engine.mainArgs], ["--verify-graphics-calls=false", "--config=bootstrap.debug=1"]);
});

test("the engine falls back to WebGL 1 when the host has no WebGL 2", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("wechat", { hostOptions: { webgl2: false } });
  assert.deepEqual({ ...host.engine.gl }, {
    created: true, majorVersion: 1, iOSVersion: 16.5, isWebGL2: false, isWebGL1: true, stencil: true,
  });
  assert.deepEqual(host.state.contextRequests.map((request) => request.type), ["webgl2", "webgl"]);
});

test("the engine picks WebGL 1 by itself on iOS older than 15.2, from the synthesized user agent", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("wechat", { hostOptions: { system: { system: "iOS 15.1" } } });
  assert.match(host.engine.env.userAgent, /CPU iPhone OS 15_1 like Mac OS X/);
  assert.equal(host.engine.gl.iOSVersion, 15.1);
  assert.equal(host.engine.gl.majorVersion, 1);
  assert.deepEqual(host.state.contextRequests.map((request) => request.type), ["webgl"]);
});

test("Android and developer-tool hosts get a matching user agent and language", async (t) => {
  const workspace = makeWorkspace(t);
  const android = await workspace.run("douyin", {
    hostOptions: { system: { platform: "android", system: "Android 13", model: "Pixel 7", language: "en_US" } },
  });
  assert.match(android.engine.env.userAgent, /Linux; Android 13; Pixel 7\).*Chrome\/\d+.*DefoldMiniGame\/douyin/);
  assert.equal(android.engine.env.language, "en-US");
  assert.equal(android.engine.gl.iOSVersion, false);
  assert.equal(android.engine.gl.majorVersion, 2);

  const devtools = await workspace.run("wechat", { hostOptions: { system: { platform: "devtools", system: "macOS 14" } } });
  assert.match(devtools.engine.env.userAgent, /^Mozilla\/5\.0 \(devtools; /);
  assert.equal(devtools.engine.gl.majorVersion, 2);
});

test("a developer tool's simulated device does not make the engine fall back to WebGL 1", async (t) => {
  // What WeChat DevTools 36.6.0 reports for its "iPhone 12/13 (Pro)" simulator.
  // The game runs in the tool's own Chromium, whatever system the device claims;
  // read as a real iOS 10 it sent a Defold 1.14.2 game to WebGL 1, for which
  // the bundle has no shaders.
  const workspace = makeWorkspace(t);
  const host = await workspace.run("wechat", {
    hostOptions: { system: { platform: "devtools", system: "iOS 10.0.1", model: "iPhone 12/13 (Pro)", pixelRatio: 3 } },
  });
  assert.match(host.engine.env.userAgent, /^Mozilla\/5\.0 \(devtools; iPhone 12\/13  Pro\) /);
  assert.ok(!/iPhone OS|CPU .*OS \d/.test(host.engine.env.userAgent), "no iOS version for the engine to parse");
  assert.equal(host.engine.gl.iOSVersion, false);
  assert.equal(host.engine.gl.majorVersion, 2);
  assert.deepEqual(host.state.contextRequests.map((request) => request.type), ["webgl2"]);
});

test("TikTok boots although GameGlobal is not the global object", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("tiktok");
  assert.notEqual(host.gameGlobal, host.global);
  assert.equal(host.adapter.platform, "tiktok");
  assert.equal(typeof host.gameGlobal.__defoldMiniGameBootEngine, "function");
  // Nothing the engine needs was written to the global object.
  for (const name of ["window", "document", "navigator", "XMLHttpRequest", "Module", "FS"]) {
    assert.equal(name in host.global, false, `${name} stays out of the global scope`);
  }
});

test("a failed subpackage download fails the start with the host's message", async (t) => {
  const workspace = makeWorkspace(t);
  workspace.export("wechat");
  const host = workspace.host("wechat", { failSubpackage: true });
  await assert.rejects(host.start(), /loadSubpackage\('engine'\) failed: loadSubpackage:fail module not found/);
  assert.equal(host.loader.state, "failed");
  assert.equal(host.state.loading.at(-1).shown, false);
  assert.equal(host.state.modals.length, 1);
  assert.equal(host.state.modals[0].title, "启动失败");
  assert.equal(host.engine, null);
});

test("a missing engine binary is reported with the path that was tried", async (t) => {
  const workspace = makeWorkspace(t);
  workspace.export("douyin");
  unlinkSync(join(workspace.outputDir("douyin"), "engine/dmengine.wasm.br"));
  const host = workspace.host("douyin");
  await assert.rejects(host.start(), /could not be instantiated \(engine\/dmengine\.wasm\.br\).*no such file/);
  assert.equal(host.loader.state, "failed");
});

test("an archive that does not match the export is refused before the engine starts", async (t) => {
  const workspace = makeWorkspace(t);
  workspace.export("wechat");
  const { appendFileSync } = await import("node:fs");
  appendFileSync(join(workspace.outputDir("wechat"), "engine/archive/game0.arci.bin"), Buffer.from([1]));
  const host = workspace.host("wechat");
  await assert.rejects(host.start(), /game\.arci is 257 bytes in the package, but the export recorded 256/);
  assert.equal(host.count("wasm.instantiate"), 0);
});

test("an engine that never starts hits the watchdog", async (t) => {
  const workspace = makeWorkspace(t);
  workspace.export("wechat", { startTimeoutMs: 150 });
  const host = workspace.host("wechat", { hangWasm: true });
  await assert.rejects(host.start(), /did not start within 0 s/);
  assert.equal(host.loader.state, "failed");
});

test("the package runs without a brotli-compressed binary too", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("tiktok", { exportOptions: { brotli: false } });
  assert.deepEqual(host.calls.get("wasm.instantiate"), [["engine/dmengine.wasm"]]);
  assert.equal(host.engine.wasmResult, 41);
});

test("a host without the required capabilities is refused with a clear message", async (t) => {
  const workspace = makeWorkspace(t);
  workspace.export("wechat");
  const host = workspace.host("wechat", { extendApi(api) { delete api.loadSubpackage; } });
  assert.throws(() => host.boot(), /engine loader is missing required capabilities: subpackage/);
});

test("an export for one platform refuses to start on another", async (t) => {
  const workspace = makeWorkspace(t);
  workspace.export("wechat");
  const host = workspace.host("douyin", { packageDir: workspace.outputDir("wechat") });
  // The boot configuration pins the platform, so the Douyin host has no `wx` to offer.
  assert.throws(() => host.boot(), /requires a WeChat \(wx\), Douyin \(tt\), or TikTok/);
});

for (const defoldVersion of DEFOLD_VERSIONS) {
  test(`an engine whose main() throws is reported as a failed start (Defold ${defoldVersion})`, async (t) => {
    const workspace = makeWorkspace(t, { defoldVersion });
    workspace.export("wechat", { engineArguments: ["--fake-main-throws"] });
    const host = workspace.host("wechat");
    await assert.rejects(host.start(), /engine main\(\) threw/);
    assert.equal(host.loader.state, "failed");
    assert.equal(host.state.modals.length, 1);
    assert.equal(host.state.loading.at(-1).shown, false);
    await host.settle();
    host.frame(2);
    assert.equal(host.engine.frames, 0, "the game loop never started");
  });
}

test("an engine that exits with an error code is not reported as running (Defold 1.14.1)", async (t) => {
  // The 1.14.1 loader checks the status main() returns; older loaders ignore it.
  const workspace = makeWorkspace(t, { defoldVersion: "1.14.1" });
  workspace.export("douyin", { engineArguments: ["--fake-exit-code=3"] });
  const host = workspace.host("douyin");
  await assert.rejects(host.start(), /Engine exited with code 3/);
  assert.equal(host.loader.state, "failed");
});

test("the project's pixel-ratio bounds apply, and the engine sees the resulting display scale", async (t) => {
  const workspace = makeWorkspace(t, { defoldVersion: "1.14.1", highDpi: true, maxPixelRatio: 3 });
  const host = await workspace.run("wechat");
  assert.equal(host.adapter.pixelRatio, 3);
  assert.equal(host.engine.displayScale, 3);
  assert.deepEqual([host.mainCanvas.width, host.mainCanvas.height], [1170, 2532]);

  const low = makeWorkspace(t, { defoldVersion: "1.14.1", highDpi: true, minPixelRatio: 2 });
  const lowHost = await low.run("douyin", { hostOptions: { system: { pixelRatio: 1 } } });
  assert.equal(lowHost.adapter.pixelRatio, 2, "html5.min_pixel_ratio raises a low device ratio");
});
