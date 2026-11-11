/**
 * Platform contracts. The values live in support-matrix.json, which the docs,
 * the website, and the tests read as well; this module only shapes them for
 * the exporter.
 */

import { ExportError, loadSupportMatrix } from "./util.mjs";

export const PLATFORM_NAMES = Object.freeze(["wechat", "douyin", "tiktok"]);

const ALIASES = {
  wechat: "wechat", weixin: "wechat", wx: "wechat",
  douyin: "douyin", tt: "douyin",
  tiktok: "tiktok", tiktok_native: "tiktok",
};

/** Text shown by the loader before the engine draws its first frame. */
const LOCALISED_TEXT = {
  wechat: { loadingText: "加载中", failureTitle: "启动失败" },
  douyin: { loadingText: "加载中", failureTitle: "启动失败" },
  tiktok: { loadingText: "Loading", failureTitle: "Startup failed" },
};

export function normalisePlatform(value) {
  const name = ALIASES[String(value || "").toLowerCase()];
  if (!name) {
    throw new ExportError(
      `unknown platform '${value}'`,
      { hint: `Choose one of: ${PLATFORM_NAMES.join(", ")}.` },
    );
  }
  return name;
}

export function getPlatform(value) {
  const name = normalisePlatform(value);
  const contract = loadSupportMatrix().platformContracts[name];
  return {
    name,
    displayName: contract.displayName,
    apiNamespace: contract.apiNamespace,
    nativeWebAssembly: contract.nativeWebAssembly,
    subpackageField: contract.subpackageField,
    supportTier: contract.supportTier,
    devtool: contract.devtool,
    minimumClientVersion: contract.minimumClientVersion || null,
    limits: { ...contract.packageLimitsBytes },
    defaults: { ...contract.defaults },
    validation: { ...contract.validation },
    text: { ...LOCALISED_TEXT[name] },
    hasPrivateConfig: name === "wechat",
  };
}
