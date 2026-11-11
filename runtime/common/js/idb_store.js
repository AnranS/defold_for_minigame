/**
 * IndexedDB stand-in for Emscripten's IDBFS.
 *
 * Defold keeps sys.save() files and anything written through io.* under a
 * persistent root that dmloader mounts as IDBFS. IDBFS mirrors that directory
 * into IndexedDB with a small, stable subset of the API: one object store,
 * out-of-line keys, a `timestamp` index walked with a key cursor, and
 * get/put/delete. This module implements exactly that subset on top of a
 * mini-game host, so the engine's own persistence code runs unchanged.
 *
 * Two durable backends exist because hosts differ:
 *   - `fs`      one file per entry under USER_DATA_PATH (WeChat, Douyin)
 *   - `storage` key-value storage with base64 payloads (TikTok Native, where
 *               file-system writes crashed the client in device tests)
 * A volatile `memory` backend keeps the engine running when neither exists.
 */

const INDEX_SCHEMA = 1;
const STORAGE_BLOB_WARN_BYTES = 700 * 1024;

function _defer(task) {
  Promise.resolve().then(task);
}

function _dbKey(name) {
  const text = String(name);
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  const safe = text.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "db";
  return `${safe}-${hash.toString(16)}`;
}

function _toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function _exactBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// ── base64 (hosts do not guarantee atob/btoa) ─────────────────────
const _B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const _B64_LOOKUP = (() => {
  const table = new Uint8Array(128).fill(255);
  for (let i = 0; i < _B64.length; i += 1) table[_B64.charCodeAt(i)] = i;
  return table;
})();

function encodeBase64(bytes) {
  let out = "";
  const length = bytes.length;
  for (let i = 0; i < length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < length ? bytes[i + 1] : 0;
    const c = i + 2 < length ? bytes[i + 2] : 0;
    out += _B64[a >> 2] + _B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < length ? _B64[((b & 15) << 2) | (c >> 6)] : "=";
    out += i + 2 < length ? _B64[c & 63] : "=";
  }
  return out;
}

function decodeBase64(text) {
  const clean = String(text).replace(/[^A-Za-z0-9+/]/g, "");
  const length = Math.floor((clean.length * 3) / 4);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = _B64_LOOKUP[clean.charCodeAt(i)];
    const b = _B64_LOOKUP[clean.charCodeAt(i + 1)];
    const c = i + 2 < clean.length ? _B64_LOOKUP[clean.charCodeAt(i + 2)] : 0;
    const d = i + 3 < clean.length ? _B64_LOOKUP[clean.charCodeAt(i + 3)] : 0;
    if (offset < length) bytes[offset++] = (a << 2) | (b >> 4);
    if (offset < length) bytes[offset++] = ((b & 15) << 4) | (c >> 2);
    if (offset < length) bytes[offset++] = ((c & 3) << 6) | d;
  }
  return bytes;
}

// ── Backends ──────────────────────────────────────────────────────
function createMemoryBackend() {
  const indexes = new Map();
  const blobs = new Map();
  return {
    kind: "memory",
    durable: false,
    loadIndex(dbKey) { return indexes.has(dbKey) ? JSON.parse(indexes.get(dbKey)) : null; },
    saveIndex(dbKey, index) { indexes.set(dbKey, JSON.stringify(index)); },
    readBlob(dbKey, id) { return blobs.get(`${dbKey}/${id}`) || null; },
    writeBlob(dbKey, id, bytes) { blobs.set(`${dbKey}/${id}`, bytes.slice()); },
    removeBlob(dbKey, id) { blobs.delete(`${dbKey}/${id}`); },
    removeDatabase(dbKey) {
      indexes.delete(dbKey);
      for (const key of [...blobs.keys()]) if (key.startsWith(`${dbKey}/`)) blobs.delete(key);
    },
  };
}

