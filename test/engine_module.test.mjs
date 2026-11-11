import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";

import { BOOT_FUNCTION_KEY, composeEngineModule, detectLoaderGeneration } from "../src/engine_module.mjs";
import { ExportError } from "../src/util.mjs";
import { DEFOLD_RELEASES, DEFOLD_VERSIONS, makeBundle, readFakeGlue } from "./helpers/bundle_fixture.mjs";

function sources(t, options) {
  const made = makeBundle(options);
  t.after(() => rmSync(made.directory, { recursive: true, force: true }));
  return {
    dmloaderText: readFileSync(join(made.directory, "dmloader.js"), "utf8"),
    glueText: readFileSync(join(made.directory, `${made.exeName}_wasm.js`), "utf8"),
    engineVersion: "1.14.0",
    engineSdkSha1: "abc",
    toolVersion: "0.0.0-test",
  };
}

test("keeps both sources verbatim apart from the counted rewrites", (t) => {
  const input = sources(t);
  const { text, report } = composeEngineModule(input);

  assert.equal(report.evalSites, 1);
  assert.equal(report.duplicateParameterRewrites, 1);
  assert.ok(!/(?<![\w$.])eval\(/.test(text), "no eval call may remain");
  assert.ok(text.includes("__defoldMiniGameEval(code)"));

  const expectedLoader = input.dmloaderText.replace(/function\s*\(\s*_\s*,\s*_\s*\)/g, "function(_, _unused)");
  const expectedGlue = input.glueText.replace(/(?<![\w$.])eval\(/g, "__defoldMiniGameEval(");
  assert.ok(text.includes(expectedLoader), "dmloader.js is embedded unchanged");
  assert.ok(text.includes(expectedGlue), "the glue is embedded unchanged");
  assert.ok(text.indexOf(expectedLoader) < text.indexOf(".configure({"));
  assert.ok(text.indexOf(".configure({") < text.indexOf(expectedGlue));
  assert.ok(text.indexOf(expectedGlue) < text.indexOf(".onGlueLoaded("));
});

test("the module parses in sloppy and strict mode and contains no module syntax", (t) => {
  const { text } = composeEngineModule(sources(t));
  assert.doesNotThrow(() => new vm.Script(text));
  assert.doesNotThrow(() => new vm.Script(`"use strict";\n${text}`));
  assert.ok(!/^\s*(import|export)\s/m.test(text));
});

test("declares every browser global the engine may read, and the loader's implicit globals", (t) => {
  const { text, report } = composeEngineModule(sources(t));
  for (const name of ["window", "self", "globalThis", "document", "navigator", "location", "indexedDB",
    "XMLHttpRequest", "WebAssembly", "WebGLRenderingContext", "WebGL2RenderingContext", "process", "require",
    "module", "fetch", "setTimeout", "requestAnimationFrame"]) {
    assert.ok(report.scopedBindings.includes(name), `${name} is bound`);
    assert.match(text, new RegExp(`\\nvar ${name} = `));
  }
  assert.match(text, /\nvar i, total, downloaded;\n/);
});

test("registers one boot function and runs nothing until it is called", (t) => {
  const { text } = composeEngineModule(sources(t));
  const sandbox = { GameGlobal: {} };
  vm.runInNewContext(text, sandbox);
  assert.equal(typeof sandbox.GameGlobal[BOOT_FUNCTION_KEY], "function");
  assert.deepEqual(Object.keys(sandbox.GameGlobal), [BOOT_FUNCTION_KEY]);
});

test("falls back to globalThis when the host has no GameGlobal", (t) => {
  const { text } = composeEngineModule(sources(t));
  const sandbox = {};
  vm.runInNewContext(text, sandbox);
  assert.equal(typeof sandbox[BOOT_FUNCTION_KEY], "function");
});

test("refuses a loader that does not have the expected layout", (t) => {
  const input = sources(t);
  const broken = input.dmloaderText.replace("onArchiveFileLoaded: function", "onArchiveFileLoadedRenamed: function");
  assert.throws(() => composeEngineModule({ ...input, dmloaderText: broken }), (error) => {
    assert.ok(error instanceof ExportError);
    assert.match(error.message, /dmloader\.js does not match/);
    assert.match(error.message, /Module\.onArchiveFileLoaded/);
    return true;
  });
});

test("refuses a glue that does not have the expected layout", (t) => {
  const input = sources(t);
  assert.throws(() => composeEngineModule({ ...input, glueText: input.glueText.replace("var IDBFS =", "var IDBFS2 =") }),
    /The engine glue does not match.*var IDBFS/);
  assert.throws(
    () => composeEngineModule({ ...input, glueText: input.glueText.replace(/var Module=typeof Module[^;]+;/, "var Module = {};") }),
    /reuses the loader's Module/,
  );
});

test("requires an eval site for html5.run unless the bridge is waived", (t) => {
  const input = sources(t);
  const glueText = input.glueText.replace("jsResult = eval(code);", "jsResult = String(code);");
  assert.throws(() => composeEngineModule({ ...input, glueText }), /no eval\(\) call/);
  const { report } = composeEngineModule({ ...input, glueText, allowMissingBridge: true });
  assert.equal(report.evalSites, 0);
});

test("a property named eval is not mistaken for a call to eval", (t) => {
  const input = sources(t);
  const glueText = `${input.glueText}\nvar helper = { eval: function (x) { return x; } }; helper.eval(1);\n`;
  const { text, report } = composeEngineModule({ ...input, glueText });
  assert.equal(report.evalSites, 1);
  assert.ok(text.includes("helper.eval(1)"));
});

test("refuses sources that collide with the exporter's identifiers or are ES modules", (t) => {
  const input = sources(t);
  assert.throws(() => composeEngineModule({ ...input, glueText: `${input.glueText}\nvar __defoldMiniGameHost = 1;` }),
    /reserved by the exporter/);
  assert.throws(() => composeEngineModule({ ...input, glueText: `${input.glueText}\nvar u = import.meta.url;` }),
    /ES module/);
});

test("reports a syntax error in the inputs instead of writing a broken module", (t) => {
  const input = sources(t);
  assert.throws(() => composeEngineModule({ ...input, glueText: `${input.glueText}\nfunction broken( {` }),
    /does not parse in sloppy mode/);
  // Legal in sloppy mode only: an octal literal.
  assert.throws(() => composeEngineModule({ ...input, glueText: `${input.glueText}\nvar legacyOctal = 017;` }),
    /does not parse in strict mode/);
});

test("the stand-in glue matches the layout of the real one it replaces", () => {
  const glue = readFakeGlue();
  assert.equal((glue.match(/(?<![\w$.])eval\(/g) || []).length, 1);
  for (const marker of ["var FS = ", "var IDBFS = ", "var DMSYS = ", "var GLFW = ", "var dmRenderer = ",
    'Module["instantiateWasm"]', 'Module["preInit"]', 'var Module=typeof Module!="undefined"?Module:{};']) {
    assert.ok(glue.includes(marker), marker);
  }
});

for (const defoldVersion of DEFOLD_VERSIONS) {
  test(`recognises the loader design of Defold ${defoldVersion} and composes it`, (t) => {
    const input = sources(t, { defoldVersion });
    const generation = DEFOLD_RELEASES[defoldVersion].loaderGeneration;
    assert.equal(detectLoaderGeneration(input.dmloaderText), generation);
    const { text, report } = composeEngineModule(input);
    assert.equal(report.loaderGeneration, generation);
    assert.equal(report.evalSites, 1);
    assert.equal(report.duplicateParameterRewrites, 1);
    assert.ok(text.includes(`generation: "${generation}"`));
    assert.ok(text.includes('GameStartup: typeof GameStartup !== "undefined" ? GameStartup : undefined'));
    assert.doesNotThrow(() => new vm.Script(`"use strict";\n${text}`));
  });
}

test("refuses a loader that follows neither start-up design", (t) => {
  const input = sources(t, { defoldVersion: "1.14.0" });
  const neither = input.dmloaderText.replace(/_preloadAndCallMain: function/, "_startWhenReady: function");
  assert.equal(detectLoaderGeneration(neither), null);
  assert.throws(() => composeEngineModule({ ...input, dmloaderText: neither }),
    /missing: Module\._preloadAndCallMain \(Defold up to 1\.14\.0\) or GameStartup \(Defold 1\.14\.1 and later\)/);

  const session = sources(t, { defoldVersion: "1.14.1" });
  const broken = session.dmloaderText.replace("selectEngine: function", "pickEngine: function");
  assert.throws(() => composeEngineModule({ ...session, dmloaderText: broken }), /missing: EngineLoader\.selectEngine/);
});
