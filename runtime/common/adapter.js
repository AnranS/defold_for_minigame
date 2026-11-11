/**
 * Mini-game browser-compat adapter for the Defold HTML5 engine.
 *
 * Builds the document / window / canvas / navigator / XMLHttpRequest /
 * WebSocket / AudioContext objects that dmloader.js and the Emscripten glue
 * expect, on top of the selected mini-game provider.
 *
 * Nothing here is written to the global scope. The exporter binds these objects
 * to scoped variables inside the generated engine module, so the adapter keeps
 * working when a host owns `window`, `document`, or `WebAssembly` itself.
 */

import { PlatformRuntime } from "./js/platform_runtime";

const _api = PlatformRuntime.requireCapabilities(["canvas", "windowInfo", "touch"], "adapter");
const _global = PlatformRuntime.global;
const _config = (_global.__defoldMiniGameConfig && typeof _global.__defoldMiniGameConfig === "object")
  ? _global.__defoldMiniGameConfig
  : {};
const _platform = PlatformRuntime.platform;
const _sysInfo = PlatformRuntime.getSystemInfo();

function _log(...args) { console.log("[DefoldMiniGame][adapter]", ...args); }
function _warn(...args) { console.warn("[DefoldMiniGame][adapter]", ...args); }

function _positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

// ── Viewport and pixel ratio ──────────────────────────────────────
// Window and touch APIs use logical pixels; the WebGL backing store uses
// physical pixels. Defold reads the canvas size every frame, so the adapter
// only has to keep `canvas.width/height` in sync with the chosen ratio.
const _hostDpr = _positive(_sysInfo.pixelRatio ?? _sysInfo.devicePixelRatio, 1);
const _maxDpr = _positive(_config.maxPixelRatio, 2);
const _minDpr = _positive(_config.minPixelRatio, 0);
const _dpr = typeof _config.pixelRatio === "number"
  ? _positive(_config.pixelRatio, 1)
  : (_config.highDpi ? Math.min(Math.max(_hostDpr, _minDpr), _maxDpr) : 1);

const _nativeCanvas = _global.canvas || _api.createCanvas();
let _viewportWidth = _positive(_sysInfo.windowWidth || _sysInfo.screenWidth, _positive(_nativeCanvas.width, 1));
let _viewportHeight = _positive(_sysInfo.windowHeight || _sysInfo.screenHeight, _positive(_nativeCanvas.height, 1));

function _backingSize(value) {
  return Math.max(1, Math.floor(value * _dpr));
}

// ── Event registry ────────────────────────────────────────────────
// The canvas, document, and window share one registry. That reproduces the
// part of DOM bubbling the engine relies on: a `touchend` on the canvas also
// reaches the interaction listener Defold registers on `document`.
const _listeners = new Map();

function _addEventListener(type, listener) {
  if (!type || !listener) return;
  let list = _listeners.get(type);
  if (!list) { list = []; _listeners.set(type, list); }
  if (list.indexOf(listener) === -1) list.push(listener);
}

function _removeEventListener(type, listener) {
  const list = _listeners.get(type);
  if (!list) return;
  const index = list.indexOf(listener);
  if (index !== -1) list.splice(index, 1);
}

function _hasListeners(type) {
  const list = _listeners.get(type);
  return !!list && list.length > 0;
}

function _dispatch(type, event) {
  const list = _listeners.get(type);
  if (!list || list.length === 0) return;
  for (const listener of list.slice()) {
    try {
      if (typeof listener === "function") listener(event);
      else if (listener && typeof listener.handleEvent === "function") listener.handleEvent(event);
    } catch (error) {
      console.error("[DefoldMiniGame][adapter] event handler failed:", type, error);
    }
  }
}

// ── Canvas ────────────────────────────────────────────────────────
// Host canvases differ: some reject new properties, some allow getContext to
// succeed only once per type. Every override is recorded here first; when a
// host refuses a direct install the same table backs a Proxy instead.
const _canvasOverrides = new Map();
const _contextCache = new Map();
let _directInstallFailed = false;

function _overrideValue(key, value) {
  _canvasOverrides.set(key, { value });
  try {
    Object.defineProperty(_nativeCanvas, key, { value, configurable: true, writable: true });
  } catch (_) {
    try { _nativeCanvas[key] = value; } catch (_2) { /* checked below */ }
  }
  let installed = false;
  try { installed = _nativeCanvas[key] === value; } catch (_) { installed = false; }
  if (!installed) _directInstallFailed = true;
}

function _overrideAccessor(key, get, set) {
  _canvasOverrides.set(key, { get, set });
  try {
    Object.defineProperty(_nativeCanvas, key, { get, set, configurable: true });
  } catch (_) {
    _directInstallFailed = true;
  }
}

const _nativeGetContext = typeof _nativeCanvas.getContext === "function"
  ? _nativeCanvas.getContext.bind(_nativeCanvas)
  : () => null;

