/**
 * Builds a synthetic Defold HTML5 bundle for tests.
 *
 * dmloader.js is the real Defold 1.14.0 template, rendered here the way
 * bob.jar renders it. The engine glue and the WebAssembly binary are
 * stand-ins (see test/fixtures/fake_engine_glue.js); the archive is filler
 * with the real file names and split layout.
 */

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { engineStandInWasm } from "./wasm_builder.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, "..", "fixtures");
/** Defold releases whose real loader template is vendored under test/fixtures/. */
export const DEFOLD_RELEASES = Object.freeze({
  "1.14.0": { sdkSha1: "d295ed4edff2e49072719835713e625f409849f1", loaderGeneration: "legacy" },
  "1.14.1": { sdkSha1: "ee283d4dad9fa451dd6399d83602e1dc25133681", loaderGeneration: "session" },
});
export const DEFOLD_VERSIONS = Object.freeze(Object.keys(DEFOLD_RELEASES));
/** The newest vendored release; tests that are not about a version use it. */
export const DEFOLD_VERSION = DEFOLD_VERSIONS[DEFOLD_VERSIONS.length - 1];
export const DEFOLD_SDK_SHA1 = DEFOLD_RELEASES[DEFOLD_VERSION].sdkSha1;

const sha1 = (data) => createHash("sha1").update(data).digest("hex");

