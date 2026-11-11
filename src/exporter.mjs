/**
 * Export orchestration: one Defold HTML5 bundle → one mini-game project for
 * exactly one of WeChat, Douyin, or TikTok Native.
 *
 * Stages: read and verify the bundle → scan the WebAssembly binary → compose
 * the engine module → assemble the package → check package limits → publish
 * through the output guard.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants as zlibConstants } from "node:zlib";

import { readBundle } from "./bundle.mjs";
import { composeEngineModule } from "./engine_module.mjs";
import { MANIFEST_NAME, publish } from "./output_guard.mjs";
import { getPlatform } from "./platforms.mjs";
import {
  ExportError, REPO_ROOT, formatBytes, isDirectory, isInside, listFiles, loadSupportMatrix,
} from "./util.mjs";
import { evaluateWasmScan, scanWasm } from "./wasm_features.mjs";

const RUNTIME_ROOT = join(REPO_ROOT, "runtime");
const ENGINE_SUBPACKAGE = "engine";
const WASM_FILE = "dmengine.wasm";

/** Runtime files copied verbatim into every export: [source under runtime/common, output path]. */
const COMMON_RUNTIME_FILES = [
  ["adapter.js", "adapter.js"],
  ["js/platform_runtime.js", "js/platform_runtime.js"],
  ["js/loader.js", "js/loader.js"],
  ["js/idb_store.js", "js/idb_store.js"],
  ["js/bridge.js", "js/bridge.js"],
  ["engine_game.js", `${ENGINE_SUBPACKAGE}/game.js`],
];

/** Folder inside the package that receives the files passed with --assets. */
const ASSETS_DIRECTORY = "assets";

/** The entry file a host runs when it loads a subpackage; ours have nothing to run. */
const SUBPACKAGE_ENTRY = "game.js";

/**
 * A subpackage is a top-level folder of the package, so its name is a folder
 * name on every file system and a value in game.json on every host.
 */
const SUBPACKAGE_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;

/** Top-level names the export writes itself (compared without case: macOS and Windows fold it). */
const RESERVED_NAMES = new Set([
  ENGINE_SUBPACKAGE, ASSETS_DIRECTORY, "js", "game.js", "game.json", "adapter.js",
  "project.config.json", "project.private.config.json", MANIFEST_NAME,
].map((name) => name.toLowerCase()));

/**
 * Extensions the WeChat developer tool uploads; anything else stays on the
 * developer's disk. The other hosts publish no list, so this one is used as
 * the conservative common denominator for the warning below.
 */
const UPLOADABLE_EXTENSIONS = new Set((
  "png jpg jpeg gif svg js json cer obj dae fbx mtl stl 3ds mp3 pvr wav plist ttf fnt gz ccz m4a mp4 bmp atlas "
  + "swf ani part proto bin sk mipmaps txt zip tt map ogg silk dbbin dbmv etc lmat lm ls lh lani lav lsani ltc "
  + "aac astc br csv cur dat dds glb gltf ico ktx lmani lml pkm prefab scene skel wasm xml"
).split(" "));

/**
 * The developer tool's project files. The export creates them; after that the
 * developer tool writes to them: Douyin's rewrites project.config.json when it
 * opens the project, and all of them keep the project settings of their UI
 * there. A later export leaves what it finds and only keeps the App ID, the
 * project type and, when one is given, the name in step.
 */
const PROJECT_FILES = ["project.config.json", "project.private.config.json"];

const ORIENTATIONS = new Set(["portrait", "landscape", "auto"]);
const ENGINE_AUDIO = new Set(["auto", "on", "off"]);
const PERSISTENCE = new Set(["auto", "fs", "storage", "off"]);

function renderTemplate(path, values) {
  const template = readFileSync(path, "utf8");
  const rendered = template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`template ${path} uses an unknown placeholder ${key}`);
    return JSON.stringify(String(values[key])).slice(1, -1);
  });
  // Re-serialising proves the result is still valid JSON after substitution.
  return `${JSON.stringify(JSON.parse(rendered), null, 2)}\n`;
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** Adds the keys of `defaults` that `target` lacks, at every depth. */
function fillDefaults(target, defaults) {
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in target)) target[key] = value;
    else if (isPlainObject(target[key]) && isPlainObject(value)) fillDefaults(target[key], value);
  }
  return target;
}

