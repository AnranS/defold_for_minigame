// Engine stand-in for the test suite.
//
// This file plays the role of the Emscripten glue `<exe>_wasm.js` in a
// synthetic HTML5 bundle. It is NOT Defold code. It reproduces, as plain
// JavaScript, the contract between dmloader.js and the real glue that the
// exporter and the mini-game runtime depend on:
//
//   - `var Module` reuses the object dmloader.js created
//   - preInit / preRun / instantiateWasm / onRuntimeInitialized / postRun order
//   - `FS`, `MEMFS`, `IDBFS`, `DMSYS`, `GLFW`, `dmRenderer` as top-level variables
//   - IDBFS mirrors a MEMFS mount into `indexedDB` with Emscripten's algorithm
//   - GLFW registers key/mouse listeners on `window`, touch listeners on the canvas
//   - html5.run() is implemented with a single dynamic-evaluation call
//
// Everything a test wants to observe is recorded on `Module.__fake`.

var Module=typeof Module!="undefined"?Module:{};

var __fake = Module["__fake"] = {
  log: [], events: [], touches: [], keys: [], frames: 0, resizes: [], ccalls: [],
  mainCalled: 0, mainArgs: null, wasmResult: null, archive: {}, loadedSave: null,
  audio: null, gl: null, focus: [], env: null, initialMemory: 0, lastRunSuccess: null
};

var ENVIRONMENT_IS_WEB = typeof window == "object";
var ENVIRONMENT_IS_WORKER = typeof WorkerGlobalScope != "undefined";
var ENVIRONMENT_IS_NODE = typeof process == "object" && typeof process.versions == "object"
  && typeof process.versions.node == "string";

__fake.env = {
  web: ENVIRONMENT_IS_WEB,
  worker: ENVIRONMENT_IS_WORKER,
  node: ENVIRONMENT_IS_NODE,
  hasRequire: typeof require != "undefined",
  hasModuleObject: typeof module != "undefined",
  hasFetch: typeof fetch != "undefined",
  userAgent: typeof navigator == "undefined" ? "" : navigator.userAgent,
  language: typeof navigator == "undefined" ? "" : (navigator.languages ? navigator.languages[0] : navigator.language),
  href: location.href,
  devicePixelRatio: window.devicePixelRatio,
  scriptSrc: document.currentScript ? document.currentScript.src : null
};

// ── memory ────────────────────────────────────────────────────────
var INITIAL_MEMORY = Module["INITIAL_MEMORY"] || 33554432;
var wasmMemory = new WebAssembly.Memory({ initial: INITIAL_MEMORY / 65536, maximum: 32768 });
__fake.initialMemory = INITIAL_MEMORY;
var wasmExports = null;

// ── PATH ──────────────────────────────────────────────────────────
var PATH = {
  normalize: function (path) {
    var absolute = path.charAt(0) === "/";
    var parts = path.split("/"), out = [];
    for (var n = 0; n < parts.length; n++) {
      var part = parts[n];
      if (part === "" || part === ".") continue;
      if (part === "..") { out.pop(); continue; }
      out.push(part);
    }
    return (absolute ? "/" : "") + out.join("/");
  },
  join2: function (a, b) { return PATH.normalize(a + "/" + b); },
  dirname: function (path) {
    var index = path.lastIndexOf("/");
    if (index <= 0) return index === 0 ? "/" : ".";
    return path.slice(0, index);
  },
  basename: function (path) { return path.slice(path.lastIndexOf("/") + 1); }
};

// ── FS: a small in-memory file system with mounts ─────────────────
var DIR_MODE = 16895, FILE_MODE = 33206;

var MEMFS = {
  createNode: function (parent, name, mode) {
    var node = { name: name, mode: mode, parent: parent, timestamp: Date.now(), mounted: null };
    if (FS.isDir(mode)) node.children = {};
    else node.contents = new Uint8Array(0);
    if (parent) parent.children[name] = node;
    return node;
  },
  mount: function (mount) { return MEMFS.createNode(null, "/", DIR_MODE); },
  getFileDataAsTypedArray: function (node) {
    return node.contents ? new Uint8Array(node.contents) : new Uint8Array(0);
  }
};