/** The subset of Mustache that dmloader.js uses: comments, sections, inverted sections, variables. */
export function renderMustache(template, view) {
  const lookup = (key) => view[key];
  const falsy = (value) => value === undefined || value === null || value === false || value === ""
    || (Array.isArray(value) && value.length === 0);
  let text = template.replace(/\{\{![\s\S]*?\}\}/g, "");
  const section = /\{\{([#^])\s*([\w.\-]+)\s*\}\}([\s\S]*?)\{\{\/\s*\2\s*\}\}/g;
  let previous;
  do {
    previous = text;
    text = text.replace(section, (_, kind, key, inner) => {
      const value = lookup(key);
      if (kind === "^") return falsy(value) ? inner : "";
      if (Array.isArray(value)) {
        return value.map((item) => inner.replace(/\{\{\s*\.\s*\}\}/g, String(item))).join("");
      }
      return falsy(value) ? "" : inner;
    });
  } while (text !== previous);
  return text.replace(/\{\{\{?\s*([\w.\-]+)\s*\}?\}\}/g, (_, key) => {
    const value = lookup(key);
    return value === undefined || value === null ? "" : String(value);
  });
}

export function readLoaderTemplate(version = DEFOLD_VERSION) {
  return readFileSync(join(FIXTURES, `defold-${version}`, "dmloader.template.js"), "utf8");
}

export function readFakeGlue() {
  return readFileSync(join(FIXTURES, "fake_engine_glue.js"), "utf8");
}

function filler(size, seed) {
  const data = Buffer.alloc(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = state >>> 24;
  }
  return data;
}

/**
 * @param {object} [options]
 * @param {string} [options.directory] where to write; a temp folder by default
 * @param {string} [options.exeName]
 * @param {boolean} [options.highDpi]
 * @param {number} [options.width] display.width
 * @param {number} [options.height] display.height
 * @param {number} [options.heapSize]
 * @param {string} [options.glue] engine glue source
 * @param {Uint8Array} [options.wasm]
 * @param {boolean} [options.threadedVariant] also write *_pthread files
 * @param {number} [options.archiveSize] size of game.arcd, split into two pieces
 * @param {boolean} [options.archiveSha1] record sha1 per archive file
 * @param {string} [options.defoldVersion] which vendored loader template to render (default: the newest)
 * @param {string} [options.loaderTemplate] dmloader.js Mustache template; overrides defoldVersion
 * @param {number} [options.minPixelRatio] html5.min_pixel_ratio (Defold 1.14.1+)
 * @param {number} [options.maxPixelRatio] html5.max_pixel_ratio (Defold 1.14.1+)
 * @returns {{ directory: string, exeName: string, archive: Map<string, Buffer> }}
 */
export function makeBundle(options = {}) {
  const directory = options.directory || mkdtempSync(join(tmpdir(), "dmg-bundle-"));
  const defoldVersion = options.defoldVersion || DEFOLD_VERSION;
  const release = DEFOLD_RELEASES[defoldVersion] || { sdkSha1: DEFOLD_SDK_SHA1 };
  const exeName = options.exeName || "HelloMiniGame";
  const glue = options.glue ?? readFakeGlue();
  const wasm = Buffer.from(options.wasm ?? engineStandInWasm());
  mkdirSync(join(directory, "archive"), { recursive: true });

  // Archive: the five files a Defold bundle carries, the big one split in two.
  const arcdSize = options.archiveSize ?? 5000;
  const firstPiece = Math.floor(arcdSize * 0.6);
  const sources = [
    ["game.projectc", [Buffer.from("[project]\ntitle = Hello Mini Game\n[display]\nwidth = 640\n", "utf8")]],
    ["game.arci", [filler(256, 1)]],
    ["game.arcd", [filler(firstPiece, 2), filler(arcdSize - firstPiece, 3)]],
    ["game.dmanifest", [filler(128, 4)]],
    ["game.public.der", [filler(162, 5)]],
  ];
  const archive = new Map();
  const content = [];
  let totalSize = 0;
  for (const [name, parts] of sources) {
    const dot = name.indexOf(".");
    const stem = name.slice(0, dot);
    const extension = name.slice(dot);
    const pieces = [];
    let offset = 0;
    parts.forEach((part, index) => {
      const pieceName = `${stem}${index}${extension}`;
      writeFileSync(join(directory, "archive", pieceName), part);
      pieces.push({ name: pieceName, offset });
      offset += part.length;
    });
    const whole = Buffer.concat(parts);
    archive.set(name, whole);
    const entry = { name, size: whole.length, pieces };
    if (options.archiveSha1) entry.sha1 = sha1(whole);
    content.push(entry);
    totalSize += whole.length;
  }
  const description = JSON.stringify({ content, total_size: totalSize });
  writeFileSync(join(directory, "archive", "archive_files.json"), description);

  const glueBuffer = Buffer.from(glue, "utf8");
  writeFileSync(join(directory, `${exeName}_wasm.js`), glueBuffer);
  writeFileSync(join(directory, `${exeName}.wasm`), wasm);
  if (options.threadedVariant) {
    writeFileSync(join(directory, `${exeName}_pthread_wasm.js`), "// threaded engine glue stand-in\n");
    writeFileSync(join(directory, `${exeName}_pthread.wasm`), wasm);
  }

  const view = {
    DEFOLD_ARCHIVE_LOCATION_PREFIX: "archive",
    DEFOLD_ARCHIVE_LOCATION_SUFFIX: "",
    DEFOLD_ENGINE_ARGUMENTS: ["--verify-graphics-calls=false"],
    DEFOLD_HEAP_SIZE: options.heapSize ?? 268435456,
    "html5.retry_time": 1,
    "html5.retry_count": 10,
    "html5.show_made_with_defold": false,
    "html5.show_fullscreen_button": false,
    "html5.wasm_streaming": "false",
    "html5.verify_downloaded_file_size": true,
    "display.width": options.width ?? 640,
    "display.height": options.height ?? 1136,
    // bob renders game.project values: "1" when set, nothing when unset.
    "display.high_dpi": options.highDpi === true ? 1 : "",
    DEFOLD_MIN_PIXEL_RATIO: options.minPixelRatio ?? 0,
    DEFOLD_MAX_PIXEL_RATIO: options.maxPixelRatio ?? 0,
    DEFOLD_HAS_WEBGPU: false,
    DEFOLD_SCALE_MODE_IS_DOWNSCALE_FIT: true,
    DEFOLD_SCALE_MODE_IS_STRETCH: false,
    DEFOLD_SCALE_MODE_IS_FIT: false,
    DEFOLD_SCALE_MODE_IS_NO_SCALE: false,
    DEFOLD_ARCHIVE_SHA1: sha1(description),
    DEFOLD_WASM_SHA1: sha1(wasm),
    DEFOLD_WASM_SIZE: wasm.length,
    DEFOLD_WASMJS_SHA1: sha1(glueBuffer),
    DEFOLD_WASMJS_SIZE: glueBuffer.length,
    DEFOLD_WASM_PTHREAD_SHA1: "",
    DEFOLD_WASM_PTHREAD_SIZE: 0,
    DEFOLD_WASMJS_PTHREAD_SHA1: "",
    DEFOLD_WASMJS_PTHREAD_SIZE: 0,
    DEFOLD_ENGINE_VERSION: options.engineVersion ?? defoldVersion,
    DEFOLD_SDK_SHA1: release.sdkSha1,
    DEFOLD_HAS_WASM_ENGINE: true,
    DEFOLD_HAS_WASM_PTHREAD_ENGINE: options.threadedVariant ? "true" : "false",
    "exe-name": exeName,
  };
  const template = options.loaderTemplate ?? readLoaderTemplate(defoldVersion);
  writeFileSync(join(directory, "dmloader.js"), renderMustache(template, view));
  writeFileSync(join(directory, "index.html"), "<!DOCTYPE html><html><body><canvas id=\"canvas\"></canvas></body></html>\n");

  return { directory, exeName, archive, defoldVersion, sdkSha1: release.sdkSha1 };
}
