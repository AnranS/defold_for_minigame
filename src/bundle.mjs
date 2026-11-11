/**
 * Reads and validates a Defold HTML5 bundle.
 *
 * The input is what `Project > Bundle > HTML5 Application` or
 * `bob.jar --platform wasm-web bundle` writes: dmloader.js, the Emscripten
 * glue `<exe>_wasm.js`, `<exe>.wasm`, and `archive/` with archive_files.json
 * and the game archive split into pieces. Nothing is modified here.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { ExportError, isDirectory, isFile, sha1 } from "./util.mjs";

function matchValue(text, pattern) {
  const match = pattern.exec(text);
  return match ? match[1] : null;
}

/** Extracts the values bob.jar rendered into dmloader.js. */
export function parseDmloader(text) {
  if (/\{\{\s*[#^/]?\s*[A-Za-z_.\-]+\s*\}\}/.test(text)) {
    throw new ExportError(
      "dmloader.js still contains unrendered {{template}} markers",
      { hint: "Export from a bundle produced by Defold, not from the engine source template." },
    );
  }
  const heap = matchValue(text, /custom_heap_size\s*:\s*(\d+)/);
  const wasmSize = matchValue(text, /\bwasm_size\s*:\s*(\d+)/);
  const wasmJsSize = matchValue(text, /\bwasmjs_size\s*:\s*(\d+)/);
  const display = /var width = (\d+);\s*var height = (\d+);/.exec(text);
  const engineArguments = [];
  const argumentsBlock = matchValue(text, /engine_arguments\s*:\s*\[([^\]]*)\]/);
  if (argumentsBlock) {
    for (const match of argumentsBlock.matchAll(/"((?:[^"\\]|\\.)*)"/g)) engineArguments.push(match[1]);
  }
  return {
    engineVersion: matchValue(text, /engineVersion\s*:\s*"([^"]*)"/) || "",
    engineSdkSha1: matchValue(text, /engineSdkSha1\s*:\s*"([^"]*)"/) || "",
    heapSizeBytes: heap ? Number(heap) : null,
    engineArguments,
    wasmSha1: matchValue(text, /\bwasm_sha1\s*:\s*"([0-9a-fA-F]*)"/) || "",
    wasmSize: wasmSize ? Number(wasmSize) : null,
    wasmJsSha1: matchValue(text, /\bwasmjs_sha1\s*:\s*"([0-9a-fA-F]*)"/) || "",
    wasmJsSize: wasmJsSize ? Number(wasmJsSize) : null,
    archiveSha1: matchValue(text, /\barc_sha1\s*:\s*"([0-9a-fA-F]*)"/) || "",
    hasPthreadEngine: /Module\["isWASMPthreadSupported"\]\s*=\s*true\b/.test(text),
    // Up to Defold 1.14.0 the loader reads devicePixelRatio only when
    // display.high_dpi is set; from 1.14.1 it passes the flag to getPixelRatio().
    highDpi: /dpi\s*=\s*window\.devicePixelRatio\s*\|\|\s*1/.test(text)
      || /var dpi = Module\["getPixelRatio"\]\(\s*(?:1|true)\s*\)/.test(text),
    // html5.min_pixel_ratio / html5.max_pixel_ratio; 0 means "not set".
    minPixelRatio: Number(matchValue(text, /var minRatio = ([0-9.]+);/)) || 0,
    maxPixelRatio: Number(matchValue(text, /var maxRatio = ([0-9.]+);/)) || 0,
    displayWidth: display ? Number(display[1]) : null,
    displayHeight: display ? Number(display[2]) : null,
  };
}

function findExecutable(directory) {
  const names = readdirSync(directory);
  const glue = names.filter((name) => name.endsWith("_wasm.js") && !name.endsWith("_pthread_wasm.js"));
  const threadedOnly = names.filter((name) => name.endsWith("_pthread_wasm.js"));
  if (glue.length === 0) {
    if (threadedOnly.length > 0) {
      throw new ExportError(
        "the bundle only contains the threaded engine (*_pthread_wasm.js)",
        { hint: "Mini-game hosts have no WebAssembly threads. Bundle with the wasm-web architecture enabled." },
      );
    }
    if (names.some((name) => name.endsWith("_asmjs.js"))) {
      throw new ExportError(
        "the bundle only contains an asm.js engine",
        { hint: "Bundle with the wasm-web architecture; asm.js engines are not supported." },
      );
    }
    throw new ExportError(
      `no <name>_wasm.js engine glue was found in ${directory}`,
      { hint: "Point --bundle at the folder that contains dmloader.js and index.html." },
    );
  }
  if (glue.length > 1) {
    throw new ExportError(`the bundle contains more than one engine glue file: ${glue.join(", ")}`);
  }
  const exeName = glue[0].slice(0, -"_wasm.js".length);
  return { exeName, glueName: glue[0], wasmName: `${exeName}.wasm`, hasThreadedVariant: threadedOnly.length > 0 };
}

