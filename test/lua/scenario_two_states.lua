-- Two Lua states on one bridge. Defold gives game object scripts and GUI
-- scripts separate Lua states unless script.shared_state is set, so a game
-- that calls the SDK from both loads this module twice. Each copy polls the
-- bridge on its own; neither may take, or lose, the other's results.

return function(first)
    -- A second copy of the module, as a second Lua state would have.
    local second = assert(loadfile("minigame/minigame.lua"))()
    check("the two copies are separate", first ~= second)
    check("both find the bridge", first.is_available() and second.is_available())

    local function pump(module, done)
        for _ = 1, 40 do
            module.update()
            if done() then return true end
            sleep(5)
        end
        return false
    end

    -- Both ask at the same moment; only the first one polls for a while.
    local first_code, first_calls = nil, 0
    local second_code, second_calls = nil, 0
    first.login(function(code) first_code, first_calls = code, first_calls + 1 end)
    second.login(function(code) second_code, second_calls = code, second_calls + 1 end)

    check("the first copy gets its result", pump(first, function() return first_calls > 0 end))
    sleep(20)
    for _ = 1, 5 do first.update() end
    check_equal("the first copy's callback fires once", first_calls, 1)
    check_equal("the first copy did not run the second one's callback", second_calls, 0)

    check("the second copy still gets its result", pump(second, function() return second_calls > 0 end))
    check_equal("the second copy's callback fires once", second_calls, 1)
    check("both received a login code", type(first_code) == "string" and first_code == second_code)

    -- Host objects: each copy keeps its own.
    local a = first.create("createRewardedVideoAd", { adUnitId = "adunit-first" })
    local b = second.create("createRewardedVideoAd", { adUnitId = "adunit-second" })
    check("both create an object", a ~= nil and b ~= nil)
    a:set("tag", "first")
    b:set("tag", "second")
    check_equal("the first copy's object kept its value", a:get("tag"), "first")
    check_equal("the second copy's object kept its value", b:get("tag"), "second")
    check_equal("the first copy's object is the one it created", a:get("adUnitId"), "adunit-first")
    a:destroy()
    check_equal("destroying one leaves the other", b:get("tag"), "second")
    b:destroy()

    -- Subscriptions: an event reaches every copy that asked for it.
    local first_shows, second_shows = 0, 0
    first.on_show(function() first_shows = first_shows + 1 end)
    second.on_show(function() second_shows = second_shows + 1 end)
    sleep(-1) -- asks the test to send the game to the background and back
    pump(first, function() return first_shows > 0 end)
    pump(second, function() return second_shows > 0 end)
    check_equal("the first copy saw the host event", first_shows, 1)
    check_equal("the second copy saw the host event", second_shows, 1)

    -- One Lua state shared by every script. That is what Defold 1.14.1 does:
    -- the module is loaded once, and a game object script and a GUI script
    -- may both call update(). msg.url() names the running script. A script
    -- that polls gets its own results and nobody else's, so a GUI callback
    -- runs in the GUI script and can touch its nodes.
    local running = "gui"
    msg = { url = function() return running end }

    local gui_ran_as, gui_events = nil, 0
    first.update() -- the GUI script polls: from now on its results wait for it
    first.login(function() gui_ran_as = running end)
    first.on_hide(function() gui_events = gui_events + 1 end)

    running = "game object"
    local object_ran_as = nil
    first.login(function() object_ran_as = running end)
    sleep(-1)
    check("the game object script gets its own result", pump(first, function() return object_ran_as ~= nil end))
    for _ = 1, 10 do first.update(); sleep(2) end
    check_equal("its callback ran in the game object script", object_ran_as, "game object")
    check_equal("the GUI's result was not delivered by the game object script", gui_ran_as, nil)
    check_equal("nor was the GUI's event", gui_events, 0)

    running = "gui"
    check("the GUI script gets its result when it polls", pump(first, function() return gui_ran_as ~= nil and gui_events > 0 end))
    check_equal("its callback ran in the GUI script", gui_ran_as, "gui")
    check_equal("its event handler ran once", gui_events, 1)

    -- A script that never polls relies on another one, as a game that only adds /minigame/minigame.go does.
    running = "a script that never polls"
    local lazy_ran_as = nil
    first.login(function() lazy_ran_as = running end)
    running = "game object"
    check("a script that does not poll is served by one that does", pump(first, function() return lazy_ran_as ~= nil end))
    check_equal("and its callback runs in the polling script", lazy_ran_as, "game object")

    -- A script that polled and then went away must not hold its results forever.
    running = "gui"
    local orphan_ran_as = nil
    first.login(function() orphan_ran_as = running end)
    running = "game object"
    sleep(30)
    for _ = 1, 300 do first.update() end
    check_equal("results of a script that stopped polling are delivered in the end", orphan_ran_as, "game object")

    msg = nil
end