function createFsBackend(api, rootDirectory) {
  const fs = api.getFileSystemManager();
  const ensured = new Set();

  function ensureDirectory(directory) {
    if (ensured.has(directory)) return;
    try {
      fs.accessSync(directory);
    } catch (_) {
      fs.mkdirSync(directory, true);
    }
    ensured.add(directory);
  }

  function directoryFor(dbKey) {
    const directory = `${rootDirectory}/${dbKey}`;
    ensureDirectory(rootDirectory);
    ensureDirectory(directory);
    return directory;
  }

  return {
    kind: "fs",
    durable: true,
    loadIndex(dbKey) {
      const path = `${rootDirectory}/${dbKey}/index.json`;
      let text;
      try { text = fs.readFileSync(path, "utf8"); } catch (_) { return null; }
      return JSON.parse(text);
    },
    saveIndex(dbKey, index) {
      const directory = directoryFor(dbKey);
      const path = `${directory}/index.json`;
      const temporary = `${directory}/index.json.tmp`;
      const text = JSON.stringify(index);
      // Rename is the closest thing to an atomic replace the host offers; a
      // crash between the two calls leaves the previous index readable.
      if (typeof fs.renameSync === "function") {
        fs.writeFileSync(temporary, text, "utf8");
        try {
          fs.renameSync(temporary, path);
          return;
        } catch (_) {
          try { fs.unlinkSync(temporary); } catch (_2) { /* nothing to clean */ }
        }
      }
      fs.writeFileSync(path, text, "utf8");
    },
    readBlob(dbKey, id) {
      try {
        const data = fs.readFileSync(`${rootDirectory}/${dbKey}/b${id}.bin`);
        return _toBytes(data);
      } catch (_) {
        return null;
      }
    },
    writeBlob(dbKey, id, bytes) {
      fs.writeFileSync(`${directoryFor(dbKey)}/b${id}.bin`, _exactBuffer(bytes));
    },
    removeBlob(dbKey, id) {
      try { fs.unlinkSync(`${rootDirectory}/${dbKey}/b${id}.bin`); } catch (_) { /* already gone */ }
    },
    removeDatabase(dbKey) {
      const directory = `${rootDirectory}/${dbKey}`;
      try {
        if (typeof fs.rmdirSync === "function") fs.rmdirSync(directory, true);
      } catch (_) { /* best effort */ }
      ensured.delete(directory);
    },
  };
}

function createStorageBackend(api, prefix) {
  const indexKey = (dbKey) => `${prefix}:${dbKey}:index`;
  const blobKey = (dbKey, id) => `${prefix}:${dbKey}:b:${id}`;
  return {
    kind: "storage",
    durable: true,
    loadIndex(dbKey) {
      const text = api.getStorageSync(indexKey(dbKey));
      if (typeof text !== "string" || text === "") return null;
      return JSON.parse(text);
    },
    saveIndex(dbKey, index) {
      api.setStorageSync(indexKey(dbKey), JSON.stringify(index));
    },
    readBlob(dbKey, id) {
      const text = api.getStorageSync(blobKey(dbKey, id));
      if (typeof text !== "string") return null;
      return decodeBase64(text);
    },
    writeBlob(dbKey, id, bytes) {
      if (bytes.length > STORAGE_BLOB_WARN_BYTES) {
        console.warn(
          `[DefoldMiniGame][persistence] a ${bytes.length}-byte save file is stored in key-value storage; `
          + "hosts limit the size of a single key, so keep save files small on this platform",
        );
      }
      api.setStorageSync(blobKey(dbKey, id), encodeBase64(bytes));
    },
    removeBlob(dbKey, id) {
      try { api.removeStorageSync(blobKey(dbKey, id)); } catch (_) { /* already gone */ }
    },
    removeDatabase(dbKey) {
      // Enumerating storage is unsafe on TikTok Native, so only the index is
      // dropped; orphaned blobs are unreachable and overwritten on reuse.
      try { api.removeStorageSync(indexKey(dbKey)); } catch (_) { /* already gone */ }
    },
  };
}

/**
 * Picks the persistence backend for the selected provider.
 * @param {object} runtime PlatformRuntime
 * @param {{ persistence?: string }} config
 */
function selectBackend(runtime, config = {}) {
  const requested = String(config.persistence || "auto");
  const api = runtime.api;
  const userDataPath = api && api.env && api.env.USER_DATA_PATH;
  const canUseFs = runtime.capabilities.fileSystem === true && typeof userDataPath === "string" && userDataPath !== "";
  const canUseStorage = runtime.capabilities.storage === true && typeof api.removeStorageSync === "function";

  const fsBackend = () => createFsBackend(api, `${userDataPath}/defold-minigame/idb`);
  const storageBackend = () => createStorageBackend(api, "defold-minigame:idb");

  if (requested === "off") return createMemoryBackend();
  if (requested === "fs") return canUseFs ? fsBackend() : createMemoryBackend();
  if (requested === "storage") return canUseStorage ? storageBackend() : createMemoryBackend();

  // TikTok Native: persistent file-system writes can terminate the host
  // process, so saves go through key-value storage there.
  if (runtime.platform === "tiktok") return canUseStorage ? storageBackend() : createMemoryBackend();
  if (canUseFs) return fsBackend();
  if (canUseStorage) return storageBackend();
  return createMemoryBackend();
}

