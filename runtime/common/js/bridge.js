/**
 * Lua ⇄ JavaScript bridge for the `minigame` Lua module.
 *
 * Mini-game hosts disable eval(), so Defold's html5.run() cannot execute
 * JavaScript. The exporter redirects the engine's single eval call to
 * `bridge.run`, which accepts a fixed handshake string and JSON commands only.
 * Lua sends a command with html5.run() and reads the JSON reply; asynchronous
 * results and host events are queued here and drained by a `poll` command once
 * per frame.
 *
 * The bridge never touches a provider directly: every call goes through the
 * selected PlatformRuntime, is capability-checked first, and respects the
 * host-specific block list below.
 */

import { BRIDGE_ABI_VERSION } from "./platform_runtime";
import { decodeBase64, encodeBase64 } from "./idb_store";

const BRIDGE_BRAND = "defold-mini-game-bridge";

/**
 * The exact expression the Lua module evaluates to find the bridge. In a
 * normal browser it evaluates to an empty string; in a mini game the bridge
 * recognises it without evaluating anything.
 */
const HANDSHAKE_EXPRESSION = "typeof DefoldMiniGameBridge==='object'?DefoldMiniGameBridge.handshake():''";

const MAX_QUEUED_EVENTS = 2000;

/**
 * Host APIs that must not be reached through the bridge. Each entry records
 * why, so the error returned to Lua explains the restriction.
 */
const BLOCKED_APIS = {
  tiktok: {
    getStorageInfoSync: "it can terminate the TikTok host process",
    getStorageInfo: "it can terminate the TikTok host process",
    getBatteryInfo: "it can terminate the TikTok host process",
    getBatteryInfoSync: "it can terminate the TikTok host process",
    getFileSystemManager: "file-system calls can terminate the TikTok host process",
  },
};

function formatError(error) {
  if (error == null) return "unknown error";
  if (typeof error === "string") return error;
  const parts = [];
  if (error.errCode !== undefined) parts.push(`code=${error.errCode}`);
  else if (error.errNo !== undefined) parts.push(`code=${error.errNo}`);
  if (error.errMsg) parts.push(String(error.errMsg));
  else if (error.message) parts.push(String(error.message));
  if (parts.length > 0) return parts.join(" ");
  try { return JSON.stringify(error); } catch (_) { return String(error); }
}

/** Converts a host value into something JSON can carry to Lua. */
function toWire(value, depth = 0) {
  if (value === undefined || typeof value === "function") return undefined;
  if (value === null || typeof value !== "object") {
    return (typeof value === "number" && !Number.isFinite(value)) ? null : value;
  }
  if (value instanceof ArrayBuffer) return { __binary: "base64", data: encodeBase64(new Uint8Array(value)) };
  if (ArrayBuffer.isView(value)) {
    return {
      __binary: "base64",
      data: encodeBase64(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)),
    };
  }
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.map((item) => toWire(item, depth + 1) ?? null);
  const out = {};
  for (const key of Object.keys(value)) {
    let field;
    try { field = value[key]; } catch (_) { continue; }
    const converted = toWire(field, depth + 1);
    if (converted !== undefined) out[key] = converted;
  }
  return out;
}

/** Converts a value decoded from Lua's JSON into what host APIs expect. */
function fromWire(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > 8) return value;
  if (Array.isArray(value)) return value.map((item) => fromWire(item, depth + 1));
  if (value.__binary === "base64" && typeof value.data === "string") {
    const bytes = decodeBase64(value.data);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  const out = {};
  for (const key of Object.keys(value)) out[key] = fromWire(value[key], depth + 1);
  return out;
}

/**
 * @param {object} runtime PlatformRuntime
 * @param {{ toolVersion?: string, engineAudio?: boolean, persistence?: string, pixelRatio?: number, subpackages?: string[] }} details
 */
