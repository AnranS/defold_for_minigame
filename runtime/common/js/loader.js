/**
 * Defold engine loader for mini games.
 *
 * Flow: loading indicator → engine subpackage → read the game archive from the
 * package → open the persistence store → boot dmloader.js and the engine glue
 * inside one scoped module → wait for the engine to call main().
 *
 * dmloader.js and the Emscripten glue run unmodified. The loader replaces the
 * three things a browser page would have done for them: download the archive,
 * download and instantiate the WebAssembly binary, and provide the DOM.
 */

import "./defold_engine";
import { adapter } from "../adapter";
import { createBridge } from "./bridge";
import { createIndexedDB, selectBackend } from "./idb_store";
import { PlatformRuntime } from "./platform_runtime";

const _api = PlatformRuntime.requireCapabilities(
  ["canvas", "fileSystem", "lifecycle", "subpackage", "windowInfo"],
  "engine loader",
);
const _global = PlatformRuntime.global;
const _config = _global.__defoldMiniGameConfig;

const BOOT_FUNCTION_KEY = "__defoldMiniGameBootEngine";
const DEFAULT_START_TIMEOUT_MS = 45000;

/**
 * Members of dmloader.js the loader relies on, checked before anything runs.
 * Defold has two start-up designs; see LOADER_GENERATIONS in the exporter.
 */
const REQUIRED_DMLOADER_MEMBERS = {
  common: [
    ["CUSTOM_PARAMETERS", "object"],
    ["ProgressView", "object"],
    ["ProgressUpdater", "object"],
    ["Module", "object"],
    ["Module.onArchiveFileLoaded", "function"],
    ["Module.runApp", "function"],
    ["Module.preloadAll", "function"],
    ["Module._callMain", "function"],
  ],
  legacy: [
    ["Module.onArchiveLoaded", "function"],
    ["Module._preloadAndCallMain", "function"],
  ],
  session: [
    ["GameStartup", "object"],
    ["GameStartup.begin", "function"],
    ["GameStartup.fail", "function"],
    ["EngineLoader.selectEngine", "function"],
  ],
};

function _log(...args) { console.log("[DefoldMiniGame][loader]", ...args); }

function _lookup(root, path) {
  return path.split(".").reduce((value, key) => (value == null ? undefined : value[key]), root);
}

function _toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new Error("the host returned a non-binary value for a binary file");
}

/**
 * The WebAssembly object bound inside the engine module. Instantiation goes
 * through Module.instantiateWasm, so the glue only needs Memory, Table,
 * Global, and the error constructors from here.
 */
function _createWebAssemblyFacade() {
  const native = PlatformRuntime.getNativeWebAssembly();
  const standard = PlatformRuntime.getStandardWebAssembly();
  const facade = {};
  for (const name of ["Memory", "Table", "Global", "Module", "Instance", "Tag", "Exception"]) {
    const source = (native && native[name]) ? native : (standard && standard[name]) ? standard : null;
    if (source) facade[name] = source[name];
  }
  for (const name of ["CompileError", "LinkError", "RuntimeError"]) {
    const source = (native && native[name]) ? native : (standard && standard[name]) ? standard : null;
    facade[name] = source ? source[name] : class extends Error {
      constructor(message) { super(message); this.name = name; }
    };
  }
  facade.validate = () => true;
  facade.instantiate = () => Promise.reject(
    new Error("WebAssembly.instantiate is routed through Module.instantiateWasm in mini games"),
  );
  return facade;
}

class Loader {
  constructor(config = _config) {
    if (!config || typeof config !== "object") {
      throw new Error("[DefoldMiniGame] js/boot_config.js did not run before the loader");
    }
    this.config = config;
    this.state = "idle";
    this.bridge = null;
    this.indexedDB = null;
    this.module = null;
    this.loaderGeneration = null;
    this._loadPromise = null;
    this._loadingVisible = false;
    this._lastLoadingUpdate = 0;
    // Published for the developer-tool console: state, bridge, and Module.
    this._publish("__defoldMiniGameLoader", this);
  }