/**
 * What to write for one of the developer tool's project files: the export's
 * own version, or the version in the output folder brought up to date.
 */
function projectFile(name, rendered, options, warnings) {
  const path = join(options.outputDir, name);
  const ours = existsSync(join(options.outputDir, MANIFEST_NAME));
  if (options.force || !ours || !existsSync(path)) return rendered;
  let existing;
  try {
    existing = JSON.parse(readFileSync(path, "utf8"));
  } catch (_) {
    existing = null;
  }
  if (!isPlainObject(existing)) {
    warnings.push(`${name} was not valid JSON and was written anew`);
    return rendered;
  }
  const fresh = JSON.parse(rendered);
  const merged = fillDefaults(existing, fresh);
  merged.appid = fresh.appid;
  if ("compileType" in fresh) merged.compileType = fresh.compileType;
  if (options.name) {
    merged.projectname = fresh.projectname;
    if (fresh.description) merged.description = fresh.description;
  }
  return `${JSON.stringify(merged, null, 2)}\n`;
}

function resolveOrientation(requested, dmloader) {
  if (requested !== "auto") return requested;
  if (dmloader.displayWidth && dmloader.displayHeight) {
    return dmloader.displayWidth > dmloader.displayHeight ? "landscape" : "portrait";
  }
  return "portrait";
}

function normaliseOptions(options) {
  if (!options || typeof options !== "object") throw new ExportError("export options are required");
  const platform = getPlatform(options.platform);

  if (!options.bundleDir) throw new ExportError("the HTML5 bundle directory is required (--bundle)");
  if (!options.outputDir) throw new ExportError("the output directory is required (--output)");
  const bundleDir = resolve(String(options.bundleDir));
  const outputDir = resolve(String(options.outputDir));
  if (isInside(bundleDir, outputDir) || isInside(outputDir, bundleDir)) {
    throw new ExportError(
      "the output directory and the HTML5 bundle must not contain one another",
      { hint: "Export to a folder outside the bundle, for example ../minigame-wechat." },
    );
  }

  const appId = String(options.appId || "").trim();
  if (appId === "") {
    throw new ExportError(
      "an App ID is required (--appid)",
      { hint: "Use the App ID from the platform console; for TikTok this is the Client Key." },
    );
  }

  const orientation = String(options.orientation || "auto");
  if (!ORIENTATIONS.has(orientation)) throw new ExportError(`unknown orientation '${orientation}'`);
  const engineAudio = String(options.engineAudio || "auto");
  if (!ENGINE_AUDIO.has(engineAudio)) throw new ExportError(`unknown engine audio mode '${engineAudio}'`);
  const persistence = String(options.persistence || "auto");
  if (!PERSISTENCE.has(persistence)) throw new ExportError(`unknown persistence mode '${persistence}'`);

  let pixelRatio = options.pixelRatio === undefined ? "auto" : options.pixelRatio;
  if (pixelRatio !== "auto") {
    pixelRatio = Number(pixelRatio);
    if (!Number.isFinite(pixelRatio) || pixelRatio <= 0 || pixelRatio > 4) {
      throw new ExportError("the pixel ratio must be 'auto' or a number between 0 and 4");
    }
  }
  // null: take html5.max_pixel_ratio from the project, or 2 when it sets none.
  const maxPixelRatio = options.maxPixelRatio === undefined || options.maxPixelRatio === null
    ? null
    : Number(options.maxPixelRatio);
  if (maxPixelRatio !== null && (!Number.isFinite(maxPixelRatio) || maxPixelRatio < 1 || maxPixelRatio > 4)) {
    throw new ExportError("the maximum pixel ratio must be between 1 and 4");
  }

  let heapSizeBytes = 0;
  if (options.heapSizeMb !== undefined && options.heapSizeMb !== null) {
    const megabytes = Number(options.heapSizeMb);
    if (!Number.isFinite(megabytes) || megabytes < 32 || megabytes > 2048) {
      throw new ExportError("the heap size must be between 32 and 2048 MB");
    }
    // WebAssembly memory is sized in 64 KiB pages.
    heapSizeBytes = Math.ceil((megabytes * 1024 * 1024) / 65536) * 65536;
  }

  let totalLimit = platform.limits.total;
  if (options.totalLimitMb !== undefined && options.totalLimitMb !== null) {
    const megabytes = Number(options.totalLimitMb);
    if (!Number.isFinite(megabytes) || megabytes <= 0) throw new ExportError("the total package limit must be positive");
    totalLimit = Math.round(megabytes * 1024 * 1024);
  }

  const brotliQuality = options.brotliQuality === undefined ? 11 : Number(options.brotliQuality);
  if (!Number.isInteger(brotliQuality) || brotliQuality < 0 || brotliQuality > 11) {
    throw new ExportError("the Brotli quality must be an integer from 0 to 11");
  }

  let assetsDir = null;
  if (options.assetsDir !== undefined && options.assetsDir !== null && options.assetsDir !== "") {
    assetsDir = resolve(String(options.assetsDir));
    if (!isDirectory(assetsDir)) throw new ExportError(`the assets directory does not exist: ${assetsDir}`);
    if (isInside(assetsDir, outputDir) || isInside(outputDir, assetsDir)) {
      throw new ExportError("the output directory and the assets directory must not contain one another");
    }
  }

  const subpackages = normaliseSubpackages(options.subpackages, outputDir);

  return {
    platform,
    bundleDir,
    outputDir,
    assetsDir,
    subpackages,
    appId,
    orientation,
    name: options.name ? String(options.name) : null,
    engineAudio,
    persistence,
    pixelRatio,
    maxPixelRatio,
    heapSizeBytes,
    totalLimit,
    brotli: options.brotli !== false,
    brotliQuality,
    loadingText: options.loadingText === undefined ? platform.text.loadingText : String(options.loadingText),
    startTimeoutMs: Number(options.startTimeoutMs) > 0 ? Number(options.startTimeoutMs) : 45000,
    extraEngineArguments: Array.isArray(options.engineArguments) ? options.engineArguments.map(String) : [],
    allowWasmFeatures: Array.isArray(options.allowWasmFeatures) ? options.allowWasmFeatures.map(String) : [],
    allowMissingBridge: options.allowMissingBridge === true,
    force: options.force === true,
  };
}