var FS = {
  root: null,
  currentPath: "/",
  mounts: [],
  syncFSRequests: 0,
  isDir: function (mode) { return (mode & 61440) === 16384; },
  isFile: function (mode) { return (mode & 61440) === 32768; },
  ErrnoError: function (message) { this.name = "ErrnoError"; this.message = message; },
  cwd: function () { return FS.currentPath; },
  chdir: function (path) { FS.lookupPath(path); FS.currentPath = FS.absolute(path); },
  absolute: function (path) {
    return PATH.normalize(path.charAt(0) === "/" ? path : FS.currentPath + "/" + path) || "/";
  },
  lookupPath: function (path, options) {
    var full = FS.absolute(path);
    var parts = full.split("/").filter(function (part) { return part !== ""; });
    var stop = options && options.parent ? parts.length - 1 : parts.length;
    var node = FS.root;
    for (var n = 0; n < stop; n++) {
      if (node.mounted) node = node.mounted.root;
      if (!node.children || !node.children[parts[n]]) throw new FS.ErrnoError("ENOENT: " + full);
      node = node.children[parts[n]];
    }
    if (node.mounted && !(options && options.parent)) node = node.mounted.root;
    return { node: node, path: full };
  },
  mkdir: function (path, mode) {
    var lookup = FS.lookupPath(path, { parent: true });
    var parent = lookup.node.mounted ? lookup.node.mounted.root : lookup.node;
    var name = PATH.basename(FS.absolute(path));
    if (parent.children[name]) throw new FS.ErrnoError("EEXIST: " + path);
    return MEMFS.createNode(parent, name, mode === undefined ? DIR_MODE : mode);
  },
  mkdirTree: function (path, mode) {
    var parts = FS.absolute(path).split("/").filter(function (part) { return part !== ""; });
    var current = "";
    for (var n = 0; n < parts.length; n++) {
      current += "/" + parts[n];
      try { FS.mkdir(current, mode); } catch (error) { if (String(error.message).indexOf("EEXIST") !== 0) throw error; }
    }
  },
  readdir: function (path) {
    var node = FS.lookupPath(path).node;
    if (!node.children) throw new FS.ErrnoError("ENOTDIR: " + path);
    return [".", ".."].concat(Object.keys(node.children));
  },
  stat: function (path) {
    var node = FS.lookupPath(path).node;
    return { mode: node.mode, size: node.contents ? node.contents.length : 4096, mtime: new Date(node.timestamp) };
  },
  chmod: function (path, mode) { FS.lookupPath(path).node.mode = mode; },
  utime: function (path, atime, mtime) { FS.lookupPath(path).node.timestamp = +mtime; },
  writeFile: function (path, data, options) {
    var lookup = FS.lookupPath(path, { parent: true });
    var parent = lookup.node.mounted ? lookup.node.mounted.root : lookup.node;
    var name = PATH.basename(FS.absolute(path));
    var node = parent.children[name] || MEMFS.createNode(parent, name, FILE_MODE);
    if (typeof data === "string") {
      var bytes = new Uint8Array(data.length);
      for (var n = 0; n < data.length; n++) bytes[n] = data.charCodeAt(n) & 255;
      node.contents = bytes;
    } else {
      node.contents = new Uint8Array(data);
    }
    node.timestamp = Date.now();
  },
  readFile: function (path, options) {
    var node = FS.lookupPath(path).node;
    if (!node.contents) throw new FS.ErrnoError("EISDIR: " + path);
    if (options && options.encoding === "utf8") {
      var text = "";
      for (var n = 0; n < node.contents.length; n++) text += String.fromCharCode(node.contents[n]);
      return text;
    }
    return new Uint8Array(node.contents);
  },
  unlink: function (path) {
    var lookup = FS.lookupPath(path, { parent: true });
    var parent = lookup.node.mounted ? lookup.node.mounted.root : lookup.node;
    delete parent.children[PATH.basename(FS.absolute(path))];
  },
  rmdir: function (path) { FS.unlink(path); },
  open: function (path, flags) {
    if (flags && flags.indexOf("w") !== -1) FS.writeFile(path, new Uint8Array(0));
    return { path: FS.absolute(path), node: FS.lookupPath(path).node, flags: flags, closed: false };
  },
  write: function (stream, buffer, offset, length, position) {
    var start = position || 0;
    var next = new Uint8Array(Math.max(stream.node.contents.length, start + length));
    next.set(stream.node.contents);
    next.set(buffer.subarray(offset, offset + length), start);
    stream.node.contents = next;
    stream.node.timestamp = Date.now();
    return length;
  },
  close: function (stream) { stream.closed = true; },
  mount: function (type, opts, mountpoint) {
    var mount = { type: type, opts: opts, mountpoint: mountpoint, mounts: [] };
    var root = type.mount(mount);
    root.mount = mount;
    mount.root = root;
    if (mountpoint === "/") FS.root = root;
    else FS.lookupPath(mountpoint, { parent: false }).node.mounted = mount;
    FS.mounts.push(mount);
    return root;
  },
  syncfs: function (populate, callback) {
    FS.syncFSRequests++;
    var mounts = FS.mounts.slice();
    var completed = 0, errored = false;
    function doCallback(error) { FS.syncFSRequests--; return callback(error); }
    function done(error) {
      if (error) { if (!errored) { errored = true; return doCallback(error); } return; }
      if (++completed >= mounts.length) doCallback(null);
    }
    mounts.forEach(function (mount) {
      if (!mount.type.syncfs) return done(null);
      mount.type.syncfs(mount, populate, done);
    });
  },
  createPreloadedFile: function (parent, name, data, canRead, canWrite) {
    FS.writeFile(parent ? PATH.join2(parent, name) : name, data);
  }
};
FS.mount(MEMFS, {}, "/");

