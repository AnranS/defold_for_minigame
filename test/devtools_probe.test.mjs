/**
 * The DevTools probe is test tooling, but a broken probe would make a real
 * run in the developer tool look like a broken export. These tests run a
 * probed export in the simulated WeChat host and check what it leaves behind.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { inflateSync } from "node:zlib";

import { collect, describeFrame, encodePng, inject, parseTouch, remove } from "../scripts/devtools_probe.mjs";
import { makeWorkspace } from "./helpers/workspace.mjs";

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** Width, height, and RGB rows of a PNG written by encodePng. */
function decodePng(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  const length = png.readUInt32BE(33);
  assert.equal(png.toString("ascii", 37, 41), "IDAT");
  const raw = inflateSync(png.subarray(41, 41 + length));
  const rows = [];
  for (let row = 0; row < height; row += 1) {
    const start = row * (1 + width * 3);
    assert.equal(raw[start], 0, "filter type none");
    rows.push([...raw.subarray(start + 1, start + 1 + width * 3)]);
  }
  return { width, height, rows };
}

test("a probed export boots, and leaves a console log, frames, touches, and a summary", async (t) => {
  const workspace = makeWorkspace(t);
  workspace.export("wechat");
  const project = workspace.outputDir("wechat");
  const config = inject({
    project, label: "sim", captures: [0, 30],
    touches: [parseTouch("start:0.5,0.25@5"), parseTouch("end:0.5,0.25@15")],
  });
  assert.equal(config.finishAt, 1530, "the run finishes a moment after its last step");
  inject({ project, label: "sim", captures: [0, 30], touches: config.touches, finishAt: 60 });
  assert.equal(readFileSync(join(project, "game.js"), "utf8").split('import "./dmg-probe";').length, 2, "injecting twice loads the probe once");

  const host = workspace.host("wechat");
  await host.start();
  for (let round = 0; round < 60; round += 1) { host.frame(1); await host.settle(1); }

  const result = collect({ storage: workspace.userDataDir, out: join(workspace.root, "evidence"), label: "sim" });
  // The loader's own lines, and the engine's, are in the mirrored console.
  assert.match(result.log, /\[log\] \[DefoldMiniGame\]\[loader\] 1\/5 loading subpackage 'engine'/);
  assert.match(result.log, /\[log\] \[DefoldMiniGame\]\[loader\] 5\/5 the engine is running/);
  assert.match(result.log, /\[probe\] system \{"platform"/);

  const summary = result.summary;
  assert.equal(summary.finished, true);
  assert.equal(summary.errors, 0);
  assert.ok(summary.engineRunningAfterMs >= 0);
  // The summary is written when the run finishes; the engine keeps drawing after that.
  assert.ok(summary.frames >= 5 && summary.frames <= host.engine.frames, `counted ${summary.frames} of ${host.engine.frames} frames`);
  assert.ok(summary.frameTime.samples >= 4);

  // Both touches reached the adapter's handlers, and through them the engine.
  assert.deepEqual(summary.touches.map((step) => [step.type, step.handlers, step.x, step.y]),
    [["onTouchStart", 1, 195, 211], ["onTouchEnd", 1, 195, 211]]);
  assert.equal(JSON.parse(JSON.stringify(host.engine.touches)).length >= 2, true);

  // Frames: the simulated context is 6 by 4, blue, with a red bottom-left pixel.
  assert.equal(summary.captures.length, 2);
  assert.deepEqual(summary.captures.map((capture) => capture.file), ["frame-1.rgba", "frame-2.rgba"]);
  assert.deepEqual(summary.captures[0].drawingBuffer, [6, 4]);
  assert.equal(summary.captures[0].distinctColours, 2);
  assert.equal(result.frames.length, 2);
  const image = decodePng(readFileSync(result.frames[0].file));
  assert.equal(image.width, 6);
  assert.equal(image.height, 4);
  // WebGL's first row is the bottom one; the saved image starts at the top.
  assert.deepEqual(image.rows[3].slice(0, 6), [255, 0, 0, 0, 0, 255]);
  assert.deepEqual(image.rows[0].slice(0, 6), [0, 0, 255, 0, 0, 255]);
  assert.deepEqual({ colours: result.frames[0].colours, background: result.frames[0].background }, { colours: 2, background: "#0000ff" });

  assert.deepEqual(host.errors(), []);
});

test("removing the probe leaves the project exactly as it was exported", (t) => {
  const workspace = makeWorkspace(t);
  workspace.export("wechat");
  const project = workspace.outputDir("wechat");
  const before = sha256(readFileSync(join(project, "game.js")));
  inject({ project });
  assert.notEqual(sha256(readFileSync(join(project, "game.js"))), before);
  assert.ok(existsSync(join(project, "dmg-probe.js")));

  remove({ project });
  assert.equal(sha256(readFileSync(join(project, "game.js"))), before);
  assert.ok(!existsSync(join(project, "dmg-probe.js")));
  // The exporter still recognises the folder and can export into it again.
  workspace.export("wechat");
  remove({ project }); // a second removal is harmless
});

test("the probe goes into WeChat and Douyin projects this tool exported, and nowhere else", (t) => {
  const workspace = makeWorkspace(t);
  assert.throws(() => inject({ project: workspace.root }), /not a project this tool exported/);
  // Writing files on TikTok can end the client, so the probe stays out of it.
  workspace.export("tiktok");
  assert.throws(() => inject({ project: workspace.outputDir("tiktok") }), /written for WeChat and Douyin DevTools/);
});

test("a probed Douyin export boots and reports through the tt API", async (t) => {
  const workspace = makeWorkspace(t);
  workspace.export("douyin");
  inject({ project: workspace.outputDir("douyin"), label: "dy", captures: [0], finishAt: 30 });
  const host = workspace.host("douyin");
  await host.start();
  for (let round = 0; round < 40; round += 1) { host.frame(1); await host.settle(1); }
  const result = collect({ storage: workspace.userDataDir, out: join(workspace.root, "evidence"), label: "dy" });
  assert.match(result.log, /5\/5 the engine is running/);
  assert.equal(result.summary.finished, true);
  assert.equal(result.summary.errors, 0);
  assert.equal(result.summary.captures.length, 1);
  assert.deepEqual(host.errors(), []);
});

test("touch steps are parsed strictly", () => {
  assert.deepEqual(parseTouch("start:0.5,0.25@2000"), { type: "onTouchStart", x: 0.5, y: 0.25, at: 2000 });
  assert.deepEqual(parseTouch("move:0,1@0"), { type: "onTouchMove", x: 0, y: 1, at: 0 });
  assert.equal(parseTouch("end:1,1@9").type, "onTouchEnd");
  for (const bad of ["tap:0.5,0.5@1", "start:2,0.5@1", "start:0.5,0.5", "start:0.5@1", ""]) {
    assert.throws(() => parseTouch(bad), /touch step|fractions of the window/, bad);
  }
});

test("frames are written as valid PNG files and described by how much was drawn", () => {
  const rgba = Buffer.from([
    10, 20, 30, 255, 10, 20, 30, 255,
    10, 20, 30, 255, 200, 100, 50, 255,
  ]);
  const image = decodePng(encodePng(2, 2, rgba));
  assert.deepEqual(image, { width: 2, height: 2, rows: [[10, 20, 30, 10, 20, 30], [10, 20, 30, 200, 100, 50]] });
  assert.deepEqual(describeFrame(2, 2, rgba), { colours: 2, background: "#0a141e", drawnShare: 0.25 });
  assert.deepEqual(describeFrame(1, 1, Buffer.from([0, 0, 0, 255])), { colours: 1, background: "#000000", drawnShare: 0 });
});

test("collecting says clearly when there is nothing to collect", (t) => {
  const workspace = makeWorkspace(t);
  assert.throws(() => collect({ storage: workspace.userDataDir, out: join(workspace.root, "evidence") }), /has the probed project run/);
});
