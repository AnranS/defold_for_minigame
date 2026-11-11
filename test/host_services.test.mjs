import assert from "node:assert/strict";
import test from "node:test";

import { makeWorkspace } from "./helpers/workspace.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));

test("the engine mixer gets a Web Audio context on WeChat and Douyin", async (t) => {
  const workspace = makeWorkspace(t);
  for (const [platform, hostCall] of [["wechat", "createWebAudioContext"], ["douyin", "getAudioContext"]]) {
    const host = await workspace.run(platform);
    assert.equal(host.adapter.engineAudio, true);
    assert.equal(host.engine.audio.available, true);
    assert.equal(host.engine.audio.sampleRate, 48000);
    assert.equal(host.count(hostCall), 1);

    // One mixed block: createBuffer + copyToChannel + createBufferSource + start.
    // The simulated AudioBuffer has no copyToChannel; the adapter supplies it.
    host.engine.queueAudio(512);
    host.engine.queueAudio(512);
    assert.equal(host.state.audioContexts[0].buffers, 2);
    assert.equal(host.state.audioContexts[0].sources, 2);
    assert.deepEqual(host.errors(), []);
  }
});

test("the engine mixer is suspended in the background and resumed in the foreground", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("wechat");
  const audio = host.state.audioContexts[0];
  await host.engine.audioContext.resume();
  assert.equal(audio.state, "running");
  host.hide();
  await host.settle(1);
  assert.equal(audio.state, "suspended");
  host.show();
  await host.settle(1);
  assert.equal(audio.state, "running");
  assert.deepEqual(plain(host.engine.audio.changes), ["running", "suspended", "running"], "the engine is told about each change");
});

test("on TikTok the engine mixer stays off by default, even though the host has Web Audio", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("tiktok");
  assert.equal(host.adapter.engineAudio, false);
  assert.deepEqual(plain(host.engine.audio), { available: false }, "the engine finds no AudioContext and runs silently");
  assert.equal(host.count("createWebAudioContext"), 0);
  assert.equal(host.bridge.handshake().engineAudio, false, "Lua can ask and fall back to inner_audio()");
  host.frame(3);
  assert.equal(host.engine.frames, 3);
});

test("--engine-audio on enables the mixer on TikTok, and off disables it elsewhere", async (t) => {
  const workspace = makeWorkspace(t);
  const on = await workspace.run("tiktok", { exportOptions: { engineAudio: "on" } });
  assert.equal(on.engine.audio.available, true);
  const off = await workspace.run("wechat", { exportOptions: { engineAudio: "off" } });
  assert.deepEqual(plain(off.engine.audio), { available: false });
  assert.equal(off.count("createWebAudioContext"), 0);
});

test("a host without Web Audio leaves the engine silent instead of failing", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("douyin", { hostOptions: { webAudio: false }, exportOptions: { engineAudio: "on" } });
  assert.equal(host.adapter.engineAudio, false);
  assert.deepEqual(plain(host.engine.audio), { available: false });
  assert.equal(host.loader.state, "running");
});

test("http.request goes through the host's request API", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("wechat");
  host.onRequest((options) => {
    assert.equal(options.url, "https://api.example.test/score");
    assert.equal(options.method, "GET");
    assert.equal(options.responseType, "arraybuffer");
    return { statusCode: 200, header: { "Content-Type": "application/json", "X-Rank": "3" }, data: Buffer.from('{"score":42}') };
  });
  const reply = await new Promise((resolve) => host.engine.http("GET", "https://api.example.test/score", null, resolve));
  assert.equal(reply.status, 200);
  assert.equal(Buffer.from(reply.body).toString("utf8"), '{"score":42}');
  assert.equal(reply.headers, "content-type: application/json\nx-rank: 3\n");
});

test("a request body is sent as an exact ArrayBuffer, not as a view into the engine heap", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("douyin");
  let received = null;
  host.onRequest((options) => { received = options; return { statusCode: 204, data: Buffer.alloc(0) }; });
  // Like HEAPU8.subarray(ptr, ptr + length): a small view into a large buffer.
  const heap = host.evaluate("new Uint8Array(4096)");
  heap.set([9, 8, 7], 100);
  const reply = await new Promise((resolve) => host.engine.http("POST", "https://api.example.test/save", heap.subarray(100, 103), resolve));
  assert.equal(reply.status, 204);
  assert.equal(received.method, "POST");
  assert.equal(received.data.byteLength, 3);
  assert.deepEqual([...new Uint8Array(received.data)], [9, 8, 7]);
});

test("a failed request reports status 0, as the engine expects for a network error", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("tiktok");
  const reply = await new Promise((resolve) => host.engine.http("GET", "https://offline.example.test/", null, resolve));
  assert.deepEqual(plain(reply), { status: 0 });
});

test("html5.run reaches the bridge through the engine's own evaluation call", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("wechat");
  const expression = host.require("js/bridge.js").HANDSHAKE_EXPRESSION;
  const info = host.lua(expression);
  assert.equal(info.brand, "defold-mini-game-bridge");
  assert.equal(info.platform, "wechat");
  assert.equal(info.persistence, "fs");
  assert.equal(info.engineAudio, true);
  assert.equal(info.toolVersion, "0.1.0");

  assert.deepEqual(host.lua({ op: "sync", api: "setStorageSync", args: ["k", "v"] }), { ok: true });
  assert.equal(host.storage.get("k"), "v");
  host.lua({ op: "call", api: "login", id: 1 });
  await host.settle();
  assert.deepEqual(host.lua({ op: "poll" }), [{ id: 1, ok: true, data: { errMsg: "login:ok", code: "wechat-login-code" } }]);
  assert.equal(host.lua({ op: "poll" }), "");
});

test("JavaScript passed to html5.run fails the way the engine reports a script error", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("douyin");
  const reply = host.lua("document.title");
  assert.match(reply.thrown, /cannot evaluate JavaScript in a mini game/);
  assert.equal(host.engine.lastRunSuccess, 0);
  assert.equal(host.loader.state, "running");
});

test("the bridge is published for the developer-tool console", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("tiktok");
  assert.equal(host.gameGlobal.DefoldMiniGameBridge, host.bridge);
  assert.equal(host.gameGlobal.__defoldMiniGameLoader.state, "running");
  assert.equal(host.bridge.handshake().persistence, "storage");
});
