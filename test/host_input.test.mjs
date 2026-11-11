import assert from "node:assert/strict";
import test from "node:test";

import { DEFOLD_VERSIONS, PLATFORMS, makeWorkspace } from "./helpers/workspace.mjs";

const plain = (value) => JSON.parse(JSON.stringify(value));
const touch = (identifier, clientX, clientY) => ({ identifier, clientX, clientY });
// The engine scales coordinates with floating-point division; compare to a micro-pixel.
const round = (value) => Math.round(value * 1e6) / 1e6;
const touches = (host) => plain(host.engine.touches).map((entry) => ({ ...entry, x: round(entry.x), y: round(entry.y) }));
/** Runs frames one at a time, each followed by what the adapter does at the end of a frame. */
async function frames(host, count = 1) {
  for (let n = 0; n < count; n += 1) {
    host.frame(1);
    await host.settle(1);
  }
}

for (const defoldVersion of DEFOLD_VERSIONS) for (const platform of PLATFORMS) {
  test(`touches reach the engine in canvas pixels (${platform}, Defold ${defoldVersion})`, async (t) => {
    const workspace = makeWorkspace(t, { defoldVersion });
    const host = await workspace.run(platform);
    assert.equal(host.adapter.pixelRatio, 1);
    assert.equal(host.mainCanvas.width, 390);
    assert.equal(host.mainCanvas.height, 844);

    const first = touch(1, 100, 200);
    const second = touch(2, 300, 400);
    host.touch("start", [first], [first]);
    host.touch("start", [first, second], [second]);
    await frames(host);
    host.touch("move", [touch(1, 110, 220), second], [touch(1, 110, 220)]);
    host.touch("end", [second], [touch(1, 110, 220)]);
    host.touch("cancel", [], [second]);

    assert.deepEqual(touches(host), [
      { phase: "began", id: 1, x: 100, y: 200, active: 1 },
      { phase: "began", id: 2, x: 300, y: 400, active: 2 },
      { phase: "moved", id: 1, x: 110, y: 220, active: 2 },
      { phase: "ended", id: 1, x: 110, y: 220, active: 1 },
      { phase: "cancelled", id: 2, x: 300, y: 400, active: 0 },
    ]);
  });
}

test("with display.high_dpi the canvas uses the host pixel ratio, capped at 2 by default", async (t) => {
  const workspace = makeWorkspace(t, { highDpi: true });
  const host = await workspace.run("wechat");
  assert.equal(host.adapter.hostPixelRatio, 3);
  assert.equal(host.adapter.pixelRatio, 2);
  assert.equal(host.engine.env.devicePixelRatio, 2);
  assert.deepEqual([host.mainCanvas.width, host.mainCanvas.height], [780, 1688]);
  host.touch("start", [touch(0, 100, 200)]);
  assert.deepEqual(touches(host), [{ phase: "began", id: 0, x: 200, y: 400, active: 1 }]);
});

test("the pixel ratio can be pinned or its cap raised", async (t) => {
  const pinned = await makeWorkspace(t).run("douyin", { exportOptions: { pixelRatio: 3 } });
  assert.deepEqual([pinned.mainCanvas.width, pinned.mainCanvas.height], [1170, 2532]);

  const raised = await makeWorkspace(t, { highDpi: true }).run("tiktok", { exportOptions: { maxPixelRatio: 3 } });
  assert.equal(raised.adapter.pixelRatio, 3);

  const fractional = await makeWorkspace(t, { highDpi: true }).run("wechat", {
    hostOptions: { system: { pixelRatio: 1.5, windowWidth: 375, windowHeight: 667 } },
  });
  assert.deepEqual([fractional.mainCanvas.width, fractional.mainCanvas.height], [562, 1000]);
});

test("TikTok touches that only carry screen coordinates are understood", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("tiktok");
  const raw = { identifier: 4, screenX: 50, screenY: 60 };
  host.touch("start", [raw]);
  assert.deepEqual(touches(host), [{ phase: "began", id: 4, x: 50, y: 60, active: 1 }]);
});

test("a canvas that rejects property overrides is wrapped, and input still works", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("wechat", { hostOptions: { strictCanvas: true } });
  assert.equal(host.adapter.usesProxyCanvas, true);
  assert.ok(host.warnings().some((line) => /using a Proxy canvas/.test(line)));
  assert.equal(host.engine.gl.created, true);
  assert.equal(host.engine.gl.isWebGL2, true);
  host.touch("start", [touch(0, 10, 20)]);
  await frames(host);
  host.touch("end", [], [touch(0, 10, 20)]);
  assert.deepEqual(touches(host).map((entry) => entry.phase), ["began", "ended"]);
  assert.deepEqual(host.errors(), []);
});

test("a touchend on the canvas also reaches listeners on document, as it would by bubbling", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("wechat");
  const seen = [];
  host.adapter.document.addEventListener("touchend", () => seen.push("touchend"));
  host.adapter.document.addEventListener("click", () => seen.push("click"));
  host.touch("start", [touch(0, 1, 1)]);
  await frames(host);
  host.touch("end", [], [touch(0, 1, 1)]);
  assert.deepEqual(seen, ["touchend", "click"]);
});