// ── IndexedDB objects ─────────────────────────────────────────────
function _event(type, target, extra) {
  return Object.assign({
    type,
    target,
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() {},
  }, extra || {});
}

function _fire(target, type, extra) {
  const event = _event(type, target, extra);
  const handler = target[`on${type}`];
  if (typeof handler === "function") {
    try {
      handler.call(target, event);
    } catch (error) {
      console.error(`[DefoldMiniGame][persistence] on${type} handler failed:`, error);
    }
  }
  return event;
}

function _newRequest(source, transaction) {
  return {
    result: undefined, error: null, readyState: "pending", source, transaction,
    onsuccess: null, onerror: null,
  };
}

function _nameList(getNames) {
  return {
    contains: (name) => getNames().includes(name),
    item: (index) => getNames()[index] || null,
    get length() { return getNames().length; },
  };
}

class Transaction {
  constructor(db, mode) {
    this.db = db;
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this._pending = 0;
    this._finished = false;
    this._dirty = false;
    this._garbage = [];
    this._written = [];
    // A transaction that never receives a request still completes.
    this._scheduleCommit();
  }

  objectStore(name) {
    if (!this.db._index.stores[name]) {
      throw new Error(`NotFoundError: object store '${name}' does not exist`);
    }
    return new ObjectStore(this, name);
  }

  abort() {
    if (this._finished) return;
    this._finished = true;
    this._discardWrites();
    this.db._reload();
    _fire(this, "abort");
  }

  _run(request, operation) {
    this._pending += 1;
    _defer(() => {
      if (!this._finished) {
        try {
          request.result = operation();
          request.readyState = "done";
          _fire(request, "success");
        } catch (error) {
          request.error = error;
          request.readyState = "done";
          this.error = error;
          const event = _fire(request, "error");
          if (!event.defaultPrevented) {
            const transactionEvent = _fire(this, "error", { target: request });
            if (!transactionEvent.defaultPrevented) this.abort();
          }
        }
      }
      this._pending -= 1;
      this._scheduleCommit();
    });
    return request;
  }

  _scheduleCommit() {
    if (this._pending !== 0 || this._finished) return;
    _defer(() => {
      if (this._pending === 0 && !this._finished) this._commit();
    });
  }

  _commit() {
    this._finished = true;
    if (this._dirty) {
      try {
        this.db._persist();
      } catch (error) {
        this.error = error;
        this._discardWrites();
        this.db._reload();
        const event = _fire(this, "error", { target: { error } });
        if (!event.defaultPrevented) _fire(this, "abort", { target: { error } });
        return;
      }
      for (const id of this._garbage) this.db._backend.removeBlob(this.db._key, id);
    }
    _fire(this, "complete");
  }

  _discardWrites() {
    for (const id of this._written) {
      try { this.db._backend.removeBlob(this.db._key, id); } catch (_) { /* best effort */ }
    }
    this._written = [];
    this._garbage = [];
  }
}

class ObjectStore {
  constructor(transaction, name) {
    this.transaction = transaction;
    this.name = name;
    this.keyPath = null;
    this.autoIncrement = false;
    this.indexNames = _nameList(() => this._state().indexes);
  }

  _state() { return this.transaction.db._index.stores[this.name]; }

  _assertWritable() {
    if (this.transaction.mode === "readonly") {
      throw new Error("ReadOnlyError: the transaction is read-only");
    }
  }

  createIndex(name) {
    const state = this._state();
    if (!state.indexes.includes(name)) state.indexes.push(name);
    this.transaction._dirty = true;
    return new StoreIndex(this, name);
  }

  index(name) {
    if (!this._state().indexes.includes(name)) {
      throw new Error(`NotFoundError: index '${name}' does not exist`);
    }
    return new StoreIndex(this, name);
  }

  get(key) {
    const request = _newRequest(this, this.transaction);
    return this.transaction._run(request, () => this.transaction.db._decode(this._state().entries[String(key)]));
  }

