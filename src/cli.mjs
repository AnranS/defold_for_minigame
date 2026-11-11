/**
 * Command-line interface. No dependencies beyond Node.js.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildBundle } from "./bob.mjs";
import { exportMiniGame, inspectBundle } from "./exporter.mjs";
import { PLATFORM_NAMES, getPlatform } from "./platforms.mjs";
import { ExportError, formatBytes, loadSupportMatrix } from "./util.mjs";
import { FEATURE_LABELS } from "./wasm_features.mjs";

const HELP = `defold-minigame — export a Defold HTML5 bundle as a WeChat, Douyin, or TikTok mini game

Usage:
  defold-minigame export  --bundle <dir> --platform <name> --appid <id> --output <dir> [options]
  defold-minigame build   --project <dir> --bob <bob.jar> --platform <name> --appid <id> --output <dir> [options]
  defold-minigame inspect --bundle <dir>
  defold-minigame --version | --help

Commands:
  export     Convert an HTML5 bundle written by Defold (Project > Bundle > HTML5 Application).
  build      Run bob.jar on a Defold project first, then export the bundle it produced.
  inspect    Report what a bundle contains and whether it can be exported. Writes nothing.

Required for export and build:
  --platform <name>          ${PLATFORM_NAMES.join(" | ")}
  --appid <id>               App ID from the platform console (TikTok: the Client Key)
  --output <dir>             Destination folder: empty, or one this tool exported before

Input:
  --bundle <dir>             (export, inspect) folder that contains dmloader.js
  --project <dir>            (build) folder that contains game.project
  --bob <path>               (build) bob.jar matching your Defold version
  --java <path>              (build) java executable to run bob.jar with (default: java)
  --variant <name>           (build) release | debug (default: release)

Options:
  --name <text>              Project name shown in the developer tool (default: the bundle's name)
  --orientation <mode>       portrait | landscape | auto (default: auto, from display.width/height)
  --heap-size <MB>           Initial WebAssembly heap; default is the project's html5.heap_size
  --pixel-ratio <auto|n>     Canvas backing scale; auto follows display.high_dpi (default: auto)
  --max-pixel-ratio <n>      Upper bound for the automatic pixel ratio (default: 2)
  --engine-audio <mode>      auto | on | off; auto keeps the engine mixer off on TikTok (default: auto)
  --persistence <mode>       auto | fs | storage | off; where sys.save() data is kept (default: auto)
  --assets <dir>             Copy a folder of loose files into the package as assets/
  --subpackage <name>=<dir>  Ship a folder as a subpackage the game loads with
                             minigame.load_subpackage("<name>"); repeatable
  --loading-text <text>      Text of the host loading indicator; "" disables it
  --engine-arg <arg>         Extra engine argument; repeatable
  --total-limit-mb <MB>      Override the platform's total package limit
  --no-brotli                Ship the engine binary uncompressed
  --allow-wasm-feature <f>   Export although the engine uses a blocked WebAssembly feature; repeatable
  --allow-missing-bridge     Export although html5.run() cannot be bridged
  --force                    Replace exporter-owned files that were edited by hand
  --json                     Print the result as JSON
`;

const FLAGS = new Set(["--no-brotli", "--allow-missing-bridge", "--force", "--json", "--help", "-h", "--version", "-v"]);
const REPEATABLE = new Set(["--engine-arg", "--allow-wasm-feature", "--subpackage"]);
const VALUE_OPTIONS = new Set([
  "--bundle", "--project", "--bob", "--java", "--variant", "--platform", "--appid", "--output", "--name",
  "--orientation", "--heap-size", "--pixel-ratio", "--max-pixel-ratio", "--engine-audio", "--persistence",
  "--loading-text", "--total-limit-mb", "--brotli-quality", "--start-timeout-ms", "--assets",
]);

class UsageError extends Error {}

export function parseArguments(argv) {
  const positional = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    let token = argv[index];
    let inlineValue;
    if (token.startsWith("--") && token.includes("=")) {
      const split = token.indexOf("=");
      inlineValue = token.slice(split + 1);
      token = token.slice(0, split);
    }
    if (!token.startsWith("-")) { positional.push(token); continue; }
    if (FLAGS.has(token)) { options[token] = true; continue; }
    if (!VALUE_OPTIONS.has(token) && !REPEATABLE.has(token)) throw new UsageError(`unknown option ${token}`);
    let value = inlineValue;
    if (value === undefined) {
      index += 1;
      if (index >= argv.length) throw new UsageError(`${token} needs a value`);
      value = argv[index];
    }
    if (REPEATABLE.has(token)) (options[token] ||= []).push(value);
    else options[token] = value;
  }
  return { positional, options };
}

/** "levels=res/levels" → { name: "levels", dir: "res/levels" }; the name ends at the first "=". */
function subpackageOptions(values) {
  return (values || []).map((value) => {
    const split = value.indexOf("=");
    if (split <= 0 || split === value.length - 1) {
      throw new UsageError(`--subpackage expects <name>=<dir>, got '${value}'`);
    }
    return { name: value.slice(0, split), dir: value.slice(split + 1) };
  });
}

