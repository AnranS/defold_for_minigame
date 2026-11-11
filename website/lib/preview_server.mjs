/**
 * A static file server for looking at the built site on this machine.
 *
 * It listens on the loopback addresses only, and it never settles on a port
 * that another program answers on: a preview address that shows somebody
 * else's project is worse than no address.
 */

import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { connect } from "node:net";
import { extname, join, resolve, sep } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/** Away from the defaults of common tools (Vite 5173 and 4173, 3000, 8000, 8080). */
export const DEFAULT_PORT = 4780;
const ATTEMPTS = 20;

function send(response, status, text) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(text);
}

function handler(root) {
  return (request, response) => {
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    } catch {
      send(response, 400, "Bad request");
      return;
    }
    let file = resolve(root, `.${pathname}`);
    if (file !== root && !file.startsWith(root + sep)) {
      send(response, 403, "Forbidden");
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) {
      // The pages link to each other relatively, so a folder needs its slash.
      if (!pathname.endsWith("/")) {
        response.writeHead(301, { Location: `${pathname}/` });
        response.end();
        return;
      }
      file = join(file, "index.html");
    }
    if (!existsSync(file)) {
      send(response, 404, "Not found");
      return;
    }
    response.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    createReadStream(file).pipe(response);
  };
}

/** Whether some program accepts connections on this loopback address and port. */
function answers(port, host) {
  return new Promise((done) => {
    const socket = connect({ port, host });
    const finish = (result) => { socket.destroy(); done(result); };
    socket.setTimeout(400, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function listen(server, port, host) {
  return new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, () => { server.removeListener("error", fail); done(); });
  });
}

function close(server) {
  return new Promise((done) => server.close(() => done()));
}

/**
 * Listens on both loopback addresses, so that 127.0.0.1 and localhost reach
 * the same pages whichever way the browser resolves the name.
 */
async function listenOnLoopback(root, port) {
  const servers = [createServer(handler(root))];
  try {
    await listen(servers[0], port, "127.0.0.1");
    const second = createServer(handler(root));
    try {
      await listen(second, port, "::1");
      servers.push(second);
    } catch (error) {
      // A machine without an IPv6 loopback is fine; a taken port is not.
      if (error.code === "EADDRINUSE") throw error;
    }
    return servers;
  } catch (error) {
    await Promise.all(servers.filter((server) => server.listening).map(close));
    throw error;
  }
}

/**
 * @param {object} options
 * @param {string} options.root the built site
 * @param {number} [options.port] where to start looking (default 4780)
 * @param {boolean} [options.strict] fail instead of moving to another port
 * @returns {Promise<{ port: number, url: string, skipped: number[], close: () => Promise<void> }>}
 */
export async function startPreviewServer(options) {
  const root = resolve(options.root);
  if (!existsSync(join(root, "index.html"))) {
    throw new Error(`${root} has no index.html. Run \`node website/build.mjs\` first.`);
  }
  const first = options.port === undefined ? DEFAULT_PORT : options.port;
  if (!Number.isInteger(first) || first < 1 || first > 65535) {
    throw new Error(`"${options.port}" is not a port number`);
  }
  const last = options.strict ? first : Math.min(first + ATTEMPTS - 1, 65535);
  const skipped = [];

  for (let port = first; port <= last; port += 1) {
    // Ask before binding: a program that listens on every address would not
    // stop a loopback-only bind on some systems, and would still be the one
    // a browser reaches through "localhost".
    const taken = (await answers(port, "127.0.0.1")) || (await answers(port, "::1"));
    if (!taken) {
      try {
        const servers = await listenOnLoopback(root, port);
        return {
          port,
          url: `http://127.0.0.1:${port}/`,
          skipped,
          close: () => Promise.all(servers.map(close)).then(() => undefined),
        };
      } catch (error) {
        if (error.code !== "EADDRINUSE") throw error;
      }
    }
    skipped.push(port);
  }

  if (options.strict) {
    throw new Error(`port ${first} is in use by another program. Stop it, or choose another port with PORT=<number>.`);
  }
  throw new Error(`ports ${first} to ${last} are all in use. Choose one with PORT=<number>.`);
}
