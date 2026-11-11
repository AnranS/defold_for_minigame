/**
 * WebAssembly feature scanner.
 *
 * Mini-game hosts compile the engine with their own WebAssembly implementation
 * (WXWebAssembly / TTWebAssembly). A module that uses a proposal the host does
 * not implement fails at instantiate time on a real device, long after the
 * export looked fine in a desktop simulator. The exporter therefore decodes the
 * binary itself and refuses the features that are known not to load.
 *
 * Release engines strip the `target_features` custom section, so the only
 * reliable evidence is the instruction stream. Every function body is decoded
 * with its immediates; a body that cannot be decoded is counted and reported
 * instead of being guessed at.
 */

const SECTION_NAMES = {
  0: "custom", 1: "type", 2: "import", 3: "function", 4: "table", 5: "memory",
  6: "global", 7: "export", 8: "start", 9: "element", 10: "code", 11: "data",
  12: "datacount", 13: "tag",
};

/** Features that make a module unloadable on at least one supported host. */
export const BLOCKING_FEATURES = Object.freeze([
  "simd",
  "threads",
  "exceptionHandling",
  "memory64",
  "tailCall",
  "gc",
  "multiMemory",
]);

export const FEATURE_LABELS = Object.freeze({
  simd: "fixed-width SIMD (v128)",
  threads: "threads / atomics / shared memory",
  exceptionHandling: "WebAssembly exception handling",
  memory64: "64-bit memory",
  tailCall: "tail calls",
  gc: "garbage collection types",
  multiMemory: "multiple memories",
  bulkMemory: "bulk memory operations",
  signExtension: "sign-extension operators",
  nontrappingFptoint: "non-trapping float-to-int conversions",
  referenceTypes: "reference types",
  multiValue: "multi-value",
  mutableGlobals: "imported or exported mutable globals",
  bigIntIntegration: "i64 in imported or exported function signatures",
});

class Reader {
  constructor(bytes, offset = 0, end = bytes.length) {
    this.b = bytes;
    this.i = offset;
    this.end = end;
  }

  eof() { return this.i >= this.end; }

  u8() {
    if (this.i >= this.end) throw new RangeError("unexpected end of wasm data");
    return this.b[this.i++];
  }

  skip(n) {
    if (this.i + n > this.end) throw new RangeError("unexpected end of wasm data");
    this.i += n;
  }

  /** Unsigned LEB128, up to 64 bits, returned as a Number (exact below 2^53). */
  uleb() {
    let result = 0;
    let factor = 1;
    for (let n = 0; n < 10; n += 1) {
      const byte = this.u8();
      result += (byte & 0x7f) * factor;
      if (byte < 0x80) return result;
      factor *= 128;
    }
    throw new RangeError("LEB128 value is too long");
  }

  /** Signed LEB128. Only the byte length and sign matter to the scanner. */
  sleb() {
    let result = 0;
    let factor = 1;
    let byte = 0;
    for (let n = 0; n < 10; n += 1) {
      byte = this.u8();
      result += (byte & 0x7f) * factor;
      factor *= 128;
      if (byte < 0x80) {
        if (byte & 0x40) result -= factor;
        return result;
      }
    }
    throw new RangeError("LEB128 value is too long");
  }

  name() {
    const length = this.uleb();
    const start = this.i;
    this.skip(length);
    return utf8(this.b, start, start + length);
  }
}

function utf8(bytes, start, end) {
  let out = "";
  for (let i = start; i < end; i += 1) out += String.fromCharCode(bytes[i]);
  try { return decodeURIComponent(escape(out)); } catch (_) { return out; }
}

const NUMERIC_TYPES = new Set([0x7f, 0x7e, 0x7d, 0x7c, 0x7b]);
const SHORT_REF_TYPES = new Set([0x70, 0x6f, 0x69, 0x6e, 0x6d, 0x6c, 0x6b, 0x6a, 0x71, 0x72, 0x73, 0x74]);