// ── IDBFS: Emscripten's algorithm, written against the FS above ───
var IDBFS = {
  dbs: {},
  indexedDB: function () {
    if (typeof indexedDB != "undefined") return indexedDB;
    var ret = null;
    if (typeof window == "object") ret = window.indexedDB || window.mozIndexedDB || window.webkitIndexedDB || window.msIndexedDB;
    return ret;
  },
  DB_VERSION: 21,
  DB_STORE_NAME: "FILE_DATA",
  mount: function (mount) { return MEMFS.mount(mount); },
  syncfs: function (mount, populate, callback) {
    IDBFS.getLocalSet(mount, function (err, local) {
      if (err) return callback(err);
      IDBFS.getRemoteSet(mount, function (err, remote) {
        if (err) return callback(err);
        var src = populate ? remote : local;
        var dst = populate ? local : remote;
        IDBFS.reconcile(src, dst, callback);
      });
    });
  },
  getDB: function (name, callback) {
    var db = IDBFS.dbs[name];
    if (db) return callback(null, db);
    var req;
    try { req = IDBFS.indexedDB().open(name, IDBFS.DB_VERSION); } catch (e) { return callback(e); }
    if (!req) return callback("Unable to connect to IndexedDB");
    req.onupgradeneeded = function (e) {
      var db = e.target.result;
      var transaction = e.target.transaction;
      var fileStore;
      if (db.objectStoreNames.contains(IDBFS.DB_STORE_NAME)) {
        fileStore = transaction.objectStore(IDBFS.DB_STORE_NAME);
      } else {
        fileStore = db.createObjectStore(IDBFS.DB_STORE_NAME);
      }
      if (!fileStore.indexNames.contains("timestamp")) {
        fileStore.createIndex("timestamp", "timestamp", { unique: false });
      }
    };
    req.onsuccess = function () {
      db = req.result;
      IDBFS.dbs[name] = db;
      callback(null, db);
    };
    req.onerror = function (e) {
      callback(e.target.error);
      e.preventDefault();
    };
  },
  getLocalSet: function (mount, callback) {
    var entries = {};
    function isRealDir(p) { return p !== "." && p !== ".."; }
    function toAbsolute(root) { return function (p) { return PATH.join2(root, p); }; }
    var check = FS.readdir(mount.mountpoint).filter(isRealDir).map(toAbsolute(mount.mountpoint));
    while (check.length) {
      var path = check.pop();
      var stat;
      try { stat = FS.stat(path); } catch (e) { return callback(e); }
      if (FS.isDir(stat.mode)) {
        check.push.apply(check, FS.readdir(path).filter(isRealDir).map(toAbsolute(path)));
      }
      entries[path] = { "timestamp": stat.mtime };
    }
    return callback(null, { type: "local", entries: entries });
  },
  getRemoteSet: function (mount, callback) {
    var entries = {};
    IDBFS.getDB(mount.mountpoint, function (err, db) {
      if (err) return callback(err);
      try {
        var transaction = db.transaction([IDBFS.DB_STORE_NAME], "readonly");
        transaction.onerror = function (e) {
          callback(e.target.error);
          e.preventDefault();
        };
        var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
        var index = store.index("timestamp");
        index.openKeyCursor().onsuccess = function (event) {
          var cursor = event.target.result;
          if (!cursor) {
            return callback(null, { type: "remote", db: db, entries: entries });
          }
          entries[cursor.primaryKey] = { "timestamp": cursor.key };
          cursor.continue();
        };
      } catch (e) {
        return callback(e);
      }
    });
  },
  loadLocalEntry: function (path, callback) {
    var stat, node;
    try {
      var lookup = FS.lookupPath(path);
      node = lookup.node;
      stat = FS.stat(path);
    } catch (e) {
      return callback(e);
    }
    if (FS.isDir(stat.mode)) {
      return callback(null, { "timestamp": stat.mtime, "mode": stat.mode });
    } else if (FS.isFile(stat.mode)) {
      node.contents = MEMFS.getFileDataAsTypedArray(node);
      return callback(null, { "timestamp": stat.mtime, "mode": stat.mode, "contents": node.contents });
    }
    return callback(new Error("node type not supported"));
  },
  storeLocalEntry: function (path, entry, callback) {
    try {
      if (FS.isDir(entry["mode"])) {
        FS.mkdirTree(path, entry["mode"]);
      } else if (FS.isFile(entry["mode"])) {
        FS.writeFile(path, entry["contents"], { canOwn: true });
      } else {
        return callback(new Error("node type not supported"));
      }
      FS.chmod(path, entry["mode"]);
      FS.utime(path, entry["timestamp"], entry["timestamp"]);
    } catch (e) {
      return callback(e);
    }
    callback(null);
  },
  removeLocalEntry: function (path, callback) {
    try {
      var stat = FS.stat(path);
      if (FS.isDir(stat.mode)) FS.rmdir(path);
      else if (FS.isFile(stat.mode)) FS.unlink(path);
    } catch (e) {
      return callback(e);
    }
    callback(null);
  },
  loadRemoteEntry: function (store, path, callback) {
    var req = store.get(path);
    req.onsuccess = function (event) { callback(null, event.target.result); };
    req.onerror = function (e) {
      callback(e.target.error);
      e.preventDefault();
    };
  },
  storeRemoteEntry: function (store, path, entry, callback) {
    try {
      var req = store.put(entry, path);
    } catch (e) {
      callback(e);
      return;
    }
    req.onsuccess = function (event) { callback(); };
    req.onerror = function (e) {
      callback(e.target.error);
      e.preventDefault();
    };
  },
  removeRemoteEntry: function (store, path, callback) {
    var req = store.delete(path);
    req.onsuccess = function (event) { callback(); };
    req.onerror = function (e) {
      callback(e.target.error);
      e.preventDefault();
    };
  },
  reconcile: function (src, dst, callback) {
    var total = 0;
    var create = [];
    Object.keys(src.entries).forEach(function (key) {
      var e = src.entries[key];
      var e2 = dst.entries[key];
      if (!e2 || e["timestamp"].getTime() != e2["timestamp"].getTime()) {
        create.push(key);
        total++;
      }
    });
    var remove = [];
    Object.keys(dst.entries).forEach(function (key) {
      if (!src.entries[key]) {
        remove.push(key);
        total++;
      }
    });
    if (!total) return callback(null);

    var errored = false;
    var db = src.type === "remote" ? src.db : dst.db;
    var transaction = db.transaction([IDBFS.DB_STORE_NAME], "readwrite");
    var store = transaction.objectStore(IDBFS.DB_STORE_NAME);
    function done(err) {
      if (err && !errored) {
        errored = true;
        return callback(err);
      }
    }
    transaction.onerror = transaction.onabort = function (e) {
      done(e.target.error);
      e.preventDefault();
    };
    transaction.oncomplete = function (e) {
      if (!errored) callback(null);
    };
    create.sort().forEach(function (path) {
      if (dst.type === "local") {
        IDBFS.loadRemoteEntry(store, path, function (err, entry) {
          if (err) return done(err);
          IDBFS.storeLocalEntry(path, entry, done);
        });
      } else {
        IDBFS.loadLocalEntry(path, function (err, entry) {
          if (err) return done(err);
          IDBFS.storeRemoteEntry(store, path, entry, done);
        });
      }
    });
    remove.sort().reverse().forEach(function (path) {
      if (dst.type === "local") IDBFS.removeLocalEntry(path, done);
      else IDBFS.removeRemoteEntry(store, path, done);
    });
  }
};