  load() {
    if (!this._loadPromise) {
      this.state = "loading";
      this._loadPromise = this._loadOnce();
    }
    return this._loadPromise;
  }

  async _loadOnce() {
    try {
      this._showLoading(0);

      _log(`1/5 loading subpackage '${this.config.engineSubpackage}'`);
      await this._loadEngineSubpackage();

      _log("2/5 reading the game archive");
      const files = this._readArchive();

      _log("3/5 opening the persistence store");
      const backend = selectBackend(PlatformRuntime, this.config);
      this.indexedDB = createIndexedDB(backend);
      adapter.setIndexedDB(this.indexedDB);
      if (!backend.durable) {
        console.warn("[DefoldMiniGame][loader] no durable storage is available; saved data will not survive a restart");
      }

      this.bridge = createBridge(PlatformRuntime, {
        toolVersion: this.config.toolVersion,
        engineAudio: adapter.engineAudio,
        persistence: backend.kind,
        pixelRatio: adapter.pixelRatio,
        subpackages: this.config.subpackages,
      });
      this._publish("DefoldMiniGameBridge", this.bridge);

      _log(`4/5 booting Defold ${this.config.engineVersion} (${this.config.exeName})`);
      await this._bootEngine(files);

      this.state = "running";
      this._hideLoading();
      _log("5/5 the engine is running");
      return this;
    } catch (error) {
      this.state = "failed";
      this._hideLoading();
      console.error("[DefoldMiniGame][loader] startup failed:", error);
      if (error && error.stack) console.error(error.stack);
      this._reportFailure(error);
      throw error;
    }
  }

  _publish(key, value) {
    for (const target of new Set([_global, globalThis])) {
      try {
        Object.defineProperty(target, key, { value, configurable: true, writable: true });
      } catch (_) {
        try { target[key] = value; } catch (_2) { /* read-only realm */ }
      }
    }
  }

  // ── Loading indicator ───────────────────────────────────────────
  _showLoading(fraction) {
    if (!PlatformRuntime.capabilities.loading || this.config.loadingText === "") return;
    const now = Date.now();
    if (this._loadingVisible && now - this._lastLoadingUpdate < 250) return;
    this._lastLoadingUpdate = now;
    const percent = Math.max(0, Math.min(100, Math.round(fraction * 100)));
    const title = percent > 0 ? `${this.config.loadingText} ${percent}%` : this.config.loadingText;
    try {
      _api.showLoading({ title, mask: true });
      this._loadingVisible = true;
    } catch (_) { /* the indicator is cosmetic */ }
  }

  _hideLoading() {
    if (!this._loadingVisible) return;
    this._loadingVisible = false;
    try { _api.hideLoading({}); } catch (_) { /* the indicator is cosmetic */ }
  }

  _reportFailure(error) {
    if (typeof _api.showModal !== "function") return;
    try {
      _api.showModal({
        title: this.config.failureTitle,
        content: String((error && error.message) || error).slice(0, 200),
        showCancel: false,
      });
    } catch (_) { /* nothing more can be shown */ }
  }

  // ── Subpackage ──────────────────────────────────────────────────
  _loadEngineSubpackage() {
    return new Promise((resolve, reject) => {
      let task;
      try {
        task = _api.loadSubpackage({
          name: this.config.engineSubpackage,
          success: () => resolve(),
          fail: (error) => reject(new Error(
            `loadSubpackage('${this.config.engineSubpackage}') failed: ${(error && error.errMsg) || error}`,
          )),
        });
      } catch (error) {
        reject(error);
        return;
      }
      if (task && typeof task.onProgressUpdate === "function") {
        task.onProgressUpdate((progress) => {
          const value = Number(progress && progress.progress);
          if (Number.isFinite(value)) this._showLoading(value / 100);
        });
      }
    });
  }