/** Reads one value type and records the features it implies. */
function readValType(r, state) {
  const t = r.u8();
  if (t === 0x7b) state.features.simd = true;
  if (NUMERIC_TYPES.has(t)) return t;
  if (t === 0x70) return t;
  if (t === 0x6f) { state.features.referenceTypes = true; return t; }
  if (t === 0x69) { state.features.exceptionHandling = true; return t; }
  if (t === 0x63 || t === 0x64) {
    // (ref null? heaptype): typed function references or GC.
    state.features.referenceTypes = true;
    const heap = r.sleb();
    if (heap >= 0 || heap < -0x12) state.features.gc = true;
    return t;
  }
  if (SHORT_REF_TYPES.has(t)) { state.features.gc = true; return t; }
  throw new RangeError(`unknown value type 0x${t.toString(16)}`);
}

function readLimits(r, state) {
  const flags = r.u8();
  const memory64 = (flags & 0x04) !== 0;
  const initial = r.uleb();
  const maximum = (flags & 0x01) ? r.uleb() : null;
  if (flags & 0x02) state.features.threads = true;
  if (memory64) state.features.memory64 = true;
  return { flags, shared: (flags & 0x02) !== 0, memory64, initial, maximum };
}

function readTableType(r, state) {
  readValType(r, state);
  return readLimits(r, { features: {} });
}

function readBlockType(r, state) {
  const first = r.b[r.i];
  if (first === 0x40) { r.i += 1; return; }
  if (NUMERIC_TYPES.has(first) || first === 0x70 || first === 0x6f || first === 0x69
      || first === 0x63 || first === 0x64 || SHORT_REF_TYPES.has(first)) {
    readValType(r, state);
    return;
  }
  // A non-negative s33 is a type index: the block has a function signature.
  const index = r.sleb();
  if (index >= 0) state.features.multiValue = true;
}

function readMemArg(r, state) {
  const align = r.uleb();
  if (align & 0x40) {
    const memory = r.uleb();
    if (memory !== 0) state.features.multiMemory = true;
  }
  r.uleb(); // offset
}

function readConstExpr(r, state) {
  // Constant expressions are short; decode them with the same instruction table.
  for (;;) {
    const op = r.u8();
    if (op === 0x0b) return;
    decodeInstruction(op, r, state);
  }
}

function decodeFC(r, state) {
  const sub = r.uleb();
  state.opcodes.fc += 1;
  if (sub <= 7) { state.features.nontrappingFptoint = true; return; }
  state.features.bulkMemory = true;
  switch (sub) {
    case 8: r.uleb(); if (r.uleb() !== 0) state.features.multiMemory = true; return; // memory.init
    case 9: r.uleb(); return; // data.drop
    case 10: { // memory.copy
      const a = r.uleb(); const b = r.uleb();
      if (a !== 0 || b !== 0) state.features.multiMemory = true;
      return;
    }
    case 11: if (r.uleb() !== 0) state.features.multiMemory = true; return; // memory.fill
    case 12: r.uleb(); r.uleb(); return; // table.init
    case 13: r.uleb(); return; // elem.drop
    case 14: r.uleb(); r.uleb(); return; // table.copy
    case 15: case 16: case 17: // table.grow / size / fill
      state.features.referenceTypes = true;
      r.uleb();
      return;
    default:
      throw new RangeError(`unknown 0xFC sub-opcode ${sub}`);
  }
}

function decodeFD(r, state) {
  const sub = r.uleb();
  state.features.simd = true;
  state.opcodes.simd += 1;
  if (sub <= 11) { readMemArg(r, state); return; } // v128.load* / v128.store
  if (sub === 12 || sub === 13) { r.skip(16); return; } // v128.const / i8x16.shuffle
  if (sub >= 21 && sub <= 34) { r.skip(1); return; } // extract_lane / replace_lane
  if (sub >= 84 && sub <= 91) { readMemArg(r, state); r.skip(1); return; } // load/store lane
  if (sub === 92 || sub === 93) { readMemArg(r, state); return; } // load32_zero / load64_zero
  // Every other SIMD and relaxed-SIMD instruction has no immediates.
}

