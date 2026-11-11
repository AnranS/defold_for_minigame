#!/usr/bin/env node
/**
 * Builds a real Defold HTML5 bundle out of one of the examples on defold.com,
 * for trying an export in a developer tool without installing Defold.
 *
 *   node scripts/fetch_example_bundle.mjs --example sprite/flip --out <folder>
 *
 * The examples on https://defold.com/examples/ are HTML5 builds made by
 * Defold's own build: a real engine (with the native extensions the examples
 * project uses) and a real game archive per example. The site serves them
 * through a loader of its own that shares one engine between all examples, so
 * this script puts the pieces back into the shape bob writes:
 *
 *   dmloader.js            Defold's stock loader template at the engine's
 *                          exact commit, rendered with this project's values
 *   <name>_wasm.js, .wasm  the engine the site serves
 *   archive/               the example's archive, as served
 *
 * The one thing that is not Defold's is the rendering of the loader template,
 * which bob would do; scripts/verify_engine.mjs relies on the same renderer.
 *
 * Nothing is executed here. The files are downloaded and written to disk.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { renderMustache } from "../test/helpers/bundle_fixture.mjs";

const SITE = "https://defold.com";
const LOADER_PATHS = [
  "com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/bundle/resources/web/dmloader.js",
  "com.dynamo.cr/com.dynamo.cr.bob/src/com/dynamo/bob/bundle/resources/jsweb/dmloader.js",
];

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

async function download(url, { binary = false, optional = false } = {}) {
  const response = await fetch(url);
  if (!response.ok) {
    if (optional) return null;
    throw new Error(`GET ${url} → ${response.status}`);
  }
  return binary ? Buffer.from(await response.arrayBuffer()) : response.text();
}

const sha1 = (data) => createHash("sha1").update(data).digest("hex");

/** game.projectc is the project's settings as an ini file. */
function parseProject(text) {
  const settings = {};
  let section = "";
  for (const line of text.split("\n")) {
    const header = /^\[([\w.]+)\]\s*$/.exec(line);
    if (header) { section = header[1]; continue; }
    const pair = /^([\w.]+)\s*=\s*(.*)$/.exec(line);
    if (pair) settings[`${section}.${pair[1]}`] = pair[2].trim();
  }
  return settings;
}

function field(loader, name) {
  const match = new RegExp(`\\b${name}\\s*:\\s*"([^"]*)"`).exec(loader);
  if (!match) throw new Error(`the example's loader has no ${name}; the site may have changed how it serves the engine`);
  return match[1];
}

