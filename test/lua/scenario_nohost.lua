-- The SDK where there is no mini-game host: every call must be safe.

return function(minigame)
    check_equal("is_available", minigame.is_available(), false)
    check_equal("platform", minigame.platform(), nil)
    check_equal("info", minigame.info(), nil)
    check_equal("has_engine_audio", minigame.has_engine_audio(), false)
    check_equal("has", minigame.has("login"), false)
    minigame.update()

    local code, err, calls = nil, nil, 0
    minigame.login(function(result, message) code, err, calls = result, message, calls + 1 end)
    check_equal("login calls back immediately", calls, 1)
    check_equal("login code", code, nil)
    check_equal("login error", err, "not running in a mini game")

    local value, sync_err = minigame.call_sync("getStorageSync", "x")
    check_equal("call_sync value", value, nil)
    check_equal("call_sync error", sync_err, "not running in a mini game")
    check_equal("call returns false", minigame.call("login", {}), false)

    check_equal("storage_get default", minigame.storage_get("level", "1"), "1")
    local stored, stored_err = minigame.storage_set("level", "2")
    check_equal("storage_set", stored, false)
    check_equal("storage_set error", stored_err, "not running in a mini game")

    check_equal("system info is an empty table", next(minigame.get_system_info()), nil)
    check_equal("safe area", minigame.get_safe_area(), nil)
    check_equal("menu button rect", minigame.get_menu_button_rect(), nil)
    check_equal("launch options", next(minigame.get_launch_options()), nil)

    local id, on_err = minigame.on_show(function() end)
    check_equal("on_show id", id, nil)
    check_equal("on_show error", on_err, "not running in a mini game")
    minigame.off(nil)
    minigame.off(42)

    local ad, ad_err = minigame.create_rewarded_video_ad("x")
    check_equal("rewarded ad", ad, nil)
    check_equal("rewarded ad error", ad_err, "not running in a mini game")
    local audio, audio_err = minigame.inner_audio("a.mp3")
    check_equal("inner audio", audio, nil)
    check_equal("inner audio error", audio_err, "not running in a mini game")

    local paid, pay_err
    minigame.request_payment({}, function(result, message) paid, pay_err = result, message end)
    check_equal("payment", paid, false)
    check_equal("payment error", pay_err, "not running in a mini game")

    local shared, share_err = minigame.set_share_content({ title = "x" })
    check_equal("share", shared, false)
    check_equal("share error", share_err, "not running in a mini game")

    local loaded, load_err
    minigame.load_subpackage("x", function(result, message) loaded, load_err = result, message end)
    check_equal("load_subpackage", loaded, false)
    check_equal("load_subpackage error", load_err, "not running in a mini game")

    check_equal("show_toast", minigame.show_toast("x"), false)
    minigame.vibrate_short()
    minigame.exit()
    local confirmed, modal_err
    minigame.show_modal({}, function(result, message) confirmed, modal_err = result, message end)
    check_equal("show_modal", confirmed, nil)
    check_equal("show_modal error", modal_err, "not running in a mini game")
end
