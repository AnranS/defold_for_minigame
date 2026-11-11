#!/usr/bin/env node
/**
 * Evidence from a run in a developer tool: WeChat DevTools or Douyin DevTools.
 *
 *   node scripts/devtools_probe.mjs inject  --project <export> [--label <name>]
 *        [--capture <ms> ...] [--touch <type>:<x>,<y>@<ms> ...] [--finish <ms>]
 *        [--storage <key>=<value> ...] [--audible] [--capture-size <pixels>]
 *   node scripts/devtools_probe.mjs collect --storage <simulator user data> --out <folder> [--label <name>]
 *   node scripts/devtools_probe.mjs remove  --project <export>
 *
 * `inject` copies scripts/devtools/probe.js into an exported WeChat or Douyin
 * project and makes game.js load it first. The probe mirrors the console to a file,
 * saves what the canvas shows at the --capture times, and replays the --touch
 * steps (type is start, move, or end; x and y are fractions of the window).
 * Times are milliseconds after the engine is reported running. A probed run
 * is silent unless --audible is given. --storage puts a value into the host's
 * key-value storage before the game starts and takes it out when the run
 * finishes; the API test app runs all its tests when it finds
 * apitest.autorun=1.
 *
 * `collect` reads the newest run with that label from the simulator's storage
 * (…/WeappSimulator/WeappFileSystem/<user>/<appid>/usr), turns the saved
 * frames into PNG files, and prints the console log and the summary.
 *
 * `remove` takes the probe out again and leaves the project as it was
 * exported.
 *
 * A probed project is for the developer tool only. Remove the probe before
 * you upload anything.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const MARKER = 'import "./dmg-probe";';

function values(argv, name) {
  const found = [];
  argv.forEach((entry, index) => { if (entry === name && argv[index + 1] !== undefined) found.push(argv[index + 1]); });
  return found;
}

function single(argv, name, fallback = null) {
  const found = values(argv, name);
  return found.length > 0 ? found[found.length - 1] : fallback;
}

function fail(message) {
  console.error(`error: ${message}`);
  return 1;
}

// ── inject ───────────────────────────────────────────────────────────────────

const TOUCH_TYPES = { start: "onTouchStart", move: "onTouchMove", end: "onTouchEnd" };

export function parseTouch(text) {
  const match = /^(start|move|end):([0-9.]+),([0-9.]+)@(\d+)$/.exec(text);
  if (!match) throw new Error(`"${text}" is not a touch step; write it as start:0.5,0.5@2000`);
  const x = Number(match[2]);
  const y = Number(match[3]);
  if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) throw new Error(`"${text}": x and y are fractions of the window, from 0 to 1`);
  return { type: TOUCH_TYPES[match[1]], x, y, at: Number(match[4]) };
}

export function parseStorage(text) {
  const split = text.indexOf("=");
  if (split < 1) throw new Error(`"${text}" is not a storage entry; write it as key=value`);
  return [text.slice(0, split), text.slice(split + 1)];
}

export function inject({ project, label = "run", captures = [1500, 4000], touches = [], finishAt, mute = true, storage = {}, captureSize = 720 }) {
  const directory = resolve(project);
  const entry = join(directory, "game.js");
  if (!existsSync(entry) || !existsSync(join(directory, ".defold-mini-game-export.json"))) {
    throw new Error(`${directory} is not a project this tool exported`);
  }
  const manifest = JSON.parse(readFileSync(join(directory, ".defold-mini-game-export.json"), "utf8"));
  // TikTok is left out on purpose: writing files there can end the client.
  if (manifest.platform && !["wechat", "douyin"].includes(manifest.platform)) {
    throw new Error(`the probe is written for WeChat and Douyin DevTools; this project was exported for ${manifest.platform}`);
  }
  const last = Math.max(0, ...captures, ...touches.map((step) => step.at));
  if (!Number.isInteger(captureSize) || captureSize < 16) throw new Error("--capture-size is the longer side of a saved frame, in pixels");
  const config = { label, captures, touches, finishAt: finishAt ?? last + 1500, mute, storage, captureSize };
  const probe = readFileSync(join(HERE, "devtools", "probe.js"), "utf8");
  const placeholder = /\/\*CONFIG\*\/\{[^\n]*\};/;
  if (!placeholder.test(probe)) throw new Error("scripts/devtools/probe.js has no CONFIG placeholder");
  writeFileSync(join(directory, "dmg-probe.js"), probe.replace(placeholder, `${JSON.stringify(config)};`));

  const source = readFileSync(entry, "utf8");
  if (!source.includes(MARKER)) writeFileSync(entry, `${MARKER}\n${source}`);
  return config;
}

/** Undoes inject(): the project is byte for byte what the exporter wrote. */
export function remove({ project }) {
  const directory = resolve(project);
  const entry = join(directory, "game.js");
  if (!existsSync(entry)) throw new Error(`${directory} has no game.js`);
  const source = readFileSync(entry, "utf8");
  if (source.startsWith(`${MARKER}\n`)) writeFileSync(entry, source.slice(MARKER.length + 1));
  rmSync(join(directory, "dmg-probe.js"), { force: true });
}

