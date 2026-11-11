import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";

import { listFiles } from "../src/util.mjs";
import { DEFOLD_VERSIONS, makeWorkspace } from "./helpers/workspace.mjs";

/** Boots a second host over the same user data, as a relaunch of the game would. */
async function relaunch(workspace, platform, previous, hostOptions = {}) {
  const host = workspace.host(platform, { storage: previous.storage, ...hostOptions });
  await host.start();
  return host;
}

for (const defoldVersion of DEFOLD_VERSIONS) for (const [platform, kind] of [["wechat", "fs"], ["douyin", "fs"], ["tiktok", "storage"]]) {
  test(`a saved file survives a relaunch on ${platform} (${kind} backend, Defold ${defoldVersion})`, async (t) => {
    const workspace = makeWorkspace(t, { defoldVersion });
    const first = await workspace.run(platform);
    assert.equal(first.loader.indexedDB.backendKind, kind);
    assert.equal(first.engine.loadedSave, null, "nothing is saved on a first launch");

    first.engine.save("save.txt", "level=3;coins=120");
    await first.settle();
    assert.equal(first.engine.load("save.txt"), "level=3;coins=120");

    const second = await relaunch(workspace, platform, first);
    assert.equal(second.engine.loadedSave, "level=3;coins=120", "restored before main() ran");

    second.engine.save("save.txt", "level=4");
    second.engine.save("settings.txt", "music=off");
    await second.settle();
    const third = await relaunch(workspace, platform, second);
    assert.equal(third.engine.loadedSave, "level=4");
    assert.equal(third.engine.load("settings.txt"), "music=off");

    third.engine.remove("save.txt");
    await third.settle();
    const fourth = await relaunch(workspace, platform, third);
    assert.equal(fourth.engine.loadedSave, null, "a deleted file stays deleted");
    assert.equal(fourth.engine.load("settings.txt"), "music=off");

    for (const host of [first, second, third, fourth]) {
      assert.equal(host.crashed, null);
      assert.deepEqual(host.errors(), []);
    }
  });
}

test("on WeChat the data lives in files under the user data path; the archive does not", async (t) => {
  const workspace = makeWorkspace(t, { archiveSize: 8000 });
  const host = await workspace.run("wechat");
  host.engine.save("save.txt", "abc");
  await host.settle();
  const files = listFiles(workspace.userDataDir);
  assert.ok(files.every((file) => file.startsWith("defold-minigame/idb/")), files.join(", "));
  assert.equal(files.filter((file) => file.endsWith(".bin")).length, 1, "one stored file: the save");
  const total = files.reduce((sum, file) => sum + (file.endsWith(".bin") ? 1 : 0), 0);
  assert.equal(total, 1);
  assert.equal(host.count("setStorageSync"), 0);
});

test("on TikTok nothing is written to the file system and storage is never enumerated", async (t) => {
  const workspace = makeWorkspace(t);
  const first = await workspace.run("tiktok");
  first.engine.save("save.txt", "tiktok-save");
  await first.settle();
  const second = await relaunch(workspace, "tiktok", first);
  assert.equal(second.engine.loadedSave, "tiktok-save");
  for (const host of [first, second]) {
    assert.equal(host.crashed, null);
    for (const call of ["fs.writeFileSync", "fs.mkdirSync", "fs.unlinkSync", "fs.renameSync", "getStorageInfoSync"]) {
      assert.equal(host.count(call), 0, call);
    }
  }
  assert.deepEqual(readdirSync(workspace.userDataDir), []);
  assert.ok([...first.storage.keys()].every((key) => key.startsWith("defold-minigame:idb:")));
});

test("--persistence off keeps the engine running but saves nothing, and says so", async (t) => {
  const workspace = makeWorkspace(t);
  const first = await workspace.run("wechat", { exportOptions: { persistence: "off" } });
  assert.equal(first.loader.indexedDB.backendKind, "memory");
  assert.ok(first.warnings().some((line) => /will not survive a restart/.test(line)));
  first.engine.save("save.txt", "gone");
  await first.settle();
  assert.equal(first.engine.load("save.txt"), "gone", "still readable in this session");
  const second = await relaunch(workspace, "wechat", first);
  assert.equal(second.engine.loadedSave, null);
  assert.deepEqual(readdirSync(workspace.userDataDir), []);
});

test("--persistence storage moves WeChat saves into key-value storage", async (t) => {
  const workspace = makeWorkspace(t);
  const first = await workspace.run("wechat", { exportOptions: { persistence: "storage" } });
  first.engine.save("save.txt", "kv");
  await first.settle();
  assert.deepEqual(readdirSync(workspace.userDataDir), []);
  assert.equal((await relaunch(workspace, "wechat", first)).engine.loadedSave, "kv");
});

test("many saves in a row end with the last one stored", async (t) => {
  const workspace = makeWorkspace(t);
  const first = await workspace.run("douyin");
  for (let n = 0; n < 25; n += 1) first.engine.save("save.txt", `n=${n}`);
  await first.settle(8);
  const second = await relaunch(workspace, "douyin", first);
  assert.equal(second.engine.loadedSave, "n=24");
  assert.equal(listFiles(workspace.userDataDir).filter((file) => file.endsWith(".bin")).length, 1);
});

test("a host whose storage fails does not stop the game", async (t) => {
  const workspace = makeWorkspace(t);
  workspace.export("tiktok");
  const host = workspace.host("tiktok", {
    extendApi(api) { api.setStorageSync = () => { throw new Error("quota exceeded"); }; },
  });
  await host.start();
  host.engine.save("save.txt", "x");
  await host.settle(8);
  host.frame(2);
  assert.equal(host.loader.state, "running");
  assert.equal(host.engine.frames, 2);
  assert.equal(host.crashed, null);
});