// ── DMSYS / dmRenderer (as in Defold's JS libraries) ──────────────
var DMSYS = {
  _folder: "/data",
  GetUserPersistentDataRoot: function () {
    if (typeof window !== "undefined") return DMSYS._folder;
    return "";
  }
};

var dmRenderer = {
  events: [],
  CONTEXT_LOST_EVENT: 0,
  CONTEXT_RESTORED_EVENT: 1,
  rendererContextEvent: function (eventType) { dmRenderer.events.push(eventType); }
};

// ── html5.run(): one dynamic-evaluation call, as in script_html5_js.cpp ──
function fakeHtml5Run(code) {
  var jsResult;
  var isSuccess = 1;
  try { jsResult = eval(code); } catch (err) { isSuccess = 0; jsResult = err; }
  __fake.lastRunSuccess = isSuccess;
  jsResult += "";
  return jsResult;
}
__fake.luaRun = fakeHtml5Run;

// ── GLFW: listener layout and coordinate conversion of Defold's web GLFW ──
var GLFW = {
  prevWidth: 0, prevHeight: 0, isFullscreen: false, mouseTouchId: null, buttons: 0,
  addEventListener: function (type, listener, useCapture) {
    if (typeof window !== "undefined") window.addEventListener(type, listener, useCapture);
  },
  addEventListenerCanvas: function (type, listener, useCapture) {
    if (typeof Module["canvas"] !== "undefined") Module["canvas"].addEventListener(type, listener, useCapture);
  },
  isCanvasActive: function (event) {
    var res = typeof document.activeElement == "undefined" || document.activeElement == Module["canvas"];
    if (!res) res = event.target == Module["canvas"];
    if (event.target.focus) event.target.focus();
    return res;
  },
  convertCoordinatesFromMonitorToWebGLPixels: function (x, y) {
    var rect = Module["canvas"].getBoundingClientRect();
    var canvasWidth = rect.right - rect.left;
    var canvasHeight = rect.bottom - rect.top;
    var finalX = Module["canvas"].width * ((x - rect.left) / canvasWidth);
    var finalY = Module["canvas"].height * ((y - rect.top) / canvasHeight);
    return [finalX, finalY];
  },
  recordTouch: function (phase, event) {
    for (var n = 0; n < event.changedTouches.length; ++n) {
      var touch = event.changedTouches[n];
      var coord = GLFW.convertCoordinatesFromMonitorToWebGLPixels(touch.clientX, touch.clientY);
      __fake.touches.push({ phase: phase, id: touch.identifier, x: coord[0], y: coord[1], active: event.touches.length });
    }
    // What the engine's input poll finds on its next frame.
    __fake.touchDown = event.touches.length;
  },
  onTouchStart: function (event) {
    if (event.target != Module["canvas"]) return;
    GLFW.recordTouch("began", event);
  },
  onTouchMove: function (event) {
    if (!GLFW.isCanvasActive(event)) return;
    GLFW.recordTouch("moved", event);
    event.preventDefault();
  },
  onTouchEnd: function (event) {
    if (!GLFW.isCanvasActive(event)) return;
    GLFW.recordTouch("ended", event);
  },
  onTouchCancel: function (event) {
    if (!GLFW.isCanvasActive(event)) return;
    GLFW.recordTouch("cancelled", event);
  },
  onKey: function (event) {
    if (!GLFW.isCanvasActive(event)) return;
    __fake.keys.push({ type: event.type, keyCode: event.keyCode, charCode: event.charCode });
  },
  onFocus: function () { __fake.focus.push("focus"); },
  onBlur: function () { __fake.focus.push("blur"); }
};

