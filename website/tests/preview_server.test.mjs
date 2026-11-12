/**
 * The preview server exists so that someone can look at the site locally.
 * The address it reports must therefore show this site, never whatever else
 * happens to listen on the machine.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { buildSite } from "../build.mjs";
import { DEFAULT_PORT, startPreviewServer } from "../lib/preview_server.mjs";

let root;

before(() => {
  root = mkdtempSync(join(tmpdir(), "defold-minigame-preview-"));
  buildSite({ outDir: root });
});

after(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A raw request: the path is sent as written, without client-side normalisation. */
function get(port, path, host = "127.0.0.1") {
  return new Promise((done, fail) => {
    const call = request({ host, port, path, method: "GET" }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => done({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    call.on("error", fail);
    call.end();
  });
}

/** Another program's server: listens the way dev servers do, on every address. */
function foreignServer() {
  const listenOn = (host) => new Promise((done, fail) => {
    const server = createServer((_, response) => response.end("<title>somebody else's project</title>"));
    server.once("error", fail);
    server.listen(0, host, () => done(server));
  });
  // "::" takes IPv4 connections too; a machine without IPv6 gets the IPv4 wildcard.
  return listenOn("::").catch(() => listenOn("0.0.0.0"));
}

const closeServer = (server) => new Promise((done) => server.close(() => done()));

test("serves the pages, the stylesheet, and folders with their slash", async (t) => {
  const server = await startPreviewServer({ root, port: 47901 });
  t.after(() => server.close());
  assert.equal(server.url, `http://127.0.0.1:${server.port}/`);

  const home = await get(server.port, "/");
  assert.equal(home.status, 200);
  assert.equal(home.headers["content-type"], "text/html; charset=utf-8");
  assert.ok(home.body.includes("<title>Defold Mini Game"));

  const english = await get(server.port, "/en/guide/");
  assert.equal(english.status, 200);
  assert.ok(english.body.includes('<html lang="en">'));

  const css = await get(server.port, "/assets/site.css");
  assert.equal(css.status, 200);
  assert.equal(css.headers["content-type"], "text/css; charset=utf-8");
  const screenshot = await get(server.port, "/screenshots/apitest-wechat-devtools-1.png");
  assert.equal(screenshot.status, 200);
  assert.equal(screenshot.headers["content-type"], "image/png");
  const video = await get(server.port, "/videos/island.mp4");
  assert.equal(video.status, 200);
  assert.equal(video.headers["content-type"], "video/mp4");

  // Relative links only work from a folder address.
  const folder = await get(server.port, "/guide");
  assert.equal(folder.status, 301);
  assert.equal(folder.headers.location, "/guide/");

  assert.equal((await get(server.port, "/nothing-here/")).status, 404);
});

test("does not serve files outside the site", async (t) => {
  const server = await startPreviewServer({ root, port: 47911 });
  t.after(() => server.close());
  for (const path of ["/%2e%2e/%2e%2e/etc/hosts", "/..%2f..%2fpackage.json", "/assets/%2e%2e/%2e%2e/build.mjs"]) {
    const response = await get(server.port, path);
    assert.ok([403, 404].includes(response.status), `${path} answered ${response.status}`);
    assert.ok(!response.body.includes("localhost") && !response.body.includes("defold-minigame"), path);
  }
  assert.equal((await get(server.port, "/%E0%A4%A")).status, 400);
});

test("answers on localhost as well as on 127.0.0.1", async (t) => {
  const server = await startPreviewServer({ root, port: 47921 });
  t.after(() => server.close());
  let viaName;
  try {
    viaName = await get(server.port, "/", "localhost");
  } catch (error) {
    t.skip(`localhost does not resolve here: ${error.code}`);
    return;
  }
  assert.ok(viaName.body.includes("<title>Defold Mini Game"));
});

test("moves to the next port when another program has the one it wanted", async (t) => {
  const foreign = await foreignServer();
  t.after(() => closeServer(foreign));
  const busy = foreign.address().port;

  const server = await startPreviewServer({ root, port: busy });
  t.after(() => server.close());
  assert.notEqual(server.port, busy);
  assert.deepEqual(server.skipped.slice(0, 1), [busy]);
  // The address that is reported shows this site, not the other program's.
  const page = await get(server.port, "/");
  assert.ok(page.body.includes("<title>Defold Mini Game"));
  assert.ok((await get(busy, "/")).body.includes("somebody else's project"));
});

test("a port the user chose is never swapped for another one", async (t) => {
  const foreign = await foreignServer();
  t.after(() => closeServer(foreign));
  const busy = foreign.address().port;
  await assert.rejects(
    startPreviewServer({ root, port: busy, strict: true }),
    new RegExp(`port ${busy} is in use by another program`),
  );
});

test("refuses to start without a built site, and rejects a bad port", async () => {
  const empty = mkdtempSync(join(tmpdir(), "defold-minigame-empty-"));
  try {
    await assert.rejects(startPreviewServer({ root: empty }), /has no index\.html/);
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
  await assert.rejects(startPreviewServer({ root, port: Number("abc") }), /is not a port number/);
  await assert.rejects(startPreviewServer({ root, port: 70000 }), /is not a port number/);
});

test("the default port is not one that common tools use", () => {
  for (const common of [3000, 4173, 5173, 8000, 8080]) assert.notEqual(DEFAULT_PORT, common);
});
