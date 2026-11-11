/**
 * Per-test workspace: a synthetic bundle, export folders, and simulated hosts.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportMiniGame } from "../../src/exporter.mjs";
import { createHost } from "../sim/host.mjs";
import { makeBundle } from "./bundle_fixture.mjs";

export const APP_ID = "wx0123456789abcdef";

/**
 * @param {import("node:test").TestContext} t
 * @param {object} [bundleOptions] passed to makeBundle
 */
export function makeWorkspace(t, bundleOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "dmg-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = makeBundle({ ...bundleOptions, directory: join(root, "bundle") });
  const userDataDir = join(root, "user");
  mkdirSync(userDataDir, { recursive: true });

  const workspace = {
    root,
    bundle,
    bundleDir: bundle.directory,
    userDataDir,
    outputDir(platform) { return join(root, `out-${platform}`); },

    /** Exports the bundle; Brotli quality is lowered to keep tests fast. */
    export(platform, options = {}) {
      return exportMiniGame({
        bundleDir: bundle.directory,
        platform,
        appId: APP_ID,
        outputDir: workspace.outputDir(platform),
        brotliQuality: 4,
        startTimeoutMs: 4000,
        ...options,
      });
    },

    /** Creates a simulated host for an already exported platform. */
    host(platform, options = {}) {
      return createHost({
        platform,
        packageDir: options.packageDir || workspace.outputDir(platform),
        userDataDir,
        ...options,
      });
    },

    /** Exports and boots in one step. */
    async run(platform, { exportOptions = {}, hostOptions = {} } = {}) {
      workspace.export(platform, exportOptions);
      const host = workspace.host(platform, hostOptions);
      await host.start();
      return host;
    },
  };
  return workspace;
}

export const PLATFORMS = ["wechat", "douyin", "tiktok"];
export { DEFOLD_RELEASES, DEFOLD_VERSION, DEFOLD_VERSIONS } from "./bundle_fixture.mjs";