// Defold 1.14.1 renamed the web platform layer; its loader refers to it by this name.
var DefoldPlatform = GLFW;

function fakeCreateContext(canvas, attributes) {
  // Mirrors GL.createContext, including the Safari WebGL 2 workaround.
  if (!canvas.getContextSafariWebGL2Fixed) {
    canvas.getContextSafariWebGL2Fixed = canvas.getContext;
    var fixedGetContext = function (ver, attrs) {
      var gl = canvas.getContextSafariWebGL2Fixed(ver, attrs);
      return (ver == "webgl") == (gl instanceof WebGLRenderingContext) ? gl : null;
    };
    canvas.getContext = fixedGetContext;
  }
  var ctx = attributes.majorVersion > 1 ? canvas.getContext("webgl2", attributes) : canvas.getContext("webgl", attributes);
  if (!ctx) return null;
  return ctx;
}

function fakeOpenWindow() {
  var attributes = { antialias: false, depth: true, stencil: true, alpha: false, majorVersion: 2 };
  var iOSVersion = false;
  try {
    iOSVersion = parseFloat(("" + (/CPU.*OS ([0-9_]{1,5})|(CPU like).*AppleWebKit.*Mobile/i.exec(navigator.userAgent) || [0, ""])[1])
      .replace("undefined", "3_2").replace("_", ".").replace("_", "")) || false;
  } catch (e) { /* as in the engine */ }
  if (iOSVersion && iOSVersion < 15.2) attributes.majorVersion = 1;
  var ctx = fakeCreateContext(Module["canvas"], attributes);
  if (ctx == null) {
    attributes.majorVersion = 1;
    ctx = fakeCreateContext(Module["canvas"], attributes);
  }
  Module.ctx = ctx;
  __fake.gl = {
    created: ctx != null,
    majorVersion: attributes.majorVersion,
    iOSVersion: iOSVersion,
    isWebGL2: ctx != null && (ctx instanceof WebGL2RenderingContext),
    isWebGL1: ctx != null && (ctx instanceof WebGLRenderingContext),
    stencil: attributes.stencil
  };
  GLFW.addEventListener("keydown", GLFW.onKey, true);
  GLFW.addEventListener("keypress", GLFW.onKey, true);
  GLFW.addEventListener("keyup", GLFW.onKey, true);
  GLFW.addEventListenerCanvas("touchstart", GLFW.onTouchStart, true);
  GLFW.addEventListenerCanvas("touchend", GLFW.onTouchEnd, true);
  GLFW.addEventListenerCanvas("touchcancel", GLFW.onTouchCancel, true);
  GLFW.addEventListenerCanvas("touchmove", GLFW.onTouchMove, true);
  GLFW.addEventListenerCanvas("focus", GLFW.onFocus, true);
  GLFW.addEventListenerCanvas("blur", GLFW.onBlur, true);
}

