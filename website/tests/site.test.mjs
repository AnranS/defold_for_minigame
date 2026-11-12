/**
 * Builds the site into a temporary folder and checks what a reader would
 * trip over: missing pages, dead links and anchors, values that disagree with
 * support-matrix.json, and translations that drifted apart.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { readLuaApi } from "../../scripts/lib/lua_api.mjs";
import { buildSite, loadSite, relativeHref, renderSite, repositoryUrl, resolveDocumentLink } from "../build.mjs";
import { home } from "../content/home.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const matrix = JSON.parse(readFileSync(join(REPO_ROOT, "support-matrix.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8"));
const repository = repositoryUrl(pkg);

const EXPECTED_ROUTES = [
  "", "quick-start/", "guide/", "api/", "architecture/", "research/",
  "en/", "en/quick-start/", "en/guide/", "en/api/", "en/architecture/",
];

let outDir;
let pages;

before(() => {
  outDir = mkdtempSync(join(tmpdir(), "defold-minigame-site-"));
  pages = buildSite({ outDir }).pages;
});

after(() => {
  rmSync(outDir, { recursive: true, force: true });
});

function page(route) {
  const found = pages.find((entry) => entry.route === route);
  assert.ok(found, `no page for route "${route}"`);
  return found;
}

function unescape(text) {
  return text.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function attributeValues(html, name) {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, "g"))].map((match) => unescape(match[1]));
}

/** The page with code samples removed, so that sample code is not read as site text. */
function withoutCode(html) {
  return html.replace(/<pre>[\s\S]*?<\/pre>/g, "").replace(/<code[^>]*>[\s\S]*?<\/code>/g, "");
}

function section(html, id) {
  const start = html.indexOf(`<section class="section" id="${id}">`);
  assert.ok(start >= 0, `no section "${id}"`);
  return html.slice(start, html.indexOf("</section>", start));
}

test("there is a page for every document in every language it is written in", () => {
  assert.deepEqual(pages.map((entry) => entry.route).sort(), [...EXPECTED_ROUTES].sort());
  for (const entry of pages) {
    assert.ok(existsSync(join(outDir, entry.route, "index.html")), `${entry.route}index.html was not written`);
  }
  assert.ok(existsSync(join(outDir, "assets", "site.css")));
  assert.ok(existsSync(join(outDir, "assets", "favicon.svg")));
  assert.ok(existsSync(join(outDir, ".nojekyll")));
});

test("every page is a complete document in the right language", () => {
  for (const entry of pages) {
    const { html, route } = entry;
    assert.ok(html.startsWith("<!doctype html>"), route);
    const expected = entry.lang === "zh" ? "zh-CN" : "en";
    assert.ok(html.includes(`<html lang="${expected}">`), `${route}: lang`);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${route}: exactly one h1`);
    const title = /<title>([^<]+)<\/title>/.exec(html);
    assert.ok(title && title[1].includes("Defold Mini Game"), `${route}: title`);
    const description = /<meta name="description" content="([^"]*)"/.exec(html);
    assert.ok(description && description[1].length > 20, `${route}: description`);
    assert.ok(html.includes('<main id="main">'), `${route}: main landmark`);
    assert.ok(!/<script/i.test(html), `${route}: the site ships no client script`);
  }
});

test("nothing unrendered is left in the text of a page", () => {
  for (const entry of pages) {
    const text = withoutCode(entry.html);
    for (const leftover of ["undefined", "[object Object]", "NaN", "\u0000"]) {
      assert.ok(!text.includes(leftover), `${entry.route}: found "${leftover}"`);
    }
    // Markdown that the renderer did not understand shows up as raw markers.
    assert.ok(!/\*\*[^*\s]/.test(text), `${entry.route}: raw bold marker`);
    assert.ok(!/\]\([^)]*\)/.test(text), `${entry.route}: raw link`);
    assert.ok(!/^\s*```/m.test(text), `${entry.route}: raw code fence`);
    if (entry.kind === "home") assert.ok(!/\{[a-zA-Z]+\}/.test(text), `${entry.route}: unfilled placeholder`);
  }
});