function exportOptions(options, bundleDir) {
  const pixelRatio = options["--pixel-ratio"];
  return {
    bundleDir,
    platform: options["--platform"],
    appId: options["--appid"],
    outputDir: options["--output"],
    name: options["--name"],
    orientation: options["--orientation"],
    heapSizeMb: options["--heap-size"],
    pixelRatio: pixelRatio === undefined || pixelRatio === "auto" ? pixelRatio : Number(pixelRatio),
    maxPixelRatio: options["--max-pixel-ratio"],
    engineAudio: options["--engine-audio"],
    persistence: options["--persistence"],
    loadingText: options["--loading-text"],
    assetsDir: options["--assets"],
    subpackages: subpackageOptions(options["--subpackage"]),
    engineArguments: options["--engine-arg"],
    totalLimitMb: options["--total-limit-mb"],
    brotli: !options["--no-brotli"],
    brotliQuality: options["--brotli-quality"] === undefined ? undefined : Number(options["--brotli-quality"]),
    startTimeoutMs: options["--start-timeout-ms"],
    allowWasmFeatures: options["--allow-wasm-feature"],
    allowMissingBridge: options["--allow-missing-bridge"] === true,
    force: options["--force"] === true,
  };
}

function printExportResult(result, out) {
  const platform = getPlatform(result.platform);
  const { sizes, report } = result;
  out(`Exported ${report.exeName} (Defold ${report.engineVersion || "unknown"}) for ${platform.displayName}`);
  out(`  output          ${result.outputDir}`);
  out(`  orientation     ${result.orientation}`);
  out(`  main package    ${formatBytes(sizes.main)} of ${formatBytes(sizes.limits.main)}`);
  out(`  engine package  ${formatBytes(sizes.engineSubpackage)}`
    + ` (engine ${formatBytes(sizes.wasmPackaged)} from ${formatBytes(sizes.wasm)}, archive ${formatBytes(sizes.archive)})`);
  for (const subpackage of report.subpackages) {
    out(`  subpackage      ${subpackage.name}  ${formatBytes(subpackage.bytes)} in ${subpackage.files} files`);
  }
  out(`  total           ${formatBytes(sizes.total)} of ${formatBytes(sizes.limits.total)}`);
  out(`  html5.run       ${report.engineModule.evalSites > 0 ? "bridged to the minigame Lua module" : "not bridged"}`);
  for (const warning of result.warnings) out(`  warning         ${warning}`);
  out("");
  out("Next steps:");
  if (platform.name === "tiktok") {
    out(`  1. cd ${result.outputDir}`);
    out("  2. ttmg init with the same Client Key, then ttmg dev");
  } else {
    out(`  1. Open ${result.outputDir} in ${platform.devtool}`);
    out("  2. Preview on a phone before you submit");
  }
  const { devtoolCompile, realDevice } = platform.validation;
  if (devtoolCompile === "verified" && realDevice === "verified") {
    out(`  Exports of this tool have run with ${platform.devtool} and on phones, iOS and Android.`);
    out("  That was a test app: try your own game on a device before you submit.");
  } else if (devtoolCompile === "verified") {
    out(`  Exports of this tool have run in the simulator of ${platform.devtool}, and on no phone yet;`);
    out("  a real device is the acceptance gate.");
  } else {
    out("  The export is checked by automated tests against a simulated host only;");
    out("  the developer tool and a real device are the acceptance gates.");
  }
}