// Emscripten's Browser.updateCanvasDimensions(), statement for statement. The
// real engine reaches it on its first swap: _dmNativeSwapBuffers() sees a new
// size and calls _dmNativeSetWindowSize(), which calls Browser.setCanvasSize().
var Browser = {
  resizeCanvas: undefined,
  updateCanvasDimensions: function (canvas, wNative, hNative) {
    if (wNative && hNative) {
      canvas.widthNative = wNative;
      canvas.heightNative = hNative;
    } else {
      wNative = canvas.widthNative;
      hNative = canvas.heightNative;
    }
    var w = wNative;
    var h = hNative;
    if (Module["forcedAspectRatio"] > 0) {
      if (w / h < Module["forcedAspectRatio"]) {
        w = Math.round(h * Module["forcedAspectRatio"]);
      } else {
        h = Math.round(w / Module["forcedAspectRatio"]);
      }
    }
    if ((document["fullscreenElement"] || document["mozFullScreenElement"] || document["msFullscreenElement"] || document["webkitFullscreenElement"] || document["webkitCurrentFullScreenElement"]) === canvas.parentNode && typeof screen != "undefined") {
      var factor = Math.min(screen.width / w, screen.height / h);
      w = Math.round(w * factor);
      h = Math.round(h * factor);
    }
    if (Browser.resizeCanvas) {
      if (canvas.width != w) canvas.width = w;
      if (canvas.height != h) canvas.height = h;
      if (typeof canvas.style != "undefined") {
        canvas.style.removeProperty("width");
        canvas.style.removeProperty("height");
      }
    } else {
      if (canvas.width != wNative) canvas.width = wNative;
      if (canvas.height != hNative) canvas.height = hNative;
      if (typeof canvas.style != "undefined") {
        if (w != wNative || h != hNative) {
          canvas.style.setProperty("width", w + "px", "important");
          canvas.style.setProperty("height", h + "px", "important");
        } else {
          canvas.style.removeProperty("width");
          canvas.style.removeProperty("height");
        }
      }
    }
  },
};

