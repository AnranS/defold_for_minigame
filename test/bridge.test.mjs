import assert from "node:assert/strict";
import test from "node:test";

import { loadSupportMatrix } from "../src/util.mjs";
import { runtimeRealm } from "./helpers/runtime_realm.mjs";

function setup(t, platform = "wechat", options = {}) {
  const host = runtimeRealm(t, platform, options);
  const module = host.require("js/bridge.js");
  const { PlatformRuntime } = host.require("js/platform_runtime.js");
  const bridge = module.createBridge(PlatformRuntime, {
    toolVersion: "9.9.9", engineAudio: true, persistence: "fs", pixelRatio: 2,
  });
  const send = (command) => {
    const reply = bridge.run(JSON.stringify(command));
    return reply === "" ? "" : JSON.parse(reply);
  };
  const poll = () => { const events = send({ op: "poll" }); return events === "" ? [] : events; };
  return { host, module, bridge, send, poll };
}

test("answers the handshake expression without evaluating it", (t) => {
  const { bridge, module, host } = setup(t);
  const info = JSON.parse(bridge.run(module.HANDSHAKE_EXPRESSION));
  assert.equal(info.brand, "defold-mini-game-bridge");
  assert.equal(info.abi, loadSupportMatrix().bridgeAbi);
  assert.equal(info.platform, "wechat");
  assert.equal(info.apiPrefix, "wx");
  assert.equal(info.toolVersion, "9.9.9");
  assert.equal(info.engineAudio, true);
  assert.equal(info.persistence, "fs");
  assert.equal(info.pixelRatio, 2);
  assert.equal(info.capabilities.storage, true);
  assert.equal(info.system.model, "iPhone 14");
  assert.equal(info.system.safeArea.top, 47);
  // In a browser the same expression is real JavaScript that yields "".
  assert.equal(new Function(`return ${module.HANDSHAKE_EXPRESSION}`)(), "");
  assert.equal(host.crashed, null);
});

test("refuses arbitrary JavaScript with an explanation", (t) => {
  const { bridge } = setup(t);
  for (const code of ["window.location.href", "1+1", "", "wx.login()"]) {
    assert.throws(() => bridge.run(code), /cannot evaluate JavaScript in a mini game.*minigame Lua module/);
  }
});

test("reports malformed and unknown commands as replies, not exceptions", (t) => {
  const { bridge, send } = setup(t);
  assert.deepEqual(JSON.parse(bridge.run("{not json")).ok, false);
  assert.match(JSON.parse(bridge.run("{not json")).error, /not valid JSON/);
  assert.deepEqual(send({ op: "teleport" }), { ok: false, error: "unknown bridge operation 'teleport'" });
  assert.deepEqual(send({ op: "constructor" }), { ok: false, error: "unknown bridge operation 'constructor'" });
});

test("sync calls pass positional arguments and return the host value", (t) => {
  const { send, host } = setup(t);
  assert.deepEqual(send({ op: "sync", api: "setStorageSync", args: ["level", "7"] }), { ok: true });
  assert.deepEqual(send({ op: "sync", api: "getStorageSync", args: ["level"] }), { ok: true, data: "7" });
  assert.equal(host.storage.get("level"), "7");
  assert.deepEqual(send({ op: "sync", api: "getLaunchOptionsSync" }), { ok: true, data: { scene: 1001, query: { from: "test" } } });
  assert.deepEqual(send({ op: "has", apis: ["login", "nope", "getStorageSync"] }),
    { ok: true, data: { login: true, nope: false, getStorageSync: true } });
});

test("async calls deliver success and failure through the event queue", async (t) => {
  const { send, poll, host } = setup(t);
  assert.equal(send({ op: "poll" }), "", "an empty queue costs nothing to parse");
  assert.deepEqual(send({ op: "call", api: "login", args: { timeout: 3000 }, id: 11 }), { ok: true });
  assert.deepEqual(send({ op: "call", api: "checkSession", id: 12 }), { ok: true });
  await host.settle();
  const events = poll();
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { id: 11, ok: true, data: { errMsg: "login:ok", code: "wechat-login-code" } });
  assert.equal(events[1].id, 12);
  assert.equal(events[1].ok, false);
  assert.match(events[1].error, /checkSession:fail session expired/);
  assert.deepEqual(poll(), []);
  assert.equal(host.calls.get("login")[0][0].timeout, 3000);
});

test("an unsupported API fails immediately and names the provider", (t) => {
  const { send } = setup(t, "douyin");
  assert.deepEqual(send({ op: "call", api: "requestMidasPayment", id: 1 }),
    { ok: false, error: "tt.requestMidasPayment is not supported by this host" });
  assert.deepEqual(send({ op: "sync", api: "" }), { ok: false, error: "an API name is required" });
});

