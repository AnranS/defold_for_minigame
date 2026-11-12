/**
 * skills/defold-minigame is what an AI coding agent works from instead of the
 * documents. These tests keep it loadable by the tools that read Agent Skills,
 * and in step with the exporter, the Lua module, and support-matrix.json.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { REFERENCES, renderReference, SKILL_DIR } from "../scripts/generate_skill_references.mjs";
import { readLuaApi } from "../scripts/lib/lua_api.mjs";
import { loadSupportMatrix, REPO_ROOT } from "../src/util.mjs";

const matrix = loadSupportMatrix();
const read = (path) => readFileSync(join(REPO_ROOT, path), "utf8");
const pkg = JSON.parse(read("package.json"));
const repository = pkg.repository.url.replace(/\.git$/, "");
const skill = read(`${SKILL_DIR}/SKILL.md`);

/** The front matter as the simplest reader sees it: one `key: value` per line, and one nested map. */
function frontMatter(text) {
  const lines = text.split("\n");
  assert.equal(lines[0], "---", "SKILL.md starts with its front matter");
  const end = lines.indexOf("---", 1);
  assert.ok(end > 0, "the front matter is closed");
  const data = {};
  let map = null;
  for (const line of lines.slice(1, end)) {
    const nested = /^ {2}([a-z-]+): (.+)$/.exec(line);
    if (nested) {
      assert.ok(map, `"${line}" is indented under nothing`);
      map[nested[1]] = nested[2].replace(/^"(.*)"$/, "$1");
      continue;
    }
    const pair = /^([a-z-]+):(?: (.+))?$/.exec(line);
    assert.ok(pair, `not a "key: value" line: ${line}`);
    map = pair[2] === undefined ? (data[pair[1]] = {}) : null;
    if (pair[2] !== undefined) data[pair[1]] = pair[2];
  }
  return { data, body: lines.slice(end + 1).join("\n") };
}

test("the skill's front matter is what the Agent Skills format asks for", () => {
  const { data, body } = frontMatter(skill);
  // The name is the folder's name: lowercase letters, digits, and single hyphens.
  assert.equal(data.name, basename(SKILL_DIR));
  assert.match(data.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(data.name.length <= 64);
  assert.ok(data.description.length >= 100 && data.description.length <= 1024, `the description is ${data.description.length} characters`);
  // A plain YAML scalar: nothing a parser could read as a key or a comment.
  assert.ok(!/: | #|^[\s"'`>|\[{*&!%@-]/.test(data.description), "the description needs no quoting");
  // It triggers on what a user would say, in either language.
  for (const word of ["WeChat", "Douyin", "TikTok", "微信小游戏", "抖音小游戏", "Defold"]) assert.ok(data.description.includes(word), `the description mentions ${word}`);
  assert.equal(data.license, pkg.license);
  assert.equal(data.metadata.version, matrix.toolVersion, "the skill describes the version in the matrix");
  assert.ok(skill.includes(`This skill describes version ${matrix.toolVersion}`));
  // Only keys every reader accepts. DeepSeek Harness drops a skill whose invocation keys are misspelt.
  assert.deepEqual(Object.keys(data).sort(), ["description", "license", "metadata", "name"]);
  assert.ok(body.split("\n").length < 500, "SKILL.md stays under 500 lines; details go into references/");
});

test("the skill sits where the tools look for it, one folder deep", () => {
  // <root>/skills/<name>/SKILL.md is the plugin layout of Claude Code and a
  // discovery location of the skills installer; DeepSeek Harness reads
  // <name>/SKILL.md directly under a skills folder and nothing nested.
  assert.equal(dirname(SKILL_DIR), "skills");
  assert.deepEqual(readdirSync(join(REPO_ROOT, "skills")), [basename(SKILL_DIR)]);
  assert.deepEqual(readdirSync(join(REPO_ROOT, SKILL_DIR)).sort(), ["SKILL.md", "references"]);
});

test("the skill's reference files are generated from the documents and are current", () => {
  for (const reference of REFERENCES) {
    assert.equal(read(`${SKILL_DIR}/${reference.target}`), renderReference(reference),
      `${SKILL_DIR}/${reference.target} is stale; run node scripts/generate_skill_references.mjs`);
  }
  assert.deepEqual(readdirSync(join(REPO_ROOT, SKILL_DIR, "references")).sort(), REFERENCES.map((reference) => basename(reference.target)).sort());
});

test("every file the skill links to is in the skill", () => {
  const files = ["SKILL.md", ...REFERENCES.map((reference) => reference.target)];
  let links = 0;
  for (const file of files) {
    for (const [, target] of read(`${SKILL_DIR}/${file}`).matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target)) continue;
      const path = join(dirname(`${SKILL_DIR}/${file}`), target.split("#")[0]);
      assert.ok(existsSync(join(REPO_ROOT, path)), `${file} links to ${target}`);
      assert.ok(path.startsWith(`${SKILL_DIR}/`), `${file} links out of the skill: ${target}`);
      links += 1;
    }
  }
  assert.ok(links >= 6, "SKILL.md points at its references");
  for (const reference of REFERENCES) assert.ok(skill.includes(`(${reference.target})`), `SKILL.md links to ${reference.target}`);
});

