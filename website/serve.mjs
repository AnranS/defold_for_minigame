#!/usr/bin/env node
/**
 * Serves website/dist on this machine only, for a look before publishing.
 *
 *   node website/build.mjs && node website/serve.mjs
 *   PORT=8080 node website/serve.mjs
 *
 * The address is printed once the server is up; open that one. Without PORT
 * the server starts at 4780 and moves on when another program has the port.
 * With PORT set, a taken port is an error, so the address is never a guess.
 */

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startPreviewServer } from "./lib/preview_server.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "dist");
const chosen = process.env.PORT;

try {
  const server = await startPreviewServer({
    root,
    port: chosen === undefined ? undefined : Number(chosen),
    strict: chosen !== undefined,
  });
  if (server.skipped.length > 0) {
    console.log(`Port ${server.skipped.join(", ")} is in use by another program; using ${server.port} instead.`);
  }
  console.log("Defold Mini Game website");
  console.log(`  ${server.url}      中文`);
  console.log(`  ${server.url}en/   English`);
  console.log("Ctrl+C to stop");
} catch (error) {
  console.error(`cannot serve the site: ${error.message}`);
  process.exitCode = 1;
}