test("host events are subscribed, delivered, and unsubscribed", (t) => {
  const { send, poll, host, bridge } = setup(t);
  assert.deepEqual(send({ op: "on", event: "onShow", id: 5 }), { ok: true });
  assert.deepEqual(send({ op: "on", event: "onHide", id: 6 }), { ok: true });
  host.show();
  host.hide();
  assert.deepEqual(poll(), [{ id: 5, ok: true, data: { scene: 1001 } }, { id: 6, ok: true, data: {} }]);
  assert.equal(bridge.subscriptionCount, 2);
  send({ op: "off", id: 5 });
  host.show();
  assert.deepEqual(poll(), []);
  assert.equal(bridge.subscriptionCount, 1);
});

test("objects are driven through handles: create, listen, invoke, read, release", async (t) => {
  const { send, poll, host, bridge } = setup(t);
  assert.deepEqual(send({ op: "new", api: "createRewardedVideoAd", args: { adUnitId: "adunit-1" }, handle: 3 }), { ok: true });
  assert.deepEqual(send({ op: "listen", handle: 3, event: "onClose", id: 20 }), { ok: true });
  assert.deepEqual(send({ op: "get", handle: 3, prop: "adUnitId" }), { ok: true, data: "adunit-1" });
  assert.deepEqual(send({ op: "invoke", handle: 3, method: "show", id: 21 }), { ok: true, async: true });
  await host.settle();
  const events = poll();
  assert.deepEqual(events.find((event) => event.id === 21), { id: 21, ok: true });
  assert.deepEqual(events.find((event) => event.id === 20), { id: 20, ok: true, data: { isEnded: true } });

  assert.deepEqual(send({ op: "set", handle: 3, prop: "tag", value: "x" }), { ok: true });
  assert.equal(host.state.lastAd.tag, "x");
  assert.deepEqual(send({ op: "invoke", handle: 3, method: "explode" }), { ok: false, error: "the object has no method 'explode'" });
  assert.deepEqual(send({ op: "invoke", handle: 99, method: "show" }), { ok: false, error: "unknown object handle 99" });
  assert.deepEqual(send({ op: "release", handle: 3 }), { ok: true });
  assert.equal(host.state.lastAd.destroyed, true);
  assert.equal(bridge.handleCount, 0);
  assert.equal(bridge.subscriptionCount, 0);
});

test("share content is set ahead of time and can be replaced", (t) => {
  const { send, host } = setup(t);
  assert.deepEqual(send({ op: "share", content: { title: "Play with me", query: "from=share" } }), { ok: true });
  assert.deepEqual({ ...host.state.shareHandler() }, { title: "Play with me", query: "from=share" });
  send({ op: "share", content: { title: "New title" } });
  assert.deepEqual({ ...host.state.shareHandler() }, { title: "New title" });
  assert.equal(host.count("onShareAppMessage"), 1);
});

test("binary values cross the bridge as base64", async (t) => {
  const { send, poll, host, module } = setup(t);
  host.onRequest(() => ({ statusCode: 200, data: Buffer.from([1, 2, 250]) }));
  send({ op: "call", api: "request", args: { url: "https://example.test", responseType: "arraybuffer",
    data: { __binary: "base64", data: Buffer.from([7, 8]).toString("base64") } }, id: 1 });
  await host.settle();
  const [event] = poll();
  assert.deepEqual(event.data.data, { __binary: "base64", data: Buffer.from([1, 2, 250]).toString("base64") });
  const sent = host.calls.get("request")[0][0].data;
  assert.deepEqual([...new Uint8Array(sent)], [7, 8]);
  // Values built inside the simulated realm have that realm's prototypes; compare them as JSON.
  const wire = JSON.parse(JSON.stringify(module.toWire({ a: undefined, f() {}, n: NaN, list: [1, undefined] })));
  assert.deepEqual(wire, { n: null, list: [1, null] });
});

test("TikTok blocks the host calls that can terminate the client", (t) => {
  const { send, host } = setup(t, "tiktok");
  for (const api of ["getStorageInfoSync", "getFileSystemManager"]) {
    const reply = send({ op: "sync", api });
    assert.equal(reply.ok, false);
    assert.match(reply.error, new RegExp(`TTMinis\\.game\\.${api} is blocked on tiktok`));
  }
  assert.match(send({ op: "call", api: "getBatteryInfo", id: 1 }).error, /blocked on tiktok/);
  assert.equal(host.crashed, null);
  assert.equal(host.count("getStorageInfoSync"), 0);
  // The same call is allowed where it is safe.
  assert.equal(setup(t, "wechat").send({ op: "sync", api: "getStorageInfoSync" }).ok, true);
});

test("an undrained queue drops the oldest events and warns", (t) => {
  const { send, poll, host } = setup(t);
  send({ op: "on", event: "onShow", id: 1 });
  for (let n = 0; n < 2100; n += 1) host.show();
  const events = poll();
  assert.equal(events.length, 2000);
  assert.ok(host.warnings().some((line) => /events were dropped/.test(line)));
});

test("log forwards to the console with a prefix", (t) => {
  const { send, host } = setup(t);
  send({ op: "log", level: "warn", message: "careful" });
  assert.ok(host.warnings().some((line) => line.includes("[DefoldMiniGame][lua] careful")));
});