/** The game's own subpackages: [{ name, dir }] → the same list, checked and resolved. */
function normaliseSubpackages(requested, outputDir) {
  if (requested === undefined || requested === null) return [];
  if (!Array.isArray(requested)) throw new ExportError("subpackages must be a list of { name, dir }");
  const subpackages = [];
  const seen = new Set();
  for (const entry of requested) {
    const name = String(entry && entry.name !== undefined && entry.name !== null ? entry.name : "");
    if (RESERVED_NAMES.has(name.toLowerCase())) {
      throw new ExportError(
        `the subpackage name '${name}' is used by the export itself`,
        { hint: "Choose another name; the folder of that name in the package holds the engine or the runtime." },
      );
    }
    if (!SUBPACKAGE_NAME.test(name)) {
      throw new ExportError(
        `'${name}' is not a usable subpackage name`,
        { hint: "Start with a letter and use only letters, digits, '-' and '_' (32 characters at most)." },
      );
    }
    if (seen.has(name.toLowerCase())) throw new ExportError(`the subpackage '${name}' is declared twice`);
    seen.add(name.toLowerCase());

    if (!entry.dir) throw new ExportError(`the subpackage '${name}' needs a folder (--subpackage ${name}=<dir>)`);
    const dir = resolve(String(entry.dir));
    if (!isDirectory(dir)) throw new ExportError(`the folder of subpackage '${name}' does not exist: ${dir}`);
    if (isInside(dir, outputDir) || isInside(outputDir, dir)) {
      throw new ExportError(`the output directory and the folder of subpackage '${name}' must not contain one another`);
    }
    subpackages.push({ name, dir });
  }
  return subpackages;
}

/**
 * Copies a folder of loose files into the package under `prefix`.
 * Hidden files stay out. Returns how many files went in, and adds the
 * extensions a developer tool would not upload to `notUploadable`.
 */