test("every internal link, anchor, and asset resolves", () => {
  const idsByFile = new Map();
  const idsOf = (file) => {
    if (!idsByFile.has(file)) idsByFile.set(file, new Set(attributeValues(readFileSync(file, "utf8"), "id")));
    return idsByFile.get(file);
  };
  let checked = 0;
  for (const entry of pages) {
    const from = join(outDir, entry.route);
    for (const href of [...attributeValues(entry.html, "href"), ...attributeValues(entry.html, "src"), ...attributeValues(entry.html, "poster")]) {
      if (/^https?:/.test(href)) continue;
      assert.ok(!href.startsWith("/"), `${entry.route}: "${href}" is tied to the host root; links must be relative`);
      const hash = href.indexOf("#");
      const path = hash < 0 ? href : href.slice(0, hash);
      const fragment = hash < 0 ? "" : decodeURIComponent(href.slice(hash + 1));
      let file = path === "" ? join(from, "index.html") : resolve(from, path);
      assert.ok(file === outDir || file.startsWith(outDir + sep), `${entry.route}: "${href}" leaves the site`);
      if (path.endsWith("/") || path === "") file = path === "" ? file : join(file, "index.html");
      assert.ok(existsSync(file), `${entry.route}: "${href}" points at ${relative(outDir, file)}, which does not exist`);
      if (fragment) assert.ok(idsOf(file).has(fragment), `${entry.route}: "${href}" has no matching id in ${relative(outDir, file)}`);
      checked += 1;
    }
  }
  assert.ok(checked > 200, `only ${checked} links were checked`);
});

test("heading ids are unique within a page", () => {
  for (const entry of pages) {
    const ids = attributeValues(entry.html, "id");
    assert.equal(new Set(ids).size, ids.length, `${entry.route}: duplicate id`);
  }
});