function _getContext(type, attributes) {
  if (_contextCache.has(type)) return _contextCache.get(type);
  let context = null;
  try {
    context = _nativeGetContext(type, attributes);
  } catch (error) {
    _warn(`getContext('${type}') threw:`, error && error.message);
  }
  if (context) _contextCache.set(type, context);
  return context || null;
}

function _boundingRect() {
  return {
    x: 0, y: 0, left: 0, top: 0,
    right: _viewportWidth, bottom: _viewportHeight,
    width: _viewportWidth, height: _viewportHeight,
  };
}

const _fakeParent = {
  style: {},
  children: [],
  appendChild(child) { return child; },
  removeChild(child) { return child; },
  insertBefore(node) { return node; },
};
const _canvasStyle = { width: `${_viewportWidth}px`, height: `${_viewportHeight}px`, background: "" };

let _keyboard = null; // assigned below once the key event helpers exist
let _contentEditable = false;

_overrideValue("getContext", _getContext);
_overrideValue("addEventListener", (type, listener) => _addEventListener(type, listener));
_overrideValue("removeEventListener", (type, listener) => _removeEventListener(type, listener));
_overrideValue("dispatchEvent", (event) => { _dispatch(event && event.type, event); return true; });
_overrideValue("getBoundingClientRect", _boundingRect);
_overrideValue("id", "canvas");
_overrideValue("tagName", "CANVAS");
_overrideValue("style", _canvasStyle);
_overrideValue("parentElement", _fakeParent);
_overrideValue("parentNode", _fakeParent);
_overrideValue("tabIndex", -1);
_overrideValue("focus", () => {});
_overrideValue("blur", () => {});
_overrideValue("setCapture", () => {});
_overrideValue("releaseCapture", () => {});
_overrideValue("insertAdjacentHTML", () => {});
_overrideValue("requestPointerLock", () => {});
_overrideValue("exitPointerLock", () => {});
_overrideValue("requestFullscreen", () => Promise.resolve());
_overrideValue("exitFullscreen", () => Promise.resolve());
_overrideAccessor("clientWidth", () => _viewportWidth);
_overrideAccessor("clientHeight", () => _viewportHeight);
_overrideAccessor("offsetWidth", () => _viewportWidth);
_overrideAccessor("offsetHeight", () => _viewportHeight);
// Defold's glfwShowKeyboard() toggles contentEditable on the canvas. Mini games
// have no editable DOM, so that write is what opens the host keyboard.
_overrideAccessor("contentEditable", () => _contentEditable, (value) => {
  _contentEditable = value === true || value === "true";
  if (_keyboard) _keyboard.setVisible(_contentEditable);
});

let _canvas = _nativeCanvas;
if (_directInstallFailed) {
  _warn("the host canvas rejected property overrides; using a Proxy canvas");
  // The Proxy wraps an empty object, not the canvas: a Proxy must report the
  // real value of every non-configurable property of its target, which is
  // exactly what a canvas that rejects overrides has.
  _canvas = new Proxy({}, {
    get(_target, key) {
      const override = _canvasOverrides.get(key);
      if (override) return override.get ? override.get() : override.value;
      const value = _nativeCanvas[key];
      return typeof value === "function" ? value.bind(_nativeCanvas) : value;
    },
    set(_target, key, value) {
      const override = _canvasOverrides.get(key);
      if (override) {
        if (override.set) override.set(value);
        else if (!override.get) override.value = value;
        return true;
      }
      try { _nativeCanvas[key] = value; } catch (_) { _canvasOverrides.set(key, { value }); }
      // A host that silently ignores the write still has to read it back.
      if (_nativeCanvas[key] !== value) _canvasOverrides.set(key, { value });
      return true;
    },
    has(_target, key) {
      return _canvasOverrides.has(key) || key in _nativeCanvas;
    },
  });
}
_fakeParent.children.push(_canvas);

function _applyCanvasSize() {
  const width = _backingSize(_viewportWidth);
  const height = _backingSize(_viewportHeight);
  if (_nativeCanvas.width !== width) _nativeCanvas.width = width;
  if (_nativeCanvas.height !== height) _nativeCanvas.height = height;
  _canvasStyle.width = `${_viewportWidth}px`;
  _canvasStyle.height = `${_viewportHeight}px`;
}
_applyCanvasSize();

// ── document ──────────────────────────────────────────────────────
function _createElement(tag) {
  const name = String(tag || "").toLowerCase();
  if (name === "canvas") {
    const offscreen = _api.createCanvas();
    const nativeGet = typeof offscreen.getContext === "function" ? offscreen.getContext.bind(offscreen) : null;
    try {
      offscreen.getContext = function (type, attributes) {
        try { return nativeGet ? nativeGet(type, attributes) : null; } catch (_) { return null; }
      };
    } catch (_) { /* keep the host implementation */ }
    return offscreen;
  }
  if ((name === "img" || name === "image") && typeof _api.createImage === "function") {
    return _api.createImage();
  }
  const element = {
    tagName: name.toUpperCase(), style: {}, className: "", id: "", src: "", type: "",
    innerHTML: "", textContent: "", children: [], childNodes: [], parentElement: null, parentNode: null,
    setAttribute() {}, getAttribute() { return null; }, hasAttribute() { return false; }, removeAttribute() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; },
    appendChild(child) { return child; }, removeChild(child) { return child; },
    insertBefore(node) { return node; }, replaceChild(node) { return node; },
    remove() {}, focus() {}, blur() {}, click() {},
    cloneNode() { return _createElement(name); },
    contains() { return false; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; },
  };
  return element;
}