test("a touch that begins and ends within one frame is still pressed for a frame", async (t) => {
  // A finger rests on the screen for several frames. A developer tool's
  // automation taps in an instant: both events arrive before the engine has
  // run a frame, and an engine that polls its input once per frame would
  // never see the press. Douyin DevTools' tap command showed exactly that.
  const workspace = makeWorkspace(t);
  const host = await workspace.run("douyin");
  await frames(host, 2);
  const finger = touch(0, 100, 200);
  const phases = () => touches(host).map((entry) => entry.phase);

  host.touch("start", [finger]);
  host.touch("end", [], [finger]);
  assert.deepEqual(phases(), ["began"], "the release waits until the engine has seen the press");
  await frames(host);
  assert.equal(host.engine.touchDownSeen, 1, "the engine's poll finds the touch down");
  assert.deepEqual(phases(), ["began", "ended"], "then the release is delivered");
  await frames(host);
  assert.equal(host.engine.touchDownSeen, 0);
  assert.equal(host.engine.framesWithTouch, 1);

  // Two instant taps stay two taps: pressed, released, pressed, released.
  for (let tap = 0; tap < 2; tap += 1) {
    host.touch("start", [finger]);
    host.touch("end", [], [finger]);
  }
  const seen = [];
  for (let frame = 0; frame < 5; frame += 1) {
    await frames(host);
    seen.push(host.engine.touchDownSeen);
  }
  assert.deepEqual(seen, [1, 0, 1, 0, 0]);
  assert.deepEqual(phases().slice(2), ["began", "ended", "began", "ended"]);

  // A second finger in the same frame is not held back by the first.
  const other = touch(1, 300, 400);
  host.touch("start", [finger], [finger]);
  host.touch("start", [finger, other], [other]);
  assert.deepEqual(phases().slice(6), ["began", "began"]);
  await frames(host);
  assert.equal(host.engine.touchDownSeen, 2);

  // An ordinary release, a frame or more after the press, is delivered at once.
  host.touch("end", [other], [finger]);
  host.touch("end", [], [other]);
  assert.deepEqual(phases().slice(8), ["ended", "ended"]);
  assert.deepEqual(host.errors(), []);
});

test("a host resize changes the canvas, and the engine notices on its next frame", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("wechat");
  host.frame(1);
  assert.deepEqual(plain(host.engine.resizes), [{ width: 390, height: 844 }]);
  host.resize(844, 390);
  assert.deepEqual([host.mainCanvas.width, host.mainCanvas.height], [844, 390]);
  assert.equal(host.adapter.window.innerWidth, 844);
  host.frame(1);
  assert.deepEqual(plain(host.engine.resizes).at(-1), { width: 844, height: 390 });
  host.touch("start", [touch(0, 422, 195)]);
  assert.deepEqual(touches(host).at(-1), { phase: "began", id: 0, x: 422, y: 195, active: 1 });
});

test("hide and show become blur and focus for the engine", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("douyin");
  host.hide();
  assert.equal(host.adapter.document.hidden, true);
  host.show();
  assert.equal(host.adapter.document.hidden, false);
  assert.deepEqual(plain(host.engine.focus), ["blur", "focus"]);
});

test("gui.show_keyboard() opens the host keyboard and typing arrives as key events", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("wechat");
  host.engine.showKeyboard(true);
  assert.equal(host.state.keyboard.visible, true);
  assert.equal(host.count("showKeyboard"), 1);

  host.keyboardInput("h");
  host.keyboardInput("hi");
  host.keyboardInput("hi中");
  host.keyboardInput("hi");
  host.keyboardInput("ho");
  host.keyboardConfirm("ho");
  const keys = plain(host.engine.keys).map((key) => `${key.type}:${key.keyCode}:${key.charCode}`);
  assert.deepEqual(keys, [
    "keypress:104:104",
    "keypress:105:105",
    "keypress:20013:20013",
    "keydown:8:0", "keyup:8:0",
    "keydown:8:0", "keyup:8:0", "keypress:111:111",
    "keydown:13:0", "keyup:13:0",
  ]);

  host.keyboardComplete("ho");
  assert.equal(host.adapter.keyboard.visible, false);
  host.engine.showKeyboard(true);
  assert.equal(host.count("showKeyboard"), 2, "the keyboard can be opened again after the host closed it");
  host.engine.showKeyboard(false);
  assert.equal(host.state.keyboard.visible, false);
  assert.equal(host.count("hideKeyboard"), 1);
});

test("typing starts from an empty field each time the keyboard opens", async (t) => {
  const workspace = makeWorkspace(t);
  const host = await workspace.run("tiktok");
  host.engine.showKeyboard(true);
  host.keyboardInput("ab");
  host.engine.showKeyboard(false);
  host.engine.showKeyboard(true);
  host.keyboardInput("c");
  const typed = plain(host.engine.keys).filter((key) => key.type === "keypress").map((key) => String.fromCodePoint(key.charCode));
  assert.deepEqual(typed, ["a", "b", "c"]);
  assert.equal(plain(host.engine.keys).some((key) => key.keyCode === 8), false, "no stray backspace");
});
