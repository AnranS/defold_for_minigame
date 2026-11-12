#!/usr/bin/env node
/**
 * Builds the documentation site into website/dist, or into --out <folder>.
 *
 * The output is static HTML, one stylesheet, and images; there is no client
 * script. Nothing on a page is typed twice:
 *   - docs/*.md                      become the documentation pages
 *   - support-matrix.json            supplies versions, platforms, validation levels
 *   - minigame/minigame.lua          supplies the number of SDK functions
 *   - scripts/generate_diagrams.mjs  draws the figures, in both languages
 *   - package.json                   supplies the repository address
 * Every link is relative, so the site works under any path prefix.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { IMAGE_DIRECTORY, REFERENCE_SIZES, renderFigures } from "../scripts/generate_diagrams.mjs";
import { readLuaApi } from "../scripts/lib/lua_api.mjs";
import { chrome, DOCUMENTS, LANGUAGES, SITE_NAME } from "./content/chrome.mjs";
import { home } from "./content/home.mjs";
import { escapeHtml, renderMarkdown } from "./lib/markdown.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const DEFAULT_BRANCH = "main";
/** How wide a screenshot is shown, in CSS pixels. The files are twice that or more. */
const SCREENSHOT_WIDTH = 260;

/** Width and height of a PNG file, read from its header. */
function pngSize(path) {
  const header = readFileSync(path).subarray(0, 24);
  if (header.toString("latin1", 1, 4) !== "PNG") throw new Error(`${path} is not a PNG file`);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

// ── site data ────────────────────────────────────────────────────────────────

function readRepoFile(path) {
  return readFileSync(join(REPO_ROOT, path), "utf8");
}

/** package.json's repository field as a browsable https address. */
export function repositoryUrl(pkg) {
  const raw = typeof pkg.repository === "string" ? pkg.repository : pkg.repository && pkg.repository.url;
  if (!raw) throw new Error("package.json has no repository field; the site links to the repository");
  return raw.replace(/^git\+/, "").replace(/\.git$/, "");
}

export function loadSite() {
  const matrix = JSON.parse(readRepoFile("support-matrix.json"));
  const pkg = JSON.parse(readRepoFile("package.json"));
  const api = readLuaApi();
  const mainLimits = new Set(Object.values(matrix.platformContracts).map((platform) => platform.packageLimitsBytes.main));
  if (mainLimits.size !== 1) throw new Error("the site copy assumes one main-package limit for every platform");
  return {
    matrix,
    api,
    figures: renderFigures(matrix),
    repository: repositoryUrl(pkg),
    values: {
      version: matrix.toolVersion,
      abi: String(matrix.bridgeAbi),
      platforms: String(Object.keys(matrix.platformContracts).length),
      functions: String(api.count),
      mainLimit: megabytes([...mainLimits][0]),
      referenceDefold: REFERENCE_SIZES.defoldVersion,
    },
  };
}

/** How far a platform has come: "simulated", "devtool", or "device". */
function platformStage(platform) {
  const validation = platform.validation;
  if (validation.devtoolCompile !== "verified") return "simulated";
  return validation.realDevice === "verified" ? "device" : "devtool";
}

function megabytes(bytes) {
  const value = bytes / (1024 * 1024);
  return `${Number.isInteger(value) ? value : value.toFixed(1)} MB`;
}

/** Replaces {name} with a site value, and fails on a name nobody defined. */
function fill(text, values) {
  return text.replace(/\{([a-zA-Z]+)\}/g, (match, key) => {
    if (!(key in values)) throw new Error(`unknown placeholder ${match} in site copy`);
    return values[key];
  });
}

/** A lookup that fails loudly, so a new matrix value cannot print "undefined". */
function pick(table, key, what) {
  if (!table || !(key in table)) throw new Error(`the site copy has no ${what} for "${key}"`);
  return table[key];
}

// ── routes ───────────────────────────────────────────────────────────────────

function homeRoute(lang) {
  return LANGUAGES[lang].prefix;
}

/** The language of the page that serves a document for readers of `lang`. */
function documentLanguage(doc, lang) {
  return doc.source[lang] ? lang : Object.keys(doc.source)[0];
}

function documentRoute(doc, lang) {
  return `${LANGUAGES[documentLanguage(doc, lang)].prefix}${doc.id}/`;
}

/** A relative address from one route (a folder) to another. */
export function relativeHref(from, to) {
  const path = posix.relative(from || ".", to || ".");
  return path === "" ? "./" : `${path}/`;
}

// ── page shell ───────────────────────────────────────────────────────────────

function layout({ lang, route, title, description, body, current, alternates, site }) {
  const t = chrome[lang];
  const link = (to) => relativeHref(route, to);
  const navigation = DOCUMENTS.map((doc) => {
    const marker = current === doc.id ? ' aria-current="page"' : "";
    return `<a href="${link(documentRoute(doc, lang))}"${marker}>${escapeHtml(doc.nav[lang])}</a>`;
  });
  const languageLinks = Object.keys(LANGUAGES)
    .filter((other) => other !== lang && alternates[other] !== undefined)
    .map((other) => {
      const code = LANGUAGES[other].htmlLang;
      return `<a href="${link(alternates[other])}" lang="${code}" hreflang="${code}">${escapeHtml(LANGUAGES[other].label)}</a>`;
    });
  const version = fill(t.footerVersion, site.values);

  return `<!doctype html>
<html lang="${LANGUAGES[lang].htmlLang}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}" />
<meta name="color-scheme" content="dark" />
<link rel="icon" type="image/svg+xml" href="${link("")}assets/favicon.svg" />
<link rel="stylesheet" href="${link("")}assets/site.css" />
</head>
<body>
<a class="skip-link" href="#main">${escapeHtml(t.skip)}</a>
<header class="site-header">
  <div class="nav-shell">
    <a class="brand" href="${link(homeRoute(lang))}"><span class="brand-mark" aria-hidden="true"></span>${escapeHtml(SITE_NAME)}</a>
    <nav class="nav-links" aria-label="${escapeHtml(t.navLabel)}">
      ${navigation.join("\n      ")}
    </nav>
    <div class="nav-meta">
      ${[...languageLinks, `<a href="${escapeHtml(site.repository)}" rel="noopener">${escapeHtml(t.github)}</a>`].join("\n      ")}
    </div>
  </div>
</header>
<main id="main">
${body}
</main>
<footer class="site-footer">
  <div class="container">
    <p>${t.footer.map(escapeHtml).join(" ")}</p>
    <p>${escapeHtml(version)} · <a href="${escapeHtml(site.repository)}" rel="noopener">${escapeHtml(site.repository.replace(/^https?:\/\//, ""))}</a></p>
  </div>
</footer>
</body>
</html>
`;
}

// ── documentation pages ──────────────────────────────────────────────────────

function splitFragment(href) {
  const index = href.indexOf("#");
  return index < 0 ? [href, ""] : [href.slice(0, index), href.slice(index)];
}

/**
 * Turns a link written for the repository into one that works on the site: a
 * document the site renders becomes its page, any other repository file
 * becomes its address on the code host.
 */
export function resolveDocumentLink(href, { source, route, lang, site }) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) return href;
  const [path, fragment] = splitFragment(href);
  const target = posix.normalize(posix.join(posix.dirname(source), path));
  if (target.startsWith("..") || !existsSync(join(REPO_ROOT, target))) {
    throw new Error(`${source} links to ${href}, which is not a file in the repository`);
  }
  if (target.startsWith("docs/screenshots/")) {
    return `${relativeHref(route, "")}screenshots/${target.slice("docs/screenshots/".length)}`;
  }
  if (target.startsWith(`${IMAGE_DIRECTORY}/`)) {
    let file = target.slice(IMAGE_DIRECTORY.length + 1);
    // A document written once for both languages shows each reader the
    // figure in their own language when there is one.
    const shared = DOCUMENTS.some((entry) => Object.values(entry.source).filter((path) => path === source).length > 1);
    const translated = file.replace(/-(zh|en)\.svg$/, `-${lang}.svg`);
    if (shared && existsSync(join(REPO_ROOT, IMAGE_DIRECTORY, translated))) file = translated;
    return `${relativeHref(route, "")}images/${file}`;
  }
  const doc = DOCUMENTS.find((entry) => Object.values(entry.source).includes(target));
  if (!doc) return `${site.repository}/blob/${DEFAULT_BRANCH}/${target}${fragment}`;
  // A file shared by both languages keeps the reader in the current one.
  const targetLang = doc.source[lang] === target ? lang : Object.keys(doc.source).find((key) => doc.source[key] === target);
  return `${relativeHref(route, `${LANGUAGES[targetLang].prefix}${doc.id}/`)}${fragment}`;
}