  // ── Archive ─────────────────────────────────────────────────────
  _readArchive() {
    const fs = _api.getFileSystemManager();
    const files = [];
    for (const entry of this.config.archive) {
      let data;
      if (entry.pieces.length === 1) {
        data = _toBytes(fs.readFileSync(entry.pieces[0].path));
      } else {
        data = new Uint8Array(entry.size);
        for (const piece of entry.pieces) {
          const bytes = _toBytes(fs.readFileSync(piece.path));
          if (piece.offset + bytes.length > data.length) {
            throw new Error(`archive piece ${piece.path} does not fit ${entry.name}`);
          }
          data.set(bytes, piece.offset);
        }
      }
      if (data.length !== entry.size) {
        throw new Error(
          `archive file ${entry.name} is ${data.length} bytes in the package, but the export recorded ${entry.size}`,
        );
      }
      files.push({ name: entry.name, data });
    }
    return files;
  }

  // ── Engine boot ─────────────────────────────────────────────────
  _instantiateWasm(module, imports, successCallback, fail) {
    const native = PlatformRuntime.getNativeWebAssembly();
    const standard = PlatformRuntime.getStandardWebAssembly();
    const candidates = this.config.wasm.candidates.slice();

    const loadFromBytes = (path) => {
      // Development fallback for a host without a path-based WebAssembly API.
      if (!standard || path.endsWith(".br")) {
        return Promise.reject(new Error(`no host API can load ${path}`));
      }
      const bytes = _toBytes(_api.getFileSystemManager().readFileSync(path));
      return standard.instantiate(bytes, imports);
    };

    const attempt = (index, lastError) => {
      if (index >= candidates.length) {
        fail(new Error(
          `the engine WebAssembly could not be instantiated (${candidates.join(", ")}): `
          + `${(lastError && (lastError.message || lastError.errMsg)) || lastError}`,
        ));
        return;
      }
      const path = candidates[index];
      _log("instantiating", path);
      let pending;
      try {
        pending = (native && typeof native.instantiate === "function")
          ? native.instantiate(path, imports)
          : loadFromBytes(path);
      } catch (error) {
        attempt(index + 1, error);
        return;
      }
      Promise.resolve(pending).then((output) => {
        module.instance = output.instance;
        successCallback(output.instance, output.module);
      }, (error) => attempt(index + 1, error));
    };
    attempt(0, null);
  }