const _container = () => ({
  style: {},
  appendChild(child) { return child; },
  removeChild(child) { return child; },
  insertBefore(node) { return node; },
  contains() { return true; },
  get clientWidth() { return _viewportWidth; },
  get clientHeight() { return _viewportHeight; },
});

const _document = {
  readyState: "complete",
  visibilityState: "visible",
  hidden: false,
  title: "",
  activeElement: _canvas,
  fullscreenElement: null,
  fullscreenEnabled: false,
  mozFullScreenEnabled: false,
  webkitFullscreenEnabled: false,
  msFullscreenEnabled: false,
  pointerLockElement: null,
  currentScript: { src: "" },
  scripts: [],
  documentElement: _container(),
  head: _container(),
  body: _container(),
  createElement: _createElement,
  createElementNS(_namespace, tag) { return _createElement(tag); },
  createTextNode(text) { return { textContent: String(text) }; },
  createEvent() { return { initEvent() {}, preventDefault() {}, stopPropagation() {} }; },
  getElementById(id) { return id === "canvas" ? _canvas : null; },
  getElementsByTagName(tag) {
    if (tag === "canvas") return [_canvas];
    if (tag === "head") return [_document.head];
    if (tag === "body") return [_document.body];
    return [];
  },
  querySelector(selector) {
    if (selector === "canvas" || selector === "#canvas") return _canvas;
    if (selector === "body") return _document.body;
    if (selector === "head") return _document.head;
    return null;
  },
  querySelectorAll(selector) {
    return selector === "canvas" || selector === "#canvas" ? [_canvas] : [];
  },
  addEventListener: (type, listener) => _addEventListener(type, listener),
  removeEventListener: (type, listener) => _removeEventListener(type, listener),
  dispatchEvent(event) { _dispatch(event && event.type, event); return true; },
  exitPointerLock() {},
  exitFullscreen() { return Promise.resolve(); },
  hasFocus() { return !_document.hidden; },
};

// ── navigator ─────────────────────────────────────────────────────
// Defold picks WebGL 1 on iOS older than 15.2 by parsing the user agent, and
// sys.get_sys_info() reports it to Lua. Hosts expose no user agent, so one is
// assembled from the system information they do provide.
function _buildUserAgent() {
  const system = String(_sysInfo.system || "");
  const hostPlatform = String(_sysInfo.platform || "").toLowerCase();
  const model = String(_sysInfo.model || "Unknown").replace(/[;()]/g, " ").trim() || "Unknown";
  const suffix = `MiniGame DefoldMiniGame/${_platform}`;
  const version = (system.match(/(\d+(?:[._]\d+)*)/) || [])[1] || "";
  if (hostPlatform === "ios" || /^ios/i.test(system)) {
    const iosVersion = (version || "15.4").replace(/\./g, "_");
    return `Mozilla/5.0 (iPhone; CPU iPhone OS ${iosVersion} like Mac OS X) AppleWebKit/605.1.15 `
      + `(KHTML, like Gecko) Mobile/15E148 ${suffix}`;
  }
  if (hostPlatform === "android" || /^android/i.test(system)) {
    return `Mozilla/5.0 (Linux; Android ${version || "10"}; ${model}) AppleWebKit/537.36 `
      + `(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36 ${suffix}`;
  }
  return `Mozilla/5.0 (${hostPlatform || "minigame"}; ${model}) AppleWebKit/537.36 `
    + `(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 ${suffix}`;
}

const _language = String(_sysInfo.language || "en").replace("_", "-");
const _navigator = {
  userAgent: _buildUserAgent(),
  platform: String(_sysInfo.platform || "MiniGame"),
  language: _language,
  languages: [_language],
  onLine: true,
  maxTouchPoints: 10,
  hardwareConcurrency: 4,
  userActivation: { hasBeenActive: true, isActive: true },
  getGamepads: () => [],
  vibrate: () => false,
};

const _location = {
  href: `https://${_platform}.minigame.localhost/index.html`,
  protocol: "https:",
  host: `${_platform}.minigame.localhost`,
  hostname: `${_platform}.minigame.localhost`,
  port: "", pathname: "/index.html", search: "", hash: "",
  origin: `https://${_platform}.minigame.localhost`,
  assign() {}, reload() {}, replace() {},
  toString() { return this.href; },
};

