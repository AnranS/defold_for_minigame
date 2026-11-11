-- The SDK against a real bridge in a simulated host.

return function(minigame)
    local expected_platform = os.getenv("EXPECTED_PLATFORM")

    -- Drains the bridge until `done()` holds, as /minigame/minigame.go does once per frame.
    local function pump(done)
        for _ = 1, 40 do
            minigame.update()
            if done() then return true end
            sleep(5)
        end
        return false
    end

    -- Handshake
    check("is_available", minigame.is_available())
    check_equal("platform", minigame.platform(), expected_platform)
    local info = minigame.info()
    check_equal("info.abi", info.abi, minigame.ABI)
    check_equal("info.brand", info.brand, "defold-mini-game-bridge")
    check("info.capabilities.storage", info.capabilities.storage == true)
    check_equal("has_engine_audio", minigame.has_engine_audio(), true)
    check("has(login)", minigame.has("login"))
    check("has(noSuchApi) is false", not minigame.has("noSuchApi"))

    -- Storage
    check("storage_set", minigame.storage_set("level", 5))
    check_equal("storage_get", minigame.storage_get("level", "1"), "5")
    check_equal("storage_get default", minigame.storage_get("missing", "fallback"), "fallback")
    check("storage_remove", minigame.storage_remove("level"))
    check_equal("storage_get after remove", minigame.storage_get("level", "none"), "none")

    -- Login and session
    local code, login_err, login_calls = nil, nil, 0
    minigame.login(function(result, err) code, login_err, login_calls = result, err, login_calls + 1 end)
    check("login is asynchronous", code == nil)
    check("login completes", pump(function() return login_calls > 0 end))
    check_equal("login code", code, expected_platform .. "-login-code")
    check_equal("login error", login_err, nil)
    minigame.update()
    check_equal("login callback fires once", login_calls, 1)

    local valid, session_err
    minigame.check_session(function(result, err) valid, session_err = result, err end)
    pump(function() return valid ~= nil end)
    check_equal("check_session reports an expired session", valid, false)
    check("check_session passes the host message", tostring(session_err):find("session expired", 1, true) ~= nil, session_err)

    -- Generic access
    local options, sync_err = minigame.call_sync("getLaunchOptionsSync")
    check_equal("call_sync result", options and options.scene, 1001)
    check_equal("call_sync nested result", options and options.query.from, "test")
    check_equal("call_sync error is nil on success", sync_err, nil)
    local missing, missing_err = minigame.call_sync("noSuchApi")
    check("call_sync unsupported", missing == nil and tostring(missing_err):find("is not supported", 1, true) ~= nil, missing_err)
    local unsupported_err
    check_equal("call unsupported returns false", minigame.call("noSuchApi", {}, function(_, err) unsupported_err = err end), false)
    check("call unsupported reports immediately", tostring(unsupported_err):find("noSuchApi is not supported", 1, true) ~= nil, unsupported_err)
    check_equal("launch options helper", minigame.get_launch_options().scene, 1001)

    -- System
    local system = minigame.get_system_info()
    check_equal("system model", system.model, "iPhone 14")
    check_equal("safe area", minigame.get_safe_area().top, 47)
    check_equal("menu button rect", minigame.get_menu_button_rect().width, 87)

    -- Native UI
    local confirmed
    minigame.show_modal({ title = "Quit?", content = "Really?" }, function(result) confirmed = result end)
    pump(function() return confirmed ~= nil end)
    check_equal("show_modal", confirmed, true)
    check("show_toast", minigame.show_toast("Saved", { icon = "success" }))
    local copied, pasted
    minigame.set_clipboard("copied text", function(result) copied = result end)
    pump(function() return copied ~= nil end)
    minigame.get_clipboard(function(result) pasted = result end)
    pump(function() return pasted ~= nil end)
    check_equal("clipboard round trip", pasted, "copied text")

    -- Lifecycle events arrive through update()
    local shows, hides = 0, 0
    local show_id = minigame.on_show(function() shows = shows + 1 end)
    minigame.on_hide(function() hides = hides + 1 end)
    check("on_show returns an id", type(show_id) == "string" and show_id ~= "")
    sleep(-1) -- asks the test to hide and show the host
    minigame.update()
    check_equal("on_hide fired", hides, 1)
    check_equal("on_show fired", shows, 1)
    minigame.off(show_id)
    sleep(-1)
    minigame.update()
    check_equal("off() stops delivery", shows, 1)
    check_equal("other subscriptions keep working", hides, 2)

    -- Sharing. TikTok has no hook for its share menu; the module says so instead of raising.
    local share_set, share_err = minigame.set_share_content({ title = "Play with me", query = "from=lua" })
    if expected_platform == "tiktok" then
        check("set_share_content is refused on TikTok, with the reason",
            share_set == false and tostring(share_err):find("onShareAppMessage", 1, true) ~= nil, share_err)
    else
        check("set_share_content", share_set, share_err)
    end

    -- Rewarded video
    local ad, ad_err = minigame.create_rewarded_video_ad("adunit-xyz")
    check("rewarded ad created", ad ~= nil, ad_err)
    local ended, show_err, show_calls = nil, nil, 0
    ad:show(function(result, err) ended, show_err, show_calls = result, err, show_calls + 1 end)
    pump(function() return show_calls > 0 end)
    check_equal("rewarded ad watched to the end", ended, true)
    check_equal("rewarded ad error", show_err, nil)
    local loaded
    ad:load(function(result) loaded = result end)
    pump(function() return loaded ~= nil end)
    check_equal("rewarded ad load", loaded, true)
    ad:destroy()
    local _, destroyed_err = ad.object:get("adUnitId")
    check_equal("a destroyed object refuses calls", destroyed_err, "the object was destroyed")

    -- Objects
    local object = minigame.create("createRewardedVideoAd", { adUnitId = "raw" })
    check_equal("object:get", object:get("adUnitId"), "raw")
    check("object:set", object:set("label", "tagged"))
    check_equal("object:get after set", object:get("label"), "tagged")
    local _, method_err = object:invoke("noSuchMethod")
    check("object:invoke unknown method", tostring(method_err):find("no method", 1, true) ~= nil, method_err)
    object:destroy()

    -- Unsupported on this host
    local interstitial, interstitial_err = minigame.create_interstitial_ad("x")
    check("unsupported object creation", interstitial == nil and tostring(interstitial_err):find("is not supported", 1, true) ~= nil, interstitial_err)
    local audio, audio_err = minigame.inner_audio("audio/bgm.mp3")
    check("inner_audio unsupported here", audio == nil and audio_err ~= nil, audio_err)
    local paid, pay_err
    minigame.request_payment({ amount = 1 }, function(result, err) paid, pay_err = result, err end)
    check_equal("payment unsupported", paid, false)
    check("payment names the provider API", tostring(pay_err):find("is not supported", 1, true) ~= nil, pay_err)

    -- Subpackage with progress
    local loaded_subpackage, progress = nil, {}
    minigame.load_subpackage("engine", function(result) loaded_subpackage = result end, function(percent) progress[#progress + 1] = percent end)
    pump(function() return loaded_subpackage ~= nil end)
    check_equal("load_subpackage", loaded_subpackage, true)
    check("load_subpackage progress", #progress >= 1 and progress[#progress] == 100, table.concat(progress, ","))

    -- A failing callback must not break delivery of later events
    local after = false
    minigame.call("login", {}, function() error("boom") end)
    minigame.call("login", {}, function() after = true end)
    pump(function() return after end)
    check("a throwing callback does not stop the queue", after)

    -- html5.run with anything else fails loudly
    local ok, run_err = pcall(html5.run, "window.location.href")
    check("html5.run rejects JavaScript", not ok and tostring(run_err):find("cannot evaluate JavaScript", 1, true) ~= nil, run_err)
end