  _bootEngine(files) {
    const boot = _global[BOOT_FUNCTION_KEY] || globalThis[BOOT_FUNCTION_KEY];
    if (typeof boot !== "function") {
      throw new Error("js/defold_engine.js did not register the engine boot function");
    }
    const config = this.config;

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = Number(config.startTimeoutMs) > 0 ? Number(config.startTimeoutMs) : DEFAULT_START_TIMEOUT_MS;
      const watchdog = setTimeout(() => {
        finish(new Error(
          `the engine did not start within ${Math.round(timeout / 1000)} s; check the console for the last log line`,
        ));
      }, timeout);

      function finish(error) {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve();
      }

      const host = {
        window: adapter.window,
        document: adapter.document,
        navigator: adapter.navigator,
        location: adapter.location,
        screen: adapter.screen,
        performance: adapter.performance,
        crypto: adapter.crypto,
        indexedDB: this.indexedDB,
        XMLHttpRequest: adapter.XMLHttpRequest,
        WebSocket: adapter.WebSocket,
        WebAssembly: _createWebAssemblyFacade(),
        WebGLRenderingContext: adapter.WebGLRenderingContext,
        WebGL2RenderingContext: adapter.WebGL2RenderingContext,
        Blob: adapter.Blob,
        URL: adapter.URL,
        Image: adapter.Image,
        requestAnimationFrame: adapter.requestAnimationFrame,
        cancelAnimationFrame: adapter.cancelAnimationFrame,
        runScript: this.bridge.run,

        configure: (dm) => {
          const generation = dm.generation === "session" ? "session" : "legacy";
          const required = REQUIRED_DMLOADER_MEMBERS.common.concat(REQUIRED_DMLOADER_MEMBERS[generation]);
          for (const [path, type] of required) {
            if (typeof _lookup(dm, path) !== type) {
              throw new Error(
                `dmloader.js from Defold ${config.engineVersion} does not expose ${path}; `
                + "this engine version is not supported by the exported runtime",
              );
            }
          }
          const parameters = dm.CUSTOM_PARAMETERS;
          const module = dm.Module;
          this.module = module;
          this.loaderGeneration = generation;

          parameters.exe_name = config.exeName;
          parameters.disable_context_menu = false;
          parameters.resize_window_callback = function () {};
          parameters.unsupported_webgl_callback = () => finish(new Error("the host did not provide a WebGL context"));
          parameters.start_success = function () {};
          parameters.start_error = (error) => finish((error && (error.error || error.message)) || error);
          parameters.can_not_download_file_callback = undefined;
          if (Array.isArray(config.extraEngineArguments) && config.extraEngineArguments.length > 0) {
            parameters.engine_arguments = (parameters.engine_arguments || []).concat(config.extraEngineArguments);
          }
          if (Number(config.heapSizeBytes) > 0) {
            parameters.custom_heap_size = Number(config.heapSizeBytes);
            module.INITIAL_MEMORY = Number(config.heapSizeBytes);
          }

          // The page progress bar is DOM markup; the host loading indicator replaces it.
          dm.ProgressView.addProgress = function () {};
          dm.ProgressView.updateProgress = function () {};
          dm.ProgressView.removeProgress = function () {};

          module.hasWebGLSupport = function () { return true; };
          module.isWASMSupported = true;
          module.isWASMPthreadSupported = false;
          module.onAbort = (reason) => finish(new Error(`the engine aborted: ${reason}`));
          // window.get_display_scale() must describe the canvas the adapter created.
          if (typeof module.getPixelRatio === "function") {
            module.getPixelRatio = function () { return adapter.pixelRatio; };
          }
          module.instantiateWasm = (imports, successCallback) => {
            if (typeof parameters.update_imports === "function") parameters.update_imports(imports);
            this._instantiateWasm(module, imports, successCallback, finish);
            return {}; // compiled asynchronously
          };

          // The start is reported only once main() has returned: dmloader calls
          // start_success before main(), and an engine that exits with an
          // error must not be reported as running.
          const callMain = module._callMain;
          let mainError = null;
          module._callMain = function () {
            try {
              callMain.apply(module, arguments);
            } catch (error) {
              // Reported through the loader; rethrowing would only surface it
              // again in whichever host callback happened to reach main().
              mainError = error;
              finish(error);
              return;
            }
            finish(null);
          };

          if (generation === "session") {
            // GameStartup would download the archive and the engine with XHR.
            // The loader keeps its session object, which the Emscripten hooks
            // resolve, and supplies those two inputs itself.
            const session = dm.GameStartup.begin();
            session.engine = dm.EngineLoader.selectEngine(config.exeName);
            for (const file of files) module.onArchiveFileLoaded({ name: file.name, data: file.data });
            Promise.all([session.runtime.promise, session.storage.promise]).then(() => {
              session.scope.check();
              module.preloadAll();
              dm.ProgressUpdater.complete();
              module._callMain();
              if (mainError) throw mainError;
              session.state = "started";
            }).catch((error) => {
              try { dm.GameStartup.fail(session, error); } catch (_) { /* reported below */ }
              finish(error);
            });
            return;
          }

          for (const file of files) module.onArchiveFileLoaded({ name: file.name, data: file.data });
          if (module.persistentStorage === true) {
            module.onArchiveLoaded();
          } else {
            // Without a persistent mount dmloader would touch the file system
            // before the glue has created it; preRun picks the archive up instead.
            module._archiveLoaded = true;
          }
        },

        onGlueLoaded: () => {
          _log("the engine glue is loaded; waiting for the runtime");
        },
      };

      try {
        boot(host);
      } catch (error) {
        finish(error);
      }
    });
  }
}

export { Loader };
export default Loader;