const _hostPerformance = (typeof _api.getPerformance === "function") ? (() => {
  try { return _api.getPerformance(); } catch (_) { return null; }
})() : null;
const _perfStart = Date.now();
const _performance = {
  // WeChat's getPerformance().now() reports microseconds on some clients, so
  // the adapter keeps one millisecond clock for every host.
  now: () => {
    if (_global.performance && typeof _global.performance.now === "function") return _global.performance.now();
    return Date.now() - _perfStart;
  },
  timing: { navigationStart: _perfStart },
  mark() {}, measure() {},
  getEntriesByName: () => [], getEntriesByType: () => [],
  clearMarks() {}, clearMeasures() {},
  host: _hostPerformance,
};

// ── XMLHttpRequest ────────────────────────────────────────────────
function _toArrayBuffer(data) {
  if (data == null) return undefined;
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  return data;
}

class _XMLHttpRequest {
  constructor() {
    this.readyState = 0;
    this.status = 0;
    this.statusText = "";
    this.response = null;
    this.responseText = "";
    this.responseType = "";
    this.responseURL = "";
    this.timeout = 0;
    this.withCredentials = false;
    this._method = "GET";
    this._url = "";
    this._headers = {};
    this._responseHeaders = {};
    this._listeners = {};
    this._task = null;
    this._done = false;
  }

  open(method, url) {
    this._method = String(method || "GET").toUpperCase();
    this._url = String(url);
    this.responseURL = this._url;
    this.readyState = 1;
    this._fire("readystatechange");
  }

  setRequestHeader(key, value) { this._headers[String(key).trim()] = String(value).trim(); }

  getResponseHeader(key) {
    const value = this._responseHeaders[String(key).toLowerCase()];
    return value === undefined ? null : value;
  }

  getAllResponseHeaders() {
    return Object.keys(this._responseHeaders)
      .map((key) => `${key}: ${this._responseHeaders[key]}`)
      .join("\r\n");
  }

  overrideMimeType() {}

  send(body) {
    if (typeof _api.request !== "function") {
      this._finish(0, "request is not supported by this host", null, "error");
      return;
    }
    const binary = this.responseType === "arraybuffer";
    const options = {
      url: this._url,
      method: this._method,
      header: this._headers,
      responseType: binary ? "arraybuffer" : "text",
      success: (res) => {
        this._responseHeaders = {};
        const headers = res.header || res.headers || {};
        for (const key of Object.keys(headers)) this._responseHeaders[key.toLowerCase()] = headers[key];
        let data = res.data;
        if (!binary && typeof data !== "string") {
          try { data = JSON.stringify(data); } catch (_) { data = String(data); }
        }
        this._finish(Number(res.statusCode) || 0, res.errMsg || "OK", data, "load");
      },
      fail: (error) => {
        const message = (error && error.errMsg) || "request failed";
        this._finish(0, message, null, /time\s?out/i.test(message) ? "timeout" : "error");
      },
    };
    const data = _toArrayBuffer(body);
    if (data !== undefined) options.data = data;
    if (this.timeout > 0) options.timeout = this.timeout;
    try {
      this._task = _api.request(options) || null;
    } catch (error) {
      this._finish(0, String((error && error.message) || error), null, "error");
    }
  }

  abort() {
    if (this._done) return;
    this._done = true;
    try { if (this._task && typeof this._task.abort === "function") this._task.abort(); } catch (_) { /* ignore */ }
    this.readyState = 0;
    this._fire("abort");
    this._fire("loadend");
  }

  _finish(status, statusText, data, eventName) {
    if (this._done) return;
    this._done = true;
    this.status = status;
    this.statusText = statusText;
    if (eventName === "load") {
      this.response = data;
      if (this.responseType !== "arraybuffer") this.responseText = data == null ? "" : data;
      const loaded = data && data.byteLength !== undefined ? data.byteLength : String(data || "").length;
      this._fire("progress", { loaded, total: loaded, lengthComputable: true });
    }
    this.readyState = 4;
    this._fire("readystatechange");
    this._fire(eventName);
    this._fire("loadend");
  }

  addEventListener(type, listener) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(listener);
  }

  removeEventListener(type, listener) {
    const list = this._listeners[type];
    if (!list) return;
    const index = list.indexOf(listener);
    if (index !== -1) list.splice(index, 1);
  }

  _fire(type, detail) {
    const event = Object.assign({ type, target: this, currentTarget: this }, detail || {});
    const handler = this[`on${type}`];
    if (typeof handler === "function") {
      try { handler.call(this, event); } catch (error) { console.error("[DefoldMiniGame][xhr]", error); }
    }
    const list = this._listeners[type];
    if (list) {
      for (const listener of list.slice()) {
        try { listener.call(this, event); } catch (error) { console.error("[DefoldMiniGame][xhr]", error); }
      }
    }
  }
}
_XMLHttpRequest.UNSENT = 0;
_XMLHttpRequest.OPENED = 1;
_XMLHttpRequest.HEADERS_RECEIVED = 2;
_XMLHttpRequest.LOADING = 3;
_XMLHttpRequest.DONE = 4;