function readArchive(directory, dmloader) {
  const archiveDirectory = join(directory, "archive");
  const descriptionPath = join(archiveDirectory, "archive_files.json");
  if (!isFile(descriptionPath)) {
    throw new ExportError(
      "archive/archive_files.json is missing from the bundle",
      { hint: "Bundle the project again; the game archive is part of every HTML5 bundle." },
    );
  }
  const descriptionText = readFileSync(descriptionPath, "utf8");
  if (dmloader.archiveSha1 && sha1(descriptionText) !== dmloader.archiveSha1.toLowerCase()) {
    throw new ExportError("archive/archive_files.json does not match the hash recorded in dmloader.js");
  }
  let description;
  try {
    description = JSON.parse(descriptionText);
  } catch (error) {
    throw new ExportError(`archive/archive_files.json is not valid JSON: ${error.message}`);
  }
  if (!description || !Array.isArray(description.content) || description.content.length === 0) {
    throw new ExportError("archive/archive_files.json lists no archive files");
  }

  const files = [];
  const seenPieces = new Set();
  for (const entry of description.content) {
    if (!entry || typeof entry.name !== "string" || !Array.isArray(entry.pieces) || entry.pieces.length === 0) {
      throw new ExportError("archive/archive_files.json contains a malformed entry");
    }
    if (!/^[A-Za-z0-9._-]+$/.test(entry.name)) {
      throw new ExportError(`unexpected archive file name '${entry.name}'`);
    }
    const pieces = [];
    let total = 0;
    for (const piece of entry.pieces) {
      if (typeof piece.name !== "string" || !/^[A-Za-z0-9._-]+$/.test(piece.name)) {
        throw new ExportError(`unexpected archive piece name '${piece && piece.name}'`);
      }
      if (seenPieces.has(piece.name)) throw new ExportError(`archive piece ${piece.name} is listed twice`);
      seenPieces.add(piece.name);
      const piecePath = join(archiveDirectory, piece.name);
      if (!isFile(piecePath)) throw new ExportError(`archive piece archive/${piece.name} is missing`);
      const data = readFileSync(piecePath);
      const offset = Number(piece.offset) || 0;
      if (offset !== total) {
        throw new ExportError(`archive piece ${piece.name} starts at ${offset}, expected ${total}`);
      }
      total += data.length;
      pieces.push({ name: piece.name, offset, size: data.length, data });
    }
    const size = Number(entry.size);
    if (Number.isFinite(size) && size !== total) {
      throw new ExportError(`${entry.name} is ${total} bytes on disk, but archive_files.json records ${size}`);
    }
    if (typeof entry.sha1 === "string" && entry.sha1 !== "") {
      const digest = sha1(Buffer.concat(pieces.map((piece) => piece.data)));
      if (digest !== entry.sha1.toLowerCase()) {
        throw new ExportError(`${entry.name} does not match the hash in archive_files.json`);
      }
    }
    files.push({ name: entry.name, size: total, pieces });
  }
  return { files, totalSize: files.reduce((sum, file) => sum + file.size, 0) };
}

/**
 * @param {string} directory path of the HTML5 bundle
 */
export function readBundle(directory) {
  if (!isDirectory(directory)) throw new ExportError(`the bundle directory does not exist: ${directory}`);
  const dmloaderPath = join(directory, "dmloader.js");
  if (!isFile(dmloaderPath)) {
    throw new ExportError(
      `dmloader.js was not found in ${directory}`,
      { hint: "Point --bundle at the folder that contains dmloader.js and index.html." },
    );
  }
  const dmloaderText = readFileSync(dmloaderPath, "utf8");
  const dmloader = parseDmloader(dmloaderText);
  const executable = findExecutable(directory);

  const wasmPath = join(directory, executable.wasmName);
  if (!isFile(wasmPath)) throw new ExportError(`${executable.wasmName} is missing from the bundle`);
  const wasm = readFileSync(wasmPath);
  const glueBuffer = readFileSync(join(directory, executable.glueName));
  const glueText = glueBuffer.toString("utf8");

  if (dmloader.wasmSize !== null && dmloader.wasmSize !== wasm.length) {
    throw new ExportError(
      `${executable.wasmName} is ${wasm.length} bytes, but dmloader.js records ${dmloader.wasmSize}`,
      { hint: "The bundle was modified after Defold wrote it. Bundle the project again." },
    );
  }
  if (dmloader.wasmSha1 && sha1(wasm) !== dmloader.wasmSha1.toLowerCase()) {
    throw new ExportError(`${executable.wasmName} does not match the hash recorded in dmloader.js`);
  }
  if (dmloader.wasmJsSize !== null && dmloader.wasmJsSize !== glueBuffer.length) {
    throw new ExportError(
      `${executable.glueName} is ${glueBuffer.length} bytes, but dmloader.js records ${dmloader.wasmJsSize}`,
      { hint: "The bundle was modified after Defold wrote it. Bundle the project again." },
    );
  }
  if (dmloader.wasmJsSha1 && sha1(glueBuffer) !== dmloader.wasmJsSha1.toLowerCase()) {
    throw new ExportError(`${executable.glueName} does not match the hash recorded in dmloader.js`);
  }

  return {
    directory,
    exeName: executable.exeName,
    glueName: executable.glueName,
    wasmName: executable.wasmName,
    hasThreadedVariant: executable.hasThreadedVariant,
    dmloader,
    dmloaderText,
    glueText,
    wasm,
    archive: readArchive(directory, dmloader),
  };
}
