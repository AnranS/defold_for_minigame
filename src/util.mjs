import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root: one level above src/. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** An error whose message is meant for the person running the export. */
export class ExportError extends Error {
  constructor(message, { hint } = {}) {
    super(message);
    this.name = "ExportError";
    this.hint = hint || null;
  }
}

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function sha1(data) {
  return createHash("sha1").update(data).digest("hex");
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function ensureDirectory(path) {
  mkdirSync(path, { recursive: true });
}

export function isDirectory(path) {
  try { return statSync(path).isDirectory(); } catch (_) { return false; }
}

export function isFile(path) {
  try { return statSync(path).isFile(); } catch (_) { return false; }
}

/** Lists every file below `root` as a POSIX-style relative path, sorted. */
export function listFiles(root) {
  const out = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(root, full).split(sep).join("/"));
    }
  };
  if (existsSync(root)) walk(root);
  return out.sort();
}

/** True when `child` is `parent` or lies inside it. */
export function isInside(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(sep) && !/^[A-Za-z]:/.test(rel));
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

let cachedMatrix = null;
export function loadSupportMatrix() {
  if (!cachedMatrix) cachedMatrix = readJson(join(REPO_ROOT, "support-matrix.json"));
  return cachedMatrix;
}