test("the skill names options the exporter has and functions the SDK has", () => {
  const help = spawnSync(process.execPath, [join(REPO_ROOT, "bin", "defold-minigame.mjs"), "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  const known = new Set(help.stdout.match(/--[a-z][a-z-]*/g));
  // Options of git, npx, and ttmg that the skill also shows.
  for (const other of ["--branch", "--depth", "--yes", "--client-key"]) known.add(other);
  const options = [...new Set(skill.match(/--[a-z][a-z-]*/g))];
  assert.ok(options.length >= 12, "the skill shows the options an export needs");
  assert.deepEqual(options.filter((option) => !known.has(option)), [], "options the exporter does not have");

  const api = readLuaApi();
  const names = new Set(api.groups.flatMap((group) => group.functions.map((record) => record.name)));
  // minigame.go and the require path "minigame.minigame" are files, not functions.
  const called = [...new Set([...skill.matchAll(/(?<![-\w])minigame\.([a-z_]+)/g)].map((match) => match[1]))].filter((name) => !["go", "minigame"].includes(name));
  assert.ok(called.length >= 10, "the skill shows the functions that trip people up");
  assert.deepEqual(called.filter((name) => !names.has(name)), [], "functions the SDK does not have");
});

test("the skill installs the released version, like the documents", () => {
  const tag = `v${matrix.toolVersion}`;
  assert.ok(skill.includes(`${repository}/archive/refs/tags/${tag}.zip`), "the library address");
  assert.ok(skill.includes(`git clone --branch ${tag} --depth 1 ${repository}.git`), "the clone");
  assert.ok(skill.includes(`npx --yes github:${repository.replace("https://github.com/", "")}#${tag} `), "the exporter through npx");
  for (const match of skill.matchAll(/refs\/tags\/(v[0-9.]+)\.zip|--branch (v[0-9.]+)|#(v[0-9.]+)\b/g)) {
    assert.equal(match[1] || match[2] || match[3], tag, `the skill names another version: ${match[0]}`);
  }
});

test("the skill's platform table says what the matrix says", () => {
  const row = (label) => {
    const line = skill.split("\n").find((candidate) => candidate.startsWith(`| ${label} |`));
    assert.ok(line, `no "${label}" row in the platform table`);
    return line.split("|").slice(2, -1).map((cell) => cell.trim());
  };
  const megabytes = (bytes) => `${bytes / 1024 / 1024} MB`;
  const order = row("`--platform`").map((cell) => cell.replace(/`/g, ""));
  assert.deepEqual(order, Object.keys(matrix.platformContracts), "one column per platform, in the matrix's order");
  const contracts = order.map((name) => matrix.platformContracts[name]);
  assert.deepEqual(row("Main package, total"), contracts.map((contract) => `${megabytes(contract.packageLimitsBytes.main)}, ${megabytes(contract.packageLimitsBytes.total)}`));
  assert.deepEqual(row("`sys.save` writes to"), contracts.map((contract) => ({ fs: "files", storage: "key-value storage" })[contract.defaults.persistence]));
  assert.deepEqual(row("Engine sound"), contracts.map((contract) => (contract.defaults.engineAudio ? "on" : "off by default")));
  for (const contract of contracts) {
    if (contract.minimumClientVersion) assert.ok(skill.includes(`client version ${contract.minimumClientVersion} or later`));
  }
});

test("the Claude Code plugin is this repository, with the skill in it", () => {
  const plugin = JSON.parse(read(".claude-plugin/plugin.json"));
  const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
  assert.equal(plugin.name, pkg.name);
  assert.equal(plugin.version, matrix.toolVersion, "a release moves the plugin's version, which is what gives its users the update");
  assert.equal(plugin.license, pkg.license);
  assert.equal(plugin.repository, repository);
  // The plugin's root is the repository's: skills/ is found by default, and the exporter comes along.
  assert.equal(marketplace.plugins.length, 1);
  assert.deepEqual({ name: marketplace.plugins[0].name, source: marketplace.plugins[0].source }, { name: plugin.name, source: "./" });
  assert.equal(marketplace.plugins[0].version, undefined, "plugin.json holds the version");
  assert.match(marketplace.name, /^[a-z0-9][a-z0-9-]*$/);
  assert.ok(existsSync(join(REPO_ROOT, "skills", plugin.name, "SKILL.md")));
  assert.ok(existsSync(join(REPO_ROOT, "bin", "defold-minigame.mjs")));
  // The install lines in the agent guides name this marketplace and this plugin.
  const [owner, name] = repository.replace("https://github.com/", "").split("/");
  for (const file of ["docs/AI_AGENTS.md", "docs/AI_AGENTS_zh.md"]) {
    const text = read(file);
    assert.ok(text.includes(`/plugin install ${plugin.name} --marketplace ${owner}/${name}`), `${file}: the one-step install`);
    assert.ok(text.includes(`/plugin install ${plugin.name}@${marketplace.name}`), `${file}: the two-step install`);
    assert.ok(text.includes(`npx skills add ${owner}/${name}`), `${file}: the installer for other tools`);
    for (const folder of [".dsh/skills/", ".agents/skills/", ".claude/skills/"]) assert.ok(text.includes(folder), `${file}: ${folder}`);
  }
});
