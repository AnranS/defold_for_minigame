/**
 * Loads single runtime modules into a simulated host realm, for unit tests
 * that do not need a whole exported package.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { REPO_ROOT } from "../../src/util.mjs";
import { createHost } from "../sim/host.mjs";

/**
 * @param {import("node:test").TestContext} t
 * @param {"wechat"|"douyin"|"tiktok"} platform
 * @param {object} [options] host options, plus `config` for __defoldMiniGameConfig
 */
export function runtimeRealm(t, platform, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "dmg-realm-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const userDataDir = options.userDataDir || join(root, "user");
  mkdirSync(userDataDir, { recursive: true });
  const host = createHost({
    platform,
    packageDir: join(REPO_ROOT, "runtime", "common"),
    userDataDir,
    ...options,
  });
  if (options.config) host.gameGlobal.__defoldMiniGameConfig = options.config;
  host.root = root;
  host.userDataDir = userDataDir;
  return host;
}
