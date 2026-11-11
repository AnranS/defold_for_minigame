/**
 * Optional step: build the HTML5 bundle from a Defold project with bob.jar.
 *
 * The exporter itself only needs the finished bundle. This module exists so a
 * build server can go from a project folder to a mini-game project with one
 * command. bob.jar and a matching JDK are supplied by the caller; nothing is
 * downloaded here.
 */

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { ExportError, isDirectory, isFile } from "./util.mjs";

/** Arguments for a single-threaded release HTML5 bundle. */
export function bobArguments({ bobJar, projectDir, bundleOutput, variant = "release", extraArguments = [] }) {
  return [
    "-jar", bobJar,
    "--root", projectDir,
    "--archive",
    "--platform", "wasm-web",
    // Only the single-threaded engine: mini-game hosts have no WebAssembly threads.
    "--architectures", "wasm-web",
    "--variant", variant,
    "--bundle-output", bundleOutput,
    ...extraArguments,
    "resolve", "build", "bundle",
  ];
}

/** Finds the folder bob wrote: the one that contains dmloader.js. */
export function locateBundle(bundleOutput) {
  if (isFile(join(bundleOutput, "dmloader.js"))) return bundleOutput;
  if (isDirectory(bundleOutput)) {
    for (const entry of readdirSync(bundleOutput)) {
      const candidate = join(bundleOutput, entry);
      if (isFile(join(candidate, "dmloader.js"))) return candidate;
    }
  }
  throw new ExportError(`bob.jar finished, but no HTML5 bundle was found under ${bundleOutput}`);
}

/**
 * @param {{ projectDir: string, bobJar: string, bundleOutput: string, java?: string, variant?: string,
 *           extraArguments?: string[], spawn?: Function, log?: Function }} options
 * @returns {string} the HTML5 bundle directory
 */
export function buildBundle(options) {
  const projectDir = resolve(String(options.projectDir || ""));
  if (!isFile(join(projectDir, "game.project"))) {
    throw new ExportError(`no game.project was found in ${projectDir}`);
  }
  const bobJar = resolve(String(options.bobJar || ""));
  if (!isFile(bobJar)) {
    throw new ExportError(
      `bob.jar was not found at ${bobJar}`,
      { hint: "Download bob.jar for your Defold version from https://github.com/defold/defold/releases and pass --bob." },
    );
  }
  const bundleOutput = resolve(String(options.bundleOutput));
  const java = options.java || "java";
  const args = bobArguments({
    bobJar, projectDir, bundleOutput, variant: options.variant, extraArguments: options.extraArguments,
  });
  const log = options.log || (() => {});
  log(`running: ${java} ${args.join(" ")}`);
  const spawn = options.spawn || spawnSync;
  const result = spawn(java, args, { cwd: projectDir, stdio: "inherit" });
  if (result.error) {
    throw new ExportError(
      `could not start ${java}: ${result.error.message}`,
      { hint: "bob.jar needs the JDK version listed in the Defold manual (OpenJDK 25 for Defold 1.14). Pass --java to select it." },
    );
  }
  if (result.status !== 0) {
    throw new ExportError(`bob.jar exited with status ${result.status}`);
  }
  return locateBundle(bundleOutput);
}
