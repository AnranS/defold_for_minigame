#!/usr/bin/env bash
# Everything a change has to pass before it is submitted:
#
#   1. the test suite: exporter, runtime in simulated hosts, Lua SDK, and the
#      agreement between support-matrix.json, the code, and the documents
#   2. the generated files are current: docs/API.md and docs/API_zh.md match
#      minigame/minigame.lua, and docs/images matches the figure generator
#   3. the website builds, and its pages, links, images, and values check out
#
# Needs Node.js 20 or later and nothing from npm. With LuaJIT or Lua 5.1 on
# the PATH the Lua integration tests run too; without one they are skipped,
# and this script says so. Set REQUIRE_LUA=1 to make that a failure (CI does).
set -euo pipefail
cd "$(dirname "$0")/.."

node_major=$(node -p 'Number(process.versions.node.split(".")[0])')
if [ "$node_major" -lt 20 ]; then
  echo "Node.js 20 or later is required; found $(node --version)." >&2
  exit 1
fi

lua=""
for candidate in luajit lua5.1 lua; do
  if "$candidate" -v >/dev/null 2>&1; then lua="$candidate"; break; fi
done
if [ -z "$lua" ] && [ "${REQUIRE_LUA:-0}" = "1" ]; then
  echo "REQUIRE_LUA=1, but no LuaJIT or Lua 5.1 interpreter is on the PATH." >&2
  exit 1
fi

step() { printf '\n== %s\n' "$1"; }

step "Test suite (Node.js $(node --version)${lua:+, $lua})"
node --test test/*.test.mjs

step "Generated files"
node scripts/generate_api_docs.mjs --check
echo "docs/API.md and docs/API_zh.md are current"
node scripts/generate_diagrams.mjs --check
echo "docs/images is current"

step "Website"
node website/build.mjs
node --test website/tests/*.test.mjs

echo
if [ -z "$lua" ]; then
  echo "All checks passed, except that the Lua integration tests were skipped:"
  echo "no LuaJIT or Lua 5.1 interpreter is on the PATH."
else
  echo "All checks passed."
fi