// ── collect ──────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}

/** An 8-bit RGB PNG from rows of RGBA pixels. */
export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: RGB
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let row = 0; row < height; row += 1) {
    const line = row * (1 + width * 3);
    for (let column = 0; column < width; column += 1) {
      const source = (row * width + column) * 4;
      const target = line + 1 + column * 3;
      raw[target] = rgba[source];
      raw[target + 1] = rgba[source + 1];
      raw[target + 2] = rgba[source + 2];
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** What a saved frame shows, in numbers: how much of it differs from its most common colour. */
export function describeFrame(width, height, rgba) {
  const counts = new Map();
  for (let index = 0; index < width * height; index += 1) {
    const key = (rgba[index * 4] << 16) | (rgba[index * 4 + 1] << 8) | rgba[index * 4 + 2];
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let background = 0;
  let most = 0;
  for (const [key, count] of counts) if (count > most) { most = count; background = key; }
  return {
    colours: counts.size,
    background: `#${background.toString(16).padStart(6, "0")}`,
    drawnShare: Math.round((1 - most / (width * height)) * 1000) / 1000,
  };
}

export function collect({ storage, out, label = "run" }) {
  const root = join(resolve(storage), "dmg-probe");
  if (!existsSync(root)) throw new Error(`${root} does not exist; has the probed project run in the simulator?`);
  const runs = readdirSync(root)
    .filter((name) => name.startsWith(`${label}-`) && statSync(join(root, name)).isDirectory())
    .sort((a, b) => Number(a.slice(label.length + 1)) - Number(b.slice(label.length + 1)));
  if (runs.length === 0) throw new Error(`no run labelled "${label}" in ${root}`);
  const run = runs[runs.length - 1];
  const directory = join(root, run);
  const target = resolve(out);
  mkdirSync(target, { recursive: true });

  const result = { run, directory, log: "", summary: null, frames: [] };
  if (existsSync(join(directory, "console.log"))) {
    result.log = readFileSync(join(directory, "console.log"), "utf8");
    writeFileSync(join(target, "console.log"), result.log);
  }
  if (existsSync(join(directory, "summary.json"))) {
    result.summary = JSON.parse(readFileSync(join(directory, "summary.json"), "utf8"));
    writeFileSync(join(target, "summary.json"), JSON.stringify(result.summary, null, 2));
  }
  for (const name of readdirSync(directory).filter((entry) => entry.endsWith(".rgba")).sort()) {
    const data = readFileSync(join(directory, name));
    const width = data.readUInt32LE(0);
    const height = data.readUInt32LE(4);
    const rgba = data.subarray(8);
    if (rgba.length !== width * height * 4) throw new Error(`${name} is truncated`);
    const file = join(target, name.replace(/\.rgba$/, ".png"));
    writeFileSync(file, encodePng(width, height, rgba));
    result.frames.push({ file, width, height, ...describeFrame(width, height, rgba) });
  }
  return result;
}

// ── command line ─────────────────────────────────────────────────────────────

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "inject") {
    const project = single(rest, "--project");
    if (!project) return fail("inject needs --project <export>");
    const captures = values(rest, "--capture").map(Number);
    const finish = single(rest, "--finish");
    const config = inject({
      project,
      label: single(rest, "--label", "run"),
      captures: captures.length > 0 ? captures : undefined,
      touches: values(rest, "--touch").map(parseTouch),
      finishAt: finish === null ? undefined : Number(finish),
      mute: !rest.includes("--audible"),
      captureSize: Number(single(rest, "--capture-size", "720")),
      storage: Object.fromEntries(values(rest, "--storage").map(parseStorage)),
    });
    console.log(`probe injected into ${resolve(project)}: ${JSON.stringify(config)}`);
    console.log("This project is for the developer tool only; remove the probe before uploading.");
    return 0;
  }
  if (command === "remove") {
    const project = single(rest, "--project");
    if (!project) return fail("remove needs --project <export>");
    remove({ project });
    console.log(`probe removed from ${resolve(project)}`);
    return 0;
  }
  if (command === "collect") {
    const storage = single(rest, "--storage");
    const out = single(rest, "--out");
    if (!storage || !out) return fail("collect needs --storage <simulator user data> and --out <folder>");
    const result = collect({ storage, out, label: single(rest, "--label", "run") });
    console.log(`run ${result.run}`);
    console.log(result.log.trimEnd());
    console.log("");
    for (const frame of result.frames) {
      console.log(`${frame.file}  ${frame.width}x${frame.height}  ${frame.colours} colours, ${Math.round(frame.drawnShare * 100)}% differs from the background ${frame.background}`);
    }
    if (result.summary) console.log(`summary: ${JSON.stringify(result.summary)}`);
    return 0;
  }
  console.error("usage: node scripts/devtools_probe.mjs inject --project <export> [options]");
  console.error("       node scripts/devtools_probe.mjs collect --storage <simulator user data> --out <folder>");
  console.error("       node scripts/devtools_probe.mjs remove --project <export>");
  return 2;
}

if (process.argv[1] && process.argv[1].endsWith("devtools_probe.mjs")) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.exitCode = fail(error.message);
  }
}
