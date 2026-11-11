/**
 * Simulated mini-game hosts for the test suite.
 *
 * `createHost` builds an isolated JavaScript realm that looks like one of the
 * three providers the runtime supports and then runs an exported package in
 * it, entry file first, the way a host would:
 *
 *   wechat   global `wx`, `WXWebAssembly`; GameGlobal is the global object
 *   douyin   global `tt`, `TTWebAssembly`; GameGlobal is the global object
 *   tiktok   global `TTMinis.game` plus `tt`/`wx` aliases, `TTWebAssembly`;
 *            GameGlobal is a separate object; file-system writes and
 *            getStorageInfoSync "crash" the host
 *
 * A simulated host proves that the runtime's own logic is consistent with the
 * documented host contracts. It does not replace a developer tool or a phone.
 */

import {
  appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";
import vm from "node:vm";
import { brotliDecompressSync } from "node:zlib";

const USER_DATA_PREFIX = { wechat: "wxfile://usr", douyin: "ttfile://user", tiktok: "ttfile://user" };
/** The game.json field each host reads its subpackages from; the other spelling is ignored. */
const SUBPACKAGE_FIELD = { wechat: "subpackages", douyin: "subPackages", tiktok: "subpackages" };

function mapNames(names) {
  return names.split(",").map((part) => part.trim()).filter(Boolean)
    .map((part) => {
      const [imported, local] = part.split(/\s+as\s+/);
      return local ? `${imported.trim()}: ${local.trim()}` : imported.trim();
    })
    .join(", ");
}

/**
 * Rewrites the ES module forms the runtime uses into CommonJS, the way a
 * developer tool does before it loads a package.
 */
export function transformModule(source) {
  let out = source;
  out = out.replace(
    /^import\s+([A-Za-z_$][\w$]*)\s*,\s*\{([^}]*)\}\s*from\s*(["'][^"']+["']);?/gm,
    (_, name, names, from) => `const __m_${name} = require(${from}); const ${name} = __m_${name}.default; const { ${mapNames(names)} } = __m_${name};`,
  );
  out = out.replace(
    /^import\s*\{([^}]*)\}\s*from\s*(["'][^"']+["']);?/gm,
    (_, names, from) => `const { ${mapNames(names)} } = require(${from});`,
  );
  out = out.replace(
    /^import\s+([A-Za-z_$][\w$]*)\s+from\s*(["'][^"']+["']);?/gm,
    (_, name, from) => `const ${name} = require(${from}).default;`,
  );
  out = out.replace(/^import\s*(["'][^"']+["']);?/gm, (_, from) => `require(${from});`);
  out = out.replace(/^export\s+default\s+([^;\n]+);?/gm, (_, expression) => `module.exports.default = ${expression};`);
  out = out.replace(/^export\s*\{([^}]*)\};?/gm, (_, names) => names.split(",")
    .map((part) => part.trim()).filter(Boolean)
    .map((part) => {
      const [local, exported] = part.split(/\s+as\s+/);
      return `module.exports.${(exported || local).trim()} = ${local.trim()};`;
    })
    .join(" "));
  return out;
}

/**
 * @param {object} options
 * @param {"wechat"|"douyin"|"tiktok"} options.platform
 * @param {string} options.packageDir an exported mini-game project
 * @param {string} options.userDataDir folder that backs the host's user data path
 * @param {Map<string, any>} [options.storage] key-value storage; reuse it to simulate a relaunch
 * @param {object} [options.system] overrides for the system information
 * @param {boolean} [options.strictCanvas] the canvas rejects new and replaced properties
 * @param {boolean} [options.webgl2] whether getContext("webgl2") succeeds (default true)
 * @param {boolean} [options.webAudio] whether the host has a Web Audio context (default true)
 * @param {boolean} [options.failSubpackage] loadSubpackage reports a failure
 * @param {boolean} [options.verbose] print console output of the simulated realm
 */