function addLooseFiles(files, directory, prefix, notUploadable) {
  let count = 0;
  for (const file of listFiles(directory)) {
    if (file.split("/").some((part) => part.startsWith("."))) continue;
    const dot = file.lastIndexOf(".");
    const extension = dot === -1 ? "" : file.slice(dot + 1).toLowerCase();
    if (!UPLOADABLE_EXTENSIONS.has(extension)) notUploadable.add(extension === "" ? "(none)" : `.${extension}`);
    files.set(`${prefix}/${file}`, readFileSync(join(directory, file)));
    count += 1;
  }
  return count;
}

function compressWasm(wasm, quality) {
  const compressed = brotliCompressSync(wasm, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: quality,
      [zlibConstants.BROTLI_PARAM_SIZE_HINT]: wasm.length,
    },
  });
  if (!brotliDecompressSync(compressed).equals(wasm)) {
    throw new Error("the Brotli round trip of the engine binary did not reproduce the input");
  }
  return compressed;
}

function bootConfigSource(config) {
  return `// Generated by defold-minigame ${config.toolVersion}. Do not edit.
const config = ${JSON.stringify(config, null, 2)};
const root = typeof GameGlobal !== "undefined" ? GameGlobal : globalThis;
root.__defoldMiniGameConfig = config;
export default config;
`;
}

/**
 * Reads a bundle and reports what an export would do, without writing anything.
 */
export function inspectBundle(bundleDir) {
  const bundle = readBundle(resolve(String(bundleDir)));
  const scan = scanWasm(new Uint8Array(bundle.wasm));
  const matrix = loadSupportMatrix();
  const engine = matrix.engines.find((entry) => entry.defoldVersion === bundle.dmloader.engineVersion) || null;
  return {
    bundle,
    scan,
    policy: evaluateWasmScan(scan),
    engineRecord: engine,
  };
}

/**
 * Exports a Defold HTML5 bundle as a mini-game project.
 * @returns {{ outputDir: string, platform: string, sizes: object, warnings: string[], report: object, manifest: object }}
 */