function fakeSwapBuffers() {
  var width = Module["canvas"].width;
  var height = Module["canvas"].height;
  if (GLFW.prevWidth != width || GLFW.prevHeight != height) {
    GLFW.prevWidth = width;
    GLFW.prevHeight = height;
    Browser.updateCanvasDimensions(Module["canvas"], width, height);
    __fake.resizes.push({ width: width, height: height });
  }
}

// ── sound device: the context lookup of Defold's library_sound.js ──
function fakeOpenSoundDevice() {
  var root = typeof globalThis !== "undefined" ? globalThis : window;
  var audioCtxCtor = root !== undefined ? (root.AudioContext || root.webkitAudioContext) : undefined;
  if (audioCtxCtor === undefined) {
    __fake.audio = { available: false };
    return;
  }
  var audioCtx;
  try { audioCtx = new audioCtxCtor({ sampleRate: 48000 }); } catch (e) {
    __fake.audio = { available: false, error: String(e) };
    return;
  }
  var changes = [];
  audioCtx.onstatechange = function () { changes.push(audioCtx.state); };
  __fake.audio = { available: true, sampleRate: audioCtx.sampleRate, state: audioCtx.state, changes: changes, queued: 0 };
  __fake.audioContext = audioCtx;
  __fake.queueAudio = function (frameCount) {
    var buf = audioCtx.createBuffer(2, frameCount, audioCtx.sampleRate);
    for (var c = 0; c < 2; c++) buf.copyToChannel(new Float32Array(frameCount), c);
    var source = audioCtx.createBufferSource();
    source.buffer = buf;
    source.connect(audioCtx.destination);
    source.start(audioCtx.currentTime);
    __fake.audio.queued++;
  };
}

// ── helpers a test drives as if they were Lua calls ───────────────
__fake.save = function (name, text) {
  var stream = FS.open(DMSYS.GetUserPersistentDataRoot() + "/" + name, "w");
  var bytes = new Uint8Array(text.length);
  for (var n = 0; n < text.length; n++) bytes[n] = text.charCodeAt(n) & 255;
  FS.write(stream, bytes, 0, bytes.length, 0);
  FS.close(stream);
};
__fake.load = function (name) {
  try { return FS.readFile(DMSYS.GetUserPersistentDataRoot() + "/" + name, { encoding: "utf8" }); } catch (e) { return null; }
};
__fake.remove = function (name) {
  FS.unlink(DMSYS.GetUserPersistentDataRoot() + "/" + name);
  FS.close({ closed: false });
};
__fake.showKeyboard = function (show) {
  Module["canvas"].contentEditable = show ? true : false;
  if (show) Module["canvas"].focus();
};
__fake.http = function (method, url, body, callback) {
  // Same shape as dmScriptHttpRequestAsync in Defold's library_script.js.
  var xhr = new XMLHttpRequest();
  function listener() {
    var headers = xhr.getAllResponseHeaders().replace(new RegExp("\r", "g"), "") + "\n";
    if (xhr.status != 0) callback({ status: xhr.status, body: new Uint8Array(xhr.response), headers: headers });
    else callback({ status: 0 });
  }
  xhr.onload = listener;
  xhr.onerror = listener;
  xhr.ontimeout = listener;
  xhr.open(method, url, true);
  xhr.responseType = "arraybuffer";
  if (body) xhr.send(body); else xhr.send();
};