// ── WebSocket ─────────────────────────────────────────────────────
class _WebSocket {
  constructor(url, protocols) {
    this.url = String(url);
    this.readyState = 0;
    this.binaryType = "arraybuffer";
    this.bufferedAmount = 0;
    this.extensions = "";
    this.protocol = "";
    this._listeners = {};
    if (typeof _api.connectSocket !== "function") {
      throw new Error("connectSocket is not supported by this host");
    }
    const list = protocols ? (Array.isArray(protocols) ? protocols : [protocols]) : [];
    this._task = _api.connectSocket({ url: this.url, protocols: list });
    this._task.onOpen(() => { this.readyState = 1; this._fire("open"); });
    this._task.onMessage((res) => { this._fire("message", { data: res.data }); });
    this._task.onError((error) => { this._fire("error", { message: (error && error.errMsg) || "socket error" }); });
    this._task.onClose((res) => {
      this.readyState = 3;
      this._fire("close", { code: (res && res.code) || 1000, reason: (res && res.reason) || "", wasClean: true });
    });
  }

  send(data) {
    if (this.readyState !== 1) throw new Error("WebSocket is not open");
    this._task.send({ data: typeof data === "string" ? data : _toArrayBuffer(data) });
  }

  close(code, reason) {
    if (this.readyState === 3) return;
    this.readyState = 2;
    this._task.close({ code: code || 1000, reason: reason || "" });
  }

  addEventListener(type, listener) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(listener);
  }

  removeEventListener(type, listener) {
    const list = this._listeners[type];
    if (!list) return;
    const index = list.indexOf(listener);
    if (index !== -1) list.splice(index, 1);
  }

  _fire(type, detail) {
    const event = Object.assign({ type, target: this }, detail || {});
    const handler = this[`on${type}`];
    if (typeof handler === "function") handler.call(this, event);
    const list = this._listeners[type];
    if (list) for (const listener of list.slice()) listener.call(this, event);
  }
}
_WebSocket.CONNECTING = 0;
_WebSocket.OPEN = 1;
_WebSocket.CLOSING = 2;
_WebSocket.CLOSED = 3;

// ── AudioContext ──────────────────────────────────────────────────
// Defold mixes audio in WebAssembly and plays each mixed block through a new
// AudioBuffer and AudioBufferSourceNode. WeChat and Douyin provide a real Web
// Audio context for that. On TikTok Native this exact pattern crashed the
// client in godot_for_minigame's device tests, so the engine mixer stays off
// there unless the export opts in; without an AudioContext Defold falls back
// to its silent wall-clock queue and the game keeps running.
function _createNativeAudioContext() {
  try {
    if (typeof _api.createWebAudioContext === "function") return _api.createWebAudioContext();
    if (typeof _api.getAudioContext === "function") return _api.getAudioContext();
  } catch (error) {
    _warn("the host Web Audio context could not be created:", error && error.message);
  }
  return null;
}

const _engineAudioSetting = String(_config.engineAudio || "auto");
const _hasWebAudio = PlatformRuntime.capabilities.webAudio === true;
const _engineAudioEnabled = _engineAudioSetting === "off"
  ? false
  : _engineAudioSetting === "on"
    ? _hasWebAudio
    : (_hasWebAudio && _platform !== "tiktok");
const _audioContexts = [];

class _AudioContext {
  constructor() {
    const native = _createNativeAudioContext();
    if (!native) throw new Error("Web Audio is not available on this host");
    this._native = native;
    this._onstatechange = null;
    this._notifiedState = native.state;
    this.destination = native.destination;
    this.listener = native.listener;
    try {
      native.onstatechange = () => this._notify();
    } catch (_) { /* some hosts expose a read-only handler slot */ }
    _audioContexts.push(this);
  }

  get sampleRate() { return this._native.sampleRate || 44100; }
  get currentTime() { return this._native.currentTime || 0; }
  get state() { return this._native.state || "running"; }
  get onstatechange() { return this._onstatechange; }
  set onstatechange(handler) { this._onstatechange = handler; }

  _notify() {
    // Some hosts fire onstatechange themselves and some do not; report each
    // transition once either way.
    const current = this.state;
    if (current === this._notifiedState) return;
    this._notifiedState = current;
    if (typeof this._onstatechange === "function") {
      try { this._onstatechange({ type: "statechange", target: this }); } catch (error) { console.error(error); }
    }
  }

  createBuffer(channels, length, sampleRate) {
    const buffer = this._native.createBuffer(channels, length, sampleRate);
    if (buffer && typeof buffer.copyToChannel !== "function" && typeof buffer.getChannelData === "function") {
      buffer.copyToChannel = function (source, channel, offset) {
        buffer.getChannelData(channel).set(source, offset || 0);
      };
    }
    return buffer;
  }

  createBufferSource() { return this._native.createBufferSource(); }
  createGain() { return this._native.createGain(); }

  _call(method) {
    let result;
    try { result = this._native[method](); } catch (error) { return Promise.reject(error); }
    const done = (result && typeof result.then === "function") ? result : Promise.resolve(result);
    return done.then((value) => { this._notify(); return value; });
  }

  resume() { return this._call("resume"); }
  suspend() { return this._call("suspend"); }