export function exportMiniGame(rawOptions) {
  const options = normaliseOptions(rawOptions);
  const matrix = loadSupportMatrix();
  const { platform } = options;
  const warnings = [];

  // 1. Bundle
  const bundle = readBundle(options.bundleDir);
  if (bundle.hasThreadedVariant) {
    warnings.push("the bundle also contains a threaded engine; only the single-threaded wasm-web engine is exported");
  }

  // 2. WebAssembly features
  const scan = scanWasm(new Uint8Array(bundle.wasm));
  const policy = evaluateWasmScan(scan, { allow: options.allowWasmFeatures });
  warnings.push(...policy.warnings);
  if (!policy.ok) {
    throw new ExportError(
      `the engine binary cannot be exported: ${policy.errors.join("; ")}`,
      { hint: "Rebuild the engine without those features, or allow one explicitly with --allow-wasm-feature." },
    );
  }

  // 3. Engine version
  const engineVersion = bundle.dmloader.engineVersion;
  const engineRecord = matrix.engines.find((entry) => entry.defoldVersion === engineVersion) || null;
  if (!engineRecord) {
    warnings.push(
      `Defold ${engineVersion || "(unknown version)"} is not in the support matrix; `
      + "the loader contract matched, but this engine version has not been analysed",
    );
  }

  // 4. Engine module
  const engineModule = composeEngineModule({
    dmloaderText: bundle.dmloaderText,
    glueText: bundle.glueText,
    engineVersion,
    engineSdkSha1: bundle.dmloader.engineSdkSha1,
    toolVersion: matrix.toolVersion,
    allowMissingBridge: options.allowMissingBridge,
  });
  if (engineModule.report.evalSites === 0) {
    warnings.push("html5.run() is not bridged; the minigame Lua module will report that no host is available");
  }

  // 5. Package
  const files = new Map();
  for (const [source, target] of COMMON_RUNTIME_FILES) {
    files.set(target, readFileSync(join(RUNTIME_ROOT, "common", source)));
  }
  const platformRoot = join(RUNTIME_ROOT, platform.name);
  const orientation = resolveOrientation(options.orientation, bundle.dmloader);
  const projectName = options.name || bundle.exeName;
  const templateValues = { ORIENTATION: orientation, NAME: projectName, APPID: options.appId };
  files.set("game.js", readFileSync(join(platformRoot, "game.js")));
  const gameJson = JSON.parse(renderTemplate(join(platformRoot, "game.json.template"), templateValues));
  for (const subpackage of options.subpackages) {
    gameJson[platform.subpackageField].push({ root: `${subpackage.name}/`, name: subpackage.name });
  }
  files.set("game.json", `${JSON.stringify(gameJson, null, 2)}\n`);
  for (const name of PROJECT_FILES) {
    if (name === "project.private.config.json" && !platform.hasPrivateConfig) continue;
    const rendered = renderTemplate(join(platformRoot, `${name}.template`), templateValues);
    files.set(name, projectFile(name, rendered, options, warnings));
  }
  files.set("js/defold_engine.js", engineModule.text);

  const wasmPath = options.brotli ? `${ENGINE_SUBPACKAGE}/${WASM_FILE}.br` : `${ENGINE_SUBPACKAGE}/${WASM_FILE}`;
  const wasmData = options.brotli ? compressWasm(bundle.wasm, options.brotliQuality) : bundle.wasm;
  files.set(wasmPath, wasmData);

  const archive = [];
  for (const file of bundle.archive.files) {
    const pieces = [];
    for (const piece of file.pieces) {
      // Hosts only upload whitelisted extensions; `.bin` is on every list.
      const path = `${ENGINE_SUBPACKAGE}/archive/${piece.name}.bin`;
      files.set(path, piece.data);
      pieces.push({ path, offset: piece.offset, size: piece.size });
    }
    archive.push({ name: file.name, size: file.size, pieces });
  }

  // Loose files the game reaches by path: InnerAudio sources, share images.
  if (options.assetsDir) {
    const skipped = new Set();
    addLooseFiles(files, options.assetsDir, ASSETS_DIRECTORY, skipped);
    if (skipped.size > 0) {
      warnings.push(
        `assets with these extensions are not on the upload whitelist and may be left out by the developer tool: ${[...skipped].sort().join(", ")}`,
      );
    }
  }

  // The game's own subpackages: files it downloads when it asks for them,
  // outside the main package and its limit.
  const subpackageReport = [];
  for (const subpackage of options.subpackages) {
    const skipped = new Set();
    const count = addLooseFiles(files, subpackage.dir, subpackage.name, skipped);
    if (count === 0) {
      throw new ExportError(`the folder of subpackage '${subpackage.name}' has no files: ${subpackage.dir}`);
    }
    if (skipped.size > 0) {
      warnings.push(
        `files in subpackage '${subpackage.name}' with these extensions are not on the upload whitelist `
        + `and may be left out by the developer tool: ${[...skipped].sort().join(", ")}`,
      );
    }
    // A host loads a subpackage by running its entry file; the folder may bring its own.
    const entry = `${subpackage.name}/${SUBPACKAGE_ENTRY}`;
    const generated = !files.has(entry);
    if (generated) files.set(entry, readFileSync(join(RUNTIME_ROOT, "common", "engine_game.js")));
    subpackageReport.push({ name: subpackage.name, files: count + (generated ? 1 : 0), bytes: 0 });
  }

  const bootConfig = {
    schema: matrix.runtimeSchema,
    toolVersion: matrix.toolVersion,
    bridgeAbi: matrix.bridgeAbi,
    platform: platform.name,
    exeName: bundle.exeName,
    engineVersion,
    engineSdkSha1: bundle.dmloader.engineSdkSha1,
    engineSubpackage: ENGINE_SUBPACKAGE,
    subpackages: options.subpackages.map((subpackage) => subpackage.name),
    wasm: { candidates: [wasmPath], size: bundle.wasm.length, packagedSize: wasmData.length },
    archive,
    heapSizeBytes: options.heapSizeBytes,
    loaderGeneration: engineModule.report.loaderGeneration,
    highDpi: bundle.dmloader.highDpi,
    pixelRatio: options.pixelRatio,
    minPixelRatio: bundle.dmloader.minPixelRatio || 0,
    maxPixelRatio: options.maxPixelRatio ?? (bundle.dmloader.maxPixelRatio > 0 ? bundle.dmloader.maxPixelRatio : 2),
    engineAudio: options.engineAudio,
    persistence: options.persistence,
    loadingText: options.loadingText,
    failureTitle: platform.text.failureTitle,
    startTimeoutMs: options.startTimeoutMs,
    extraEngineArguments: options.extraEngineArguments,
  };
  files.set("js/boot_config.js", bootConfigSource(bootConfig));

  // 6. Package limits
  let mainBytes = 0;
  let engineBytes = 0;
  let totalBytes = 0;
  const subpackageBytes = new Map(options.subpackages.map((subpackage) => [subpackage.name, 0]));
  for (const [path, content] of files) {
    const size = typeof content === "string" ? Buffer.byteLength(content, "utf8") : content.length;
    const slash = path.indexOf("/");
    const top = slash === -1 ? null : path.slice(0, slash);
    totalBytes += size;
    if (top === ENGINE_SUBPACKAGE) engineBytes += size;
    else if (subpackageBytes.has(top)) subpackageBytes.set(top, subpackageBytes.get(top) + size);
    else mainBytes += size;
  }
  for (const entry of subpackageReport) entry.bytes = subpackageBytes.get(entry.name);
  const sizes = {
    main: mainBytes,
    engineSubpackage: engineBytes,
    subpackages: Object.fromEntries(subpackageBytes),
    total: totalBytes,
    wasm: bundle.wasm.length,
    wasmPackaged: wasmData.length,
    archive: bundle.archive.totalSize,
    engineModule: engineModule.report.bytes,
    limits: { main: platform.limits.main, total: options.totalLimit },
  };
  if (mainBytes > platform.limits.main) {
    throw new ExportError(
      `the main package is ${formatBytes(mainBytes)}, above the ${formatBytes(platform.limits.main)} limit of ${platform.displayName}`,
      { hint: "The main package only holds the engine glue and the runtime; a custom engine with many extensions can exceed it." },
    );
  }
  if (totalBytes > options.totalLimit) {
    throw new ExportError(
      `the package is ${formatBytes(totalBytes)}, above the ${formatBytes(options.totalLimit)} limit of ${platform.displayName}`,
      { hint: "Reduce the game archive (texture compression) or the subpackages, or raise the limit with --total-limit-mb if your account allows it." },
    );
  }
  if (!options.brotli) {
    warnings.push("the engine binary is not Brotli-compressed; the package is larger than it needs to be");
  }
  const effectiveHeap = options.heapSizeBytes || bundle.dmloader.heapSizeBytes || 0;
  if (effectiveHeap > 512 * 1024 * 1024) {
    warnings.push(`the WebAssembly heap starts at ${formatBytes(effectiveHeap)}; low-memory phones may refuse it`);
  }

  // 7. Publish
  const manifest = publish({
    outputDir: options.outputDir,
    files,
    force: options.force,
    shared: PROJECT_FILES,
    manifest: {
      toolVersion: matrix.toolVersion,
      bridgeAbi: matrix.bridgeAbi,
      platform: platform.name,
      appId: options.appId,
      orientation,
      engine: {
        defoldVersion: engineVersion,
        loaderGeneration: engineModule.report.loaderGeneration,
        sdkSha1: bundle.dmloader.engineSdkSha1,
        exeName: bundle.exeName,
        inSupportMatrix: engineRecord !== null,
      },
    },
  });

  return {
    outputDir: options.outputDir,
    platform: platform.name,
    orientation,
    sizes,
    warnings,
    manifest,
    report: {
      exeName: bundle.exeName,
      engineVersion,
      engineInSupportMatrix: engineRecord !== null,
      engineModule: engineModule.report,
      wasm: {
        features: Object.keys(scan.features).filter((name) => scan.features[name]),
        blocking: scan.blocking,
        functions: scan.functions.defined,
        memory: scan.memory,
      },
      archiveFiles: archive.map((file) => ({ name: file.name, size: file.size, pieces: file.pieces.length })),
      subpackages: subpackageReport,
      fileCount: files.size,
    },
  };
}