function decodeFE(r, state) {
  const sub = r.uleb();
  state.features.threads = true;
  state.opcodes.atomics += 1;
  if (sub === 3) { r.skip(1); return; } // atomic.fence
  if (sub <= 2 || (sub >= 0x10 && sub <= 0x4e)) { readMemArg(r, state); return; }
  throw new RangeError(`unknown 0xFE sub-opcode ${sub}`);
}

function decodeInstruction(op, r, state) {
  if (op >= 0x45 && op <= 0xbf) return; // comparisons, arithmetic, conversions
  if (op >= 0xc0 && op <= 0xc4) { state.features.signExtension = true; return; }
  if (op >= 0x28 && op <= 0x3e) { readMemArg(r, state); return; } // loads and stores
  switch (op) {
    case 0x00: case 0x01: case 0x05: case 0x0b: case 0x0f: case 0x1a: case 0x1b:
      return;
    case 0x02: case 0x03: case 0x04:
      readBlockType(r, state);
      return;
    case 0x06: // try (legacy exception handling)
      state.features.exceptionHandling = true; state.opcodes.exceptions += 1;
      readBlockType(r, state);
      return;
    case 0x07: case 0x08: case 0x09: case 0x18: // catch / throw / rethrow / delegate
      state.features.exceptionHandling = true; state.opcodes.exceptions += 1;
      r.uleb();
      return;
    case 0x0a: case 0x19: // throw_ref / catch_all
      state.features.exceptionHandling = true; state.opcodes.exceptions += 1;
      return;
    case 0x1f: { // try_table
      state.features.exceptionHandling = true; state.opcodes.exceptions += 1;
      readBlockType(r, state);
      const clauses = r.uleb();
      for (let n = 0; n < clauses; n += 1) {
        const kind = r.u8();
        if (kind === 0 || kind === 1) r.uleb();
        r.uleb();
      }
      return;
    }
    case 0x0c: case 0x0d:
      r.uleb();
      return;
    case 0x0e: {
      const count = r.uleb();
      for (let n = 0; n <= count; n += 1) r.uleb();
      return;
    }
    case 0x10:
      r.uleb();
      return;
    case 0x11: {
      r.uleb();
      if (r.uleb() !== 0) state.features.referenceTypes = true;
      return;
    }
    case 0x12:
      state.features.tailCall = true; r.uleb();
      return;
    case 0x13:
      state.features.tailCall = true; r.uleb(); r.uleb();
      return;
    case 0x14: case 0x15:
      state.features.gc = true; r.uleb();
      return;
    case 0x1c: {
      state.features.referenceTypes = true;
      const count = r.uleb();
      for (let n = 0; n < count; n += 1) readValType(r, state);
      return;
    }
    case 0x20: case 0x21: case 0x22: case 0x23: case 0x24:
      r.uleb();
      return;
    case 0x25: case 0x26:
      state.features.referenceTypes = true; r.uleb();
      return;
    case 0x3f: case 0x40:
      if (r.uleb() !== 0) state.features.multiMemory = true;
      return;
    case 0x41: case 0x42:
      r.sleb();
      return;
    case 0x43:
      r.skip(4);
      return;
    case 0x44:
      r.skip(8);
      return;
    case 0xd0:
      state.features.referenceTypes = true; r.sleb();
      return;
    case 0xd1:
      state.features.referenceTypes = true;
      return;
    case 0xd2:
      state.features.referenceTypes = true; r.uleb();
      return;
    case 0xd3: case 0xd4:
      state.features.gc = true;
      return;
    case 0xd5: case 0xd6:
      state.features.gc = true; r.uleb();
      return;
    case 0xfb:
      state.features.gc = true;
      throw new RangeError("garbage-collection instructions are not decoded");
    case 0xfc:
      decodeFC(r, state);
      return;
    case 0xfd:
      decodeFD(r, state);
      return;
    case 0xfe:
      decodeFE(r, state);
      return;
    default:
      throw new RangeError(`unknown opcode 0x${op.toString(16)}`);
  }
}

