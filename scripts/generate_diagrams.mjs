#!/usr/bin/env node
/**
 * Draws the figures used by the READMEs, the documents, and the website.
 *
 *   node scripts/generate_diagrams.mjs          write docs/images/*.svg
 *   node scripts/generate_diagrams.mjs --check  fail if a file is stale
 *
 * Every figure exists in Chinese and in English, drawn from one description,
 * so the two cannot drift apart. Platform names, namespaces, and limits come
 * from support-matrix.json. The output is plain SVG with system fonts: no
 * drawing tool, and no binary files in the repository.
 *
 * The figures show how the tool is built. None of them is a screenshot: the
 * project has not run in a developer tool yet, and a drawing must not look as
 * if it had.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadSupportMatrix, REPO_ROOT } from "../src/util.mjs";

export const IMAGE_DIRECTORY = "docs/images";
export const LANGUAGES = ["zh", "en"];

/**
 * Sizes of an export made from the stock Defold 1.14.1 engine, as printed by
 * scripts/verify_engine.mjs and quoted in the READMEs. The test suite checks
 * that the READMEs still quote the same figures.
 */
export const REFERENCE_SIZES = Object.freeze({
  defoldVersion: "1.14.1",
  mainPackageMb: 0.42,
  engineOriginalMb: 2.89,
  engineCompressedMb: 0.92,
});

// ── drawing kit ──────────────────────────────────────────────────────────────

const COLOR = {
  panel: "#0b1018", panelStroke: "#1c2533",
  card: "#111824", cardStroke: "#263243", cardRaised: "#0f1b2b",
  track: "#1c2533", trackStrong: "#3a475a",
  text: "#f5f7fb", muted: "#9ca9bb", dim: "#68778b",
  accent: "#5bb4ff", warm: "#ffa24d", green: "#07c160", cyan: "#25f4ee", red: "#fe2c55",
};

const STYLE = `
  text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; }
  .mono { font-family: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; }
  .caps { letter-spacing: 0.08em; }
`.trim();

const escapeXml = (value) => String(value)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const isWide = (character) => {
  const code = character.codePointAt(0);
  return (code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef);
};
const CLOSING = "，。、；：）」》！？";

/**
 * A width estimate in em. There is no font engine here, so the numbers lean
 * wide: a label that is estimated to fit does fit.
 */
function characterWidth(character, mono) {
  if (isWide(character)) return 1;
  if (mono) return 0.61;
  if (character === " ") return 0.3;
  if ("ijl.,:;|'!`".includes(character)) return 0.3;
  if ("ftr()[]{}-/·".includes(character)) return 0.4;
  if ("mwMW".includes(character)) return 0.88;
  if (/[A-Z0-9]/.test(character)) return 0.68;
  if (character.codePointAt(0) > 0x2000) return 1;
  return 0.57;
}

export function textWidth(content, size, mono = false) {
  let width = 0;
  for (const character of content) width += characterWidth(character, mono);
  return width * size;
}

/** Breaks at spaces, and between any two CJK characters. */
export function wrap(content, maxWidth, size, mono = false) {
  const units = [];
  let word = "";
  for (const character of content) {
    if (character === " ") {
      if (word) units.push(word);
      units.push(" ");
      word = "";
    } else if (isWide(character)) {
      if (word) units.push(word);
      word = "";
      // Closing punctuation stays with what it closes.
      if (CLOSING.includes(character) && units.length > 0) units[units.length - 1] += character;
      else units.push(character);
    } else {
      word += character;
    }
  }
  if (word) units.push(word);

  const lines = [];
  let line = "";
  for (const unit of units) {
    const candidate = line + unit;
    if (line.trim() === "" || textWidth(candidate.trimEnd(), size, mono) <= maxWidth) {
      line = candidate;
    } else {
      lines.push(line.trimEnd());
      line = unit === " " ? "" : unit;
    }
  }
  if (line.trim() !== "") lines.push(line.trimEnd());
  for (const entry of lines) {
    if (textWidth(entry, size, mono) > maxWidth) {
      throw new Error(`"${entry}" cannot be wrapped into ${Math.round(maxWidth)}px at ${size}px`);
    }
  }
  return lines;
}