/** The first plain paragraph of a document, for the page description. */
function firstParagraph(markdown) {
  let inFence = false;
  for (const line of markdown.split("\n")) {
    const text = line.trim();
    if (text.startsWith("```")) { inFence = !inFence; continue; }
    if (inFence || text === "" || /^(#|>|\||<!--|[-*]\s|\d+\.\s)/.test(text)) continue;
    const plain = text.replace(/`/g, "").replace(/\*\*/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
    return plain.length > 200 ? `${plain.slice(0, 197)}...` : plain;
  }
  return "";
}

function renderDocument(doc, lang, site) {
  const t = chrome[lang];
  const source = doc.source[lang];
  const route = documentRoute(doc, lang);
  const markdown = readRepoFile(source);
  const headings = [];
  const article = renderMarkdown(markdown, {
    headings,
    resolveLink: (href) => resolveDocumentLink(href, { source, route, lang, site }),
  });
  const top = headings.find((heading) => heading.level === 1);
  if (!top) throw new Error(`${source} has no level-1 heading; the page needs a title`);

  const documentLinks = DOCUMENTS.map((entry) => {
    const marker = entry.id === doc.id ? ' aria-current="page"' : "";
    return `<li><a href="${relativeHref(route, documentRoute(entry, lang))}"${marker}>${escapeHtml(entry.nav[lang])}</a></li>`;
  });
  const pageLinks = headings
    .filter((heading) => heading.level === 2 || heading.level === 3)
    .map((heading) => `<li class="depth-${heading.level}"><a href="#${escapeHtml(heading.slug)}">${escapeHtml(heading.text)}</a></li>`);

  const body = `<div class="container docs">
  <aside class="docs-nav" aria-label="${escapeHtml(t.docsLabel)}">
    <p class="group">${escapeHtml(t.docsGroup)}</p>
    <ul>
      ${documentLinks.join("\n      ")}
    </ul>
    <p class="group">${escapeHtml(t.pageGroup)}</p>
    <ul>
      ${pageLinks.join("\n      ")}
    </ul>
  </aside>
  <article class="prose">
${article}
  </article>
</div>`;

  const alternates = {};
  for (const other of Object.keys(LANGUAGES)) {
    if (doc.source[other]) alternates[other] = `${LANGUAGES[other].prefix}${doc.id}/`;
  }
  return {
    route,
    lang,
    kind: "document",
    id: doc.id,
    source,
    html: layout({
      lang, route, site, body, alternates,
      current: doc.id,
      title: `${top.text} · ${t.titleSuffix}`,
      description: firstParagraph(markdown),
    }),
  };
}

// ── home page ────────────────────────────────────────────────────────────────

function compareVersions(a, b) {
  const left = a.split(".").map(Number);
  const right = b.split(".").map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] || 0) - (right[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The first fenced block of a language in a document, without its list indentation. */
function firstCodeBlock(markdown, language) {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === `\`\`\`${language}`);
  if (start < 0) throw new Error(`no ${language} code block to show on the home page`);
  const indent = lines[start].search(/\S/);
  const body = [];
  for (let index = start + 1; index < lines.length && lines[index].trim() !== "```"; index += 1) {
    body.push(lines[index].slice(Math.min(indent, lines[index].search(/\S|$/))));
  }
  return body.join("\n");
}

/** The export command and what it prints, as the quick start shows them. */
function exportExample(markdown) {
  const command = firstCodeBlock(markdown, "bash").split("\n");
  const start = command.findIndex((line) => line.startsWith("node bin/defold-minigame.mjs export"));
  const output = firstCodeBlock(markdown, "text");
  if (start < 0 || !output.startsWith("Exported ")) {
    throw new Error("the quick start no longer shows the export command and its output; the home page quotes them");
  }
  return { command: command.slice(start).join("\n"), output };
}

const ICONS = {
  export: '<path d="M12 3v11"/><path d="M8 7l4-4 4 4"/><path d="M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"/>',
  layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 12.5l9 5 9-5"/><path d="M3 17l9 5 9-5"/>',
  code: '<path d="M8 7l-5 5 5 5"/><path d="M16 7l5 5-5 5"/><path d="M13.5 4l-3 16"/>',
  repeat: '<path d="M4 11a8 8 0 0 1 14-4l2 2"/><path d="M20 4v5h-5"/><path d="M20 13a8 8 0 0 1-14 4l-2-2"/><path d="M4 20v-5h5"/>',
};

function icon(name) {
  const shape = pick(ICONS, name, "icon");
  return `<span class="icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${shape}</svg></span>`;
}

/** A figure drawn by scripts/generate_diagrams.mjs, in the page's language. */
function figure(site, name, lang, route, { eager = false } = {}) {
  const drawn = site.figures.find((entry) => entry.name === name && entry.lang === lang);
  if (!drawn) throw new Error(`there is no figure "${name}" in ${lang}`);
  return `<figure class="figure"><img src="${relativeHref(route, "")}images/${drawn.file}" alt="${escapeHtml(drawn.description)}" width="${drawn.width}" height="${drawn.height}"${eager ? "" : ' loading="lazy"'} /></figure>`;
}

function platformLogo(key, route) {
  if (!existsSync(join(HERE, "assets", "logos", `${key}.svg`))) throw new Error(`website/assets/logos has no logo for "${key}"`);
  return `<img src="${relativeHref(route, "")}assets/logos/${key}.svg" alt="" width="20" height="20" />`;
}

function table(headers, rows, modifier = "") {
  return `<div class="table-wrap${modifier ? ` ${modifier}` : ""}"><table>
<thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("")}</tr></thead>
<tbody>
${rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("\n")}
</tbody>
</table></div>`;
}

function sectionHead(kicker, title, lead) {
  return `<p class="section-kicker">${escapeHtml(kicker)}</p>
    <h2>${escapeHtml(title)}</h2>${lead ? `\n    <p class="section-lead">${escapeHtml(lead)}</p>` : ""}`;
}

/**
 * How far a validation level has come, read from the matrix: "all", "some",
 * or "none" of the entries that carry it are verified. A level that is kept
 * per platform counts once for each platform.
 */
function progress(entries, fields) {
  const states = entries.flatMap((entry) => fields.flatMap((field) => {
    if (!(field in entry.validation)) throw new Error(`support-matrix.json: missing validation.${field}`);
    const value = entry.validation[field];
    return (typeof value === "object" ? Object.values(value) : [value]).map((state) => state === "verified");
  }));
  if (states.every(Boolean)) return "all";
  return states.some(Boolean) ? "some" : "none";
}

/** The platforms on which a per-platform level is verified, by their short names. */
function verifiedPlatforms(level, names) {
  return Object.keys(level).filter((key) => level[key] === "verified").map((key) => pick(names, key, "short platform name"));
}

function renderHome(lang, site) {
  const t = home[lang];
  const route = homeRoute(lang);
  const link = (id) => relativeHref(route, documentRoute(DOCUMENTS.find((doc) => doc.id === id), lang));
  const text = (value) => escapeHtml(fill(value, site.values));
  const platforms = Object.entries(site.matrix.platformContracts);
  const engines = [...site.matrix.engines].sort((a, b) => compareVersions(b.defoldVersion, a.defoldVersion));

  const pill = (state) => {
    if (state === "all") return `<span class="pill ok">${escapeHtml(t.verified)}</span>`;
    if (state === "some") return `<span class="pill warn">${escapeHtml(t.partial)}</span>`;
    return `<span class="pill todo">${escapeHtml(t.notRun)}</span>`;
  };

  const platformRows = platforms.map(([key, platform]) => {
    const limits = platform.packageLimitsBytes;
    const client = platform.minimumClientVersion
      ? `<br /><small>${escapeHtml(t.minimumClient.replace("{client}", platform.minimumClientVersion))}</small>`
      : "";
    return [
      `<span class="platform-name">${platformLogo(key, route)}${escapeHtml(pick(t.platformNames, key, "platform name"))}</span>${client}`,
      `<code>${escapeHtml(platform.apiNamespace)}</code>`,
      `<code>${escapeHtml(platform.subpackageField)}</code>`,
      `${megabytes(limits.main)} / ${megabytes(limits.total)}`,
      escapeHtml(pick(t.persistence, platform.defaults.persistence, "save backend name")),
      escapeHtml(platform.defaults.engineAudio ? t.audio.on : t.audio.off),
      `<span class="pill warn">${escapeHtml(pick(t.tier, platform.supportTier, "support tier name"))}</span>`
        + ` <small>${escapeHtml(pick(t.platformStatus, platformStage(platform), "platform status"))}</small>`,
    ];
  });

  // A level kept per platform says where it holds when it holds only in part.
  const perPlatform = (level) => {
    const where = verifiedPlatforms(level, t.platformShort);
    const state = progress([{ validation: { level } }], ["level"]);
    return state === "some" ? `${pill(state)} <small>${escapeHtml(where.join(t.listSeparator))}</small>` : pill(state);
  };
  const engineRows = engines.map((engine) => [
    `<code>${escapeHtml(engine.defoldVersion)}</code>`,
    `<code>${escapeHtml(engine.engineSha1.slice(0, 12))}</code>`,
    escapeHtml(pick(t.generation, engine.loaderGeneration, "loader design name")),
    pill(progress([engine], ["staticContract", "wasmFeatureScan"])),
    perPlatform(engine.validation.devtool),
    perPlatform(engine.validation.realDevice),
  ]);

  // The four finished levels are what the test suite and verify_engine.mjs
  // do; the three open ones are read from the matrix so that this table
  // changes when, and only when, the evidence is recorded there.
  const evidence = {
    automated: `<span class="pill ok">${escapeHtml(t.automated)}</span>`,
    static: pill(progress(engines, ["staticContract", "wasmFeatureScan"])),
    devtool: pill(progress(platforms.map(([, platform]) => platform), ["devtoolCompile"])),
    device: pill(progress(platforms.map(([, platform]) => platform), ["realDevice"])),
  };
  const validationRows = t.validation.map(([level, what, key]) => [
    `<strong>${escapeHtml(level)}</strong>`,
    escapeHtml(what),
    pick(evidence, key, "validation level"),
  ]);

  // What was actually run in a host, newest first, as the matrix records it.
  const runRows = [...(site.matrix.hostRuns || [])].sort((a, b) => b.date.localeCompare(a.date)).map((run) => [
    escapeHtml(run.date),
    `${escapeHtml(pick(t.platformShort, run.platform, "short platform name"))}<br /><small>${escapeHtml(run.host)}</small>`,
    `<code>${escapeHtml(run.defoldVersion)}</code>${run.channel === "stable" ? "" : ` <small>${escapeHtml(run.channel)}</small>`}`,
    `${escapeHtml((lang === "zh" && run.zh ? run.zh : run).bundle)}<br /><small>${escapeHtml((lang === "zh" && run.zh ? run.zh : run).result)}</small>`,
  ]);
  // Real frames from a developer tool's simulator, each with what it shows.
  const screenshots = t.shots.map((shot) => {
    const file = join(REPO_ROOT, "docs", "screenshots", shot.file);
    if (!existsSync(file)) throw new Error(`docs/screenshots/${shot.file} is missing`);
    const size = pngSize(file);
    const height = Math.round((SCREENSHOT_WIDTH * size.height) / size.width);
    return `<figure><img src="${relativeHref(route, "")}screenshots/${shot.file}" alt="${escapeHtml(shot.caption)}" width="${SCREENSHOT_WIDTH}" height="${height}" loading="lazy" />`
      + `<figcaption>${escapeHtml(shot.caption)}</figcaption></figure>`;
  });

  const quickStart = readRepoFile(DOCUMENTS.find((doc) => doc.id === "quick-start").source[lang]);
  const snippet = firstCodeBlock(quickStart, "lua");
  const example = exportExample(quickStart);
  const chips = platforms.map(([key]) => `<li>${platformLogo(key, route)}${escapeHtml(pick(t.platformNames, key, "platform name"))}</li>`);

  const body = `<section class="hero">
  <div class="container">
    <div class="hero-grid">
      <div class="hero-copy">
        <p class="kicker">${text(t.kicker)}</p>
        <h1>${t.heading}</h1>
        <p class="lead">${text(t.lead)}</p>
        <div class="cta-row">
          <a class="button primary" href="${link("quick-start")}">${text(t.primary)}</a>
          <a class="button" href="${link("guide")}">${text(t.secondary)}</a>
        </div>
        <ul class="platform-chips" aria-label="${text(t.platformsLabel)}">
          ${chips.join("\n          ")}
        </ul>
      </div>
      <figure class="terminal" aria-label="${text(t.terminalLabel)}">
        <div class="terminal-bar" aria-hidden="true"><i></i><i></i><i></i></div>
        <pre><code><span class="prompt">$ </span>${escapeHtml(example.command)}
<span class="output">${escapeHtml(example.output)}</span></code></pre>
        <figcaption>${text(t.terminalCaption)}</figcaption>
      </figure>
    </div>
    <p class="notice">${t.notice}</p>
  </div>
</section>

<section class="section" id="overview">
  <div class="container">
    ${figure(site, "banner", lang, route, { eager: true })}
  </div>
</section>

<section class="section" id="at-a-glance">
  <div class="container">
    <div class="grid four">
      ${t.stats.map((stat) => `<div class="card stat"><div class="value">${text(stat.value)}</div><div class="label">${text(stat.label)}</div></div>`).join("\n      ")}
    </div>
  </div>
</section>

<section class="section" id="features">
  <div class="container">
    ${sectionHead(t.featuresKicker, t.featuresTitle, t.featuresLead)}
    <div class="grid two">
      ${t.features.map((feature) => `<div class="card">${icon(feature.icon)}<h3>${text(feature.title)}</h3><p>${text(feature.body)}</p></div>`).join("\n      ")}
    </div>
  </div>
</section>

<section class="section" id="platforms">
  <div class="container">
    ${sectionHead(t.platformsKicker, t.platformsTitle, t.platformsLead)}
    ${table(t.platformHeaders, platformRows, "wide")}
  </div>
</section>

<section class="section" id="versions">
  <div class="container">
    ${sectionHead(t.versionsKicker, t.versionsTitle, t.versionsLead)}
    ${table(t.versionHeaders, engineRows, "wide")}
  </div>
</section>

<section class="section" id="workflow">
  <div class="container">
    ${sectionHead(t.workflowKicker, t.workflowTitle)}
    <div class="grid four steps">
      ${t.workflow.map((step) => `<div class="card"><h3>${text(step.title)}</h3><p>${text(step.body)}</p></div>`).join("\n      ")}
    </div>
  </div>
</section>

<section class="section" id="package">
  <div class="container">
    ${sectionHead(t.packageKicker, t.packageTitle, fill(t.packageLead, site.values))}
    ${figure(site, "package", lang, route)}
  </div>
</section>

<section class="section" id="how-it-works">
  <div class="container">
    ${sectionHead(t.architectureKicker, t.architectureTitle, t.architectureLead)}
    ${figure(site, "architecture", lang, route)}
    <p class="more"><a href="${link("architecture")}">${escapeHtml(DOCUMENTS.find((doc) => doc.id === "architecture").nav[lang])} →</a></p>
  </div>
</section>

<section class="section" id="sdk">
  <div class="container">
    ${sectionHead(t.sdkKicker, t.sdkTitle, fill(t.sdkLead, site.values))}
    <pre><code class="language-lua">${escapeHtml(snippet)}</code></pre>
    <p class="more"><a href="${link("api")}">${text(t.sdkLink)} →</a></p>
    <h3 class="figure-title">${text(t.bridgeTitle)}</h3>
    ${figure(site, "bridge", lang, route)}
  </div>
</section>

<section class="section" id="validation">
  <div class="container">
    ${sectionHead(t.validationKicker, t.validationTitle)}
    ${table(t.validationHeaders, validationRows)}
    <h3 class="figure-title">${text(t.runsTitle)}</h3>
    ${table(t.runHeaders, runRows, "wide")}
    <p class="section-lead runs-note">${text(t.runsNote)}</p>
  </div>
</section>

<section class="section" id="demo">
  <div class="container">
    ${sectionHead(t.demoKicker, t.demoTitle, fill(t.demoLead, site.values))}
    <div class="demo">
      <video src="${relativeHref(route, "")}videos/island.mp4" poster="${relativeHref(route, "")}videos/island-poster.png" width="780" height="1688" controls muted loop playsinline preload="metadata" aria-label="${escapeHtml(t.demoVideoLabel)}"></video>
      <div class="demo-notes">
        <ul>
          ${t.demoPoints.map((point) => `<li>${text(fill(point, site.values))}</li>`).join("\n          ")}
        </ul>
        <p class="more"><a href="${escapeHtml(site.repository)}/tree/main/demo/island" rel="noopener">${text(t.demoLink)} →</a></p>
      </div>
    </div>
  </div>
</section>

<section class="section" id="screenshots">
  <div class="container">
    ${sectionHead(t.screenshotsKicker, t.screenshotsTitle, fill(t.screenshotsLead, site.values))}
    <div class="screenshots">
      ${screenshots.join("\n      ")}
    </div>
    <p class="section-lead runs-note">${text(t.shotsNote)}</p>
  </div>
</section>

<section class="section" id="faq">
  <div class="container">
    <h2>${text(t.faqTitle)}</h2>
    <div class="grid two faq">
      ${t.faq.map(([question, answer]) => `<div class="card"><h3>${text(question)}</h3><p>${text(answer)}</p></div>`).join("\n      ")}
    </div>
  </div>
</section>

<section class="final-cta">
  <div class="container">
    <h2>${text(t.finalTitle)}</h2>
    <p>${text(t.finalLead)}</p>
    <div class="cta-row">
      <a class="button primary" href="${link("quick-start")}">${text(t.primary)}</a>
      <a class="button" href="${escapeHtml(site.repository)}" rel="noopener">${escapeHtml(chrome[lang].github)}</a>
    </div>
  </div>
</section>`;

  const alternates = {};
  for (const other of Object.keys(LANGUAGES)) alternates[other] = homeRoute(other);
  return {
    route,
    lang,
    kind: "home",
    id: "home",
    html: layout({
      lang, route, site, body, alternates,
      current: "home",
      title: fill(t.title, site.values),
      description: fill(t.description, site.values),
    }),
  };
}

// ── build ────────────────────────────────────────────────────────────────────

/** Renders every page without touching the disk. */
export function renderSite(site = loadSite()) {
  const pages = [];
  for (const lang of Object.keys(LANGUAGES)) {
    pages.push(renderHome(lang, site));
    for (const doc of DOCUMENTS) {
      if (doc.source[lang]) pages.push(renderDocument(doc, lang, site));
    }
  }
  return pages;
}

/**
 * @param {{ outDir?: string }} [options]
 * @returns {{ outDir: string, pages: object[] }}
 */
export function buildSite(options = {}) {
  const outDir = resolve(options.outDir || join(HERE, "dist"));
  if (outDir === REPO_ROOT || outDir === HERE || REPO_ROOT.startsWith(`${outDir}/`)) {
    throw new Error(`refusing to build the site into ${outDir}: the folder is emptied first`);
  }
  // Render everything before the old output is removed: a broken link then
  // leaves the previous build in place.
  const site = loadSite();
  const pages = renderSite(site);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const page of pages) {
    const file = join(outDir, page.route, "index.html");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, page.html);
    page.file = file;
  }
  cpSync(join(HERE, "assets"), join(outDir, "assets"), { recursive: true });
  mkdirSync(join(outDir, "images"), { recursive: true });
  for (const drawn of site.figures) writeFileSync(join(outDir, "images", drawn.file), drawn.svg);
  cpSync(join(REPO_ROOT, "docs", "screenshots"), join(outDir, "screenshots"), { recursive: true });
  cpSync(join(REPO_ROOT, "docs", "videos"), join(outDir, "videos"), { recursive: true });
  // Tells GitHub Pages to serve the files as they are.
  writeFileSync(join(outDir, ".nojekyll"), "");
  return { outDir, pages };
}

function main(argv) {
  let outDir;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--out" && argv[index + 1]) { outDir = argv[index + 1]; index += 1; continue; }
    console.error(`usage: node website/build.mjs [--out <folder>]`);
    return 2;
  }
  const result = buildSite({ outDir });
  for (const page of result.pages) console.log(`  ${page.lang}  /${page.route}`);
  console.log(`Built ${result.pages.length} pages into ${result.outDir}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`site build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