function createBridge(runtime, details = {}) {
  const api = runtime.api;
  const blocked = BLOCKED_APIS[runtime.platform] || {};
  const queue = [];
  const subscriptions = new Map(); // id → { target, event, handler }
  const handles = new Map(); // handle → host object
  let dropped = 0;
  // Every Lua state that finds the bridge is a client of its own. Defold runs
  // game object scripts and GUI scripts in separate Lua states unless
  // script.shared_state is set, and each state polls for itself, so a client
  // names its ids "<client>:<n>" and a poll returns only that client's events.
  let nextClient = 1;
  let shareContent = null;
  let shareBound = false;

  function push(event) {
    if (queue.length >= MAX_QUEUED_EVENTS) {
      queue.shift();
      dropped += 1;
      if (dropped === 1 || dropped % 500 === 0) {
        console.warn(
          `[DefoldMiniGame][bridge] ${dropped} events were dropped; call minigame.update() every frame to drain them`,
        );
      }
    }
    queue.push(event);
  }

  function ok(data) {
    const reply = { ok: true };
    const wire = toWire(data);
    if (wire !== undefined) reply.data = wire;
    return reply;
  }

  function fail(message) {
    return { ok: false, error: String(message) };
  }

  function resolveApi(name) {
    if (typeof name !== "string" || name === "") return { error: "an API name is required" };
    if (!runtime.available) return { error: "no mini-game host API is available" };
    if (Object.prototype.hasOwnProperty.call(blocked, name)) {
      return { error: `${runtime.apiPrefix}.${name} is blocked on ${runtime.platform}: ${blocked[name]}` };
    }
    if (typeof api[name] !== "function") {
      return { error: `${runtime.apiPrefix}.${name} is not supported by this host` };
    }
    return { fn: api[name] };
  }

  function resolveHandle(handle) {
    const target = handles.get(handle);
    return target ? { target } : { error: `unknown object handle ${handle}` };
  }

  function settle(id, result) {
    if (id == null) return false;
    if (result && typeof result.then === "function") {
      result.then(
        (value) => push({ id, ok: true, data: toWire(value) }),
        (error) => push({ id, ok: false, error: formatError(error), data: toWire(error) }),
      );
      return true;
    }
    return false;
  }

  function handshake() {
    const system = runtime.getSystemInfo();
    return {
      brand: BRIDGE_BRAND,
      abi: BRIDGE_ABI_VERSION,
      platform: runtime.platform,
      apiPrefix: runtime.apiPrefix,
      capabilities: runtime.capabilities,
      toolVersion: details.toolVersion || "",
      engineAudio: details.engineAudio === true,
      persistence: details.persistence || "memory",
      pixelRatio: details.pixelRatio || 1,
      // The game's own subpackages, by the name minigame.load_subpackage() takes.
      subpackages: Array.isArray(details.subpackages) ? details.subpackages.map(String) : [],
      system: toWire({
        platform: system.platform, system: system.system, model: system.model, brand: system.brand,
        language: system.language, version: system.version, SDKVersion: system.SDKVersion,
        pixelRatio: system.pixelRatio, windowWidth: system.windowWidth, windowHeight: system.windowHeight,
        screenWidth: system.screenWidth, screenHeight: system.screenHeight,
        statusBarHeight: system.statusBarHeight, safeArea: system.safeArea,
      }),
    };
  }

  const operations = {
    info() {
      return ok(handshake());
    },

    poll(command) {
      if (queue.length === 0) return "";
      const client = command && command.client != null ? `${command.client}:` : null;
      // A module from before clients existed is the only one polling: it gets everything.
      if (client === null) return queue.splice(0, queue.length);
      const mine = [];
      const others = [];
      for (const event of queue) (String(event.id).startsWith(client) ? mine : others).push(event);
      if (mine.length === 0) return "";
      queue.length = 0;
      for (const event of others) queue.push(event);
      return mine;
    },

    has(command) {
      const names = Array.isArray(command.apis) ? command.apis : [];
      const result = {};
      for (const name of names) result[name] = !resolveApi(name).error;
      return ok(result);
    },

    call(command) {
      const resolved = resolveApi(command.api);
      if (resolved.error) return fail(resolved.error);
      const id = command.id;
      const options = Object.assign({}, fromWire(command.args) || {});
      options.success = (res) => push({ id, ok: true, data: toWire(res) });
      options.fail = (error) => push({ id, ok: false, error: formatError(error), data: toWire(error) });
      let task;
      try {
        task = resolved.fn.call(api, options);
      } catch (error) {
        return fail(formatError(error));
      }
      if (command.handle != null && task && typeof task === "object") handles.set(command.handle, task);
      return ok();
    },

    sync(command) {
      const resolved = resolveApi(command.api);
      if (resolved.error) return fail(resolved.error);
      const args = Array.isArray(command.args) ? fromWire(command.args) : [];
      try {
        return ok(resolved.fn.apply(api, args));
      } catch (error) {
        return fail(formatError(error));
      }
    },

    on(command) {
      const resolved = resolveApi(command.event);
      if (resolved.error) return fail(resolved.error);
      const id = command.id;
      const handler = (res) => push({ id, ok: true, data: toWire(res) });
      try {
        resolved.fn.call(api, handler);
      } catch (error) {
        return fail(formatError(error));
      }
      subscriptions.set(id, { target: api, event: command.event, handler });
      return ok();
    },

    off(command) {
      const subscription = subscriptions.get(command.id);
      if (!subscription) return ok();
      subscriptions.delete(command.id);
      const offName = subscription.event.replace(/^on/, "off");
      const off = subscription.target[offName];
      if (typeof off === "function") {
        try { off.call(subscription.target, subscription.handler); } catch (_) { /* best effort */ }
      }
      return ok();
    },

    new(command) {
      const resolved = resolveApi(command.api);
      if (resolved.error) return fail(resolved.error);
      if (command.handle == null) return fail("an object handle is required");
      const args = Array.isArray(command.args)
        ? fromWire(command.args)
        : (command.args === undefined ? [] : [fromWire(command.args)]);
      let object;
      try {
        object = resolved.fn.apply(api, args);
      } catch (error) {
        return fail(formatError(error));
      }
      if (!object || (typeof object !== "object" && typeof object !== "function")) {
        return fail(`${runtime.apiPrefix}.${command.api} did not return an object`);
      }
      handles.set(command.handle, object);
      return ok();
    },

    invoke(command) {
      const resolved = resolveHandle(command.handle);
      if (resolved.error) return fail(resolved.error);
      const method = resolved.target[command.method];
      if (typeof method !== "function") return fail(`the object has no method '${command.method}'`);
      const args = Array.isArray(command.args) ? fromWire(command.args) : [];
      let result;
      try {
        result = method.apply(resolved.target, args);
      } catch (error) {
        return fail(formatError(error));
      }
      if (settle(command.id, result)) return { ok: true, async: true };
      if (result && typeof result.then === "function") {
        result.then(() => {}, () => {});
        return { ok: true, async: true };
      }
      return ok(result);
    },

    listen(command) {
      const resolved = resolveHandle(command.handle);
      if (resolved.error) return fail(resolved.error);
      const register = resolved.target[command.event];
      if (typeof register !== "function") return fail(`the object has no event '${command.event}'`);
      const id = command.id;
      const handler = (res) => push({ id, ok: true, data: toWire(res) });
      try {
        register.call(resolved.target, handler);
      } catch (error) {
        return fail(formatError(error));
      }
      subscriptions.set(id, { target: resolved.target, event: command.event, handler });
      return ok();
    },

    get(command) {
      const resolved = resolveHandle(command.handle);
      if (resolved.error) return fail(resolved.error);
      try {
        return ok(resolved.target[command.prop]);
      } catch (error) {
        return fail(formatError(error));
      }
    },

    set(command) {
      const resolved = resolveHandle(command.handle);
      if (resolved.error) return fail(resolved.error);
      try {
        resolved.target[command.prop] = fromWire(command.value);
      } catch (error) {
        return fail(formatError(error));
      }
      return ok();
    },

    release(command) {
      const target = handles.get(command.handle);
      handles.delete(command.handle);
      for (const [id, subscription] of [...subscriptions]) {
        if (subscription.target === target) subscriptions.delete(id);
      }
      if (target && command.destroy !== false && typeof target.destroy === "function") {
        try { target.destroy(); } catch (_) { /* best effort */ }
      }
      return ok();
    },

    share(command) {
      // onShareAppMessage must return its content synchronously, so Lua sets
      // the content ahead of time instead of answering a callback.
      const resolved = resolveApi("onShareAppMessage");
      if (resolved.error) return fail(resolved.error);
      shareContent = fromWire(command.content) || {};
      if (!shareBound) {
        try {
          resolved.fn.call(api, () => shareContent);
        } catch (error) {
          return fail(formatError(error));
        }
        shareBound = true;
      }
      return ok();
    },

    log(command) {
      const level = command.level === "error" ? "error" : command.level === "warn" ? "warn" : "log";
      console[level]("[DefoldMiniGame][lua]", String(command.message));
      return ok();
    },
  };

  /**
   * Entry point the engine calls in place of eval().
   * @param {string} code the string passed to html5.run()
   * @returns {string}
   */
  function run(code) {
    if (code === HANDSHAKE_EXPRESSION) {
      const reply = handshake();
      reply.client = `c${nextClient}`;
      nextClient += 1;
      return JSON.stringify(reply);
    }
    if (typeof code !== "string" || code.charCodeAt(0) !== 123 /* { */) {
      throw new Error(
        "html5.run() cannot evaluate JavaScript in a mini game because the host disables eval(); "
        + "use the minigame Lua module instead",
      );
    }
    let command;
    try {
      command = JSON.parse(code);
    } catch (error) {
      return JSON.stringify(fail(`the bridge command is not valid JSON: ${error.message}`));
    }
    const operation = Object.prototype.hasOwnProperty.call(operations, command.op) ? operations[command.op] : null;
    if (!operation) return JSON.stringify(fail(`unknown bridge operation '${command.op}'`));
    let reply;
    try {
      reply = operation(command);
    } catch (error) {
      reply = fail(formatError(error));
    }
    return typeof reply === "string" ? reply : JSON.stringify(reply);
  }

  return {
    brand: BRIDGE_BRAND,
    abi: BRIDGE_ABI_VERSION,
    handshake,
    run,
    /** Queues an event for Lua; used by the loader for lifecycle notifications. */
    emit: push,
    get pending() { return queue.length; },
    get handleCount() { return handles.size; },
    get subscriptionCount() { return subscriptions.size; },
  };
}

export {
  BLOCKED_APIS,
  BRIDGE_BRAND,
  HANDSHAKE_EXPRESSION,
  createBridge,
  formatError,
  fromWire,
  toWire,
};