  close() {
    const index = _audioContexts.indexOf(this);
    if (index !== -1) _audioContexts.splice(index, 1);
    return typeof this._native.close === "function" ? this._call("close") : Promise.resolve();
  }
}

function _forEachAudioContext(method) {
  for (const context of _audioContexts.slice()) {
    try {
      const result = context[method]();
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) { /* a failing host context must not break the lifecycle */ }
  }
}

// ── crypto ────────────────────────────────────────────────────────
const _hostCrypto = (_global.crypto && typeof _global.crypto.getRandomValues === "function")
  ? _global.crypto
  : (typeof globalThis.crypto === "object" && globalThis.crypto
      && typeof globalThis.crypto.getRandomValues === "function")
    ? globalThis.crypto
    : null;
const _fallbackCrypto = {
  // Compatibility fallback only; it never replaces a host implementation and
  // must not be used for anything security sensitive.
  getRandomValues(view) {
    for (let i = 0; i < view.length; i += 1) view[i] = Math.floor(Math.random() * 256);
    return view;
  },
};

// ── window ────────────────────────────────────────────────────────
const _timers = {
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (id) => clearTimeout(id),
  setInterval: (...args) => setInterval(...args),
  clearInterval: (id) => clearInterval(id),
};

function _requestAnimationFrame(callback) {
  if (typeof _global.requestAnimationFrame === "function") return _global.requestAnimationFrame(callback);
  if (typeof requestAnimationFrame === "function") return requestAnimationFrame(callback);
  if (typeof _nativeCanvas.requestAnimationFrame === "function") return _nativeCanvas.requestAnimationFrame(callback);
  return setTimeout(() => callback(_performance.now()), 16);
}

function _cancelAnimationFrame(id) {
  if (typeof _global.cancelAnimationFrame === "function") return _global.cancelAnimationFrame(id);
  if (typeof cancelAnimationFrame === "function") return cancelAnimationFrame(id);
  if (typeof _nativeCanvas.cancelAnimationFrame === "function") return _nativeCanvas.cancelAnimationFrame(id);
  return clearTimeout(id);
}

const _screen = {
  get width() { return _positive(_sysInfo.screenWidth, _viewportWidth); },
  get height() { return _positive(_sysInfo.screenHeight, _viewportHeight); },
  get availWidth() { return _viewportWidth; },
  get availHeight() { return _viewportHeight; },
  orientation: { type: "portrait-primary", angle: 0, addEventListener() {}, removeEventListener() {} },
};

const _window = {
  document: _document,
  navigator: _navigator,
  location: _location,
  screen: _screen,
  performance: _performance,
  canvas: _canvas,
  crypto: _hostCrypto || _fallbackCrypto,
  devicePixelRatio: _dpr,
  innerWidth: _viewportWidth,
  innerHeight: _viewportHeight,
  outerWidth: _viewportWidth,
  outerHeight: _viewportHeight,
  scrollX: 0, scrollY: 0, pageXOffset: 0, pageYOffset: 0,
  isSecureContext: true,
  crossOriginIsolated: false,
  indexedDB: null, // installed by the loader once the persistence store is open
  XMLHttpRequest: _XMLHttpRequest,
  WebSocket: _WebSocket,
  setTimeout: _timers.setTimeout,
  clearTimeout: _timers.clearTimeout,
  setInterval: _timers.setInterval,
  clearInterval: _timers.clearInterval,
  requestAnimationFrame: _requestAnimationFrame,
  cancelAnimationFrame: _cancelAnimationFrame,
  addEventListener: (type, listener) => _addEventListener(type, listener),
  removeEventListener: (type, listener) => _removeEventListener(type, listener),
  dispatchEvent(event) { _dispatch(event && event.type, event); return true; },
  scrollTo() {},
  focus() {}, blur() {},
  open() { return null; },
  alert(message) { console.warn("[alert]", message); },
  confirm() { return false; },
  prompt() { return null; },
  getComputedStyle: () => ({}),
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
};
if (_engineAudioEnabled) {
  _window.AudioContext = _AudioContext;
  _window.webkitAudioContext = _AudioContext;
}
_window.window = _window;
_window.self = _window;
_window.top = _window;
_window.parent = _window;
_window.globalThis = _window;

// ── Touch input ───────────────────────────────────────────────────
// Defold registers touchstart/touchmove/touchend/touchcancel on the canvas and
// derives its own mouse state from the first touch, so the canonical touch
// stream is all it needs. Mouse events are only synthesized for code that
// registered no touch listener at all.
function _coordinate(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return 0;
}

function _wrapTouch(raw) {
  const source = raw || {};
  // TikTok Native documents screenX/screenY; WeChat and Douyin use clientX/clientY.
  const clientX = _coordinate(source.clientX, source.pageX, source.screenX);
  const clientY = _coordinate(source.clientY, source.pageY, source.screenY);
  return {
    identifier: source.identifier ?? 0,
    clientX, clientY,
    pageX: _coordinate(source.pageX, clientX),
    pageY: _coordinate(source.pageY, clientY),
    screenX: _coordinate(source.screenX, clientX),
    screenY: _coordinate(source.screenY, clientY),
    radiusX: source.radiusX ?? 0,
    radiusY: source.radiusY ?? 0,
    rotationAngle: source.rotationAngle ?? 0,
    force: source.force ?? 1,
    target: _canvas,
  };
}

