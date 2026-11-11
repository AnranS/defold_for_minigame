import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { listFiles } from "../src/util.mjs";
import { runtimeRealm } from "./helpers/runtime_realm.mjs";

const STORE = "FILE_DATA";
const FILE_MODE = 33206;
const DIR_MODE = 16895;

/** Promise wrappers around the callback-style IndexedDB API. */
function request(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = (event) => { event.preventDefault(); reject(req.error); };
  });
}

function completed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = (event) => { event.preventDefault(); reject(transaction.error); };
    transaction.onabort = () => reject(transaction.error || new Error("aborted"));
  });
}

/** Opens a database the way Emscripten's IDBFS does. */
function openLikeIdbfs(indexedDB, name = "/data") {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, 21);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      const store = db.objectStoreNames.contains(STORE)
        ? event.target.transaction.objectStore(STORE)
        : db.createObjectStore(STORE);
      if (!store.indexNames.contains("timestamp")) store.createIndex("timestamp", "timestamp", { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = (event) => { event.preventDefault(); reject(req.error); };
  });
}

function cursorKeys(index) {
  return new Promise((resolve, reject) => {
    const rows = [];
    const req = index.openKeyCursor();
    req.onsuccess = (event) => {
      const cursor = event.target.result;
      if (!cursor) { resolve(rows); return; }
      rows.push({ path: cursor.primaryKey, time: cursor.key.getTime() });
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

function setup(t, platform, options = {}) {
  const host = runtimeRealm(t, platform, options);
  const module = host.require("js/idb_store.js");
  const { PlatformRuntime } = host.require("js/platform_runtime.js");
  const SandboxDate = host.evaluate("Date");
  const backend = module.selectBackend(PlatformRuntime, options.config || {});
  return {
    host, module, PlatformRuntime, backend,
    indexedDB: module.createIndexedDB(backend),
    date: (ms) => new SandboxDate(ms),
    reopen: () => module.createIndexedDB(module.selectBackend(PlatformRuntime, options.config || {})),
  };
}

test("base64 round-trips every tail length", (t) => {
  const { module } = setup(t, "wechat");
  for (let length = 0; length < 70; length += 1) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 37 + 11) & 255);
    const text = module.encodeBase64(bytes);
    assert.equal(text, Buffer.from(bytes).toString("base64"), `length ${length}`);
    assert.deepEqual([...module.decodeBase64(text)], [...bytes]);
  }
});

test("picks the backend each host can use safely", (t) => {
  assert.equal(setup(t, "wechat").backend.kind, "fs");
  assert.equal(setup(t, "douyin").backend.kind, "fs");
  assert.equal(setup(t, "tiktok").backend.kind, "storage");
  assert.equal(setup(t, "wechat", { config: { persistence: "storage" } }).backend.kind, "storage");
  assert.equal(setup(t, "wechat", { config: { persistence: "off" } }).backend.kind, "memory");
  const noFs = setup(t, "wechat", { extendApi(api) { delete api.getFileSystemManager; } });
  assert.equal(noFs.backend.kind, "storage");
  const nothing = setup(t, "douyin", { extendApi(api) { delete api.getFileSystemManager; delete api.setStorageSync; } });
  assert.equal(nothing.backend.kind, "memory");
  assert.equal(nothing.backend.durable, false);
});

test("runs the upgrade once and then opens without it", async (t) => {
  const { indexedDB, reopen } = setup(t, "wechat");
  let upgrades = 0;
  const open = (factory) => new Promise((resolve) => {
    const req = factory.open("/data", 21);
    req.onupgradeneeded = (event) => {
      upgrades += 1;
      assert.equal(event.oldVersion, 0);
      assert.equal(event.newVersion, 21);
      event.target.result.createObjectStore(STORE).createIndex("timestamp", "timestamp", { unique: false });
    };
    req.onsuccess = () => resolve(req.result);
  });
  const first = await open(indexedDB);
  assert.equal(first.version, 21);
  assert.equal(first.objectStoreNames.contains(STORE), true);
  await open(indexedDB);
  await open(reopen());
  assert.equal(upgrades, 1);
});

for (const platform of ["wechat", "tiktok"]) {
  test(`stores and restores files and directories across launches (${platform})`, async (t) => {
    const first = setup(t, platform);
    const db = await openLikeIdbfs(first.indexedDB);
    const contents = Uint8Array.from({ length: 300 }, (_, index) => index & 255);

    const write = db.transaction([STORE], "readwrite");
    const store = write.objectStore(STORE);
    store.put({ timestamp: first.date(2000), mode: DIR_MODE }, "/data/saves");
    store.put({ timestamp: first.date(3000), mode: FILE_MODE, contents }, "/data/saves/slot1");
    store.put({ timestamp: first.date(1000), mode: FILE_MODE, contents: new Uint8Array(0) }, "/data/empty");
    await completed(write);

    // A new launch: a fresh IndexedDB object over the same host storage.
    const second = {
      wechat: () => first.reopen(),
      tiktok: () => setup(t, "tiktok", { storage: first.host.storage }).indexedDB,
    }[platform]();
    const reopened = await openLikeIdbfs(second);
    const read = reopened.transaction([STORE], "readonly");
    const rows = await cursorKeys(read.objectStore(STORE).index("timestamp"));
    assert.deepEqual(rows, [
      { path: "/data/empty", time: 1000 },
      { path: "/data/saves", time: 2000 },
      { path: "/data/saves/slot1", time: 3000 },
    ]);
    const file = await request(reopened.transaction([STORE], "readonly").objectStore(STORE).get("/data/saves/slot1"));
    assert.equal(file.mode, FILE_MODE);
    assert.equal(file.timestamp.getTime(), 3000);
    assert.deepEqual([...file.contents], [...contents]);
    const directory = await request(reopened.transaction([STORE], "readonly").objectStore(STORE).get("/data/saves"));
    assert.equal(directory.mode, DIR_MODE);
    assert.equal("contents" in directory, false);
    assert.equal(await request(reopened.transaction([STORE], "readonly").objectStore(STORE).get("/data/missing")), undefined);
    assert.equal(first.host.crashed, null);
  });
}

test("the fs backend keeps one file per entry and removes replaced contents", async (t) => {
  const { indexedDB, host, date } = setup(t, "wechat");
  const db = await openLikeIdbfs(indexedDB);
  const put = async (bytes, time) => {
    const transaction = db.transaction([STORE], "readwrite");
    transaction.objectStore(STORE).put({ timestamp: date(time), mode: FILE_MODE, contents: Uint8Array.from(bytes) }, "/data/save");
    await completed(transaction);
  };
  await put([1, 2, 3], 1);
  await put([4, 5, 6, 7], 2);
  await put([8], 3);

  const files = listFiles(host.userDataDir);
  const blobs = files.filter((file) => /\/b\d+\.bin$/.test(file));
  assert.equal(blobs.length, 1, `one blob remains: ${files.join(", ")}`);
  assert.deepEqual([...readFileSync(join(host.userDataDir, blobs[0]))], [8]);
  assert.ok(files.some((file) => file.endsWith("/index.json")));
  assert.ok(!files.some((file) => file.endsWith(".tmp")), "the temporary index was renamed into place");

  const remove = db.transaction([STORE], "readwrite");
  remove.objectStore(STORE).delete("/data/save");
  await completed(remove);
  assert.deepEqual(listFiles(host.userDataDir).filter((file) => file.endsWith(".bin")), []);
});

test("TikTok persistence never touches the file system or enumerates storage", async (t) => {
  const { indexedDB, host, date } = setup(t, "tiktok");
  const db = await openLikeIdbfs(indexedDB);
  const transaction = db.transaction([STORE], "readwrite");
  transaction.objectStore(STORE).put({ timestamp: date(5), mode: FILE_MODE, contents: Uint8Array.from([9, 9]) }, "/data/save");
  await completed(transaction);
  assert.equal(host.crashed, null);
  assert.equal(host.count("getFileSystemManager"), 0);
  assert.equal(host.count("getStorageInfoSync"), 0);
  assert.equal(host.count("fs.writeFileSync"), 0);
  const keys = [...host.storage.keys()];
  assert.ok(keys.some((key) => key.endsWith(":index")));
  assert.ok(keys.some((key) => /:b:\d+$/.test(key)));
  assert.deepEqual(readdirSync(host.userDataDir), []);
});

test("a transaction completes after all of its requests, in order", async (t) => {
  const { indexedDB, date } = setup(t, "wechat");
  const db = await openLikeIdbfs(indexedDB);
  const order = [];
  const transaction = db.transaction([STORE], "readwrite");
  const store = transaction.objectStore(STORE);
  transaction.oncomplete = () => order.push("complete");
  for (const name of ["a", "b", "c"]) {
    store.put({ timestamp: date(1), mode: DIR_MODE }, name).onsuccess = () => {
      order.push(name);
      // A request issued from a success handler keeps the transaction open.
      if (name === "c") store.count().onsuccess = (event) => order.push(`count=${event.target.result}`);
    };
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(order, ["a", "b", "c", "count=3", "complete"]);
});

test("a read-only transaction rejects writes and still completes", async (t) => {
  const { indexedDB, date } = setup(t, "wechat");
  const db = await openLikeIdbfs(indexedDB);
  const transaction = db.transaction([STORE], "readonly");
  const done = completed(transaction);
  await assert.rejects(request(transaction.objectStore(STORE).put({ timestamp: date(1), mode: DIR_MODE }, "x")), /read-only/);
  await done;
  assert.throws(() => db.transaction(["NOPE"], "readonly"), /does not exist/);
});

test("missing contents surface as a request error, not as corrupt data", async (t) => {
  const { indexedDB, host, date } = setup(t, "wechat");
  const db = await openLikeIdbfs(indexedDB);
  const write = db.transaction([STORE], "readwrite");
  write.objectStore(STORE).put({ timestamp: date(1), mode: FILE_MODE, contents: Uint8Array.from([1]) }, "/data/save");
  await completed(write);
  for (const file of listFiles(host.userDataDir).filter((name) => name.endsWith(".bin"))) {
    writeFileSync(join(host.userDataDir, file), "");
    // Remove it entirely to simulate a host that evicted the file.
    (await import("node:fs")).unlinkSync(join(host.userDataDir, file));
  }
  await assert.rejects(request(db.transaction([STORE], "readonly").objectStore(STORE).get("/data/save")), /contents of blob \d+ are missing/);
});

test("an unreadable index starts empty and says so", async (t) => {
  const first = setup(t, "wechat");
  const db = await openLikeIdbfs(first.indexedDB);
  const write = db.transaction([STORE], "readwrite");
  write.objectStore(STORE).put({ timestamp: first.date(1), mode: DIR_MODE }, "/data/x");
  await completed(write);
  const index = listFiles(first.host.userDataDir).find((file) => file.endsWith("/index.json"));
  writeFileSync(join(first.host.userDataDir, index), "{ not json");

  const reopened = await openLikeIdbfs(first.reopen());
  assert.equal(await request(reopened.transaction([STORE], "readonly").objectStore(STORE).count()), 0);
  assert.ok(first.host.warnings().some((line) => /stored index is unreadable/.test(line)));
});

test("refuses to open an older version than the stored one", async (t) => {
  const { indexedDB } = setup(t, "wechat");
  await openLikeIdbfs(indexedDB);
  await assert.rejects(request(indexedDB.open("/data", 3)), /VersionError/);
});

test("deleteDatabase forgets the stored entries", async (t) => {
  const { indexedDB, date, host } = setup(t, "wechat");
  const db = await openLikeIdbfs(indexedDB);
  const write = db.transaction([STORE], "readwrite");
  write.objectStore(STORE).put({ timestamp: date(1), mode: FILE_MODE, contents: Uint8Array.from([1]) }, "/data/x");
  await completed(write);
  await request(indexedDB.deleteDatabase("/data"));
  assert.deepEqual(listFiles(host.userDataDir), []);
  const again = await openLikeIdbfs(indexedDB);
  assert.equal(await request(again.transaction([STORE], "readonly").objectStore(STORE).count()), 0);
  assert.ok(existsSync(host.userDataDir));
});
