import assert from "node:assert/strict";
import test from "node:test";

import { BLOCKING_FEATURES, evaluateWasmScan, scanWasm } from "../src/wasm_features.mjs";
import {
  F32, I32, I64, V128, engineStandInWasm, funcType, moduleBytes, moduleWithCode, name, section, uleb, vec,
} from "./helpers/wasm_builder.mjs";

test("the engine stand-in is a loadable module with an imported memory", async () => {
  const bytes = engineStandInWasm();
  const scan = scanWasm(bytes);
  assert.equal(scan.complete, true);
  assert.deepEqual(scan.blocking, []);
  assert.deepEqual(scan.memory, { imported: true, shared: false, memory64: false, initialPages: 1, maximumPages: 32768 });
  assert.equal(scan.imports.functions, 1);
  assert.deepEqual(scan.imports.modules, ["a"]);
  assert.equal(scan.functions.decoded, 1);

  const memory = new WebAssembly.Memory({ initial: 1, maximum: 32768 });
  const { instance } = await WebAssembly.instantiate(bytes, { a: { a: memory, b: (x) => x * 2 } });
  assert.equal(instance.exports.run(20), 41);
});

test("rejects files that are not WebAssembly", () => {
  assert.throws(() => scanWasm(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])), /magic/);
  assert.throws(() => scanWasm(Buffer.from("not wasm").buffer), /Uint8Array/);
  assert.throws(() => scanWasm(new Uint8Array([0, 0x61, 0x73, 0x6d, 2, 0, 0, 0])), /version 2/);
});

test("detects SIMD from instructions and from v128 types", () => {
  // v128.const (16 immediate bytes), then drop.
  const byInstruction = scanWasm(moduleWithCode([0xfd, 0x0c, ...new Array(16).fill(0), 0x1a]));
  assert.equal(byInstruction.features.simd, true);
  assert.equal(byInstruction.opcodes.simd, 1);
  assert.deepEqual(byInstruction.blocking, ["simd"]);

  const byLocal = scanWasm(moduleWithCode([0x01], { locals: [[...uleb(1), V128]] }));
  assert.equal(byLocal.features.simd, true);
});

test("an i32 constant whose bytes look like a SIMD prefix is not SIMD", () => {
  // i32.const 253 encodes as 0x41 0xFD 0x01: the 0xFD is an immediate, not an opcode.
  const scan = scanWasm(moduleWithCode([0x41, 0xfd, 0x01, 0x1a]));
  assert.equal(scan.features.simd, false);
  assert.equal(scan.complete, true);
  assert.deepEqual(scan.blocking, []);
});

test("detects threads from atomic instructions and from shared memory", () => {
  // i32.const 0; i32.atomic.load (align 2, offset 0); drop
  const atomics = scanWasm(moduleWithCode([0x41, 0x00, 0xfe, 0x10, 0x02, 0x00, 0x1a]));
  assert.equal(atomics.features.threads, true);
  assert.equal(atomics.opcodes.atomics, 1);

  const shared = scanWasm(engineStandInWasm({ shared: true }));
  assert.equal(shared.features.threads, true);
  assert.equal(shared.memory.shared, true);
  assert.ok(shared.blocking.includes("threads"));
});

test("detects exception handling from the tag section and from try/catch", () => {
  const tagged = scanWasm(moduleWithCode([0x01], { extraSections: [section(13, vec([[0x00, ...uleb(0)]]))] }));
  assert.equal(tagged.features.exceptionHandling, true);

  // try (void) ... catch_all ... end
  const legacy = scanWasm(moduleWithCode([0x06, 0x40, 0x01, 0x19, 0x01, 0x0b]));
  assert.equal(legacy.features.exceptionHandling, true);
  assert.equal(legacy.opcodes.exceptions, 2);
});

test("detects 64-bit memory and tail calls", () => {
  assert.ok(scanWasm(engineStandInWasm({ memory64: true })).blocking.includes("memory64"));
  // return_call 0
  assert.ok(scanWasm(moduleWithCode([0x12, 0x00])).blocking.includes("tailCall"));
});

test("classifies the non-blocking proposals", () => {
  // i32.const 0; i32.extend8_s; drop
  assert.equal(scanWasm(moduleWithCode([0x41, 0x00, 0xc0, 0x1a])).features.signExtension, true);
  // f32.const 0; i32.trunc_sat_f32_s; drop
  const sat = scanWasm(moduleWithCode([0x43, 0, 0, 0, 0, 0xfc, 0x00, 0x1a]));
  assert.equal(sat.features.nontrappingFptoint, true);
  assert.equal(sat.features.bulkMemory, false);
  // i32.const 0 ×3; memory.fill
  const fill = scanWasm(moduleWithCode([0x41, 0, 0x41, 0, 0x41, 0, 0xfc, 0x0b, 0x00]));
  assert.equal(fill.features.bulkMemory, true);
  assert.deepEqual(fill.blocking, []);
  // A DataCount section alone already requires bulk-memory support.
  const dataCount = scanWasm(moduleWithCode([0x01], { extraSections: [section(12, uleb(0))] }));
  assert.equal(dataCount.features.bulkMemory, true);
});

test("reports i64 on the JavaScript boundary and multi-value signatures", () => {
  const bigint = scanWasm(moduleBytes([
    section(1, vec([funcType([I64], [])])),
    section(2, vec([[...name("env"), ...name("f"), 0x00, ...uleb(0)]])),
  ]));
  assert.equal(bigint.features.bigIntIntegration, true);

  const multi = scanWasm(moduleBytes([section(1, vec([funcType([], [I32, F32])]))]));
  assert.equal(multi.features.multiValue, true);
});

test("an undecodable function body makes the scan incomplete and fails the policy", () => {
  const scan = scanWasm(moduleWithCode([0xff]));
  assert.equal(scan.complete, false);
  assert.equal(scan.functions.undecodable, 1);
  assert.match(scan.functions.firstDecodeError, /unknown opcode 0xff/);
  const policy = evaluateWasmScan(scan);
  assert.equal(policy.ok, false);
  assert.match(policy.errors[0], /could not be decoded/);
});

test("the policy blocks by default and downgrades an explicit allowance to a warning", () => {
  const scan = scanWasm(moduleWithCode([0xfd, 0x0c, ...new Array(16).fill(0), 0x1a]));
  const blocked = evaluateWasmScan(scan);
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors[0], /SIMD/);

  const allowed = evaluateWasmScan(scan, { allow: ["simd"] });
  assert.equal(allowed.ok, true);
  assert.match(allowed.warnings[0], /allowed explicitly/);
  assert.ok(BLOCKING_FEATURES.includes("simd"));
});

test("reads the target_features custom section when it is present", () => {
  const payload = [...name("target_features"), ...uleb(2), 0x2b, ...name("simd128"), 0x2b, ...name("bulk-memory")];
  const scan = scanWasm(moduleBytes([section(0, payload)]));
  assert.deepEqual(scan.customSections, ["target_features"]);
  assert.deepEqual(scan.sections[0].targetFeatures, ["+simd128", "+bulk-memory"]);
});
