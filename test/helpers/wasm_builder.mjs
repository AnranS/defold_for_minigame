/**
 * A very small WebAssembly binary writer for tests.
 *
 * It produces real, loadable modules without a toolchain: the engine stand-in
 * used by the simulated hosts, and deliberately "wrong" modules that carry the
 * proposals the feature scanner has to reject.
 */

export function uleb(value) {
  const out = [];
  let rest = value >>> 0;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) byte |= 0x80;
    out.push(byte);
  } while (rest !== 0);
  return out;
}

export function sleb(value) {
  const out = [];
  let rest = value | 0;
  for (;;) {
    const byte = rest & 0x7f;
    rest >>= 7;
    const done = (rest === 0 && (byte & 0x40) === 0) || (rest === -1 && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
}

export function name(text) {
  const bytes = [...Buffer.from(text, "utf8")];
  return [...uleb(bytes.length), ...bytes];
}

export function vec(items) {
  return [...uleb(items.length), ...items.flat()];
}

export function section(id, payload) {
  return [id, ...uleb(payload.length), ...payload];
}

export const I32 = 0x7f;
export const I64 = 0x7e;
export const F32 = 0x7d;
export const F64 = 0x7c;
export const V128 = 0x7b;

export function funcType(params, results) {
  return [0x60, ...vec(params.map((type) => [type])), ...vec(results.map((type) => [type]))];
}

export function body(locals, code) {
  const content = [...vec(locals), ...code, 0x0b];
  return [...uleb(content.length), ...content];
}

export function moduleBytes(sections) {
  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...sections.flat()]);
}

/**
 * The engine stand-in: imports its memory and one host function from module
 * `a` (like a Defold release build) and exports `run(x) = host(x) + 1`.
 */
export function engineStandInWasm({ shared = false, memory64 = false } = {}) {
  let flags = 0x01;
  if (shared) flags |= 0x02;
  if (memory64) flags |= 0x04;
  return moduleBytes([
    section(1, vec([funcType([I32], [I32])])),
    section(2, vec([
      [...name("a"), ...name("a"), 0x02, flags, ...uleb(1), ...uleb(32768)],
      [...name("a"), ...name("b"), 0x00, ...uleb(0)],
    ])),
    section(3, vec([[...uleb(0)]])),
    section(7, vec([[...name("run"), 0x00, ...uleb(1)]])),
    section(10, vec([body([], [0x20, 0x00, 0x10, 0x00, 0x41, 0x01, 0x6a])])),
  ]);
}

/** A module with one function made of the given instruction bytes. */
export function moduleWithCode(code, { locals = [], extraSections = [], types } = {}) {
  return moduleBytes([
    section(1, vec(types || [funcType([], [])])),
    section(3, vec([[...uleb(0)]])),
    section(5, vec([[0x00, ...uleb(1)]])),
    ...extraSections,
    section(10, vec([body(locals, code)])),
  ]);
}
