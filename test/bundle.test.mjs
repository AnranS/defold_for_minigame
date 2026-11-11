import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { parseDmloader, readBundle } from "../src/bundle.mjs";
import { ExportError } from "../src/util.mjs";
import {
  DEFOLD_RELEASES, DEFOLD_SDK_SHA1, DEFOLD_VERSION, DEFOLD_VERSIONS, makeBundle, readLoaderTemplate,
} from "./helpers/bundle_fixture.mjs";

function bundle(t, options) {
  const made = makeBundle(options);
  t.after(() => rmSync(made.directory, { recursive: true, force: true }));
  return made;
}

test("reads a complete bundle and the values bob rendered into dmloader.js", (t) => {
  const made = bundle(t, { exeName: "MyGame", width: 1280, height: 720, highDpi: true, heapSize: 134217728 });
  const read = readBundle(made.directory);
  assert.equal(read.exeName, "MyGame");
  assert.equal(read.glueName, "MyGame_wasm.js");
  assert.equal(read.wasmName, "MyGame.wasm");
  assert.equal(read.hasThreadedVariant, false);
  assert.equal(read.dmloader.engineVersion, DEFOLD_VERSION);
  assert.equal(read.dmloader.engineSdkSha1, DEFOLD_SDK_SHA1);
  assert.equal(read.dmloader.heapSizeBytes, 134217728);
  assert.equal(read.dmloader.highDpi, true);
  assert.equal(read.dmloader.displayWidth, 1280);
  assert.equal(read.dmloader.displayHeight, 720);
  assert.deepEqual(read.dmloader.engineArguments, ["--verify-graphics-calls=false"]);
  assert.equal(read.dmloader.hasPthreadEngine, false);
  assert.equal(read.dmloader.wasmSize, read.wasm.length);
  assert.equal(read.dmloader.wasmSha1.length, 40);
});

test("reassembles the archive description, including split files", (t) => {
  const made = bundle(t, { archiveSize: 9000 });
  const read = readBundle(made.directory);
  assert.deepEqual(read.archive.files.map((file) => file.name),
    ["game.projectc", "game.arci", "game.arcd", "game.dmanifest", "game.public.der"]);
  const arcd = read.archive.files.find((file) => file.name === "game.arcd");
  assert.equal(arcd.size, 9000);
  assert.equal(arcd.pieces.length, 2);
  assert.deepEqual(arcd.pieces.map((piece) => piece.offset), [0, 5400]);
  assert.ok(Buffer.concat(arcd.pieces.map((piece) => piece.data)).equals(made.archive.get("game.arcd")));
  assert.equal(read.archive.totalSize, [...made.archive.values()].reduce((sum, data) => sum + data.length, 0));
});

for (const defoldVersion of DEFOLD_VERSIONS) {
  test(`reads display.high_dpi and the release identity from a Defold ${defoldVersion} loader`, (t) => {
    const off = readBundle(bundle(t, { defoldVersion }).directory).dmloader;
    assert.equal(off.highDpi, false);
    assert.equal(off.engineVersion, defoldVersion);
    assert.equal(off.engineSdkSha1, DEFOLD_RELEASES[defoldVersion].sdkSha1);
    assert.equal(off.displayWidth, 640);
    assert.equal(off.displayHeight, 1136);
    assert.equal(readBundle(bundle(t, { defoldVersion, highDpi: true }).directory).dmloader.highDpi, true);
  });
}

test("reads html5.min_pixel_ratio and html5.max_pixel_ratio where the loader has them", (t) => {
  const set = readBundle(bundle(t, { defoldVersion: "1.14.1", minPixelRatio: 1.5, maxPixelRatio: 3 }).directory).dmloader;
  assert.equal(set.minPixelRatio, 1.5);
  assert.equal(set.maxPixelRatio, 3);
  const unset = readBundle(bundle(t, { defoldVersion: "1.14.1" }).directory).dmloader;
  assert.equal(unset.minPixelRatio, 0);
  assert.equal(unset.maxPixelRatio, 0);
  const older = readBundle(bundle(t, { defoldVersion: "1.14.0" }).directory).dmloader;
  assert.equal(older.maxPixelRatio, 0);
});

