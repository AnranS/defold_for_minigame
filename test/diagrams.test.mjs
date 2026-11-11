/**
 * The figures in docs/images are generated. These tests keep the committed
 * files current, well-formed, equal in structure across the two languages,
 * and consistent with support-matrix.json and with what the READMEs say.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  IMAGE_DIRECTORY, LANGUAGES, REFERENCE_SIZES, renderFigures, textWidth, wrap,
} from "../scripts/generate_diagrams.mjs";
import { loadSupportMatrix, REPO_ROOT } from "../src/util.mjs";

const matrix = loadSupportMatrix();
const figures = renderFigures(matrix);
const read = (path) => readFileSync(join(REPO_ROOT, path), "utf8");

const DOCUMENTS = [
  "README.md", "README_zh.md",
  ...readdirSync(join(REPO_ROOT, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`),
];

/** Fails on anything an XML parser would reject in the subset the generator writes. */
function assertWellFormed(svg, name) {
  const open = [];
  for (const match of svg.matchAll(/<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g)) {
    const [, closing, tag, , selfClosing] = match;
    if (selfClosing) continue;
    if (closing) assert.equal(open.pop(), tag, `${name}: </${tag}> closes the wrong element`);
    else open.push(tag);
  }
  assert.deepEqual(open, [], `${name}: unclosed elements`);
  const leftover = svg.replace(/<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<]*")*)\s*(\/?)>/g, "");
  assert.ok(!/[<>]/.test(leftover), `${name}: a stray < or > outside a tag`);
  assert.ok(!/&(?!(amp|lt|gt|quot);)/.test(svg), `${name}: an unescaped &`);
}

test("the committed figures are what the generator draws", () => {
  for (const figure of figures) {
    assert.ok(existsSync(join(REPO_ROOT, figure.path)), `${figure.path} is missing; run node scripts/generate_diagrams.mjs`);
    assert.equal(read(figure.path), figure.svg, `${figure.path} is stale; run node scripts/generate_diagrams.mjs`);
  }
  const committed = readdirSync(join(REPO_ROOT, IMAGE_DIRECTORY)).sort();
  assert.deepEqual(committed, figures.map((figure) => figure.file).sort(), `${IMAGE_DIRECTORY} holds exactly the generated figures`);
});