function _wrapTouchList(raw) {
  const list = [];
  if (raw) for (let i = 0; i < raw.length; i += 1) list.push(_wrapTouch(raw[i]));
  list.item = (index) => list[index] || null;
  return list;
}

function _baseEvent(type) {
  return {
    type,
    target: _canvas, currentTarget: _canvas, srcElement: _canvas,
    bubbles: true, cancelable: true, defaultPrevented: false,
    timeStamp: _performance.now(),
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {}, stopImmediatePropagation() {},
  };
}

function _touchEvent(type, raw) {
  const event = _baseEvent(type);
  event.touches = _wrapTouchList(raw && raw.touches);
  event.changedTouches = _wrapTouchList(raw && raw.changedTouches);
  event.targetTouches = event.touches;
  return event;
}

function _mouseEvent(type, touch) {
  const event = _baseEvent(type);
  Object.assign(event, {
    clientX: touch.clientX, clientY: touch.clientY,
    pageX: touch.pageX, pageY: touch.pageY,
    screenX: touch.screenX, screenY: touch.screenY,
    offsetX: touch.clientX, offsetY: touch.clientY,
    movementX: 0, movementY: 0,
    button: 0, buttons: type === "mouseup" ? 0 : 1, detail: 0,
  });
  return event;
}

function _forwardTouch(touchType, mouseType, raw) {
  const changed = (raw && raw.changedTouches) || [];
  if (changed.length === 0) return;
  if (_hasListeners(touchType)) {
    _dispatch(touchType, _touchEvent(touchType, raw));
  } else if (mouseType) {
    _dispatch(mouseType, _mouseEvent(mouseType, _wrapTouch(changed[0])));
  }
  if (touchType === "touchend") _dispatch("click", _mouseEvent("click", _wrapTouch(changed[0])));
}

_api.onTouchStart((raw) => _forwardTouch("touchstart", "mousedown", raw));
_api.onTouchMove((raw) => _forwardTouch("touchmove", "mousemove", raw));
_api.onTouchEnd((raw) => _forwardTouch("touchend", "mouseup", raw));
if (typeof _api.onTouchCancel === "function") {
  _api.onTouchCancel((raw) => _forwardTouch("touchcancel", "mouseup", raw));
}

// ── Keyboard ──────────────────────────────────────────────────────
// gui.show_keyboard() ends up in glfwShowKeyboard(), which makes the canvas
// content-editable and waits for DOM key events. The adapter opens the host
// keyboard instead and replays the edited text as keydown/keypress/keyup.
function _keyEvent(type, keyCode, charCode, key) {
  const event = _baseEvent(type);
  Object.assign(event, {
    keyCode, which: charCode || keyCode, charCode: charCode || 0, key: key || "",
    code: "", location: 0, repeat: false,
    altKey: false, ctrlKey: false, shiftKey: false, metaKey: false,
  });
  return event;
}

function _pressKey(keyCode, key) {
  _dispatch("keydown", _keyEvent("keydown", keyCode, 0, key));
  _dispatch("keyup", _keyEvent("keyup", keyCode, 0, key));
}

function _typeText(text) {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    _dispatch("keypress", _keyEvent("keypress", codePoint, codePoint, character));
  }
}

function _createKeyboard() {
  if (!PlatformRuntime.capabilities.keyboard) return null;
  let visible = false;
  let lastValue = "";
  let bound = false;

  function onInput(res) {
    const value = String((res && res.value) || "");
    let prefix = 0;
    const limit = Math.min(value.length, lastValue.length);
    while (prefix < limit && value[prefix] === lastValue[prefix]) prefix += 1;
    const removed = Array.from(lastValue.slice(prefix)).length;
    for (let n = 0; n < removed; n += 1) _pressKey(8, "Backspace");
    _typeText(value.slice(prefix));
    lastValue = value;
  }

  function onConfirm() {
    _pressKey(13, "Enter");
  }

  function onComplete() {
    visible = false;
    lastValue = "";
    _contentEditable = false;
  }

  function bind() {
    if (bound) return;
    bound = true;
    _api.onKeyboardInput(onInput);
    if (typeof _api.onKeyboardConfirm === "function") _api.onKeyboardConfirm(onConfirm);
    if (typeof _api.onKeyboardComplete === "function") _api.onKeyboardComplete(onComplete);
  }

  return {
    get visible() { return visible; },
    setVisible(show) {
      if (show === visible) return;
      visible = show;
      lastValue = "";
      try {
        if (show) {
          bind();
          _api.showKeyboard({
            defaultValue: "", maxLength: 1000, multiple: false,
            confirmHold: false, confirmType: "done",
          });
        } else {
          _api.hideKeyboard({});
        }
      } catch (error) {
        _warn("the host keyboard call failed:", error && error.message);
      }
    },
  };
}
_keyboard = _createKeyboard();