function printInspection(inspection, out) {
  const { bundle, scan, policy, engineRecord } = inspection;
  const used = Object.keys(scan.features).filter((name) => scan.features[name]);
  out(`Bundle          ${bundle.directory}`);
  out(`Executable      ${bundle.exeName}`);
  out(`Defold          ${bundle.dmloader.engineVersion || "unknown"} (${bundle.dmloader.engineSdkSha1 || "unknown sdk"})`);
  out(`Support matrix  ${engineRecord ? "listed" : "not listed"}`);
  out(`Engine binary   ${formatBytes(bundle.wasm.length)}, ${scan.functions.defined} functions`);
  out(`Engine glue     ${formatBytes(Buffer.byteLength(bundle.glueText, "utf8"))}`);
  out(`Game archive    ${formatBytes(bundle.archive.totalSize)} in ${bundle.archive.files.length} files`);
  out(`Heap            ${bundle.dmloader.heapSizeBytes ? formatBytes(bundle.dmloader.heapSizeBytes) : "unknown"}`);
  out(`High DPI        ${bundle.dmloader.highDpi ? "on" : "off"}`);
  out(`Wasm features   ${used.length ? used.map((name) => FEATURE_LABELS[name] || name).join("; ") : "none beyond the MVP"}`);
  out(`Threaded build  ${bundle.hasThreadedVariant ? "present (ignored)" : "absent"}`);
  if (policy.ok) out("Result          exportable");
  else for (const error of policy.errors) out(`Blocked         ${error}`);
  for (const warning of policy.warnings) out(`Warning         ${warning}`);
}

/**
 * @param {string[]} argv arguments after the executable name
 * @param {{ out?: Function, err?: Function }} io
 * @returns {number} process exit code
 */
export function main(argv, io = {}) {
  const out = io.out || ((line) => console.log(line));
  const err = io.err || ((line) => console.error(line));
  let parsed;
  try {
    parsed = parseArguments(argv);
  } catch (error) {
    err(`error: ${error.message}`);
    err("Run defold-minigame --help for usage.");
    return 2;
  }
  const { positional, options } = parsed;
  if (options["--version"] || options["-v"]) { out(loadSupportMatrix().toolVersion); return 0; }
  if (options["--help"] || options["-h"] || positional.length === 0) { out(HELP); return positional.length === 0 && !options["--help"] && !options["-h"] ? 2 : 0; }

  const command = positional[0];
  let temporary = null;
  try {
    if (command === "inspect") {
      if (!options["--bundle"]) throw new UsageError("inspect needs --bundle <dir>");
      const inspection = inspectBundle(options["--bundle"]);
      if (options["--json"]) {
        const { bundle, scan, policy, engineRecord } = inspection;
        out(JSON.stringify({
          exeName: bundle.exeName, dmloader: bundle.dmloader, archive: bundle.archive.files.map(({ name, size }) => ({ name, size })),
          wasm: { size: bundle.wasm.length, features: scan.features, blocking: scan.blocking, memory: scan.memory, functions: scan.functions },
          policy, inSupportMatrix: engineRecord !== null,
        }, null, 2));
      } else {
        printInspection(inspection, out);
      }
      return inspection.policy.ok ? 0 : 1;
    }

    if (command === "export" || command === "build") {
      let bundleDir = options["--bundle"];
      if (command === "build") {
        if (!options["--project"]) throw new UsageError("build needs --project <dir>");
        if (!options["--bob"]) throw new UsageError("build needs --bob <path to bob.jar>");
        temporary = mkdtempSync(join(tmpdir(), "defold-minigame-bundle-"));
        bundleDir = buildBundle({
          projectDir: options["--project"],
          bobJar: options["--bob"],
          java: options["--java"],
          variant: options["--variant"],
          bundleOutput: temporary,
          log: (line) => err(line),
        });
      } else if (!bundleDir) {
        throw new UsageError("export needs --bundle <dir>");
      }
      const result = exportMiniGame(exportOptions(options, bundleDir));
      if (options["--json"]) {
        out(JSON.stringify({
          outputDir: result.outputDir, platform: result.platform, orientation: result.orientation,
          sizes: result.sizes, warnings: result.warnings, report: result.report,
        }, null, 2));
      } else {
        printExportResult(result, out);
      }
      return 0;
    }

    throw new UsageError(`unknown command '${command}'`);
  } catch (error) {
    if (error instanceof UsageError) {
      err(`error: ${error.message}`);
      err("Run defold-minigame --help for usage.");
      return 2;
    }
    if (error instanceof ExportError) {
      err(`error: ${error.message}`);
      if (error.hint) err(`hint: ${error.hint}`);
      return 1;
    }
    throw error;
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