test("every figure is well-formed, described, and free of unrendered values", () => {
  assert.equal(figures.length, 4 * LANGUAGES.length);
  for (const figure of figures) {
    assertWellFormed(figure.svg, figure.file);
    assert.ok(figure.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"'), figure.file);
    assert.ok(figure.title.length > 5 && figure.description.length > 60, `${figure.file}: title and description`);
    assert.ok(figure.width === 1200 && figure.height > 300, `${figure.file}: size`);
    for (const leftover of ["undefined", "NaN", "[object", "null"]) {
      assert.ok(!figure.svg.includes(leftover), `${figure.file}: found "${leftover}"`);
    }
    // Nothing that would run or load when the file is opened on its own.
    assert.ok(!/<script|<foreignObject|href=|url\((?!#)/i.test(figure.svg), `${figure.file}: active or external content`);
  }
});

test("the Chinese and English versions of a figure have the same structure", () => {
  const shapes = (svg) => ["<rect", "<path", "<circle"].map((tag) => svg.split(tag).length - 1);
  for (const name of new Set(figures.map((figure) => figure.name))) {
    const zh = figures.find((figure) => figure.name === name && figure.lang === "zh");
    const en = figures.find((figure) => figure.name === name && figure.lang === "en");
    assert.deepEqual(shapes(zh.svg), shapes(en.svg), `${name}: the two languages draw different shapes`);
    assert.notEqual(zh.title, en.title, `${name}: the title was not translated`);
    assert.ok(/[一-鿿]/.test(zh.description), `${name}: the Chinese description is not Chinese`);
    assert.ok(!/[一-鿿]/.test(en.svg), `${name}: Chinese text in the English figure`);
  }
});

test("the figures show the platforms and limits in support-matrix.json", () => {
  const contracts = Object.values(matrix.platformContracts);
  for (const lang of LANGUAGES) {
    const banner = figures.find((figure) => figure.name === "banner" && figure.lang === lang).svg;
    const architecture = figures.find((figure) => figure.name === "architecture" && figure.lang === lang).svg;
    const layout = figures.find((figure) => figure.name === "package" && figure.lang === lang).svg;
    for (const contract of contracts) {
      assert.ok(banner.includes(`>${contract.apiNamespace}</text>`), `banner-${lang}: ${contract.apiNamespace}`);
      assert.ok(architecture.includes(contract.apiNamespace), `architecture-${lang}: ${contract.apiNamespace}`);
      assert.ok(layout.includes(`${contract.packageLimitsBytes.total / 1048576} MB`), `package-${lang}: total limit`);
    }
    assert.ok(layout.includes(`${contracts[0].packageLimitsBytes.main / 1048576} MB`), `package-${lang}: main limit`);
  }
});

test("the sizes in the figures are the ones the READMEs quote", () => {
  assert.ok(matrix.engines.some((engine) => engine.defoldVersion === REFERENCE_SIZES.defoldVersion),
    "the reference sizes are for a Defold version the matrix lists");
  for (const file of ["README.md", "README_zh.md"]) {
    const text = read(file);
    for (const size of [REFERENCE_SIZES.mainPackageMb, REFERENCE_SIZES.engineOriginalMb, REFERENCE_SIZES.engineCompressedMb]) {
      assert.ok(text.includes(`${size} MB`), `${file} does not quote ${size} MB`);
    }
    assert.ok(text.includes(`Defold ${REFERENCE_SIZES.defoldVersion}`), `${file}: reference Defold version`);
  }
  for (const lang of LANGUAGES) {
    const layout = figures.find((figure) => figure.name === "package" && figure.lang === lang).svg;
    for (const size of [REFERENCE_SIZES.mainPackageMb, REFERENCE_SIZES.engineOriginalMb, REFERENCE_SIZES.engineCompressedMb]) {
      assert.ok(layout.includes(`${size} MB`), `package-${lang}: ${size} MB`);
    }
  }
});

test("the bridge figure shows the protocol the bridge and the Lua module speak", () => {
  const bridge = read("runtime/common/js/bridge.js");
  const lua = read("minigame/minigame.lua");
  // The operations and the event fields drawn in the figure exist in the code.
  assert.ok(/\bcall\(command\)/.test(bridge) && /\bpoll\(\)/.test(bridge));
  assert.ok(bridge.includes("push({ id, ok: true, data: toWire(res) })"));
  assert.ok(lua.includes('request({ op = "call", api = api, args = args or {}, id = id })'));
  assert.ok(lua.includes('send({ op = "poll" })'));
  for (const lang of LANGUAGES) {
    const figure = figures.find((entry) => entry.name === "bridge" && entry.lang === lang).svg;
    for (const label of ["&quot;op&quot;:&quot;call&quot;", "&quot;op&quot;:&quot;poll&quot;", "&quot;ok&quot;:true", "wx.login({ success, fail })", "callback(code, nil)"]) {
      assert.ok(figure.includes(label), `bridge-${lang}: ${label}`);
    }
  }
});

test("documents reference figures that exist, in their own language, and every figure is used", () => {
  const used = new Set();
  for (const file of DOCUMENTS) {
    const prefix = file.startsWith("docs/") ? "images/" : `${IMAGE_DIRECTORY}/`;
    for (const match of read(file).matchAll(/(?:\]\(|src=")((?:docs\/)?images\/[\w-]+\.svg)/g)) {
      const reference = match[1];
      assert.ok(reference.startsWith(prefix), `${file}: ${reference} should be written relative to the file`);
      const name = reference.slice(prefix.length);
      assert.ok(figures.some((figure) => figure.file === name), `${file}: ${reference} is not a generated figure`);
      // A Chinese document shows the Chinese figure; everything else the English one.
      const expected = /_zh\.md$/.test(file) ? "zh" : "en";
      assert.ok(name.endsWith(`-${expected}.svg`), `${file}: ${reference} should be the ${expected} figure`);
      used.add(name);
    }
  }
  for (const figure of figures) assert.ok(used.has(figure.file), `${figure.file} is not used by any document`);
});

test("images in the READMEs carry a description", () => {
  for (const file of ["README.md", "README_zh.md"]) {
    const images = [...read(file).matchAll(/<img\s[^>]*>/g)].map((match) => match[0]);
    assert.ok(images.length >= 3, `${file}: banner, architecture, and package figures`);
    for (const image of images) {
      const alt = /alt="([^"]*)"/.exec(image);
      assert.ok(alt && alt[1].length > 30, `${file}: ${image.slice(0, 60)} needs a real description`);
    }
  }
});

test("text is measured wide enough and wrapped at sensible places", () => {
  assert.ok(textWidth("中文", 10) === 20);
  assert.ok(textWidth("abc", 10, true) > 18 && textWidth("abc", 10, true) < 19);
  assert.ok(textWidth("WWW", 10) > textWidth("iii", 10));

  assert.deepEqual(wrap("one two three", 1000, 10), ["one two three"]);
  const english = wrap("eval redirected to the Lua bridge", 120, 10);
  assert.ok(english.length > 1);
  assert.equal(english.join(" "), "eval redirected to the Lua bridge");
  for (const line of english) assert.ok(textWidth(line, 10) <= 120 && !line.startsWith(" ") && !line.endsWith(" "));

  // Chinese breaks between characters, never before closing punctuation.
  const chinese = wrap("两个文件共用一个函数作用域，不往全局对象写东西。", 100, 10);
  assert.ok(chinese.length > 1);
  assert.equal(chinese.join(""), "两个文件共用一个函数作用域，不往全局对象写东西。");
  for (const line of chinese) assert.ok(!/^[，。、；：）]/.test(line), `"${line}" starts with punctuation`);

  // A word that cannot fit is an error, not a silent overflow.
  assert.throws(() => wrap("Supercalifragilistic", 40, 10), /cannot be wrapped/);
});
