/**
 * Extracts the public API of minigame/minigame.lua from its doc comments.
 * The README, the generated reference, and the website all read this, so the
 * Lua source stays the single place where a function is described.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { REPO_ROOT } from "../../src/util.mjs";

const SECTION_RULE = /^-- -{20,}$/;

/**
 * @returns {{ groups: { title: string, functions: object[] }[], methods: object[], count: number }}
 */
export function readLuaApi(path = join(REPO_ROOT, "minigame", "minigame.lua")) {
  const lines = readFileSync(path, "utf8").split("\n");
  const groups = [{ title: "Setup", functions: [] }];
  const methods = [];
  let comment = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (SECTION_RULE.test(line) && lines[index + 1] && lines[index + 1].startsWith("-- ") && SECTION_RULE.test(lines[index + 2] || "")) {
      groups.push({ title: lines[index + 1].slice(3).trim(), functions: [] });
      index += 2;
      comment = [];
      continue;
    }
    if (line.startsWith("---")) {
      comment = [line.replace(/^---\s?/, "")];
      continue;
    }
    if (line.startsWith("--") && comment.length > 0) {
      comment.push(line.replace(/^--\s?/, ""));
      continue;
    }
    const publicFunction = /^function M\.([a-z_]+)\((.*)\)$/.exec(line);
    const method = /^function Object:([a-z_]+)\((.*)\)$/.exec(line);
    if (publicFunction || method) {
      const [, name, parameters] = publicFunction || method;
      const description = [];
      const tags = [];
      for (const entry of comment) {
        if (entry.startsWith("@")) tags.push(entry);
        else description.push(entry);
      }
      const record = {
        name,
        signature: publicFunction ? `minigame.${name}(${parameters})` : `object:${name}(${parameters})`,
        description: description.join(" ").trim(),
        tags,
      };
      if (publicFunction) groups[groups.length - 1].functions.push(record);
      else methods.push(record);
    }
    if (line.trim() !== "" || comment.length === 0) comment = line.startsWith("--") ? comment : [];
  }

  const nonEmpty = groups.filter((group) => group.functions.length > 0);
  return {
    groups: nonEmpty,
    methods,
    count: nonEmpty.reduce((sum, group) => sum + group.functions.length, 0),
  };
}