// ── Window resize and lifecycle ───────────────────────────────────
function _setViewportSize(width, height) {
  _viewportWidth = _positive(width, _viewportWidth);
  _viewportHeight = _positive(height, _viewportHeight);
  _window.innerWidth = _viewportWidth;
  _window.innerHeight = _viewportHeight;
  _window.outerWidth = _viewportWidth;
  _window.outerHeight = _viewportHeight;
  _applyCanvasSize();
}

if (typeof _api.onWindowResize === "function") {
  _api.onWindowResize((res) => {
    const size = (res && res.size) || res || {};
    _setViewportSize(size.windowWidth, size.windowHeight);
    _dispatch("resize", _baseEvent("resize"));
  });
}

if (PlatformRuntime.capabilities.lifecycle) {
  _api.onHide(() => {
    _document.hidden = true;
    _document.visibilityState = "hidden";
    _dispatch("blur", _baseEvent("blur"));
    _dispatch("visibilitychange", _baseEvent("visibilitychange"));
    _forEachAudioContext("suspend");
  });
  _api.onShow(() => {
    _document.hidden = false;
    _document.visibilityState = "visible";
    _forEachAudioContext("resume");
    _dispatch("focus", _baseEvent("focus"));
    _dispatch("visibilitychange", _baseEvent("visibilitychange"));
  });
}

// ── WebGL constructor stand-ins ───────────────────────────────────
// Emscripten checks `gl instanceof WebGLRenderingContext` to tell a WebGL 1
// context from a WebGL 2 one. Hosts do not always expose those constructors,
// so the stand-ins answer the same question by looking at the context itself.
function _isWebGL2(context) {
  if (!context) return false;
  const HostWebGL2 = _global.WebGL2RenderingContext || globalThis.WebGL2RenderingContext;
  if (typeof HostWebGL2 === "function") {
    try { if (context instanceof HostWebGL2) return true; } catch (_) { /* fall through */ }
  }
  return typeof context.createVertexArray === "function" && typeof context.texStorage2D === "function";
}

function _contextType(name, predicate) {
  const type = function () { throw new TypeError(`${name} is not constructible`); };
  Object.defineProperty(type, Symbol.hasInstance, { value: predicate });
  Object.defineProperty(type, "name", { value: name });
  return type;
}

const _WebGLRenderingContext = _contextType("WebGLRenderingContext", (value) => !!value && !_isWebGL2(value));
const _WebGL2RenderingContext = _contextType("WebGL2RenderingContext", (value) => _isWebGL2(value));

class _Blob {
  constructor(parts, options) {
    this.parts = parts || [];
    this.type = (options && options.type) || "";
    this.size = this.parts.reduce((total, part) => total + ((part && (part.byteLength ?? part.length)) || 0), 0);
  }
}

const _URL = {
  createObjectURL: () => "",
  revokeObjectURL: () => {},
};

const adapter = {
  platform: _platform,
  canvas: _canvas,
  nativeCanvas: _nativeCanvas,
  usesProxyCanvas: _canvas !== _nativeCanvas,
  window: _window,
  document: _document,
  navigator: _navigator,
  location: _location,
  screen: _screen,
  performance: _performance,
  crypto: _hostCrypto || _fallbackCrypto,
  XMLHttpRequest: _XMLHttpRequest,
  WebSocket: _WebSocket,
  AudioContext: _engineAudioEnabled ? _AudioContext : undefined,
  WebGLRenderingContext: _WebGLRenderingContext,
  WebGL2RenderingContext: _WebGL2RenderingContext,
  Blob: _Blob,
  URL: _URL,
  Image: function Image() { return _createElement("img"); },
  requestAnimationFrame: _requestAnimationFrame,
  cancelAnimationFrame: _cancelAnimationFrame,
  pixelRatio: _dpr,
  hostPixelRatio: _hostDpr,
  engineAudio: _engineAudioEnabled,
  keyboard: _keyboard,
  getViewport: () => ({ width: _viewportWidth, height: _viewportHeight }),
  setIndexedDB(indexedDB) { _window.indexedDB = indexedDB; },
  dispatch: _dispatch,
  hasListeners: _hasListeners,
};

try {
  Object.defineProperty(_global, "__defoldMiniGameAdapter", { value: adapter, configurable: true, writable: true });
} catch (_) {
  _global.__defoldMiniGameAdapter = adapter;
}

_log(
  `ready: ${_platform}, viewport ${_viewportWidth}x${_viewportHeight}, pixel ratio ${_dpr}`
  + ` (host ${_hostDpr}), canvas ${_nativeCanvas.width}x${_nativeCanvas.height}`
  + `${adapter.usesProxyCanvas ? " via Proxy" : ""}, engine audio ${_engineAudioEnabled ? "on" : "off"}`,
);

export { adapter };
export default adapter;