function decodeFunctionBody(r, state) {
  const localGroups = r.uleb();
  for (let n = 0; n < localGroups; n += 1) {
    r.uleb();
    readValType(r, state);
  }
  while (!r.eof()) decodeInstruction(r.u8(), r, state);
}

function emptyFeatures() {
  const features = {};
  for (const key of Object.keys(FEATURE_LABELS)) features[key] = false;
  return features;
}

/**
 * Decodes a WebAssembly module far enough to tell which proposals it needs.
 * @param {Uint8Array} bytes
 */
export function scanWasm(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("scanWasm expects a Uint8Array");
  if (bytes.length < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error("not a WebAssembly binary: missing \\0asm magic");
  }
  const version = bytes[4] | (bytes[5] << 8) | (bytes[6] << 16) | (bytes[7] << 24);
  if (version !== 1) throw new Error(`unsupported WebAssembly binary version ${version}`);

  const state = {
    features: emptyFeatures(),
    opcodes: { simd: 0, atomics: 0, exceptions: 0, fc: 0 },
  };
  const result = {
    size: bytes.length,
    version,
    sections: [],
    customSections: [],
    memory: null,
    imports: { functions: 0, memories: 0, tables: 0, globals: 0, tags: 0, modules: [] },
    exports: { functions: 0, memories: 0, tables: 0, globals: 0, tags: 0 },
    functions: { defined: 0, decoded: 0, undecodable: 0, firstDecodeError: null },
    features: state.features,
    opcodes: state.opcodes,
  };

  const types = []; // function signatures: { params: number[], results: number[] }
  const importedFunctionTypes = [];
  const definedFunctionTypes = [];
  const importModules = new Set();
  const exportedFunctionIndices = [];
  const r = new Reader(bytes, 8);

  while (!r.eof()) {
    const id = r.u8();
    const size = r.uleb();
    const start = r.i;
    const end = start + size;
    if (end > bytes.length) throw new Error(`section ${id} runs past the end of the file`);
    const s = new Reader(bytes, start, end);
    const entry = { id, name: SECTION_NAMES[id] || `unknown-${id}`, size };
    result.sections.push(entry);

    switch (id) {
      case 0: {
        const name = s.name();
        entry.customName = name;
        result.customSections.push(name);
        if (name === "target_features") {
          const count = s.uleb();
          entry.targetFeatures = [];
          for (let n = 0; n < count; n += 1) {
            const prefix = String.fromCharCode(s.u8());
            entry.targetFeatures.push(prefix + s.name());
          }
        }
        break;
      }
      case 1: {
        const count = s.uleb();
        for (let n = 0; n < count; n += 1) {
          const form = s.u8();
          if (form !== 0x60) {
            // Recursive groups, structs, and arrays belong to the GC proposal.
            state.features.gc = true;
            break;
          }
          const params = [];
          const results = [];
          const paramCount = s.uleb();
          for (let p = 0; p < paramCount; p += 1) params.push(readValType(s, state));
          const resultCount = s.uleb();
          for (let p = 0; p < resultCount; p += 1) results.push(readValType(s, state));
          if (results.length > 1) state.features.multiValue = true;
          types.push({ params, results });
        }
        break;
      }
      case 2: {
        const count = s.uleb();
        for (let n = 0; n < count; n += 1) {
          importModules.add(s.name());
          s.name();
          const kind = s.u8();
          if (kind === 0) {
            importedFunctionTypes.push(s.uleb());
            result.imports.functions += 1;
          } else if (kind === 1) {
            readTableType(s, state);
            result.imports.tables += 1;
          } else if (kind === 2) {
            const limits = readLimits(s, state);
            result.imports.memories += 1;
            result.memory = {
              imported: true, shared: limits.shared, memory64: limits.memory64,
              initialPages: limits.initial, maximumPages: limits.maximum,
            };
          } else if (kind === 3) {
            readValType(s, state);
            if (s.u8() === 1) state.features.mutableGlobals = true;
            result.imports.globals += 1;
          } else if (kind === 4) {
            s.u8(); s.uleb();
            state.features.exceptionHandling = true;
            result.imports.tags += 1;
          } else {
            throw new Error(`unknown import kind ${kind}`);
          }
        }
        break;
      }
      case 3: {
        const count = s.uleb();
        for (let n = 0; n < count; n += 1) definedFunctionTypes.push(s.uleb());
        result.functions.defined = count;
        break;
      }
      case 4: {
        const count = s.uleb();
        if (count + result.imports.tables > 1) state.features.referenceTypes = true;
        break;
      }
      case 5: {
        const count = s.uleb();
        if (count + result.imports.memories > 1) state.features.multiMemory = true;
        if (count > 0) {
          const limits = readLimits(s, state);
          result.memory = {
            imported: false, shared: limits.shared, memory64: limits.memory64,
            initialPages: limits.initial, maximumPages: limits.maximum,
          };
        }
        break;
      }
      case 6: {
        const count = s.uleb();
        for (let n = 0; n < count; n += 1) {
          readValType(s, state);
          s.u8();
          readConstExpr(s, state);
        }
        break;
      }
      case 7: {
        const count = s.uleb();
        for (let n = 0; n < count; n += 1) {
          s.name();
          const kind = s.u8();
          const index = s.uleb();
          if (kind === 0) { result.exports.functions += 1; exportedFunctionIndices.push(index); }
          else if (kind === 1) result.exports.tables += 1;
          else if (kind === 2) result.exports.memories += 1;
          else if (kind === 3) result.exports.globals += 1;
          else if (kind === 4) { result.exports.tags += 1; state.features.exceptionHandling = true; }
        }
        break;
      }
      case 10: {
        const count = s.uleb();
        for (let n = 0; n < count; n += 1) {
          const bodySize = s.uleb();
          const bodyStart = s.i;
          const bodyEnd = bodyStart + bodySize;
          if (bodyEnd > end) throw new Error("function body runs past the end of the code section");
          try {
            decodeFunctionBody(new Reader(bytes, bodyStart, bodyEnd), state);
            result.functions.decoded += 1;
          } catch (error) {
            result.functions.undecodable += 1;
            if (!result.functions.firstDecodeError) {
              result.functions.firstDecodeError = `function ${n}: ${error.message}`;
            }
          }
          s.i = bodyEnd;
        }
        break;
      }
      case 12:
        state.features.bulkMemory = true;
        break;
      case 13:
        state.features.exceptionHandling = true;
        break;
      default:
        break;
    }
    r.i = end;
  }

  const boundaryTypes = [
    ...importedFunctionTypes,
    ...exportedFunctionIndices
      .map((index) => index - importedFunctionTypes.length)
      .filter((index) => index >= 0 && index < definedFunctionTypes.length)
      .map((index) => definedFunctionTypes[index]),
  ];
  for (const typeIndex of boundaryTypes) {
    const type = types[typeIndex];
    if (type && (type.params.includes(0x7e) || type.results.includes(0x7e))) {
      state.features.bigIntIntegration = true;
      break;
    }
  }

  result.imports.modules = [...importModules].sort();
  result.blocking = BLOCKING_FEATURES.filter((name) => state.features[name]);
  result.complete = result.functions.undecodable === 0;
  return result;
}

/**
 * Applies the export policy to a scan result.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function evaluateWasmScan(scan, { allow = [] } = {}) {
  const allowed = new Set(allow);
  const errors = [];
  const warnings = [];
  for (const feature of scan.blocking) {
    const label = FEATURE_LABELS[feature] || feature;
    if (allowed.has(feature)) {
      warnings.push(`the engine uses ${label}; it was allowed explicitly and may not load on every device`);
    } else {
      errors.push(`the engine uses ${label}, which mini-game hosts do not load reliably`);
    }
  }
  if (!scan.complete) {
    errors.push(
      `${scan.functions.undecodable} of ${scan.functions.defined} function bodies could not be decoded `
      + `(${scan.functions.firstDecodeError}); the feature scan is incomplete`,
    );
  }
  if (!scan.memory) warnings.push("the engine declares no linear memory");
  return { ok: errors.length === 0, errors, warnings };
}