async function main() {
  const example = argument("--example");
  const out = argument("--out");
  if (!example || !out || !/^[\w-]+\/[\w-]+$/.test(example)) {
    console.error("usage: node scripts/fetch_example_bundle.mjs --example <category>/<name> --out <folder>");
    console.error("       for example --example sprite/flip; see https://defold.com/examples/");
    return 2;
  }
  const directory = resolve(out);
  if (existsSync(directory) && readdirSync(directory).length > 0) {
    console.error(`${directory} is not empty; choose a new folder`);
    return 2;
  }

  const base = `${SITE}/examples/${example}`;
  const page = await download(`${base}/`);
  const exeName = (/EngineLoader\.load\(\s*"[^"]*"\s*,\s*"([^"]+)"\s*\)/.exec(page) || [])[1];
  if (!exeName) throw new Error(`${base}/ does not start a Defold engine; is "${example}" an example?`);

  const siteLoader = await download(`${base}/dmloader.js`);
  const engineVersion = field(siteLoader, "engineVersion");
  const engineSha1 = field(siteLoader, "engineSdkSha1");
  const glue = await download(new URL(field(siteLoader, "wasmjs_file"), SITE).href);
  const wasm = await download(new URL(field(siteLoader, "wasm_file"), SITE).href, { binary: true });

  let template = null;
  for (const ref of [engineVersion, engineSha1]) {
    for (const path of LOADER_PATHS) {
      template = await download(`https://raw.githubusercontent.com/defold/defold/${ref}/${path}`, { optional: true });
      if (template) break;
    }
    if (template) break;
  }
  if (!template) throw new Error(`Defold's dmloader.js was not found at ${engineVersion} or ${engineSha1}`);

  const description = await download(`${base}/archive/archive_files.json`);
  const archive = JSON.parse(description);
  mkdirSync(join(directory, "archive"), { recursive: true });
  writeFileSync(join(directory, "archive", "archive_files.json"), description);
  let project = null;
  for (const entry of archive.content) {
    const pieces = [];
    for (const piece of entry.pieces) {
      const data = await download(`${base}/archive/${piece.name}`, { binary: true });
      writeFileSync(join(directory, "archive", piece.name), data);
      pieces.push(data);
    }
    const whole = Buffer.concat(pieces);
    if (whole.length !== entry.size) throw new Error(`${entry.name} is ${whole.length} bytes, the archive description says ${entry.size}`);
    if (entry.name === "game.projectc") project = parseProject(whole.toString("utf8"));
  }
  if (!project) throw new Error("the archive has no game.projectc");

  // The values bob takes from game.project when it renders the loader.
  const setting = (key, fallback) => (project[key] !== undefined && project[key] !== "" ? project[key] : fallback);
  const scaleMode = setting("html5.scale_mode", "downscale_fit");
  const glueBuffer = Buffer.from(glue, "utf8");
  const view = {
    DEFOLD_ARCHIVE_LOCATION_PREFIX: "archive",
    DEFOLD_ARCHIVE_LOCATION_SUFFIX: "",
    DEFOLD_ENGINE_ARGUMENTS: setting("html5.engine_arguments", "").split(",").map((entry) => entry.trim()).filter(Boolean),
    DEFOLD_HEAP_SIZE: Number(setting("html5.heap_size", "256")) * 1024 * 1024,
    "html5.retry_time": setting("html5.retry_time", "1"),
    "html5.retry_count": setting("html5.retry_count", "10"),
    "html5.show_made_with_defold": false,
    "html5.show_fullscreen_button": false,
    "html5.wasm_streaming": "false",
    "html5.verify_downloaded_file_size": true,
    "display.width": Number(setting("display.width", "960")),
    "display.height": Number(setting("display.height", "640")),
    "display.high_dpi": setting("display.high_dpi", "0") === "1" ? 1 : "",
    DEFOLD_MIN_PIXEL_RATIO: Number(setting("html5.min_pixel_ratio", "0")),
    DEFOLD_MAX_PIXEL_RATIO: Number(setting("html5.max_pixel_ratio", "0")),
    DEFOLD_HAS_WEBGPU: false,
    DEFOLD_SCALE_MODE_IS_DOWNSCALE_FIT: scaleMode === "downscale_fit",
    DEFOLD_SCALE_MODE_IS_STRETCH: scaleMode === "stretch",
    DEFOLD_SCALE_MODE_IS_FIT: scaleMode === "fit",
    DEFOLD_SCALE_MODE_IS_NO_SCALE: scaleMode === "no_scale",
    DEFOLD_ARCHIVE_SHA1: sha1(description),
    DEFOLD_WASM_SHA1: sha1(wasm),
    DEFOLD_WASM_SIZE: wasm.length,
    DEFOLD_WASMJS_SHA1: sha1(glueBuffer),
    DEFOLD_WASMJS_SIZE: glueBuffer.length,
    DEFOLD_WASM_PTHREAD_SHA1: "",
    DEFOLD_WASM_PTHREAD_SIZE: 0,
    DEFOLD_WASMJS_PTHREAD_SHA1: "",
    DEFOLD_WASMJS_PTHREAD_SIZE: 0,
    DEFOLD_ENGINE_VERSION: engineVersion,
    DEFOLD_SDK_SHA1: engineSha1,
    DEFOLD_HAS_WASM_ENGINE: true,
    DEFOLD_HAS_WASM_PTHREAD_ENGINE: "false",
    "exe-name": exeName,
  };

  writeFileSync(join(directory, "dmloader.js"), renderMustache(template, view));
  writeFileSync(join(directory, `${exeName}_wasm.js`), glueBuffer);
  writeFileSync(join(directory, `${exeName}.wasm`), wasm);
  writeFileSync(join(directory, "index.html"),
    `<!DOCTYPE html><html><body><canvas id="canvas"></canvas><script src="dmloader.js"></script>`
    + `<script>EngineLoader.load("canvas", "${exeName}");</script></body></html>\n`);

  console.log(`Defold example ${example}: "${setting("project.title", exeName)}", main collection ${setting("bootstrap.main_collection", "?")}`);
  console.log(`  engine   Defold ${engineVersion} (${engineSha1}), ${wasm.length} byte binary, ${glueBuffer.length} byte glue`);
  console.log(`  archive  ${archive.total_size} bytes in ${archive.content.length} files`);
  console.log(`  display  ${view["display.width"]}x${view["display.height"]}, high dpi ${view["display.high_dpi"] === 1 ? "on" : "off"}, heap ${view.DEFOLD_HEAP_SIZE / 1048576} MB`);
  console.log(`  bundle   ${directory}`);
  return 0;
}

main().then((code) => { process.exitCode = code; }, (error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