  put(value, key) {
    const request = _newRequest(this, this.transaction);
    return this.transaction._run(request, () => {
      this._assertWritable();
      if (key === undefined || key === null) throw new Error("DataError: this store uses out-of-line keys");
      const entries = this._state().entries;
      const previous = entries[String(key)];
      const transaction = this.transaction;
      const encoded = transaction.db._encode(value, (id) => transaction._written.push(id));
      if (previous && previous.b != null) transaction._garbage.push(previous.b);
      entries[String(key)] = encoded;
      transaction._dirty = true;
      return key;
    });
  }

  add(value, key) { return this.put(value, key); }

  delete(key) {
    const request = _newRequest(this, this.transaction);
    return this.transaction._run(request, () => {
      this._assertWritable();
      const entries = this._state().entries;
      const previous = entries[String(key)];
      if (previous) {
        if (previous.b != null) this.transaction._garbage.push(previous.b);
        delete entries[String(key)];
        this.transaction._dirty = true;
      }
      return undefined;
    });
  }

  clear() {
    const request = _newRequest(this, this.transaction);
    return this.transaction._run(request, () => {
      this._assertWritable();
      const state = this._state();
      for (const entry of Object.values(state.entries)) {
        if (entry.b != null) this.transaction._garbage.push(entry.b);
      }
      state.entries = {};
      this.transaction._dirty = true;
      return undefined;
    });
  }

  count() {
    const request = _newRequest(this, this.transaction);
    return this.transaction._run(request, () => Object.keys(this._state().entries).length);
  }

  getAllKeys() {
    const request = _newRequest(this, this.transaction);
    return this.transaction._run(request, () => Object.keys(this._state().entries).sort());
  }

  _openCursor(order, withValues) {
    const transaction = this.transaction;
    const request = _newRequest(this, transaction);
    let position = 0;
    let rows = null;
    const cursor = {
      key: undefined, primaryKey: undefined, value: undefined, source: this,
      continue: () => { position += 1; advance(); },
      advance: (count) => { position += Math.max(1, count | 0); advance(); },
    };
    const advance = () => transaction._run(request, () => {
      if (rows === null) rows = order(this._state().entries);
      if (position >= rows.length) return null;
      const row = rows[position];
      cursor.key = row.key;
      cursor.primaryKey = row.primaryKey;
      if (withValues) cursor.value = transaction.db._decode(this._state().entries[row.primaryKey]);
      return cursor;
    });
    advance();
    return request;
  }

  openCursor() {
    return this._openCursor((entries) => Object.keys(entries).sort().map((key) => ({ key, primaryKey: key })), true);
  }

  openKeyCursor() {
    return this._openCursor((entries) => Object.keys(entries).sort().map((key) => ({ key, primaryKey: key })), false);
  }
}

class StoreIndex {
  constructor(store, name) {
    this.objectStore = store;
    this.name = name;
    this.keyPath = name;
    this.unique = false;
  }

  _rows(entries) {
    // Only `timestamp` is ever indexed by IDBFS; it is stored as `t`.
    const field = this.name === "timestamp" ? "t" : null;
    return Object.keys(entries)
      .filter((key) => field && entries[key][field] != null)
      .map((key) => ({ sort: entries[key][field], key: new Date(entries[key][field]), primaryKey: key }))
      .sort((a, b) => (a.sort - b.sort) || (a.primaryKey < b.primaryKey ? -1 : a.primaryKey > b.primaryKey ? 1 : 0));
  }

  openKeyCursor() { return this.objectStore._openCursor((entries) => this._rows(entries), false); }
  openCursor() { return this.objectStore._openCursor((entries) => this._rows(entries), true); }
}

class Database {
  constructor(name, backend) {
    this.name = name;
    this._key = _dbKey(name);
    this._backend = backend;
    this._index = null;
    this.objectStoreNames = _nameList(() => Object.keys(this._index.stores));
    this.onversionchange = null;
    this.onclose = null;
    this._reload();
  }

  get version() { return this._index.version; }

  _reload() {
    let index = null;
    try {
      index = this._backend.loadIndex(this._key);
    } catch (error) {
      console.warn("[DefoldMiniGame][persistence] the stored index is unreadable; starting empty:", error && error.message);
    }
    if (!index || index.schema !== INDEX_SCHEMA || typeof index.stores !== "object") {
      index = { schema: INDEX_SCHEMA, version: 0, nextBlobId: 1, stores: {} };
    }
    this._index = index;
  }

  _persist() {
    this._backend.saveIndex(this._key, this._index);
  }

