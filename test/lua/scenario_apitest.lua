-- The API test app's own list, run against a real bridge in a simulated host.
-- The app's screen needs the engine; the tests behind its buttons do not.

return function(minigame)
    local apitest = require "example.apitest"

    local delayed = {}
    local env = {
        delay = function(_, fn) delayed[#delayed + 1] = fn end,
    }

    local seen = {}
    local counts = { pass = 0, fail = 0, skip = 0, info = 0 }
    local unattended = 0
    for _, entry in ipairs(apitest.all()) do
        local test = entry.test
        check("the test " .. tostring(test.id) .. " has an id, a label, and a run function",
            type(test.id) == "string" and type(test.label) == "string" and type(test.run) == "function")
        check("the id " .. tostring(test.id) .. " is used once", not seen[test.id])
        seen[test.id] = true

        if test.auto then
            unattended = unattended + 1
            local status, detail
            local ok, err = pcall(test.run, function(result, text) status, detail = result, text end, env)
            if not ok then
                status, detail = "fail", "raised: " .. tostring(err)
            end
            -- Results arrive the way they do in the engine: on a later frame.
            for _ = 1, 60 do
                if status ~= nil and #delayed == 0 then break end
                sleep(5)
                local due = delayed
                delayed = {}
                for index = 1, #due do due[index]() end
                minigame.update()
            end
            status = status or "fail"
            counts[status] = (counts[status] or 0) + 1
            print(("%s %s %s"):format(status, test.id, tostring(detail)))
            check(test.id .. " does not fail", status == "pass" or status == "skip" or status == "info",
                tostring(status) .. ": " .. tostring(detail))
        end
    end
    check("the list has unattended tests", unattended >= 30, unattended)
    check("most unattended tests pass in the simulated host", counts.pass >= 25, counts.pass)
    print(("apitest pass=%d skip=%d info=%d fail=%d"):format(counts.pass, counts.skip, counts.info, counts.fail))
end
