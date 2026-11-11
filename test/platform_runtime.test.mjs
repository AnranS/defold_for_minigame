import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT, loadSupportMatrix } from "../src/util.mjs";
import { runtimeRealm } from "./helpers/runtime_realm.mjs";
import { transformModule } from "./sim/host.mjs";

const EXPECTED = {
  wechat: { apiPrefix: "wx", native: "WXWebAssembly" },
  douyin: { apiPrefix: "tt", native: "TTWebAssembly" },
  tiktok: { apiPrefix: "TTMinis.game", native: "TTWebAssembly" },
};

for (const platform of Object.keys(EXPECTED)) {
  test(`selects the ${platform} provider and its WebAssembly API`, (t) => {
    const host = runtimeRealm(t, platform);
    const { PlatformRuntime, BRIDGE_ABI_VERSION } = host.require("js/platform_runtime.js");
    const contract = loadSupportMatrix().platformContracts[platform];

    assert.equal(PlatformRuntime.platform, platform);
    assert.equal(PlatformRuntime.apiPrefix, EXPECTED[platform].apiPrefix);
    assert.equal(PlatformRuntime.apiPrefix, contract.apiNamespace);
    assert.equal(PlatformRuntime.api, host.api);
    assert.equal(PlatformRuntime.available, true);
    assert.equal(PlatformRuntime.getNativeWebAssembly(), host.global[EXPECTED[platform].native]);
    assert.equal(EXPECTED[platform].native, contract.nativeWebAssembly);
    assert.equal(BRIDGE_ABI_VERSION, loadSupportMatrix().bridgeAbi);
    assert.equal(PlatformRuntime.global, host.gameGlobal);

    for (const capability of ["canvas", "fileSystem", "storage", "touch", "touchCancel", "windowInfo",
      "windowResize", "subpackage", "lifecycle", "keyboard", "loading", "webAudio", "webAssembly", "request"]) {
      assert.equal(PlatformRuntime.capabilities[capability], true, capability);
    }
    assert.equal(PlatformRuntime.requirePlatform(platform, "test"), host.api);
    const other = platform === "wechat" ? "douyin" : "wechat";
    assert.throws(() => PlatformRuntime.requirePlatform(other, "test"), new RegExp(`requires ${other}, but detected ${platform}`));
  });
}

test("TikTok wins over the wx and tt aliases its host also exposes", (t) => {
  const host = runtimeRealm(t, "tiktok");
  assert.equal(typeof host.global.wx, "object");
  assert.equal(typeof host.global.tt, "object");
  const { PlatformRuntime } = host.require("js/platform_runtime.js");
  assert.equal(PlatformRuntime.platform, "tiktok");
  assert.notEqual(host.gameGlobal, host.global, "TikTok keeps GameGlobal apart from the global object");
});

test("the exported configuration can pin the platform", (t) => {
  const host = runtimeRealm(t, "tiktok", { config: { platform: "douyin" } });
  const { PlatformRuntime } = host.require("js/platform_runtime.js");
  assert.equal(PlatformRuntime.platform, "douyin");
  assert.equal(PlatformRuntime.apiPrefix, "tt");
});

test("merges the modern window information over the legacy system information", (t) => {
  const host = runtimeRealm(t, "wechat", { system: { windowWidth: 414, pixelRatio: 2 } });
  const info = host.require("js/platform_runtime.js").PlatformRuntime.getSystemInfo();
  assert.equal(info.windowWidth, 414);
  assert.equal(info.pixelRatio, 2);
  assert.equal(info.model, "iPhone 14");
});

test("reports missing capabilities by name", (t) => {
  const host = runtimeRealm(t, "wechat", { extendApi(api) { delete api.loadSubpackage; delete api.onShow; } });
  const { PlatformRuntime } = host.require("js/platform_runtime.js");
  assert.equal(PlatformRuntime.capabilities.subpackage, false);
  assert.equal(PlatformRuntime.capabilities.lifecycle, false);
  assert.throws(() => PlatformRuntime.requireCapabilities(["canvas", "subpackage", "lifecycle"], "engine loader"),
    /engine loader is missing required capabilities: subpackage, lifecycle/);
});

test("a realm without any provider yields an unavailable runtime", () => {
  const context = vm.createContext({ console });
  const source = transformModule(readFileSync(join(REPO_ROOT, "runtime/common/js/platform_runtime.js"), "utf8"));
  const module = { exports: {} };
  vm.runInContext(`(function (require, module, exports) {${source}\n})`, context)(() => ({}), module, module.exports);
  const { PlatformRuntime } = module.exports;
  assert.equal(PlatformRuntime.available, false);
  assert.equal(PlatformRuntime.platform, "unknown");
  assert.throws(() => PlatformRuntime.requireApi("adapter"), /adapter requires a WeChat \(wx\), Douyin \(tt\), or TikTok/);
  assert.throws(() => PlatformRuntime.requirePlatform("nintendo", "x"), /invalid platform/);
  assert.equal(PlatformRuntime.getNativeWebAssembly(), null);
});