function text(x, y, content, options = {}) {
  const { size = 15, fill = COLOR.text, weight = 400, anchor = "start", mono = false, caps = false, maxWidth } = options;
  if (maxWidth !== undefined && textWidth(content, size, mono) > maxWidth) {
    throw new Error(`"${content}" is wider than the ${Math.round(maxWidth)}px it was given`);
  }
  const classes = [mono ? "mono" : "", caps ? "caps" : ""].filter(Boolean).join(" ");
  return `<text x="${x}" y="${y}" font-size="${size}"${weight !== 400 ? ` font-weight="${weight}"` : ""} fill="${fill}"`
    + `${anchor !== "start" ? ` text-anchor="${anchor}"` : ""}${classes ? ` class="${classes}"` : ""}>${escapeXml(content)}</text>`;
}

function rect(x, y, width, height, options = {}) {
  const { fill = COLOR.card, stroke = COLOR.cardStroke, radius = 14, strokeWidth = 1 } = options;
  return `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="${fill}"`
    + `${stroke ? ` stroke="${stroke}" stroke-width="${strokeWidth}"` : ""}/>`;
}

function path(d, options = {}) {
  const { stroke = COLOR.accent, dashed = false, marker = "arrow", width = 2 } = options;
  return `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"`
    + `${dashed ? ' stroke-dasharray="6 6"' : ""}${marker ? ` marker-end="url(#${marker})"` : ""}/>`;
}