// ── engine main ───────────────────────────────────────────────────
function fakeEngineMain(args) {
  __fake.mainCalled++;
  __fake.mainArgs = args;
  __fake.cwd = FS.cwd();
  __fake.persistentRoot = DMSYS.GetUserPersistentDataRoot();
  ["game.projectc", "game.arci", "game.arcd", "game.dmanifest", "game.public.der"].forEach(function (name) {
    try {
      var data = FS.readFile(name);
      var sum = 0;
      for (var n = 0; n < data.length; n++) sum = (sum + data[n]) >>> 0;
      __fake.archive[name] = { size: data.length, sum: sum };
    } catch (e) {
      __fake.archive[name] = null;
    }
  });
  __fake.loadedSave = __fake.load("save.txt");
  // dmNativeGetDisplayScaleFactor(): window.get_display_scale() in Lua (Defold 1.14.1+).
  __fake.displayScale = typeof Module["getPixelRatio"] == "function" ? Module["getPixelRatio"](1) : null;
  fakeOpenWindow();
  fakeOpenSoundDevice();
  function frame() {
    __fake.frames++;
    // The engine reads the state of its input once per frame. A press that
    // was already released by then was never pressed, as far as it can tell.
    __fake.touchDownSeen = __fake.touchDown || 0;
    if (__fake.touchDownSeen > 0) __fake.framesWithTouch = (__fake.framesWithTouch || 0) + 1;
    fakeSwapBuffers();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

// ── Emscripten run sequence ───────────────────────────────────────
var runDependencies = 0;
var dependenciesFulfilled = null;
var calledRun = false;

function addRunDependency() { runDependencies++; }
function removeRunDependency() {
  runDependencies--;
  if (runDependencies == 0 && dependenciesFulfilled) {
    var callback = dependenciesFulfilled;
    dependenciesFulfilled = null;
    callback();
  }
}

function createWasm() {
  addRunDependency("wasm-instantiate");
  var info = { a: { a: wasmMemory, b: function (x) { return x * 2; } } };
  function receiveInstance(instance, module) {
    wasmExports = instance.exports;
    __fake.wasmResult = wasmExports.run(20);
    removeRunDependency("wasm-instantiate");
    return wasmExports;
  }
  if (!Module["instantiateWasm"]) throw new Error("the engine stand-in needs Module.instantiateWasm");
  Module["instantiateWasm"](info, receiveInstance);
  return {};
}

function runCallbacks(key) {
  if (!Module[key]) return;
  if (typeof Module[key] == "function") Module[key] = [Module[key]];
  while (Module[key].length) Module[key].shift()();
}

// Engine arguments a test can pass to make main() fail the way an engine does.
Module["callMain"] = function (args) {
  var list = args || [];
  for (var n = 0; n < list.length; n++) {
    if (list[n] === "--fake-main-throws") throw new Error("engine main() threw");
    if (list[n].indexOf("--fake-exit-code=") === 0) return Number(list[n].slice(17));
  }
  fakeEngineMain(args);
  return 0;
};
Module["ccall"] = function (name) { __fake.ccalls.push(name); };

function run() {
  if (runDependencies > 0) { dependenciesFulfilled = run; return; }
  runCallbacks("preRun");
  if (runDependencies > 0) { dependenciesFulfilled = run; return; }
  function doRun() {
    if (calledRun) return;
    calledRun = true;
    Module["calledRun"] = true;
    if (Module["onRuntimeInitialized"]) Module["onRuntimeInitialized"]();
    if (!Module["noInitialRun"]) Module["callMain"]([]);
    runCallbacks("postRun");
  }
  if (Module["setStatus"]) {
    Module["setStatus"]("Running...");
    setTimeout(function () {
      setTimeout(function () { Module["setStatus"](""); }, 1);
      doRun();
    }, 1);
  } else {
    doRun();
  }
}

createWasm();
if (Module["preInit"]) {
  if (typeof Module["preInit"] == "function") Module["preInit"] = [Module["preInit"]];
  while (Module["preInit"].length > 0) Module["preInit"].pop()();
}
run();
