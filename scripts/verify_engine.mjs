#!/usr/bin/env node
/**
 * Static verification of a Defold release for the support matrix.
 *
 *   node scripts/verify_engine.mjs --version 1.14.0 [--sha1 <engine sha1>] [--channel stable|beta|alpha] [--keep <dir>]
 *
 * Downloads the stock single-threaded web engine (dmengine_release.js and
 * dmengine_release.wasm) from d.defold.com and dmloader.js from the Defold
 * source tree at that tag, then runs the exporter's own checks on them:
 *
 *   - the loader and glue contract (src/engine_module.mjs)
 *   - the WebAssembly feature scan (src/wasm_features.mjs)
 *   - a full export for every platform, including the sloppy and strict
 *     compile check of the composed module
 *
 * Nothing that is downloaded is executed. The engine is only read, parsed,
 * and compiled. This proves the exporter understands the release; it does not
 * prove that the engine runs in a mini-game host. That takes a real bundle in
 * a developer tool and on a device.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { exportMiniGame, inspectBundle } from "../src/exporter.mjs";
import { PLATFORM_NAMES } from "../src/platforms.mjs";
import { formatBytes } from "../src/util.mjs";
import { makeBundle } from "../test/helpers/bundle_fixture.mjs";

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

async function main() {
  const version = argument("--version");
  if (!version) {
    console.error("usage: node scripts/verify_engine.mjs --version <defold version> [--sha1 <sha1>] [--channel stable|beta|alpha] [--keep <dir>]");
    return 2;
  }
  // Releases are published per channel. A pre-release build is only found
  // under its own channel, and its loader only under its commit, not a tag.
  const channel = argument("--channel") || "stable";
  if (!["stable", "beta", "alpha"].includes(channel)) {
    console.error(`unknown channel '${channel}'; use stable, beta, or alpha`);
    return 2;
  }
  let sha1 = argument("--sha1");
  if (!sha1) {
    const info = JSON.parse(await download(`https://d.defold.com/${channel}/info.json`));
    if (info.version !== version) {
      console.error(`the current ${channel} release is ${info.version}; pass --sha1 for ${version}`);
      return 2;
    }
    sha1 = info.sha1;
  }

  const keep = argument("--keep");
  const work = keep ? resolve(keep) : mkdtempSync(join(tmpdir(), "dmg-verify-"));
  mkdirSync(work, { recursive: true });
  try {
    const base = `https://d.defold.com/archive/${channel}/${sha1}/engine/wasm-web`;
    console.log(`Defold ${version} (${sha1})${channel === "stable" ? "" : `, ${channel} channel`}`);
    const glue = await download(`${base}/dmengine_release.js`);
    const wasm = await download(`${base}/dmengine_release.wasm`, { binary: true });
    let loaderTemplate = null;
    for (const ref of [version, sha1]) {
      for (const path of LOADER_PATHS) {
        loaderTemplate = await download(`https://raw.githubusercontent.com/defold/defold/${ref}/${path}`, { optional: true });
        if (loaderTemplate) break;
      }
      if (loaderTemplate) break;
    }
    if (!loaderTemplate) throw new Error(`dmloader.js was not found in the Defold source tree at tag ${version} or commit ${sha1}`);
    if (keep) {
      writeFileSync(join(work, "dmengine_release.js"), glue);
      writeFileSync(join(work, "dmengine_release.wasm"), wasm);
      writeFileSync(join(work, "dmloader.template.js"), loaderTemplate);
    }

    // A bundle with the real loader, glue, and binary; only the archive is filler.
    const bundle = makeBundle({
      directory: join(work, "bundle"), exeName: "StockEngine", glue, wasm, loaderTemplate, engineVersion: version,
    });
    const inspection = inspectBundle(bundle.directory);
    const features = Object.keys(inspection.scan.features).filter((name) => inspection.scan.features[name]);
    console.log(`  engine binary   ${formatBytes(wasm.length)}, ${inspection.scan.functions.defined} functions, all decoded: ${inspection.scan.complete}`);
    console.log(`  wasm features   ${features.join(", ") || "none"}; blocking: ${inspection.scan.blocking.join(", ") || "none"}`);
    console.log(`  memory          ${JSON.stringify(inspection.scan.memory)}`);
    if (!inspection.policy.ok) {
      for (const error of inspection.policy.errors) console.error(`  blocked         ${error}`);
      return 1;
    }

    let report = null;
    for (const platform of PLATFORM_NAMES) {
      const result = exportMiniGame({
        bundleDir: bundle.directory, platform, appId: "verify", outputDir: join(work, `out-${platform}`),
      });
      report = result;
      console.log(`  ${platform.padEnd(15)} main ${formatBytes(result.sizes.main)}, engine binary packaged ${formatBytes(result.sizes.wasmPackaged)}`);
    }
    console.log(`  engine module   ${formatBytes(report.sizes.engineModule)}, eval sites ${report.report.engineModule.evalSites}, `
      + `strict-mode rewrites ${report.report.engineModule.duplicateParameterRewrites}`);
    console.log("  contract        matched; the composed module parses in sloppy and strict mode");
    console.log("");
    console.log("support-matrix.json entry:");
    console.log(JSON.stringify({
      defoldVersion: version,
      engineSha1: sha1,
      variant: "release",
      architecture: "wasm-web",
      analysedOn: new Date().toISOString().slice(0, 10),
      wasm: {
        blockingFeatures: inspection.scan.blocking,
        features,
        importedMemory: inspection.scan.memory ? inspection.scan.memory.imported : false,
        initialPages: inspection.scan.memory ? inspection.scan.memory.initialPages : null,
        maximumPages: inspection.scan.memory ? inspection.scan.memory.maximumPages : null,
      },
      validation: {
        staticContract: "verified", wasmFeatureScan: "verified",
        devtool: Object.fromEntries(PLATFORM_NAMES.map((name) => [name, "not-run"])),
        realDevice: Object.fromEntries(PLATFORM_NAMES.map((name) => [name, "not-run"])),
      },
    }, null, 2));
    return 0;
  } finally {
    if (!keep) rmSync(work, { recursive: true, force: true });
  }
}

main().then((code) => { process.exitCode = code; }, (error) => {
  console.error(`error: ${error.message}`);
  process.exitCode = 1;
});