function frame(width, height, title, description, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="figure-title figure-description">
<title id="figure-title">${escapeXml(title)}</title>
<desc id="figure-description">${escapeXml(description)}</desc>
<defs>
<marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="${COLOR.accent}"/></marker>
<marker id="arrow-muted" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0 0L10 5L0 10z" fill="${COLOR.muted}"/></marker>
<linearGradient id="brand" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${COLOR.accent}"/><stop offset="1" stop-color="${COLOR.warm}"/></linearGradient>
</defs>
<style>${STYLE}</style>
${rect(0.5, 0.5, width - 1, height - 1, { fill: COLOR.panel, stroke: COLOR.panelStroke, radius: 24 })}
${body.join("\n")}
</svg>
`;
}

// ── shared words ─────────────────────────────────────────────────────────────

const PLATFORM_WORDS = {
  wechat: { zh: "微信小游戏", en: "WeChat Mini Game", short: { zh: "微信", en: "WeChat" }, color: COLOR.green },
  douyin: { zh: "抖音小游戏", en: "Douyin Mini Game", short: { zh: "抖音", en: "Douyin" }, color: COLOR.cyan },
  tiktok: { zh: "TikTok Mini Game", en: "TikTok Mini Game", short: { zh: "TikTok", en: "TikTok" }, color: COLOR.red },
};
const DEVTOOL_ZH = { "WeChat DevTools": "微信开发者工具", "Douyin DevTools": "抖音开发者工具", ttmg: "ttmg" };

function platformList(matrix) {
  return Object.entries(matrix.platformContracts).map(([key, contract]) => {
    if (!PLATFORM_WORDS[key]) throw new Error(`the figures have no words for the platform "${key}"`);
    return { key, contract, words: PLATFORM_WORDS[key] };
  });
}

const megabytes = (bytes) => `${bytes / 1048576} MB`;

// ── figure: from a Defold bundle to three platforms ──────────────────────────

function banner(lang, matrix) {
  const zh = lang === "zh";
  const body = [];
  const platforms = platformList(matrix);

  const left = { x: 48, y: 58, width: 330, height: 264 };
  body.push(rect(left.x, left.y, left.width, left.height));
  body.push(text(left.x + 24, left.y + 38, zh ? "输入" : "INPUT", { size: 12, fill: COLOR.accent, weight: 600, caps: true }));
  body.push(text(left.x + 24, left.y + 70, zh ? "Defold HTML5 包" : "Defold HTML5 bundle", { size: 22, weight: 650, maxWidth: left.width - 48 }));
  body.push(text(left.x + 24, left.y + 96, "Project › Bundle › HTML5 Application", { size: 13, fill: COLOR.dim, maxWidth: left.width - 48 }));
  ["dmloader.js", "MyGame_wasm.js", "MyGame.wasm", "archive/"].forEach((name, index) => {
    const y = left.y + 138 + index * 32;
    body.push(rect(left.x + 24, y - 13, 13, 16, { fill: "none", stroke: COLOR.accent, radius: 3, strokeWidth: 1.5 }));
    body.push(text(left.x + 50, y, name, { size: 15, mono: true, fill: COLOR.text }));
  });

  const pill = { x: 432, y: 150, width: 336, height: 80 };
  const centre = pill.x + pill.width / 2;
  const middle = pill.y + pill.height / 2;
  body.push(text(centre, 126, zh ? "一条命令" : "ONE COMMAND", { size: 12, fill: COLOR.dim, weight: 600, anchor: "middle", caps: true }));
  body.push(rect(pill.x, pill.y, pill.width, pill.height, { fill: "#0f1622", stroke: "url(#brand)", radius: 40, strokeWidth: 2 }));
  body.push(text(centre, middle + 7, "defold-minigame export", { size: 19, weight: 600, mono: true, anchor: "middle", maxWidth: pill.width - 48 }));
  body.push(text(centre, 266, zh ? "校验 · 合成 · 分包" : "verify · compose · package", { size: 15, fill: COLOR.muted, anchor: "middle" }));
  body.push(text(centre, 292, zh ? "用 Defold 官方引擎，不用自己编译" : "Defold's stock engine, nothing to compile", { size: 13, fill: COLOR.dim, anchor: "middle", maxWidth: pill.width + 40 }));
  body.push(path(`M${left.x + left.width + 8} ${middle}H${pill.x - 8}`));

  const right = { x: 832, width: 320, height: 72, gap: 24 };
  platforms.forEach((platform, index) => {
    const y = 58 + index * (right.height + right.gap);
    const cy = y + right.height / 2;
    body.push(path(`M${pill.x + pill.width + 6} ${middle}C${right.x - 30} ${middle} ${right.x - 34} ${cy} ${right.x - 8} ${cy}`));
    body.push(rect(right.x, y, right.width, right.height));
    body.push(rect(right.x + 14, y + 16, 4, right.height - 32, { fill: platform.words.color, stroke: null, radius: 2 }));
    const namespace = platform.contract.apiNamespace;
    const devtool = zh ? DEVTOOL_ZH[platform.contract.devtool] : platform.contract.devtool;
    if (!devtool) throw new Error(`the figures have no Chinese name for "${platform.contract.devtool}"`);
    const available = right.width - 34 - 20;
    body.push(text(right.x + 34, y + 32, platform.words[lang], { size: 17, weight: 600, maxWidth: available }));
    // Second line: the runtime namespace, then the tool that opens the project.
    const namespaceWidth = textWidth(namespace, 14, true);
    body.push(text(right.x + 34, y + 54, namespace, { size: 14, mono: true, fill: COLOR.accent }));
    body.push(text(right.x + 34 + namespaceWidth + 14, y + 54, devtool, {
      size: 13, fill: COLOR.dim, maxWidth: available - namespaceWidth - 14,
    }));
  });

  return frame(1200, 380,
    zh ? "从 Defold HTML5 包到三个小游戏平台" : "From a Defold HTML5 bundle to three mini-game platforms",
    zh
      ? "Defold 打出的 HTML5 包（dmloader.js、引擎胶水、引擎二进制、归档）经过 defold-minigame export 一条命令，变成微信、抖音或 TikTok 的小游戏工程。"
      : "The HTML5 bundle Defold writes (dmloader.js, the engine glue, the engine binary, the archive) goes through one defold-minigame export command and becomes a WeChat, Douyin, or TikTok mini-game project.",
    body);
}

// ── figure: what happens at export time and at run time ──────────────────────

function architecture(lang, matrix) {
  const zh = lang === "zh";
  const body = [];
  const margin = 48;
  const inner = 1200 - margin * 2;

  body.push(text(margin, 52, zh ? "导出时" : "AT EXPORT TIME", { size: 13, fill: COLOR.accent, weight: 600, caps: true }));

  const steps = [
    {
      tag: zh ? "输入" : "INPUT",
      title: zh ? "Defold HTML5 包" : "Defold HTML5 bundle",
      mono: true,
      items: ["dmloader.js", "<name>_wasm.js", "<name>.wasm", "archive/"],
    },
    {
      tag: zh ? "校验" : "VERIFY",
      title: zh ? "先确认能导再动手" : "Check before writing",
      items: zh
        ? ["核对大小和哈希", "逐函数扫描 WebAssembly 特性", "检查加载器的结构", "检查包体上限"]
        : ["sizes and hashes", "WebAssembly features, function by function", "the loader's structure", "package limits"],
    },
    {
      tag: zh ? "合成" : "COMPOSE",
      title: zh ? "引擎模块" : "Engine module",
      items: zh
        ? ["dmloader.js 和引擎胶水原样放入", "两个文件共用一个函数作用域", "eval 改接到 Lua 桥", "不往全局对象写东西"]
        : ["dmloader.js and the engine glue, verbatim", "one function scope for both files", "eval redirected to the Lua bridge", "nothing written to the global object"],
    },
    {
      tag: zh ? "产物" : "OUTPUT",
      title: zh ? "小游戏工程" : "Mini-game project",
      items: zh
        ? [`主包约 ${REFERENCE_SIZES.mainPackageMb} MB`, "engine 分包：引擎和归档", "所有权清单", "失败时回滚"]
        : [`main package ≈ ${REFERENCE_SIZES.mainPackageMb} MB`, "engine subpackage: engine and archive", "ownership manifest", "rollback on failure"],
    },
  ];

  const gap = 32;
  const cardWidth = (inner - gap * (steps.length - 1)) / steps.length;
  const padding = 20;
  const top = 76;
  const laid = steps.map((step) => {
    const titleLines = wrap(step.title, cardWidth - padding * 2, 18);
    const itemLines = step.items.map((item) => wrap(item, cardWidth - padding * 2 - 16, 14.5, step.mono));
    const height = 46 + titleLines.length * 24 + 14 + itemLines.reduce((sum, lines) => sum + lines.length * 21 + 6, 0) + 12;
    return { step, titleLines, itemLines, height };
  });
  const cardHeight = Math.max(...laid.map((entry) => entry.height));

  laid.forEach((entry, index) => {
    const x = margin + index * (cardWidth + gap);
    body.push(rect(x, top, cardWidth, cardHeight));
    body.push(text(x + padding, top + 32, entry.step.tag, { size: 12, fill: COLOR.warm, weight: 600, caps: true }));
    let y = top + 62;
    for (const line of entry.titleLines) {
      body.push(text(x + padding, y, line, { size: 18, weight: 650 }));
      y += 24;
    }
    y += 10;
    for (const lines of entry.itemLines) {
      body.push(`<circle cx="${x + padding + 3}" cy="${y - 5}" r="2.5" fill="${COLOR.accent}"/>`);
      for (const line of lines) {
        body.push(text(x + padding + 16, y, line, { size: 14.5, fill: COLOR.muted, mono: entry.step.mono }));
        y += 21;
      }
      y += 6;
    }
    if (index < laid.length - 1) {
      const from = x + cardWidth + 6;
      body.push(path(`M${from} ${top + cardHeight / 2}H${from + gap - 12}`));
    }
  });

  const stackTop = top + cardHeight + 78;
  body.push(text(margin, stackTop - 24, zh ? "运行时" : "AT RUN TIME", { size: 13, fill: COLOR.accent, weight: 600, caps: true }));

  const namespaces = platformList(matrix).map((platform) => platform.contract.apiNamespace).join("   |   ");
  const layers = [
    {
      title: zh ? "你的游戏" : "Your game",
      detail: zh ? "Lua 脚本、资源，以及 minigame.lua" : "Lua scripts, assets, and minigame.lua",
      badge: zh ? "你的代码" : "yours",
    },
    {
      title: zh ? "Defold 引擎" : "Defold engine",
      detail: zh ? "dmloader.js、引擎胶水、dmengine.wasm，全部原样运行" : "dmloader.js, the engine glue, and dmengine.wasm, all verbatim",
      badge: zh ? "来自 Defold" : "from Defold",
    },
    {
      title: zh ? "适配层" : "Adapter",
      detail: zh ? "画布 · 触摸 · 键盘 · 网络 · 音频 · 存档 · Lua 桥" : "canvas · touch · keyboard · network · audio · saves · Lua bridge",
      badge: zh ? "本项目" : "this project",
      raised: true,
    },
    {
      title: zh ? "宿主" : "Host",
      detail: namespaces,
      mono: true,
      badge: zh ? "平台提供" : "the platform",
    },
  ];
  const layerHeight = 70;
  const layerGap = 10;
  layers.forEach((layer, index) => {
    const y = stackTop + index * (layerHeight + layerGap);
    const baseline = y + layerHeight / 2 + 6;
    body.push(rect(margin, y, inner, layerHeight, layer.raised
      ? { fill: COLOR.cardRaised, stroke: COLOR.accent, strokeWidth: 1.5 }
      : {}));
    body.push(text(margin + 26, baseline, layer.title, { size: 18, weight: 650, maxWidth: 190 }));
    const badgeWidth = textWidth(layer.badge, 13) + 28;
    const badgeX = margin + inner - 24 - badgeWidth;
    body.push(text(margin + 230, baseline - 1, layer.detail, {
      size: 15, fill: layer.raised ? COLOR.text : COLOR.muted, mono: layer.mono, maxWidth: badgeX - (margin + 230) - 16,
    }));
    body.push(rect(badgeX, y + layerHeight / 2 - 14, badgeWidth, 28, {
      fill: "none", stroke: layer.raised ? COLOR.accent : COLOR.cardStroke, radius: 14,
    }));
    body.push(text(badgeX + badgeWidth / 2, y + layerHeight / 2 + 4.5, layer.badge, {
      size: 13, fill: layer.raised ? COLOR.accent : COLOR.muted, anchor: "middle",
    }));
  });

  const height = stackTop + layers.length * (layerHeight + layerGap) - layerGap + margin;
  return frame(1200, height,
    zh ? "导出时和运行时各做了什么" : "What happens at export time and at run time",
    zh
      ? "导出时：读取 Defold HTML5 包，校验大小、哈希、WebAssembly 特性和加载器结构，把 dmloader.js 和引擎胶水原样合成进一个作用域模块，生成主包和 engine 分包。运行时自上而下四层：你的游戏；原样运行的 Defold 引擎；本项目提供的适配层；宿主 wx、tt 或 TTMinis.game。"
      : "At export time the tool reads the Defold HTML5 bundle, verifies sizes, hashes, WebAssembly features, and the loader's structure, composes dmloader.js and the engine glue verbatim into one scoped module, and writes a main package and an engine subpackage. At run time there are four layers, top to bottom: your game; the Defold engine, run verbatim; the adapter this project provides; and the host, wx, tt, or TTMinis.game.",
    body);
}

// ── figure: what an export contains ──────────────────────────────────────────

function packageLayout(lang, matrix) {
  const zh = lang === "zh";
  const body = [];
  const platforms = platformList(matrix);
  const mainLimits = new Set(platforms.map((platform) => platform.contract.packageLimitsBytes.main));
  if (mainLimits.size !== 1) throw new Error("the package figure assumes one main-package limit for every platform");
  const mainLimitMb = [...mainLimits][0] / 1048576;

  const card = { y: 48, width: 540, height: 344 };
  const padding = 26;
  const rowHeight = 31;

  function column(x, kicker, title, rows) {
    body.push(rect(x, card.y, card.width, card.height));
    body.push(text(x + padding, card.y + 36, kicker, { size: 12, fill: COLOR.warm, weight: 600, caps: true }));
    body.push(text(x + padding, card.y + 68, title, { size: 20, weight: 650, maxWidth: card.width - padding * 2 }));
    rows.forEach(([name, note], index) => {
      const y = card.y + 108 + index * rowHeight;
      const available = card.width - padding * 2;
      if (textWidth(name, 14.5, true) + textWidth(note, 14) + 18 > available) {
        throw new Error(`"${name}" and "${note}" do not fit on one row of the package figure`);
      }
      body.push(text(x + padding, y, name, { size: 14.5, mono: true }));
      body.push(text(x + card.width - padding, y, note, { size: 14, fill: COLOR.muted, anchor: "end" }));
    });
    return card.y + 108 + rows.length * rowHeight;
  }

  function bar(x, y, fraction, color, leftLabel, rightLabel) {
    const width = card.width - padding * 2;
    body.push(text(x + padding, y, leftLabel, { size: 14, fill: COLOR.text, weight: 600 }));
    body.push(text(x + card.width - padding, y, rightLabel, { size: 13, fill: COLOR.dim, anchor: "end" }));
    body.push(rect(x + padding, y + 10, width, 10, { fill: COLOR.track, stroke: null, radius: 5 }));
    body.push(rect(x + padding, y + 10, Math.max(10, Math.round(width * fraction)), 10, { fill: color, stroke: null, radius: 5 }));
  }

  const leftX = 48;
  const afterLeft = column(leftX, zh ? "主包" : "MAIN PACKAGE", zh ? "胶水和运行时" : "Glue and runtime", [
    ["game.js", zh ? "入口" : "entry"],
    ["game.json", zh ? "配置，声明 engine 分包" : "config, declares the subpackage"],
    ["adapter.js", zh ? "浏览器环境适配" : "browser environment adapter"],
    ["js/defold_engine.js", zh ? "dmloader.js 和引擎胶水" : "dmloader.js and the engine glue"],
    ["js/loader.js, bridge.js, …", zh ? "启动、Lua 桥、存档" : "boot, Lua bridge, saves"],
  ]);
  bar(leftX, afterLeft + 26, REFERENCE_SIZES.mainPackageMb / mainLimitMb, COLOR.accent,
    zh ? `约 ${REFERENCE_SIZES.mainPackageMb} MB` : `about ${REFERENCE_SIZES.mainPackageMb} MB`,
    zh ? `主包上限 ${mainLimitMb} MB` : `main package limit ${mainLimitMb} MB`);

  const rightX = 612;
  const afterRight = column(rightX, zh ? "ENGINE 分包" : "ENGINE SUBPACKAGE", zh ? "引擎和你的游戏资源" : "The engine and your game's assets", [
    ["engine/dmengine.wasm.br", zh ? "官方引擎，Brotli 压缩" : "stock engine, Brotli"],
    ["engine/archive/*.bin", zh ? "游戏归档：你的资源" : "game archive: your assets"],
    ["engine/game.js", zh ? "分包入口" : "subpackage entry"],
  ]);
  bar(rightX, afterRight + 26, 1, COLOR.trackStrong,
    zh ? `引擎二进制 ${REFERENCE_SIZES.engineOriginalMb} MB` : `engine binary ${REFERENCE_SIZES.engineOriginalMb} MB`,
    zh ? "压缩前" : "before compression");
  bar(rightX, afterRight + 76, REFERENCE_SIZES.engineCompressedMb / REFERENCE_SIZES.engineOriginalMb, COLOR.warm,
    `${REFERENCE_SIZES.engineCompressedMb} MB`,
    zh ? "Brotli 压缩后，放进包里的是这个" : "after Brotli: this is what ships");

  const limits = platforms
    .map((platform) => `${platform.words.short[lang]} ${megabytes(platform.contract.packageLimitsBytes.total)}`)
    .join("  ·  ");
  const footer = zh ? `总包上限：${limits}` : `Total limit: ${limits}`;
  const note = zh
    ? `数字来自 Defold ${REFERENCE_SIZES.defoldVersion} 官方引擎的导出，归档大小取决于你的游戏`
    : `Figures from an export of the stock Defold ${REFERENCE_SIZES.defoldVersion} engine; the archive depends on your game`;
  body.push(text(600, card.y + card.height + 40, footer, { size: 15, fill: COLOR.muted, anchor: "middle", maxWidth: 1100 }));
  body.push(text(600, card.y + card.height + 66, note, { size: 13, fill: COLOR.dim, anchor: "middle", maxWidth: 1100 }));

  return frame(1200, card.y + card.height + 96,
    zh ? "一次导出里有什么" : "What an export contains",
    zh
      ? `主包只有入口、配置、适配层和引擎模块，约 ${REFERENCE_SIZES.mainPackageMb} MB，上限 ${mainLimitMb} MB。engine 分包里是 Brotli 压缩后的官方引擎（${REFERENCE_SIZES.engineOriginalMb} MB 压到 ${REFERENCE_SIZES.engineCompressedMb} MB）和游戏归档。${footer}。`
      : `The main package holds only the entry, the configuration, the adapter, and the engine module: about ${REFERENCE_SIZES.mainPackageMb} MB of a ${mainLimitMb} MB limit. The engine subpackage holds the stock engine compressed with Brotli (${REFERENCE_SIZES.engineOriginalMb} MB down to ${REFERENCE_SIZES.engineCompressedMb} MB) and the game archive. ${footer}.`,
    body);
}

// ── figure: one SDK call across the Lua bridge ───────────────────────────────

function bridge(lang) {
  const zh = lang === "zh";
  const body = [];
  const lanes = [
    { x: 180, title: zh ? "Lua 脚本" : "Lua script", detail: "minigame.lua" },
    { x: 600, title: zh ? "Lua 桥" : "Lua bridge", detail: "js/bridge.js" },
    { x: 1020, title: zh ? "宿主" : "Host", detail: zh ? "以微信为例：wx" : "WeChat here: wx" },
  ];
  const messages = [
    {
      from: 0, to: 1,
      label: `{"op":"call","api":"login","id":"c1:1"}`,
      caption: zh ? "minigame.login(callback) 经 html5.run() 发出命令" : "minigame.login(callback), sent with html5.run()",
    },
    {
      from: 1, to: 2,
      label: "wx.login({ success, fail })",
      caption: zh ? "桥调用宿主接口" : "the bridge calls the host API",
    },
    {
      from: 2, to: 1, reply: true,
      label: "success({ code })",
      caption: zh ? "结果进入队列，不打断引擎" : "the result is queued, the engine is not interrupted",
    },
    {
      from: 0, to: 1,
      label: `{"op":"poll","client":"c1"}`,
      caption: zh ? "minigame.update() 每帧取一次自己的结果" : "minigame.update() asks for its results every frame",
    },
    {
      from: 1, to: 0, reply: true,
      label: `[{"id":"c1:1","ok":true,"data":{"code":"…"}}]`,
      caption: zh ? "你的回调收到 callback(code, nil)" : "your callback receives callback(code, nil)",
    },
  ];

  const headerTop = 44;
  const first = 168;
  const step = 76;
  const last = first + (messages.length - 1) * step;
  const lifeEnd = last + 46;

  for (const lane of lanes) {
    body.push(`<path d="M${lane.x} ${headerTop + 60}V${lifeEnd}" stroke="${COLOR.cardStroke}" stroke-width="1.5" stroke-dasharray="4 6" fill="none"/>`);
    body.push(rect(lane.x - 140, headerTop, 280, 60));
    body.push(text(lane.x, headerTop + 27, lane.title, { size: 17, weight: 650, anchor: "middle" }));
    body.push(text(lane.x, headerTop + 47, lane.detail, { size: 12.5, fill: COLOR.dim, anchor: "middle", mono: !isWide(lane.detail[0]), maxWidth: 250 }));
  }

  messages.forEach((message, index) => {
    const y = first + index * step;
    const from = lanes[message.from].x;
    const to = lanes[message.to].x;
    const direction = Math.sign(to - from);
    const middle = (from + to) / 2;
    const span = Math.abs(to - from) - 44;
    body.push(path(`M${from + direction * 16} ${y}H${to - direction * 10}`, message.reply
      ? { stroke: COLOR.muted, dashed: true, marker: "arrow-muted" }
      : {}));
    body.push(`<circle cx="${from}" cy="${y}" r="11" fill="${COLOR.panel}" stroke="${message.reply ? COLOR.muted : COLOR.accent}" stroke-width="1.5"/>`);
    body.push(text(from, y + 4.5, String(index + 1), { size: 12.5, weight: 650, fill: message.reply ? COLOR.muted : COLOR.accent, anchor: "middle" }));
    body.push(text(middle, y - 12, message.label, { size: 13, mono: true, anchor: "middle", maxWidth: span }));
    body.push(text(middle, y + 22, message.caption, { size: 13, fill: COLOR.muted, anchor: "middle", maxWidth: span }));
  });

  const footnote = zh
    ? "html5.run() 在浏览器里就是 eval。小游戏禁用 eval，所以导出时这一处调用被改接到桥上，桥只接受 JSON 命令。"
    : "In a browser html5.run() is eval. Mini games disable eval, so the export redirects that one call to the bridge, which accepts JSON commands only.";
  body.push(text(600, lifeEnd + 44, footnote, { size: 13.5, fill: COLOR.dim, anchor: "middle", maxWidth: 1120 }));

  return frame(1200, lifeEnd + 76,
    zh ? "一次 SDK 调用怎样穿过 Lua 桥" : "One SDK call across the Lua bridge",
    zh
      ? "第一步，minigame.login 通过 html5.run 把一条 JSON 命令交给桥，命令的编号带着这个 Lua 环境的名字。第二步，桥调用宿主的 wx.login。第三步，宿主的成功回调把结果放进队列。第四步，minigame.update 每帧用 poll 命令取一次属于自己的结果。第五步，你的回调收到登录凭证。"
      : "Step 1: minigame.login hands a JSON command to the bridge through html5.run; its id carries the name of this Lua state. Step 2: the bridge calls the host's wx.login. Step 3: the host's success callback puts the result in a queue. Step 4: minigame.update asks for its own results with a poll command once per frame. Step 5: your callback receives the login code.",
    body);
}

// ── catalogue ────────────────────────────────────────────────────────────────

const DRAW = { banner, architecture, package: packageLayout, bridge };

/** The figures by name; the website reads sizes and descriptions from here. */
export function renderFigures(matrix = loadSupportMatrix()) {
  const figures = [];
  for (const [name, draw] of Object.entries(DRAW)) {
    for (const lang of LANGUAGES) {
      const svg = draw(lang, matrix);
      const size = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
      figures.push({
        name,
        lang,
        file: `${name}-${lang}.svg`,
        path: `${IMAGE_DIRECTORY}/${name}-${lang}.svg`,
        width: Number(size[1]),
        height: Number(size[2]),
        title: /<title id="figure-title">([^<]*)<\/title>/.exec(svg)[1],
        description: /<desc id="figure-description">([^<]*)<\/desc>/.exec(svg)[1],
        svg,
      });
    }
  }
  return figures;
}

if (process.argv[1] && process.argv[1].endsWith("generate_diagrams.mjs")) {
  const check = process.argv.includes("--check");
  let stale = false;
  mkdirSync(join(REPO_ROOT, IMAGE_DIRECTORY), { recursive: true });
  for (const figure of renderFigures()) {
    const file = join(REPO_ROOT, figure.path);
    if (check) {
      if (!existsSync(file) || readFileSync(file, "utf8") !== figure.svg) {
        console.error(`${figure.path} is out of date; run node scripts/generate_diagrams.mjs`);
        stale = true;
      }
    } else {
      writeFileSync(file, figure.svg);
      console.log(`wrote ${figure.path} (${figure.width}x${figure.height})`);
    }
  }
  if (stale) process.exitCode = 1;
}
