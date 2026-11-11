-- Runs minigame.lua outside Defold, for the Node test suite.
--
--   luajit test/lua/harness.lua <mode> <scenario.lua>
--
-- mode "bridge":  html5.run() is piped to the Node process, which answers with
--                 the real JavaScript bridge running in a simulated host.
-- mode "browser": html5.run() behaves like a plain HTML5 build without a bridge.
-- mode "native":  there is no html5 module at all (editor, desktop, mobile).
--
-- Protocol on stdout / stdin, one line each way:
--   ">" code      → "ok <reply>" or "err <message>"
--   "~" millis    → any line, after the Node event loop ran for that long
--   "# text"      a log line
--   "DONE <json>" the check results

package.path = "./?.lua;" .. package.path
json = require "test.lua.json"

local mode, scenario = arg[1], arg[2]

local function exchange(line)
    io.stdout:write(line, "\n")
    io.stdout:flush()
    local reply = io.stdin:read("*l")
    if reply == nil then
        error("the test bridge closed the pipe", 0)
    end
    return reply
end

if mode == "bridge" then
    html5 = {
        run = function(code)
            local reply = exchange(">" .. code)
            if reply:sub(1, 2) == "ok" then
                return reply:sub(4)
            end
            -- The engine raises a Lua error when the evaluation throws.
            error(reply:sub(5), 0)
        end,
    }
elseif mode == "browser" then
    html5 = {
        run = function(code)
            if code:sub(1, 1) == "{" then
                error("SyntaxError: Unexpected token ':'", 0)
            end
            return ""
        end,
    }
else
    html5 = nil
end

print = function(...)
    local parts = {}
    for index = 1, select("#", ...) do
        parts[index] = tostring(select(index, ...))
    end
    io.stdout:write("# ", table.concat(parts, " "), "\n")
    io.stdout:flush()
end

function sleep(milliseconds)
    if mode == "bridge" then
        exchange("~" .. milliseconds)
    end
end

local results = {}

function check(name, condition, detail)
    results[#results + 1] = {
        name = name,
        ok = condition and true or false,
        detail = detail ~= nil and tostring(detail) or "",
    }
end

function check_equal(name, actual, expected)
    check(name, actual == expected, ("expected %s, got %s"):format(tostring(expected), tostring(actual)))
end

local minigame = require "minigame.minigame"
local run = dofile(scenario)
local ok, err = pcall(run, minigame)
if not ok then
    check("scenario ran to completion", false, err)
end

io.stdout:write("DONE ", json.encode(results), "\n")
io.stdout:flush()
