/**
 * Text shared by every page: navigation, footer, and the list of documents.
 */

export const SITE_NAME = "Defold Mini Game";

export const LANGUAGES = {
  zh: { htmlLang: "zh-CN", label: "中文", prefix: "" },
  en: { htmlLang: "en", label: "English", prefix: "en/" },
};

/**
 * The documents the site renders. A document without a source in a language
 * has no page in that language; links from that language point at the page
 * that exists and say which language it is in.
 */
export const DOCUMENTS = [
  {
    id: "quick-start",
    source: { zh: "docs/QUICK_START_zh.md", en: "docs/QUICK_START.md" },
    nav: { zh: "快速开始", en: "Quick start" },
  },
  {
    id: "guide",
    source: { zh: "docs/USAGE_zh.md", en: "docs/USAGE.md" },
    nav: { zh: "使用指南", en: "Usage guide" },
  },
  {
    id: "api",
    source: { zh: "docs/API_zh.md", en: "docs/API.md" },
    nav: { zh: "Lua SDK", en: "Lua SDK" },
  },
  {
    id: "agents",
    source: { zh: "docs/AI_AGENTS_zh.md", en: "docs/AI_AGENTS.md" },
    nav: { zh: "AI 助手", en: "AI agents" },
  },
  {
    id: "architecture",
    source: { zh: "docs/ARCHITECTURE.md", en: "docs/ARCHITECTURE.md" },
    nav: { zh: "架构", en: "Architecture" },
  },
  {
    id: "research",
    source: { zh: "docs/RESEARCH_zh.md" },
    nav: { zh: "调研依据", en: "Research (中文)" },
  },
];

export const chrome = {
  zh: {
    skip: "跳到正文",
    navLabel: "主导航",
    docsLabel: "文档导航",
    docsGroup: "文档",
    pageGroup: "本页内容",
    home: "首页",
    github: "GitHub",
    footer: [
      "MIT 许可。导出产物里的 Defold 引擎文件仍遵循 Defold License。",
      "本项目不是 Defold 官方项目。",
    ],
    footerVersion: "版本 {version}，桥接 ABI {abi}",
    titleSuffix: "Defold Mini Game",
  },
  en: {
    skip: "Skip to content",
    navLabel: "Main",
    docsLabel: "Documentation",
    docsGroup: "Documentation",
    pageGroup: "On this page",
    home: "Home",
    github: "GitHub",
    footer: [
      "MIT licensed. The Defold engine files inside an export stay under the Defold License.",
      "This is not an official Defold project.",
    ],
    footerVersion: "Version {version}, bridge ABI {abi}",
    titleSuffix: "Defold Mini Game",
  },
};