test("links out of the site go to the repository named in package.json", () => {
  let blobs = 0;
  for (const entry of pages) {
    for (const href of attributeValues(entry.html, "href")) {
      if (!href.startsWith("https://github.com/")) continue;
      if (href.startsWith("https://github.com/AnranS/godot_for_minigame")) continue;
      assert.ok(href === repository || href.startsWith(`${repository}/`), `${entry.route}: ${href}`);
      const blob = href.slice(repository.length).match(/^\/blob\/main\/([^#]+)/);
      if (blob) {
        blobs += 1;
        assert.ok(existsSync(join(REPO_ROOT, blob[1])), `${entry.route}: ${blob[1]} is not in the repository`);
      }
    }
    assert.ok(entry.html.includes(`href="${repository}"`), `${entry.route}: no repository link`);
  }
  assert.ok(blobs > 0, "expected at least one link to a repository file");
});

test("the home pages show the values in support-matrix.json", () => {
  const functions = readLuaApi().count;
  for (const route of ["", "en/"]) {
    const { html } = page(route);
    assert.ok(html.includes(`v${matrix.toolVersion}`), `${route}: tool version`);
    assert.ok(html.includes(`<div class="value">${functions}</div>`), `${route}: SDK function count`);
    assert.ok(html.includes(`<div class="value">${Object.keys(matrix.platformContracts).length}</div>`), `${route}: platform count`);

    const platforms = section(html, "platforms");
    for (const platform of Object.values(matrix.platformContracts)) {
      assert.ok(platforms.includes(`<code>${platform.apiNamespace}</code>`), `${route}: ${platform.apiNamespace}`);
      assert.ok(platforms.includes(`<code>${platform.subpackageField}</code>`), `${route}: ${platform.subpackageField}`);
      const limits = platform.packageLimitsBytes;
      assert.ok(platforms.includes(`${limits.main / 1048576} MB / ${limits.total / 1048576} MB`), `${route}: limits`);
      if (platform.minimumClientVersion) assert.ok(platforms.includes(platform.minimumClientVersion), `${route}: client version`);
    }
    assert.equal((platforms.match(/<tr>/g) || []).length, 1 + Object.keys(matrix.platformContracts).length);

    const versions = section(html, "versions");
    for (const engine of matrix.engines) {
      assert.ok(versions.includes(`<code>${engine.defoldVersion}</code>`), `${route}: ${engine.defoldVersion}`);
      assert.ok(versions.includes(`<code>${engine.engineSha1.slice(0, 12)}</code>`), `${route}: sha1`);
    }
    // Newest first.
    const order = matrix.engines.map((engine) => versions.indexOf(`<code>${engine.defoldVersion}</code>`));
    assert.ok(order[0] > order[order.length - 1], `${route}: engines are listed newest first`);
    assert.ok(html.includes(`ABI ${matrix.bridgeAbi}`), `${route}: bridge ABI in the footer`);
  }
});

test("the validation table says only what the matrix records", () => {
  const rows = (html) => [...section(html, "validation").matchAll(/<tr><td><strong>[\s\S]*?<\/tr>/g)].map((match) => match[0]);
  const state = (row) => /class="pill (ok|warn|todo)"/.exec(row)[1];
  const expected = (site) => {
    const platforms = Object.values(site.matrix.platformContracts);
    const level = (field) => {
      const done = platforms.filter((platform) => platform.validation[field] === "verified").length;
      return done === platforms.length ? "ok" : done > 0 ? "warn" : "todo";
    };
    return ["ok", "ok", "ok", "ok", level("devtoolCompile"), level("realDevice")];
  };

  // As released: the page shows what support-matrix.json records, no more.
  for (const route of ["", "en/"]) {
    assert.deepEqual(rows(page(route).html).map(state), expected(loadSite()), route);
  }

  // Recording evidence in the matrix is the only thing that changes the page.
  const site = loadSite();
  site.matrix = structuredClone(site.matrix);
  for (const platform of Object.values(site.matrix.platformContracts)) {
    platform.validation.devtoolCompile = "not-run";
    platform.validation.realDevice = "not-run";
  }
  const render = () => rows(renderSite(site).find((entry) => entry.route === "en/").html).map(state);
  assert.deepEqual(render(), ["ok", "ok", "ok", "ok", "todo", "todo"]);
  site.matrix.platformContracts.douyin.validation.devtoolCompile = "verified";
  assert.deepEqual(render(), ["ok", "ok", "ok", "ok", "warn", "todo"]);
  for (const platform of Object.values(site.matrix.platformContracts)) {
    platform.validation.devtoolCompile = "verified";
    platform.validation.realDevice = "verified";
  }
  assert.deepEqual(render(), ["ok", "ok", "ok", "ok", "ok", "ok"]);
});

test("the home pages list the recorded host runs and show the real screenshots", () => {
  for (const [route, lang] of [["", "zh"], ["en/", "en"]]) {
    const { html } = page(route);
    const validation = section(html, "validation");
    for (const run of matrix.hostRuns) {
      assert.ok(validation.includes(run.date), `${route}: run of ${run.date}`);
      assert.ok(validation.includes(`<code>${run.defoldVersion}</code>`), `${route}: Defold ${run.defoldVersion}`);
      const words = lang === "zh" ? run.zh : run;
      assert.ok(validation.includes(words.result.replace(/&/g, "&amp;")), `${route}: the run's result in ${lang}`);
      if (run.channel !== "stable") assert.ok(validation.includes(`<small>${run.channel}</small>`), `${route}: a pre-release is marked`);
    }
    // Every screenshot the copy lists is shown, with its caption, and is a file in the site.
    const shots = section(html, "screenshots");
    assert.ok(home[lang].shots.length >= 6, `${route}: a gallery, not a pair`);
    for (const shot of home[lang].shots) {
      const figure = new RegExp(`<figure><img src="[./]*screenshots/${shot.file.replace(".", "\\.")}" alt="[^"]+" width="260" height="\\d+" loading="lazy" /><figcaption>([^<]+)</figcaption></figure>`).exec(shots);
      assert.ok(figure, `${route}: ${shot.file}`);
      assert.equal(figure[1], shot.caption.replace(/&/g, "&amp;"), `${route}: caption of ${shot.file}`);
      assert.ok(existsSync(join(outDir, "screenshots", shot.file)), `${shot.file} is in the built site`);
    }
    assert.deepEqual(home.zh.shots.map((shot) => shot.file), home.en.shots.map((shot) => shot.file), "both languages show the same pictures");
    // The versions table says where a level holds when it holds only in part.
    const versions = section(html, "versions");
    for (const engine of matrix.engines) {
      const verified = Object.keys(engine.validation.devtool).filter((name) => engine.validation.devtool[name] === "verified");
      const row = versions.slice(versions.indexOf(`<code>${engine.defoldVersion}</code>`)).split("</tr>")[0];
      const pills = [...row.matchAll(/class="pill (ok|warn|todo)"/g)].map((match) => match[1]);
      assert.equal(pills[1], verified.length === 3 ? "ok" : verified.length > 0 ? "warn" : "todo", `${route}: developer tool for ${engine.defoldVersion}`);
    }
  }
  assert.ok(existsSync(join(outDir, "screenshots", "apitest-wechat-devtools-1.png")));
});

test("a matrix value the copy has no words for stops the build", () => {
  const site = loadSite();
  site.matrix = structuredClone(site.matrix);
  site.matrix.platformContracts.wechat.supportTier = "stable";
  assert.throws(() => renderSite(site), /support tier name for "stable"/);
});

test("the home pages show the demo game: a video that plays without sound, and where its source is", () => {
  for (const [route, lang] of [["", "zh"], ["en/", "en"]]) {
    const demo = section(page(route).html, "demo");
    const video = /<video ([^>]+)>/.exec(demo);
    assert.ok(video, `${route}: no video in the demo section`);
    const attributes = video[1];
    assert.match(attributes, /src="[./]*videos\/island\.mp4"/);
    assert.match(attributes, /poster="[./]*videos\/island-poster\.png"/);
    // Browsers only start a video by themselves when it is muted, and phones only inline with playsinline.
    for (const flag of ["controls", "muted", "loop", "playsinline"]) assert.ok(new RegExp(`\\b${flag}\\b`).test(attributes), `${route}: ${flag}`);
    assert.match(attributes, /preload="metadata"/, "the page does not download the whole video before anyone asks for it");
    assert.match(attributes, /aria-label="[^"]{12,}"/, "the video says what it shows");
    assert.match(attributes, /width="\d+" height="\d+"/, "the video has a size before it loads");
    assert.ok(demo.includes(`href="${loadSite().repository}/tree/main/demo/island"`), `${route}: no link to the demo's source`);
    assert.ok(home[lang].demoPoints.length >= 3);
    for (const point of home[lang].demoPoints) assert.ok(demo.includes(point.split("{")[0].slice(0, 12)), `${route}: ${point}`);
  }
  for (const file of ["island.mp4", "island-poster.png"]) {
    assert.ok(existsSync(join(outDir, "videos", file)), `${file} is in the built site`);
  }
  const size = readFileSync(join(outDir, "videos", "island.mp4")).length;
  assert.ok(size > 100 * 1024 && size < 4 * 1024 * 1024, `the video is ${size} bytes`);
});

test("the two languages have the same structure", () => {
  const outline = (html) => [...html.matchAll(/<section class="[^"]*" id="([^"]+)">/g)].map((match) => match[1]);
  assert.deepEqual(outline(page("").html), outline(page("en/").html));
  assert.ok(outline(page("").html).length >= 8);

  const count = (html, pattern) => (html.match(pattern) || []).length;
  for (const id of ["quick-start", "guide", "api"]) {
    const zh = page(`${id}/`).html;
    const en = page(`en/${id}/`).html;
    for (const [what, pattern] of [["h2", /<h2 /g], ["h3", /<h3 /g], ["code block", /<pre>/g], ["table", /<table>/g], ["callout", /class="callout /g]]) {
      assert.equal(count(zh, pattern), count(en, pattern), `${id}: the translations differ in the number of ${what}s`);
    }
  }
});

test("the language switch leads to the same page in the other language", () => {
  assert.ok(page("").html.includes('<a href="en/" lang="en" hreflang="en">English</a>'));
  assert.ok(page("en/").html.includes('<a href="../" lang="zh-CN" hreflang="zh-CN">中文</a>'));
  assert.ok(page("guide/").html.includes('<a href="../en/guide/" lang="en" hreflang="en">English</a>'));
  assert.ok(page("en/guide/").html.includes('<a href="../../guide/" lang="zh-CN" hreflang="zh-CN">中文</a>'));
  // The research notes exist in Chinese only: no switch, and English pages say so.
  assert.ok(!page("research/").html.includes("hreflang="));
  assert.ok(page("en/").html.includes('<a href="../research/">Research (中文)</a>'));
});

test("the current page is marked in the navigation", () => {
  assert.equal((page("").html.match(/aria-current="page"/g) || []).length, 0);
  for (const route of ["guide/", "en/api/", "research/"]) {
    const marks = page(route).html.match(/<a href="\.\/" aria-current="page">/g) || [];
    assert.equal(marks.length, 2, `${route}: marked in the header and in the sidebar`);
  }
});

test("the SDK sample on the home page is the one in the quick start", () => {
  for (const [home, quickStart] of [["", "quick-start/"], ["en/", "en/quick-start/"]]) {
    const sample = /<pre><code class="language-lua">([\s\S]*?)<\/code><\/pre>/.exec(section(page(home).html, "sdk"));
    assert.ok(sample, `${home}: no Lua sample`);
    assert.ok(sample[1].includes("minigame.login("));
    assert.ok(page(quickStart).html.includes(sample[1]), `${home}: sample differs from the quick start`);
  }
});

test("the built site carries the figures and the platform logos", () => {
  const images = readdirSync(join(outDir, "images")).sort();
  assert.deepEqual(images, [
    "architecture-en.svg", "architecture-zh.svg", "banner-en.svg", "banner-zh.svg",
    "bridge-en.svg", "bridge-zh.svg", "package-en.svg", "package-zh.svg",
  ]);
  for (const key of Object.keys(matrix.platformContracts)) {
    assert.ok(existsSync(join(outDir, "assets", "logos", `${key}.svg`)), `logo for ${key}`);
  }
});

test("the home pages show the figures and the export example in their own language", () => {
  for (const [route, lang, quickStart] of [["", "zh", "quick-start/"], ["en/", "en", "en/quick-start/"]]) {
    const { html } = page(route);
    const other = lang === "zh" ? "en" : "zh";
    for (const [name, sectionId] of [["banner", "overview"], ["package", "package"], ["architecture", "how-it-works"], ["bridge", "sdk"]]) {
      const image = new RegExp(`<img src="[./]*images/${name}-${lang}\\.svg" alt="([^"]+)" width="1200" height="\\d+"`).exec(section(html, sectionId));
      assert.ok(image, `${route}: the ${name} figure in section ${sectionId}`);
      assert.ok(image[1].length > 60, `${route}: the ${name} figure needs a description`);
    }
    assert.ok(!html.includes(`-${other}.svg`), `${route}: a figure in the other language`);

    // The terminal quotes the quick start, so the two cannot disagree.
    const terminal = /<figure class="terminal"[\s\S]*?<\/figure>/.exec(html);
    assert.ok(terminal, `${route}: no terminal`);
    assert.ok(terminal[0].includes('<span class="prompt">$ </span>node bin/defold-minigame.mjs export'));
    const output = /<span class="output">([\s\S]*?)<\/span>/.exec(terminal[0])[1];
    assert.ok(output.startsWith("Exported MyGame"));
    assert.ok(page(quickStart).html.includes(output), `${route}: the terminal output differs from the quick start`);
    assert.ok(/<figcaption>[^<]*1\.14\.1[^<]*<\/figcaption>/.test(terminal[0]), `${route}: the caption says where the figures come from`);

    const chips = /<ul class="platform-chips"[\s\S]*?<\/ul>/.exec(html)[0];
    assert.equal((chips.match(/<li>/g) || []).length, Object.keys(matrix.platformContracts).length);
    assert.equal((section(html, "features").match(/<span class="icon" aria-hidden="true">/g) || []).length, 4);
    assert.equal((section(html, "platforms").match(/assets\/logos\//g) || []).length, Object.keys(matrix.platformContracts).length);
  }
});

test("a document shows figures in the reader's language, also when it is written once for both", () => {
  assert.ok(page("guide/").html.includes('<img src="../images/package-zh.svg"'));
  assert.ok(page("en/guide/").html.includes('<img src="../../images/package-en.svg"'));
  // docs/ARCHITECTURE.md is one file for both languages and names the English figures.
  assert.ok(page("architecture/").html.includes('<img src="../images/architecture-zh.svg"'));
  assert.ok(page("architecture/").html.includes('<img src="../images/bridge-zh.svg"'));
  assert.ok(page("en/architecture/").html.includes('<img src="../../images/architecture-en.svg"'));
});

test("every image says what it shows, or is marked as decoration", () => {
  for (const entry of pages) {
    for (const [image] of entry.html.matchAll(/<img\s[^>]*>/g)) {
      const alt = /\salt="([^"]*)"/.exec(image);
      assert.ok(alt, `${entry.route}: ${image} has no alt attribute`);
      // Logos sit next to the platform's name, so they are decoration.
      if (image.includes("assets/logos/")) assert.equal(alt[1], "", `${entry.route}: a logo repeats the name next to it`);
      // A sentence in Chinese has far fewer characters than the same one in English.
      else assert.ok(alt[1].length > 15, `${entry.route}: ${image.slice(0, 70)} needs a description`);
    }
  }
});

test("document links are rewritten for the site", () => {
  const site = { repository };
  const zh = { source: "docs/USAGE_zh.md", route: "guide/", lang: "zh", site };
  const en = { source: "docs/USAGE.md", route: "en/guide/", lang: "en", site };
  assert.equal(resolveDocumentLink("API_zh.md", zh), "../api/");
  assert.equal(resolveDocumentLink("API.md", en), "../api/");
  assert.equal(resolveDocumentLink("QUICK_START_zh.md#准备", zh), "../quick-start/#准备");
  assert.equal(resolveDocumentLink("ARCHITECTURE.md", zh), "../architecture/");
  assert.equal(resolveDocumentLink("ARCHITECTURE.md", en), "../architecture/");
  assert.equal(resolveDocumentLink("RESEARCH_zh.md", en), "../../research/");
  assert.equal(resolveDocumentLink("../support-matrix.json", en), `${repository}/blob/main/support-matrix.json`);
  assert.equal(resolveDocumentLink("images/package-zh.svg", zh), "../images/package-zh.svg");
  assert.equal(resolveDocumentLink("images/package-en.svg", en), "../../images/package-en.svg");
  const shared = { source: "docs/ARCHITECTURE.md", route: "architecture/", lang: "zh", site };
  assert.equal(resolveDocumentLink("images/bridge-en.svg", shared), "../images/bridge-zh.svg");
  assert.throws(() => resolveDocumentLink("images/missing.svg", en), /not a file in the repository/);
  assert.equal(resolveDocumentLink("#8-audio", en), "#8-audio");
  assert.equal(resolveDocumentLink("https://example.com/a", en), "https://example.com/a");
  assert.throws(() => resolveDocumentLink("MISSING.md", en), /not a file in the repository/);
  assert.throws(() => resolveDocumentLink("../../outside.md", en), /not a file in the repository/);
});

test("relative addresses between routes", () => {
  assert.equal(relativeHref("", ""), "./");
  assert.equal(relativeHref("", "guide/"), "guide/");
  assert.equal(relativeHref("guide/", ""), "../");
  assert.equal(relativeHref("guide/", "api/"), "../api/");
  assert.equal(relativeHref("en/guide/", "research/"), "../../research/");
  assert.equal(relativeHref("en/", "en/guide/"), "guide/");
});

test("the repository address comes from package.json", () => {
  assert.equal(repositoryUrl({ repository: { url: "git+https://github.com/a/b.git" } }), "https://github.com/a/b");
  assert.equal(repositoryUrl({ repository: "https://github.com/a/b" }), "https://github.com/a/b");
  assert.throws(() => repositoryUrl({}), /no repository field/);
});

test("the build refuses to empty a folder that holds the project", () => {
  assert.throws(() => buildSite({ outDir: REPO_ROOT }), /refusing to build/);
  assert.throws(() => buildSite({ outDir: join(REPO_ROOT, "website") }), /refusing to build/);
  assert.throws(() => buildSite({ outDir: dirname(REPO_ROOT) }), /refusing to build/);
});