export function createHost(options) {
  const platform = options.platform;
  const packageDir = options.packageDir;
  const userDataDir = options.userDataDir;
  const storage = options.storage || new Map();
  const userDataPrefix = USER_DATA_PREFIX[platform];
  const logs = [];
  const calls = new Map();
  const state = {
    crashed: null,
    loadedSubpackages: new Set(),
    frameCallbacks: [],
    frameCount: 0,
    now: 0,
    touchHandlers: { start: [], move: [], end: [], cancel: [] },
    showHandlers: [], hideHandlers: [], resizeHandlers: [],
    keyboard: { visible: false, input: [], confirm: [], complete: [], shown: [] },
    requestHandler: null,
    audioContexts: [],
    shareHandler: null,
    loading: [], modals: [],
    canvasCount: 0,
    contextRequests: [],
  };

  const record = (name, args) => {
    if (!calls.has(name)) calls.set(name, []);
    calls.get(name).push(args);
  };
  const sink = (level) => (...args) => {
    const line = args.map((arg) => (arg instanceof Error ? (arg.stack || arg.message) : typeof arg === "string" ? arg : (() => {
      try { return JSON.stringify(arg); } catch (_) { return String(arg); }
    })())).join(" ");
    logs.push({ level, line });
    if (options.verbose) process.stderr.write(`[sim:${platform}][${level}] ${line}\n`);
  };

  const sandbox = {
    console: { log: sink("log"), info: sink("info"), warn: sink("warn"), error: sink("error"), debug: sink("debug") },
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  const context = vm.createContext(sandbox);
  const realm = vm.runInContext("({ Uint8Array, ArrayBuffer, WebAssembly, Promise, Error, Object, globalThis })", context);
  const sandboxGlobal = realm.globalThis;

  const toRealmBuffer = (data) => {
    const bytes = new realm.Uint8Array(data.length);
    bytes.set(data);
    return bytes.buffer;
  };
  const fromRealmBinary = (data) => {
    if (typeof data === "string") return Buffer.from(data, "utf8");
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return Buffer.from(new Uint8Array(data));
  };
  const hostError = (message) => Object.assign(new realm.Error(message), { errMsg: message });
  const crash = (what) => {
    if (!state.crashed) state.crashed = what;
    throw hostError(`simulated host crash: ${what}`);
  };

  // ── paths ───────────────────────────────────────────────────────
  function resolvePath(path, { write = false } = {}) {
    const text = String(path);
    if (text.startsWith(userDataPrefix)) {
      return { kind: "user", full: join(userDataDir, text.slice(userDataPrefix.length)) };
    }
    if (write) throw hostError(`fail permission denied, open ${text}`);
    const clean = posix.normalize(text.replace(/^\/+/, ""));
    if (clean.startsWith("..")) throw hostError(`fail no such file or directory ${text}`);
    const top = clean.split("/")[0];
    if (declaredSubpackages().has(top) && !state.loadedSubpackages.has(top)) {
      throw hostError(`fail no such file or directory ${text} (subpackage '${top}' is not loaded)`);
    }
    return { kind: "package", full: join(packageDir, clean) };
  }

  /**
   * The subpackages the package declares, under the field this host reads.
   * Their files are not on the device until loadSubpackage has run.
   */
  function declaredSubpackages() {
    const manifest = join(packageDir, "game.json");
    // Single runtime modules are loaded without a package around them.
    if (!existsSync(manifest)) return new Set(["engine"]);
    const entries = JSON.parse(readFileSync(manifest, "utf8"))[SUBPACKAGE_FIELD[platform]] || [];
    return new Set(entries.map((entry) => String(entry.name)));
  }

  // ── file system manager ─────────────────────────────────────────
  const writeGuard = (name) => { if (platform === "tiktok") crash(`FileSystemManager.${name}`); };
  const fileSystemManager = {
    readFileSync(path, encoding) {
      record("fs.readFileSync", [path, encoding]);
      const target = resolvePath(path);
      if (!existsSync(target.full)) throw hostError(`fail no such file or directory, open ${path}`);
      const data = readFileSync(target.full);
      return encoding ? data.toString(encoding === "utf8" || encoding === "utf-8" ? "utf8" : encoding) : toRealmBuffer(data);
    },
    writeFileSync(path, data, encoding) {
      record("fs.writeFileSync", [path]);
      writeGuard("writeFileSync");
      const target = resolvePath(path, { write: true });
      if (!existsSync(dirname(target.full))) throw hostError(`fail no such file or directory, open ${path}`);
      writeFileSync(target.full, typeof data === "string" ? Buffer.from(data, encoding || "utf8") : fromRealmBinary(data));
    },
    appendFileSync(path, data, encoding) {
      record("fs.appendFileSync", [path]);
      writeGuard("appendFileSync");
      const target = resolvePath(path, { write: true });
      if (!existsSync(target.full)) throw hostError(`fail no such file or directory, open ${path}`);
      appendFileSync(target.full, typeof data === "string" ? Buffer.from(data, encoding || "utf8") : fromRealmBinary(data));
    },
    accessSync(path) {
      const target = resolvePath(path);
      if (!existsSync(target.full)) throw hostError(`fail no such file or directory ${path}`);
    },
    mkdirSync(path, recursive) {
      record("fs.mkdirSync", [path, recursive]);
      writeGuard("mkdirSync");
      const target = resolvePath(path, { write: true });
      if (!recursive && !existsSync(dirname(target.full))) throw hostError(`fail no such file or directory ${path}`);
      mkdirSync(target.full, { recursive: true });
    },
    unlinkSync(path) {
      record("fs.unlinkSync", [path]);
      writeGuard("unlinkSync");
      const target = resolvePath(path, { write: true });
      if (!existsSync(target.full)) throw hostError(`fail no such file or directory ${path}`);
      unlinkSync(target.full);
    },
    renameSync(from, to) {
      record("fs.renameSync", [from, to]);
      writeGuard("renameSync");
      renameSync(resolvePath(from, { write: true }).full, resolvePath(to, { write: true }).full);
    },
    rmdirSync(path, recursive) {
      record("fs.rmdirSync", [path]);
      writeGuard("rmdirSync");
      rmSync(resolvePath(path, { write: true }).full, { recursive: !!recursive, force: true });
    },
    statSync(path) {
      const target = resolvePath(path);
      if (!existsSync(target.full)) throw hostError(`fail no such file or directory ${path}`);
      const stat = statSync(target.full);
      return { size: stat.size, isDirectory: () => stat.isDirectory(), isFile: () => stat.isFile() };
    },
  };

  // ── canvas and WebGL ────────────────────────────────────────────
  function makeContext(type) {
    if (type === "webgl2") {
      if (options.webgl2 === false) return null;
      return {
        __type: "webgl2", createVertexArray() {}, texStorage2D() {}, getParameter() { return null; },
        // Enough of a frame buffer for a tool that copies what was drawn:
        // a 6 by 4 image, blue with one red pixel in the bottom-left corner.
        drawingBufferWidth: 6, drawingBufferHeight: 4,
        FRAMEBUFFER: 0x8d40, FRAMEBUFFER_BINDING: 0x8ca6, RGBA: 0x1908, UNSIGNED_BYTE: 0x1401,
        bindFramebuffer() {},
        readPixels(x, y, width, height, format, type, pixels) {
          for (let index = 0; index < width * height; index += 1) {
            pixels[index * 4] = index === 0 ? 255 : 0;
            pixels[index * 4 + 1] = 0;
            pixels[index * 4 + 2] = index === 0 ? 0 : 255;
            pixels[index * 4 + 3] = 255;
          }
        },
      };
    }
    if (type === "webgl" || type === "experimental-webgl") {
      return { __type: "webgl", getParameter() { return null; } };
    }
    if (type === "2d") return { __type: "2d", fillRect() {}, drawImage() {} };
    return null;
  }

  function makeCanvas(isMain) {
    const contexts = new Map();
    let width = 300;
    let height = 150;
    const canvas = {};
    Object.defineProperty(canvas, "width", { get: () => width, set: (value) => { width = value; }, enumerable: true, configurable: false });
    Object.defineProperty(canvas, "height", { get: () => height, set: (value) => { height = value; }, enumerable: true, configurable: false });
    const getContext = function (type, attributes) {
      if (isMain) state.contextRequests.push({ type, attributes: attributes ? { ...attributes } : null });
      // A host hands out one context per type; a second request with other
      // attributes would not change the first one.
      if (!contexts.has(type)) contexts.set(type, makeContext(type));
      return contexts.get(type);
    };
    if (options.strictCanvas && isMain) {
      Object.defineProperty(canvas, "getContext", { value: getContext, writable: false, configurable: false, enumerable: true });
      Object.preventExtensions(canvas);
    } else {
      canvas.getContext = getContext;
    }
    return canvas;
  }
  let mainCanvas = null;

  // ── Web Audio ───────────────────────────────────────────────────
  function makeAudioContext() {
    const audio = {
      sampleRate: 48000,
      state: "suspended",
      currentTime: 0,
      destination: { kind: "destination" },
      listener: {},
      onstatechange: null,
      sources: 0,
      buffers: 0,
      createBuffer(channels, length, sampleRate) {
        audio.buffers += 1;
        const data = [];
        for (let c = 0; c < channels; c += 1) data.push(new Float32Array(length));
        // No copyToChannel: older host AudioBuffers only have getChannelData.
        return { numberOfChannels: channels, length, sampleRate, getChannelData: (c) => data[c] };
      },
      createBufferSource() {
        audio.sources += 1;
        return { buffer: null, onended: null, connect() {}, disconnect() {}, start() {}, stop() {} };
      },
      createGain() { return { gain: { value: 1 }, connect() {}, disconnect() {} }; },
      resume() { audio.state = "running"; if (audio.onstatechange) audio.onstatechange(); return realm.Promise.resolve(); },
      suspend() { audio.state = "suspended"; if (audio.onstatechange) audio.onstatechange(); return realm.Promise.resolve(); },
      close() { audio.state = "closed"; return realm.Promise.resolve(); },
    };
    state.audioContexts.push(audio);
    return audio;
  }

  // ── system information ──────────────────────────────────────────
  const system = Object.assign({
    brand: "Apple", model: "iPhone 14", platform: "ios", system: "iOS 16.5", language: "zh_CN",
    version: "8.0.50", SDKVersion: "3.8.12", pixelRatio: 3,
    windowWidth: 390, windowHeight: 844, screenWidth: 390, screenHeight: 844, statusBarHeight: 47,
    safeArea: { top: 47, bottom: 810, left: 0, right: 390, width: 390, height: 763 },
  }, options.system || {});

  const defer = (task) => setTimeout(task, 0);
  const asyncApi = (name, produce) => function (opts) {
    record(name, [opts]);
    const request = opts || {};
    defer(() => {
      let result;
      try { result = produce(request); } catch (error) {
        if (typeof request.fail === "function") request.fail({ errMsg: `${name}:fail ${error.message}` });
        return;
      }
      if (typeof request.success === "function") request.success(Object.assign({ errMsg: `${name}:ok` }, result));
    });
  };

  // ── the provider API ────────────────────────────────────────────
  const api = {
    env: { USER_DATA_PATH: userDataPrefix },
    getSystemInfoSync() { record("getSystemInfoSync", []); return { ...system }; },
    getWindowInfo() {
      return {
        pixelRatio: system.pixelRatio, windowWidth: system.windowWidth, windowHeight: system.windowHeight,
        screenWidth: system.screenWidth, screenHeight: system.screenHeight, statusBarHeight: system.statusBarHeight,
        safeArea: system.safeArea,
      };
    },
    createCanvas() {
      record("createCanvas", []);
      state.canvasCount += 1;
      if (!mainCanvas) { mainCanvas = makeCanvas(true); return mainCanvas; }
      return makeCanvas(false);
    },
    createImage() { return { src: "", width: 0, height: 0, onload: null, onerror: null }; },
    getFileSystemManager() {
      record("getFileSystemManager", []);
      return fileSystemManager;
    },
    getStorageSync(key) { record("getStorageSync", [key]); return storage.has(key) ? storage.get(key) : ""; },
    setStorageSync(key, value) { record("setStorageSync", [key]); storage.set(key, value); },
    removeStorageSync(key) { record("removeStorageSync", [key]); storage.delete(key); },
    clearStorageSync() { record("clearStorageSync", []); storage.clear(); },
    getStorageInfoSync() {
      record("getStorageInfoSync", []);
      if (platform === "tiktok") crash("getStorageInfoSync");
      return { keys: [...storage.keys()], currentSize: storage.size, limitSize: 10240 };
    },
    onTouchStart(handler) { state.touchHandlers.start.push(handler); },
    onTouchMove(handler) { state.touchHandlers.move.push(handler); },
    onTouchEnd(handler) { state.touchHandlers.end.push(handler); },
    onTouchCancel(handler) { state.touchHandlers.cancel.push(handler); },
    onShow(handler) { state.showHandlers.push(handler); },
    onHide(handler) { state.hideHandlers.push(handler); },
    offShow(handler) { state.showHandlers = state.showHandlers.filter((entry) => entry !== handler); },
    offHide(handler) { state.hideHandlers = state.hideHandlers.filter((entry) => entry !== handler); },
    onWindowResize(handler) { state.resizeHandlers.push(handler); },
    loadSubpackage(opts) {
      record("loadSubpackage", [opts.name]);
      const progressHandlers = [];
      defer(() => {
        for (const handler of progressHandlers) handler({ progress: 50, totalBytesWritten: 1, totalBytesExpectedToWrite: 2 });
        if (options.failSubpackage) {
          if (opts.fail) opts.fail({ errMsg: "loadSubpackage:fail module not found" });
          return;
        }
        if (!declaredSubpackages().has(opts.name)) {
          if (opts.fail) opts.fail({ errMsg: `loadSubpackage:fail the subpackage '${opts.name}' is not declared in game.json` });
          return;
        }
        state.loadedSubpackages.add(opts.name);
        try {
          load(`${opts.name}/game.js`);
        } catch (error) {
          if (opts.fail) opts.fail({ errMsg: `loadSubpackage:fail ${error.message}` });
          return;
        }
        for (const handler of progressHandlers) handler({ progress: 100, totalBytesWritten: 2, totalBytesExpectedToWrite: 2 });
        if (opts.success) opts.success({ errMsg: "loadSubpackage:ok" });
      });
      return { onProgressUpdate(handler) { progressHandlers.push(handler); } };
    },
    showLoading(opts) { record("showLoading", [opts]); state.loading.push({ shown: true, title: opts && opts.title }); },
    hideLoading() { record("hideLoading", []); state.loading.push({ shown: false }); },
    showModal(opts) {
      record("showModal", [opts]);
      state.modals.push(opts);
      defer(() => { if (opts && opts.success) opts.success({ confirm: true, cancel: false }); });
    },
    showToast: asyncApi("showToast", () => ({})),
    request(opts) {
      record("request", [opts]);
      let aborted = false;
      defer(() => {
        if (aborted) return;
        const handler = state.requestHandler;
        if (!handler) { if (opts.fail) opts.fail({ errMsg: "request:fail no network" }); return; }
        const reply = handler(opts);
        if (!reply) { if (opts.fail) opts.fail({ errMsg: "request:fail timeout" }); return; }
        const data = Buffer.isBuffer(reply.data) && opts.responseType === "arraybuffer"
          ? toRealmBuffer(reply.data)
          : Buffer.isBuffer(reply.data) ? reply.data.toString("utf8") : reply.data;
        opts.success({ statusCode: reply.statusCode || 200, header: reply.header || {}, data, errMsg: "request:ok" });
      });
      return { abort() { aborted = true; } };
    },
    showKeyboard(opts) { record("showKeyboard", [opts]); state.keyboard.visible = true; state.keyboard.shown.push(opts); },
    hideKeyboard() { record("hideKeyboard", []); state.keyboard.visible = false; },
    onKeyboardInput(handler) { state.keyboard.input.push(handler); },
    onKeyboardConfirm(handler) { state.keyboard.confirm.push(handler); },
    onKeyboardComplete(handler) { state.keyboard.complete.push(handler); },
    login: asyncApi("login", () => ({ code: `${platform}-login-code` })),
    checkSession: asyncApi("checkSession", () => { throw new Error("session expired"); }),
    vibrateShort: asyncApi("vibrateShort", () => ({})),
    setClipboardData: asyncApi("setClipboardData", (opts) => { state.clipboard = opts.data; return {}; }),
    getClipboardData: asyncApi("getClipboardData", () => ({ data: state.clipboard || "" })),
    getLaunchOptionsSync() { record("getLaunchOptionsSync", []); return { scene: 1001, query: { from: "test" } }; },
    getMenuButtonBoundingClientRect() { return { top: 48, bottom: 80, left: 281, right: 368, width: 87, height: 32 }; },
    onShareAppMessage(handler) { record("onShareAppMessage", []); state.shareHandler = handler; },
    showShareMenu: asyncApi("showShareMenu", () => ({})),
    shareAppMessage: asyncApi("shareAppMessage", () => ({})),
    createRewardedVideoAd(opts) {
      record("createRewardedVideoAd", [opts]);
      const handlers = { close: [], error: [], load: [] };
      const ad = {
        adUnitId: opts && opts.adUnitId,
        destroyed: false,
        load() { defer(() => handlers.load.forEach((handler) => handler({}))); return realm.Promise.resolve(); },
        show() {
          defer(() => handlers.close.forEach((handler) => handler({ isEnded: true })));
          return realm.Promise.resolve();
        },
        onClose(handler) { handlers.close.push(handler); },
        onError(handler) { handlers.error.push(handler); },
        onLoad(handler) { handlers.load.push(handler); },
        destroy() { ad.destroyed = true; },
      };
      state.lastAd = ad;
      return ad;
    },
    getUpdateManager() {
      return { onCheckForUpdate() {}, onUpdateReady() {}, onUpdateFailed() {}, applyUpdate() {} };
    },
  };
  if (options.webAudio !== false) {
    if (platform === "douyin") api.getAudioContext = () => { record("getAudioContext", []); return makeAudioContext(); };
    else api.createWebAudioContext = () => { record("createWebAudioContext", []); return makeAudioContext(); };
  }
  // TikTok opens its share sheet with shareAppMessage and has no hook for the
  // share menu. Seen on an iPhone and an Android phone, 2026-11-11.
  if (platform === "tiktok") delete api.onShareAppMessage;
  if (typeof options.extendApi === "function") options.extendApi(api, { state, realm, defer });

  // ── WebAssembly ─────────────────────────────────────────────────
  const nativeWebAssembly = {
    instantiate(path, imports) {
      record("wasm.instantiate", [path]);
      if (options.hangWasm) return new realm.Promise(() => {});
      if (typeof path !== "string") {
        return realm.Promise.reject(hostError("instantiate only accepts a package path"));
      }
      let bytes;
      try {
        const target = resolvePath(path);
        if (target.kind !== "package") throw hostError("instantiate only accepts a package path");
        if (!existsSync(target.full)) throw hostError(`fail no such file or directory ${path}`);
        bytes = readFileSync(target.full);
        if (path.endsWith(".br")) bytes = brotliDecompressSync(bytes);
      } catch (error) {
        return realm.Promise.reject(error);
      }
      return realm.WebAssembly.instantiate(new realm.Uint8Array(toRealmBuffer(bytes)), imports);
    },
    Memory: realm.WebAssembly.Memory,
    Table: realm.WebAssembly.Table,
    Global: realm.WebAssembly.Global,
  };

  // ── globals of the realm ────────────────────────────────────────
  // WeChat and Douyin expose the global object as GameGlobal; TikTok keeps a
  // separate GameGlobal, which is why nothing may rely on bare globals.
  const gameGlobal = platform === "tiktok" ? vm.runInContext("({})", context) : sandboxGlobal;
  sandboxGlobal.GameGlobal = gameGlobal;
  if (platform === "wechat") {
    sandboxGlobal.wx = api;
    sandboxGlobal.WXWebAssembly = nativeWebAssembly;
  } else if (platform === "douyin") {
    sandboxGlobal.tt = api;
    sandboxGlobal.TTWebAssembly = nativeWebAssembly;
  } else {
    sandboxGlobal.TTMinis = { game: api };
    sandboxGlobal.tt = api;
    sandboxGlobal.wx = api;
    sandboxGlobal.TTWebAssembly = nativeWebAssembly;
  }
  sandboxGlobal.requestAnimationFrame = (callback) => {
    state.frameCallbacks.push(callback);
    return state.frameCallbacks.length;
  };
  sandboxGlobal.cancelAnimationFrame = () => {};

  // ── module loader ───────────────────────────────────────────────
  const modules = new Map();
  function load(relative) {
    const key = posix.normalize(relative);
    if (modules.has(key)) return modules.get(key).exports;
    const target = resolvePath(key);
    if (!existsSync(target.full)) throw hostError(`module not found: ${key}`);
    const source = transformModule(readFileSync(target.full, "utf8"));
    const wrapper = vm.runInContext(`(function (require, module, exports) {${source}\n})`, context, { filename: key });
    const module = { exports: {} };
    modules.set(key, module);
    const base = posix.dirname(key);
    const requireFrom = (request) => {
      let resolved = posix.normalize(posix.join(base, request));
      if (!/\.[a-z]+$/.test(resolved)) resolved += ".js";
      return load(resolved);
    };
    wrapper(requireFrom, module, module.exports);
    return module.exports;
  }

  const host = {
    platform, context, api, logs, calls, state, storage, system,
    global: sandboxGlobal,
    gameGlobal,
    get crashed() { return state.crashed; },
    get mainCanvas() { return mainCanvas; },
    get loader() { return gameGlobal.__defoldMiniGameLoader || sandboxGlobal.__defoldMiniGameLoader || null; },
    get adapter() { return gameGlobal.__defoldMiniGameAdapter || null; },
    get engine() { const loader = host.loader; return loader && loader.module ? loader.module.__fake : null; },
    get bridge() { const loader = host.loader; return loader ? loader.bridge : null; },
    count(name) { return calls.has(name) ? calls.get(name).length : 0; },
    errors() { return logs.filter((entry) => entry.level === "error").map((entry) => entry.line); },
    warnings() { return logs.filter((entry) => entry.level === "warn").map((entry) => entry.line); },

    /** Loads one module of the package, as `require` would. */
    require(path) { return load(path); },
    /** Evaluates an expression inside the simulated realm. */
    evaluate(code) { return vm.runInContext(code, context); },

    /** Runs the package entry file. */
    boot() {
      load("game.js");
      return host;
    },

    /** Runs the entry file and waits for the loader to finish. */
    async start() {
      host.boot();
      const loader = host.loader;
      if (!loader) throw new Error("the package did not publish its loader");
      await loader.load();
      return host;
    },

    /** Lets timers and promise reactions run. */
    async settle(rounds = 4) {
      for (let n = 0; n < rounds; n += 1) await new Promise((resolve) => setTimeout(resolve, 2));
    },

    /** Runs `count` animation frames. */
    frame(count = 1) {
      for (let n = 0; n < count; n += 1) {
        const callbacks = state.frameCallbacks.splice(0, state.frameCallbacks.length);
        state.now += 16.7;
        state.frameCount += 1;
        for (const callback of callbacks) callback(state.now);
      }
    },

    touch(phase, touches, changed) {
      const payload = { touches, changedTouches: changed || touches, timeStamp: state.now };
      for (const handler of state.touchHandlers[phase]) handler(payload);
    },
    hide() { for (const handler of state.hideHandlers.slice()) handler({}); },
    show() { for (const handler of state.showHandlers.slice()) handler({ scene: 1001 }); },
    resize(windowWidth, windowHeight) {
      system.windowWidth = windowWidth;
      system.windowHeight = windowHeight;
      for (const handler of state.resizeHandlers) handler({ windowWidth, windowHeight });
    },
    keyboardInput(value) { for (const handler of state.keyboard.input) handler({ value }); },
    keyboardConfirm(value) { for (const handler of state.keyboard.confirm) handler({ value }); },
    keyboardComplete(value) {
      state.keyboard.visible = false;
      for (const handler of state.keyboard.complete) handler({ value });
    },
    onRequest(handler) { state.requestHandler = handler; },

    /** Sends a bridge command the way the Lua module does and parses the reply. */
    lua(command) {
      const engine = host.engine;
      if (!engine) throw new Error("the engine is not running");
      const reply = engine.luaRun(typeof command === "string" ? command : JSON.stringify(command));
      if (engine.lastRunSuccess !== 1) return { thrown: reply };
      if (reply === "") return "";
      try { return JSON.parse(reply); } catch (_) { return reply; }
    },
  };
  return host;
}
