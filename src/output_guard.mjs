/**
 * Output ownership and transactional publish.
 *
 * An export never writes into the destination directly. Everything is built
 * in a sibling staging directory, described by a manifest (path, size,
 * SHA-256), and only then swapped into place under a lock. The exporter owns a
 * fixed set of top-level names; anything else in the folder is a sidecar and is
 * left alone, so re-exporting into the same folder is safe.
 *
 * The swap and its in-process rollback are transactional, but this is not a
 * crash-atomic primitive: if the process dies mid-publish, the lock, staging,
 * or backup directory stays beside the output and the next export stops and
 * reports it instead of guessing.
 */

import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

import { ExportError, ensureDirectory, isDirectory, listFiles, sha256 } from "./util.mjs";

export const MANIFEST_NAME = ".defold-mini-game-export.json";
export const MANIFEST_SCHEMA = 1;
export const GENERATOR = "defold-minigame";

function readManifest(outputDir) {
  const path = join(outputDir, MANIFEST_NAME);
  if (!existsSync(path)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch (_) {
    return { invalid: true };
  }
  const valid = manifest && manifest.generator === GENERATOR && manifest.schema === MANIFEST_SCHEMA
    && Array.isArray(manifest.managed) && Array.isArray(manifest.artifacts);
  return valid ? manifest : { invalid: true };
}

function leftoverSiblings(outputDir) {
  const parent = dirname(outputDir);
  const name = basename(outputDir);
  if (!isDirectory(parent)) return [];
  return readdirSync(parent)
    .filter((entry) => entry === `${name}.lock`
      || entry.startsWith(`${name}.staging-`)
      || entry.startsWith(`${name}.backup-`))
    .map((entry) => join(parent, entry));
}

/**
 * Decides whether the destination may be published into.
 * `shared` names exporter-owned files that something else may rewrite: the
 * developer tool's project files. They are not held to their recorded hash.
 * @returns {{ fresh: boolean, manifest: object|null }}
 */
export function checkDestination(outputDir, { force = false, shared = [] } = {}) {
  if (!existsSync(outputDir)) return { fresh: true, manifest: null };
  if (!isDirectory(outputDir)) throw new ExportError(`the output path exists and is not a directory: ${outputDir}`);

  const entries = readdirSync(outputDir).filter((entry) => entry !== ".DS_Store");
  if (entries.length === 0) return { fresh: true, manifest: null };

  const manifest = readManifest(outputDir);
  if (!manifest || manifest.invalid) {
    throw new ExportError(
      `the output directory is not empty and was not created by ${GENERATOR}: ${outputDir}`,
      { hint: "Export to a new empty folder once, then keep exporting into that folder." },
    );
  }

  const known = new Map(manifest.artifacts.map((artifact) => [artifact.path, artifact]));
  const problems = [];
  for (const name of manifest.managed) {
    const full = join(outputDir, name);
    if (!existsSync(full)) continue;
    const files = isDirectory(full) ? listFiles(full).map((file) => `${name}/${file}`) : [name];
    for (const file of files) {
      if (file === MANIFEST_NAME || file.endsWith("/.DS_Store") || shared.includes(file)) continue;
      const artifact = known.get(file);
      if (!artifact) {
        problems.push(`${file} was not written by the exporter`);
      } else if (sha256(readFileSync(join(outputDir, file))) !== artifact.sha256) {
        problems.push(`${file} was modified after the last export`);
      }
    }
  }
  if (problems.length > 0 && !force) {
    const shown = problems.slice(0, 8).join("; ");
    const more = problems.length > 8 ? `; and ${problems.length - 8} more` : "";
    throw new ExportError(
      `the exporter-owned paths in ${outputDir} changed: ${shown}${more}`,
      { hint: "Move your own files to another top-level name, or pass --force to discard those changes." },
    );
  }
  return { fresh: false, manifest };
}

/**
 * Publishes `files` into `outputDir`.
 * @param {{ outputDir: string, files: Map<string, Buffer|string>, manifest: object, force?: boolean, shared?: string[] }} input
 */
export function publish({ outputDir, files, manifest, force = false, shared = [] }) {
  const leftovers = leftoverSiblings(outputDir);
  if (leftovers.length > 0) {
    throw new ExportError(
      `an earlier export did not finish; these paths were left beside the output: ${leftovers.join(", ")}`,
      { hint: "Compare them with the output folder, archive what you need, then delete them and export again." },
    );
  }
  checkDestination(outputDir, { force, shared });

  const token = `${process.pid}-${randomBytes(4).toString("hex")}`;
  const staging = `${outputDir}.staging-${token}`;
  const backup = `${outputDir}.backup-${token}`;
  const lock = `${outputDir}.lock`;

  const artifacts = [];
  const topLevel = new Set([MANIFEST_NAME]);
  ensureDirectory(dirname(outputDir));
  ensureDirectory(staging);
  try {
    for (const [path, content] of files) {
      if (path.startsWith("/") || path.split("/").includes("..")) {
        throw new Error(`refusing to write outside the output directory: ${path}`);
      }
      const data = typeof content === "string" ? Buffer.from(content, "utf8") : content;
      const full = join(staging, path);
      ensureDirectory(dirname(full));
      writeFileSync(full, data);
      artifacts.push({ path, size: data.length, sha256: sha256(data) });
      topLevel.add(path.split("/")[0]);
    }
    artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const finalManifest = {
      schema: MANIFEST_SCHEMA,
      generator: GENERATOR,
      ...manifest,
      managed: [...topLevel].sort(),
      artifacts,
    };
    writeFileSync(join(staging, MANIFEST_NAME), `${JSON.stringify(finalManifest, null, 2)}\n`);

    // Validate the staged tree against its own manifest before touching the output.
    for (const artifact of artifacts) {
      const data = readFileSync(join(staging, artifact.path));
      if (data.length !== artifact.size || sha256(data) !== artifact.sha256) {
        throw new Error(`the staged file ${artifact.path} does not match its manifest entry`);
      }
    }

    let lockHandle;
    try {
      lockHandle = openSync(lock, "wx");
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new ExportError(`another export holds the lock ${lock}`);
      }
      throw error;
    }

    const movedIn = [];
    const movedOut = [];
    try {
      // The destination may have changed while the staging tree was built.
      const current = checkDestination(outputDir, { force, shared });
      ensureDirectory(outputDir);
      mkdirSync(backup);
      const owned = new Set([...(current.manifest ? current.manifest.managed : []), ...topLevel]);
      for (const name of owned) {
        const existing = join(outputDir, name);
        if (existsSync(existing)) {
          renameSync(existing, join(backup, name));
          movedOut.push(name);
        }
      }
      for (const name of topLevel) {
        renameSync(join(staging, name), join(outputDir, name));
        movedIn.push(name);
      }
    } catch (error) {
      // Roll back to the previous export.
      for (const name of movedIn) rmSync(join(outputDir, name), { recursive: true, force: true });
      for (const name of movedOut) {
        try { renameSync(join(backup, name), join(outputDir, name)); } catch (_) { /* left in the backup */ }
      }
      // A fully restored backup is empty and can go; anything still in it is
      // evidence the next export must report rather than delete.
      try {
        if (existsSync(backup) && readdirSync(backup).length === 0) rmSync(backup, { recursive: true, force: true });
      } catch (_) { /* keep the backup */ }
      throw error;
    } finally {
      closeSync(lockHandle);
      rmSync(lock, { force: true });
    }
    rmSync(backup, { recursive: true, force: true });
    return finalManifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
