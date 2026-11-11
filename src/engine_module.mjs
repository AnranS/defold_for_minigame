/**
 * Composes dmloader.js and the Emscripten glue into one mini-game module.
 *
 * In a browser the two files share the page's global scope: dmloader.js reads
 * the glue's `FS`, `IDBFS`, `DMSYS`, `GLFW`, and `dmRenderer`, and the glue
 * reads dmloader's `Module`. Mini-game modules have no shared global scope and
 * no `document`, so both files are placed, in order, inside one function whose
 * local variables stand in for the browser globals.
 *
 * Both sources are kept verbatim apart from three mechanical rewrites that are
 * counted and verified:
 *   1. the engine's eval() call is redirected to the Lua bridge;
 *   2. duplicate parameter names are renamed so the file parses in strict mode;
 *   3. nothing else.
 */

import { Script } from "node:vm";

import { ExportError } from "./util.mjs";

export const BOOT_FUNCTION_KEY = "__defoldMiniGameBootEngine";

const HOST = "__defoldMiniGameHost";
const EVAL_BRIDGE = "__defoldMiniGameEval";

/** What the loader needs from every dmloader.js. Checked before anything is written. */
const DMLOADER_CONTRACT = [
  ["var CUSTOM_PARAMETERS", /\bvar CUSTOM_PARAMETERS\s*=/],
  ["var FileLoader", /\bvar FileLoader\s*=/],
  ["var EngineLoader", /\bvar EngineLoader\s*=/],
  ["var GameArchiveLoader", /\bvar GameArchiveLoader\s*=/],
  ["var ProgressView", /\bvar ProgressView\s*=/],
  ["var ProgressUpdater", /\bvar ProgressUpdater\s*=/],
  ["var Module", /\bvar Module\s*=\s*\{/],
  ["Module.onArchiveFileLoaded", /\bonArchiveFileLoaded\s*:\s*function/],
  ["Module.runApp", /\brunApp\s*:\s*function/],
  ["Module.preloadAll", /\bpreloadAll\s*:\s*function/],
  ["Module._callMain", /\b_callMain\s*:\s*function/],
  ["Module.preInit", /\bpreInit\s*:\s*\[/],
  ["Module.onRuntimeInitialized", /Module\[['"]onRuntimeInitialized['"]\]\s*=/],
];

/**
 * Defold has shipped two start-up designs in dmloader.js. The runtime boots
 * each one differently, so the exporter has to know which one it embeds.
 *
 *   legacy   up to 1.14.0: archive and engine callbacks each call
 *            Module._preloadAndCallMain(), which starts main() once all are in.
 *   session  from 1.14.1: GameStartup owns the ordering; Emscripten hooks only
 *            resolve the session's runtime / storage / filesystem signals.
 */
export const LOADER_GENERATIONS = Object.freeze({
  legacy: {
    marker: /\b_preloadAndCallMain\s*:\s*function/,
    contract: [
      ["Module._preloadAndCallMain", /\b_preloadAndCallMain\s*:\s*function/],
      ["Module.onArchiveLoaded", /\bonArchiveLoaded\s*:\s*function/],
    ],
  },
  session: {
    marker: /\bvar GameStartup\s*=/,
    contract: [
      ["var GameStartup", /\bvar GameStartup\s*=/],
      ["GameStartup.begin", /\bbegin\s*:\s*function/],
      ["GameStartup.fail", /\bfail\s*:\s*function/],
      ["EngineLoader.selectEngine", /\bselectEngine\s*:\s*function/],
    ],
  },
});

/** @returns {"legacy"|"session"|null} */
export function detectLoaderGeneration(dmloaderText) {
  if (LOADER_GENERATIONS.session.marker.test(dmloaderText)) return "session";
  if (LOADER_GENERATIONS.legacy.marker.test(dmloaderText)) return "legacy";
  return null;
}

/** What the composed module needs from the Emscripten glue. */
const GLUE_CONTRACT = [
  ["var Module (reuses the loader's Module)", /\bvar Module\s*=\s*typeof Module\s*!==?\s*["']undefined["']\s*\?\s*Module\s*:\s*\{\s*\}/],
  ["Module.instantiateWasm hook", /Module\[["']instantiateWasm["']\]/],
  ["Module.preInit hook", /Module\[["']preInit["']\]/],
  ["var FS", /\bvar FS\s*=/],
  ["var IDBFS", /\bvar IDBFS\s*=/],
  ["var DMSYS", /\bvar DMSYS\s*=/],
];

/**
 * Browser globals the engine may reference as bare identifiers. Each becomes a
 * local variable of the boot function, bound to the adapter's implementation.
 */
const SCOPED_BINDINGS = [
  ["window", "H.window"],
  ["self", "H.window"],
  ["globalThis", "H.window"],
  ["document", "H.document"],
  ["navigator", "H.navigator"],
  ["location", "H.location"],
  ["screen", "H.screen"],
  ["performance", "H.performance"],
  ["crypto", "H.crypto"],
  ["indexedDB", "H.indexedDB"],
  ["XMLHttpRequest", "H.XMLHttpRequest"],
  ["WebSocket", "H.WebSocket"],
  ["WebAssembly", "H.WebAssembly"],
  ["WebGLRenderingContext", "H.WebGLRenderingContext"],
  ["WebGL2RenderingContext", "H.WebGL2RenderingContext"],
  ["Blob", "H.Blob"],
  ["URL", "H.URL"],
  ["Image", "H.Image"],
  ["requestAnimationFrame", "H.requestAnimationFrame"],
  ["cancelAnimationFrame", "H.cancelAnimationFrame"],
  ["setTimeout", "H.window.setTimeout"],
  ["clearTimeout", "H.window.clearTimeout"],
  ["setInterval", "H.window.setInterval"],
  ["clearInterval", "H.window.clearInterval"],
  ["addEventListener", "H.window.addEventListener"],
  ["removeEventListener", "H.window.removeEventListener"],
  ["alert", "H.window.alert"],
  ["confirm", "H.window.confirm"],
  ["prompt", "H.window.prompt"],
  // Nothing in a mini-game package can be fetched; the engine falls back to XHR.
  ["fetch", "undefined"],
  // Keep Emscripten from mistaking a Node-based developer tool for Node.js,
  // and from exporting itself through a CommonJS wrapper.
  ["process", "undefined"],
  ["require", "undefined"],
  ["module", "undefined"],
  ["exports", "undefined"],
  ["define", "undefined"],
  ["importScripts", "undefined"],
  ["WorkerGlobalScope", "undefined"],
  [EVAL_BRIDGE, "H.runScript"],
];

/**
 * Identifiers dmloader.js assigns without declaring. They are implicit globals
 * in a browser and a ReferenceError in strict mode, so they are declared here.
 */
const IMPLICIT_GLOBALS = ["i", "total", "downloaded"];

const EVAL_CALL = /(?<![\w$.])eval\(/g;
const DUPLICATE_UNDERSCORE_PARAMETERS = /function\s*\(\s*_\s*,\s*_\s*\)/g;

function assertContract(label, text, contract) {
  const missing = contract.filter(([, pattern]) => !pattern.test(text)).map(([name]) => name);
  if (missing.length > 0) {
    throw new ExportError(
      `${label} does not match the layout this exporter understands; missing: ${missing.join(", ")}`,
      { hint: "This Defold version changed its HTML5 loader. Check the support matrix or report the engine version." },
    );
  }
}

function assertCompiles(text, label) {
  for (const [mode, prefix] of [["sloppy", ""], ["strict", "\"use strict\";\n"]]) {
    try {
      // Compile only; the generated module is never executed by the exporter.
      new Script(prefix + text, { filename: `defold_engine.${mode}.js` });
    } catch (error) {
      throw new ExportError(
        `${label} does not parse in ${mode} mode: ${error.message}`,
        { hint: "Mini-game toolchains may compile every file in strict mode." },
      );
    }
  }
}

/**
 * @param {{ dmloaderText: string, glueText: string, engineVersion: string, engineSdkSha1: string,
 *           toolVersion: string, allowMissingBridge?: boolean }} input
 */
export function composeEngineModule(input) {
  const { dmloaderText, glueText } = input;
  for (const [label, text] of [["dmloader.js", dmloaderText], ["the engine glue", glueText]]) {
    if (text.includes(HOST) || text.includes(EVAL_BRIDGE) || text.includes(BOOT_FUNCTION_KEY)) {
      throw new ExportError(`${label} already contains identifiers reserved by the exporter`);
    }
  }
  if (/\bimport\.meta\b/.test(glueText) || /^\s*export\s+default\b/m.test(glueText)) {
    throw new ExportError("the engine glue is an ES module; only the classic script build is supported");
  }

  assertContract("dmloader.js", dmloaderText, DMLOADER_CONTRACT);
  const generation = detectLoaderGeneration(dmloaderText);
  if (!generation) {
    throw new ExportError(
      "dmloader.js does not match the layout this exporter understands; "
      + "missing: Module._preloadAndCallMain (Defold up to 1.14.0) or GameStartup (Defold 1.14.1 and later)",
      { hint: "This Defold version changed its HTML5 loader. Check the support matrix or report the engine version." },
    );
  }
  assertContract("dmloader.js", dmloaderText, LOADER_GENERATIONS[generation].contract);
  assertContract("The engine glue", glueText, GLUE_CONTRACT);

  const evalSites = (glueText.match(EVAL_CALL) || []).length;
  if (evalSites === 0 && !input.allowMissingBridge) {
    throw new ExportError(
      "the engine glue contains no eval() call to route html5.run() through",
      { hint: "The minigame Lua module needs html5.run(). Pass --allow-missing-bridge to export without it." },
    );
  }
  const patchedGlue = glueText.replace(EVAL_CALL, `${EVAL_BRIDGE}(`);
  if ((patchedGlue.match(EVAL_CALL) || []).length !== 0) {
    throw new ExportError("an eval() call survived the bridge rewrite");
  }

  const duplicateParameters = (dmloaderText.match(DUPLICATE_UNDERSCORE_PARAMETERS) || []).length;
  const patchedLoader = dmloaderText.replace(DUPLICATE_UNDERSCORE_PARAMETERS, "function(_, _unused)");

  // The host object keeps its long name: the glue declares its own short
  // top-level variables, and any of them could shadow a one-letter alias.
  const bindings = SCOPED_BINDINGS
    .map(([name, source]) => `var ${name} = ${source.replace(/^H\./, `${HOST}.`)};`)
    .join("\n");
  const banner = [
    "/**",
    ` * Generated by defold-minigame ${input.toolVersion}. Do not edit.`,
    ` * Defold ${input.engineVersion || "unknown"} (${input.engineSdkSha1 || "unknown sdk"}):`,
    " * dmloader.js and the engine glue, verbatim, inside one scoped module.",
    " * Defold is licensed under the Defold License 1.0, https://defold.com/license",
    " */",
  ].join("\n");

  const text = `${banner}
;(function (root) {
function bootDefoldEngine(${HOST}) {
${bindings}
var ${IMPLICIT_GLOBALS.join(", ")};

/* ---------------------------------------------------------------- dmloader.js */
${patchedLoader}

/* ------------------------------------------------------------ host configuration */
;${HOST}.configure({
  CUSTOM_PARAMETERS: CUSTOM_PARAMETERS,
  FileLoader: FileLoader,
  EngineLoader: EngineLoader,
  GameArchiveLoader: GameArchiveLoader,
  ProgressView: ProgressView,
  ProgressUpdater: ProgressUpdater,
  Module: Module,
  GameStartup: typeof GameStartup !== "undefined" ? GameStartup : undefined,
  generation: "${generation}"
});

/* ---------------------------------------------------------------- engine glue */
${patchedGlue}

;${HOST}.onGlueLoaded({ Module: Module });
}
root.${BOOT_FUNCTION_KEY} = bootDefoldEngine;
})(typeof GameGlobal !== "undefined" ? GameGlobal : globalThis);
`;

  assertCompiles(text, "the composed engine module");

  return {
    text,
    report: {
      loaderGeneration: generation,
      evalSites,
      duplicateParameterRewrites: duplicateParameters,
      scopedBindings: SCOPED_BINDINGS.map(([name]) => name),
      bytes: Buffer.byteLength(text, "utf8"),
    },
  };
}