test("notes a threaded engine next to the single-threaded one", (t) => {
  const read = readBundle(bundle(t, { threadedVariant: true }).directory);
  assert.equal(read.hasThreadedVariant, true);
  assert.equal(read.exeName, "HelloMiniGame");
  assert.equal(read.dmloader.hasPthreadEngine, true);
});

test("refuses a bundle that only has the threaded engine", (t) => {
  const made = bundle(t, { threadedVariant: true });
  unlinkSync(join(made.directory, "HelloMiniGame_wasm.js"));
  assert.throws(() => readBundle(made.directory), (error) => {
    assert.ok(error instanceof ExportError);
    assert.match(error.message, /only contains the threaded engine/);
    assert.match(error.hint, /wasm-web/);
    return true;
  });
});

test("explains what is missing", (t) => {
  const empty = mkdtempSync(join(tmpdir(), "dmg-empty-"));
  t.after(() => rmSync(empty, { recursive: true, force: true }));
  assert.throws(() => readBundle(join(empty, "nope")), /does not exist/);
  assert.throws(() => readBundle(empty), /dmloader\.js was not found/);

  const noWasm = bundle(t, {});
  unlinkSync(join(noWasm.directory, "HelloMiniGame.wasm"));
  assert.throws(() => readBundle(noWasm.directory), /HelloMiniGame\.wasm is missing/);

  const noArchive = bundle(t, {});
  unlinkSync(join(noArchive.directory, "archive", "archive_files.json"));
  assert.throws(() => readBundle(noArchive.directory), /archive_files\.json is missing/);

  const noPiece = bundle(t, {});
  unlinkSync(join(noPiece.directory, "archive", "game1.arcd"));
  assert.throws(() => readBundle(noPiece.directory), /archive\/game1\.arcd is missing/);
});

test("detects a bundle that was modified after Defold wrote it", (t) => {
  const wasm = bundle(t, {});
  appendFileSync(join(wasm.directory, "HelloMiniGame.wasm"), Buffer.from([0]));
  assert.throws(() => readBundle(wasm.directory), /dmloader\.js records/);

  const glue = bundle(t, {});
  const gluePath = join(glue.directory, "HelloMiniGame_wasm.js");
  const text = readFileSync(gluePath, "utf8");
  writeFileSync(gluePath, text.replace("stand-in", "stand+in"));
  assert.throws(() => readBundle(glue.directory), /does not match the hash recorded in dmloader\.js/);

  const piece = bundle(t, {});
  appendFileSync(join(piece.directory, "archive", "game0.arci"), Buffer.from([1, 2, 3]));
  assert.throws(() => readBundle(piece.directory), /archive_files\.json records/);

  const description = bundle(t, {});
  appendFileSync(join(description.directory, "archive", "archive_files.json"), " ");
  assert.throws(() => readBundle(description.directory), /does not match the hash recorded in dmloader\.js/);
});

test("verifies per-file hashes when the bundle carries them", (t) => {
  const made = bundle(t, { archiveSha1: true });
  assert.equal(readBundle(made.directory).archive.files.length, 5);
  // Same size, different content: only the hash can tell.
  const path = join(made.directory, "archive", "game0.dmanifest");
  const data = readFileSync(path);
  data[0] ^= 0xff;
  writeFileSync(path, data);
  assert.throws(() => readBundle(made.directory), /game\.dmanifest does not match the hash/);
});

test("refuses the unrendered engine template", () => {
  for (const defoldVersion of DEFOLD_VERSIONS) {
    assert.throws(() => parseDmloader(readLoaderTemplate(defoldVersion)), /unrendered/);
  }
});