  _encode(value, onBlobWritten) {
    const record = { t: null, m: null, b: null, n: 0 };
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      record.v = value;
      return record;
    }
    const extra = {};
    let hasExtra = false;
    for (const key of Object.keys(value)) {
      const field = value[key];
      if (key === "timestamp" && field instanceof Date) record.t = field.getTime();
      else if (key === "mode" && typeof field === "number") record.m = field;
      else if (key === "contents" && _toBytes(field)) {
        const bytes = _toBytes(field);
        const id = this._index.nextBlobId;
        this._index.nextBlobId += 1;
        this._backend.writeBlob(this._key, id, bytes);
        onBlobWritten(id);
        record.b = id;
        record.n = bytes.length;
      } else {
        extra[key] = field;
        hasExtra = true;
      }
    }
    if (hasExtra) record.x = extra;
    return record;
  }

  _decode(record) {
    if (!record) return undefined;
    if ("v" in record) return record.v;
    const value = Object.assign({}, record.x || {});
    if (record.t != null) value.timestamp = new Date(record.t);
    if (record.m != null) value.mode = record.m;
    if (record.b != null) {
      const bytes = this._backend.readBlob(this._key, record.b);
      if (!bytes) throw new Error(`DataError: the stored contents of blob ${record.b} are missing`);
      value.contents = bytes;
    }
    return value;
  }

  createObjectStore(name) {
    if (!this._index.stores[name]) this._index.stores[name] = { indexes: [], entries: {} };
    if (this._upgrade) this._upgrade._dirty = true;
    return new ObjectStore(this._upgrade || new Transaction(this, "readwrite"), name);
  }

  deleteObjectStore(name) {
    delete this._index.stores[name];
    if (this._upgrade) this._upgrade._dirty = true;
  }

  transaction(storeNames, mode) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    for (const name of names) {
      if (!this._index.stores[name]) throw new Error(`NotFoundError: object store '${name}' does not exist`);
    }
    return new Transaction(this, mode === "readwrite" ? "readwrite" : "readonly");
  }

  close() {}
}

/**
 * Creates the object the engine sees as `indexedDB`.
 * @param {object} backend one of the backends above
 */
function createIndexedDB(backend) {
  const databases = new Map();

  function getDatabase(name) {
    let database = databases.get(name);
    if (!database) {
      database = new Database(name, backend);
      databases.set(name, database);
    }
    return database;
  }

  return {
    backendKind: backend.kind,
    durable: backend.durable,

    open(name, version) {
      const request = _newRequest(null, null);
      request.onupgradeneeded = null;
      request.onblocked = null;
      _defer(() => {
        let database;
        try {
          database = getDatabase(String(name));
        } catch (error) {
          request.error = error;
          request.readyState = "done";
          _fire(request, "error");
          return;
        }
        const oldVersion = database.version;
        const requested = version === undefined ? Math.max(oldVersion, 1) : Number(version);
        request.result = database;
        request.readyState = "done";
        if (requested < oldVersion) {
          request.error = new Error(`VersionError: requested ${requested}, stored ${oldVersion}`);
          request.result = undefined;
          _fire(request, "error");
          return;
        }
        const finish = () => _fire(request, "success");
        if (requested === oldVersion) {
          finish();
          return;
        }
        const upgrade = new Transaction(database, "versionchange");
        upgrade._dirty = true;
        database._upgrade = upgrade;
        database._index.version = requested;
        request.transaction = upgrade;
        upgrade.oncomplete = () => {
          database._upgrade = null;
          request.transaction = null;
          finish();
        };
        upgrade.onabort = () => {
          database._upgrade = null;
          request.error = upgrade.error || new Error("AbortError: the upgrade was aborted");
          request.result = undefined;
          _fire(request, "error");
        };
        // The upgrade handler runs inside the version-change transaction; a
        // pending slot keeps the transaction open until it returns.
        upgrade._pending += 1;
        try {
          _fire(request, "upgradeneeded", { oldVersion, newVersion: requested });
        } finally {
          upgrade._pending -= 1;
          upgrade._scheduleCommit();
        }
      });
      return request;
    },

    deleteDatabase(name) {
      const request = _newRequest(null, null);
      _defer(() => {
        try {
          backend.removeDatabase(_dbKey(String(name)));
          databases.delete(String(name));
          request.readyState = "done";
          _fire(request, "success");
        } catch (error) {
          request.error = error;
          request.readyState = "done";
          _fire(request, "error");
        }
      });
      return request;
    },
  };
}

export {
  createFsBackend,
  createIndexedDB,
  createMemoryBackend,
  createStorageBackend,
  decodeBase64,
  encodeBase64,
  selectBackend,
};
