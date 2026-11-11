--- The API tests of the test app: one entry per function of the minigame module.
--
-- Each test has an id, a label for its button, and run(done, env).
-- done(status, detail) may be called more than once; the last call counts.
--   pass  the call did what the module documents
--   fail  it did not
--   skip  the host has no such API, or lacks something the test needs
--   info  the host answered, and whether that answer is right depends on
--         something the test cannot know: an ad unit id, a payment setup
-- auto = true marks what "Run all" runs: tests that need no tap from the
-- player, do not leave the game, and touch nothing outside it.
--
-- env.delay(seconds, fn) runs fn later. The module uses nothing else from the
-- engine, so the same list runs under plain LuaJIT in the test suite.

local minigame = require "minigame.minigame"

local M = {}

--- An ad unit id that no host knows. Ads are tested for a well-formed answer, not for an ad.
M.PLACEHOLDER_AD_UNIT = "adunit-0000000000000000"
--- The audio file the app ships with --assets example/assets.
M.TONE = "assets/tone.wav"
--- The subpackage the app ships with --subpackage extras=example/extras, and what is in it.
M.EXTRAS = "extras"
M.EXTRAS_NOTE = "extras/note.txt"
M.EXTRAS_NOTE_TEXT = "loaded from the extras subpackage"
M.EXTRAS_CHIME = "extras/chime.wav"

local function brief(value)
    if type(value) == "table" then
        local ok, encoded = pcall(json.encode, value)
        value = ok and encoded or tostring(value)
    end
    value = tostring(value)
    if #value > 110 then
        value = value:sub(1, 107) .. "..."
    end
    return value
end

--- Skips with one message when the host has no such API.
local function requires(api, done)
    if minigame.has(api) then
        return true
    end
    done("skip", "the host has no " .. api)
    return false
end

--- For calls the module accepts or refuses on the spot.
local function accepted(done, ok, what)
    if ok then
        done("pass", what)
    else
        done("fail", "the host refused the call")
    end
end

--- Loads the extras subpackage and then calls fn(progress). Skips when the
-- export was made without it: the host would refuse a name game.json lacks.
local function with_extras(done, fn)
    if not requires("loadSubpackage", done) then return end
    local declared = false
    for _, name in ipairs((minigame.info() or {}).subpackages or {}) do
        declared = declared or name == M.EXTRAS
    end
    if not declared then
        done("skip", "exported without --subpackage " .. M.EXTRAS .. "=example/extras")
        return
    end
    local progress = nil
    minigame.load_subpackage(M.EXTRAS, function(loaded, err)
        if loaded then
            fn(progress)
        else
            done("fail", err)
        end
    end, function(percent)
        progress = percent
    end)
end

M.sections = {
    {
        title = "Setup",
        tests = {
            { id = "init", label = "init", auto = true, run = function(done)
                if minigame.init() then
                    done("pass", "bridge found")
                else
                    done("fail", "no bridge: this is not a mini game")
                end
            end },
            { id = "is_available", label = "is_available", auto = true, run = function(done)
                done(minigame.is_available() and "pass" or "fail", tostring(minigame.is_available()))
            end },
            { id = "platform", label = "platform", auto = true, run = function(done)
                local platform = minigame.platform()
                local known = platform == "wechat" or platform == "douyin" or platform == "tiktok"
                done(known and "pass" or "fail", tostring(platform))
            end },
            { id = "info", label = "info", auto = true, run = function(done)
                local info = minigame.info()
                if type(info) ~= "table" then
                    done("fail", "no info")
                elseif info.abi ~= minigame.ABI then
                    done("fail", ("bridge ABI %s, module ABI %s"):format(tostring(info.abi), tostring(minigame.ABI)))
                else
                    done("pass", ("ABI %s, tool %s, saves in %s"):format(info.abi, tostring(info.toolVersion), tostring(info.persistence)))
                end
            end },
            { id = "has_engine_audio", label = "engine audio", auto = true, run = function(done)
                local value = minigame.has_engine_audio()
                done(type(value) == "boolean" and "pass" or "fail", tostring(value))
            end },
            { id = "has", label = "has", auto = true, run = function(done)
                local known = minigame.has("getSystemInfoSync")
                local unknown = minigame.has("definitelyNotAnApi")
                done((known and not unknown) and "pass" or "fail",
                    ("getSystemInfoSync %s, definitelyNotAnApi %s"):format(tostring(known), tostring(unknown)))
            end },
            { id = "update", label = "update", auto = true, run = function(done)
                minigame.update()
                done("pass", "polled without an error")
            end },
            { id = "log", label = "log", auto = true, run = function(done)
                local ok = minigame.log("[apitest] a line written with minigame.log")
                done(ok and "pass" or "fail", ok and "written to the host console" or "the host console was not reached")
            end },
        },
    },
    {
        title = "Generic access",
        tests = {
            { id = "call_sync", label = "call_sync", auto = true, run = function(done)
                local data, err = minigame.call_sync("getSystemInfoSync")
                if type(data) == "table" and tonumber(data.windowWidth) then
                    done("pass", ("window %sx%s"):format(tostring(data.windowWidth), tostring(data.windowHeight)))
                else
                    done("fail", err or "no window size in the answer")
                end
            end },
            { id = "call", label = "call", auto = true, run = function(done)
                if not requires("getSystemInfo", done) then return end
                minigame.call("getSystemInfo", {}, function(result, err)
                    if err then
                        done("fail", err)
                    else
                        done("pass", "answered later: " .. tostring(result.model))
                    end
                end)
            end },
            { id = "call_unknown", label = "call (unknown)", auto = true, run = function(done)
                minigame.call("definitelyNotAnApi", {}, function(result, err)
                    if result == nil and tostring(err):find("is not supported", 1, true) then
                        done("pass", "refused with a clear error")
                    else
                        done("fail", "expected an error, got " .. brief(result or err))
                    end
                end)
            end },
            { id = "on_off", label = "on / off", auto = true, run = function(done)
                local id, err = minigame.on("onShow", function() end)
                if not id then
                    done("fail", err)
                    return
                end
                minigame.off(id)
                done("pass", "subscribed and cancelled")
            end },
            { id = "create", label = "create", auto = true, run = function(done)
                if not requires("createInnerAudioContext", done) then return end
                local object, err = minigame.create("createInnerAudioContext", {})
                if not object then
                    done("fail", err)
                    return
                end
                local set_ok, set_err = object:set("volume", 0)
                local volume = object:get("volume")
                object:invoke("stop", {})
                object:destroy()
                local _, destroyed_err = object:get("volume")
                if not set_ok then
                    done("fail", "set failed: " .. tostring(set_err))
                elseif tonumber(volume) ~= 0 then
                    done("fail", "volume read back as " .. tostring(volume))
                elseif destroyed_err == nil then
                    done("fail", "a destroyed object still answered")
                else
                    done("pass", "created, set, read, invoked, destroyed")
                end
            end },
        },
    },
    {
        title = "Account",
        hint = "talks to the platform's servers",
        tests = {
            { id = "login", label = "login", run = function(done)
                minigame.login(function(code, err)
                    if err then
                        done("fail", err)
                    elseif type(code) == "string" and #code > 0 then
                        -- The code is a credential; show that it came, not what it is.
                        done("pass", ("a login code of %d characters"):format(#code))
                    else
                        done("fail", "no code in the answer")
                    end
                end)
            end },
            { id = "check_session", label = "check_session", run = function(done)
                minigame.check_session(function(valid, err)
                    done("pass", valid and "the session is valid" or ("no valid session: " .. tostring(err)))
                end)
            end },
        },
    },
    {
        title = "Key-value storage",
        tests = {
            { id = "storage_set", label = "set", auto = true, run = function(done)
                local ok, err = minigame.storage_set("apitest.value", "stored by the API test")
                done(ok and "pass" or "fail", ok and "stored" or err)
            end },
            { id = "storage_get", label = "get", auto = true, run = function(done)
                minigame.storage_set("apitest.value", "stored by the API test")
                local value = minigame.storage_get("apitest.value", "missing")
                local fallback = minigame.storage_get("apitest.never-set", "fallback")
                if value == "stored by the API test" and fallback == "fallback" then
                    done("pass", "read back, and a missing key gave the default")
                else
                    done("fail", ("got %s and %s"):format(brief(value), brief(fallback)))
                end
            end },
            { id = "storage_remove", label = "remove", auto = true, run = function(done)
                minigame.storage_set("apitest.value", "to be removed")
                local ok, err = minigame.storage_remove("apitest.value")
                local value = minigame.storage_get("apitest.value", "gone")
                if ok and value == "gone" then
                    done("pass", "removed")
                else
                    done("fail", err or ("still there: " .. brief(value)))
                end
            end },
            { id = "storage_clear", label = "clear", run = function(done)
                local ok, err = minigame.storage_clear()
                done(ok and "pass" or "fail", ok and "every key removed" or err)
            end },
        },
    },
    {
        title = "Native UI",
        tests = {
            { id = "show_toast", label = "toast", auto = true, run = function(done)
                if not requires("showToast", done) then return end
                accepted(done, minigame.show_toast("API test", { duration = 800 }), "toast requested")
            end },
            { id = "hide_toast", label = "hide toast", auto = true, run = function(done)
                if not requires("hideToast", done) then return end
                accepted(done, minigame.hide_toast(), "hide requested")
            end },
            { id = "show_modal", label = "modal", run = function(done)
                if not requires("showModal", done) then return end
                minigame.show_modal({ title = "API test", content = "Confirm or cancel." }, function(confirmed, err)
                    if err then
                        done("fail", err)
                    else
                        done("pass", confirmed and "confirmed" or "cancelled")
                    end
                end)
            end },
            { id = "show_loading", label = "loading", auto = true, run = function(done, env)
                if not requires("showLoading", done) then return end
                if not minigame.show_loading("API test") then
                    done("fail", "the host refused the call")
                    return
                end
                env.delay(0.4, function()
                    accepted(done, minigame.hide_loading(), "shown, then hidden")
                end)
            end },
            { id = "hide_loading", label = "hide loading", auto = true, run = function(done)
                if not requires("hideLoading", done) then return end
                accepted(done, minigame.hide_loading(), "hide requested")
            end },
            { id = "vibrate_short", label = "vibrate short", auto = true, run = function(done)
                if not requires("vibrateShort", done) then return end
                accepted(done, minigame.vibrate_short("light"), "requested")
            end },
            { id = "vibrate_long", label = "vibrate long", auto = true, run = function(done)
                if not requires("vibrateLong", done) then return end
                accepted(done, minigame.vibrate_long(), "requested")
            end },
            { id = "set_clipboard", label = "copy", run = function(done)
                if not requires("setClipboardData", done) then return end
                minigame.set_clipboard("copied by the Defold Mini Game API test", function(ok, err)
                    done(ok and "pass" or "fail", ok and "copied" or err)
                end)
            end },
            { id = "get_clipboard", label = "paste", run = function(done)
                if not requires("getClipboardData", done) then return end
                minigame.get_clipboard(function(text, err)
                    if err then
                        done("fail", err)
                    else
                        done("pass", ("%d characters on the clipboard"):format(#text))
                    end
                end)
            end },
            { id = "set_keep_screen_on", label = "keep screen on", auto = true, run = function(done)
                if not requires("setKeepScreenOn", done) then return end
                local on = minigame.set_keep_screen_on(true)
                local off = minigame.set_keep_screen_on(false)
                accepted(done, on and off, "turned on, then off")
            end },
        },
    },
    {
        title = "System",
        tests = {
            { id = "get_system_info", label = "system info", auto = true, run = function(done)
                local info = minigame.get_system_info()
                if tonumber(info.windowWidth) and tonumber(info.pixelRatio) then
                    done("pass", ("%s, %s, ratio %s"):format(tostring(info.model), tostring(info.system), tostring(info.pixelRatio)))
                else
                    done("fail", "no window size or pixel ratio: " .. brief(info))
                end
            end },
            { id = "get_safe_area", label = "safe area", auto = true, run = function(done)
                local area = minigame.get_safe_area()
                if type(area) == "table" then
                    done("pass", ("top %s, bottom %s"):format(tostring(area.top), tostring(area.bottom)))
                else
                    done("skip", "the host reports no safe area")
                end
            end },
            { id = "get_menu_button_rect", label = "menu button", auto = true, run = function(done)
                local rect = minigame.get_menu_button_rect()
                if type(rect) == "table" and tonumber(rect.width) then
                    done("pass", ("%sx%s at top %s"):format(tostring(rect.width), tostring(rect.height), tostring(rect.top)))
                else
                    done("skip", "the host has no menu capsule")
                end
            end },
            { id = "get_launch_options", label = "launch options", auto = true, run = function(done)
                local options = minigame.get_launch_options()
                done(type(options) == "table" and "pass" or "fail", "scene " .. tostring(options.scene))
            end },
            { id = "on_show", label = "on_show", auto = true, run = function(done)
                local count = 0
                local id, err = minigame.on_show(function()
                    count = count + 1
                    done("pass", ("the game came to the foreground %d time(s)"):format(count))
                end)
                done(id and "pass" or "fail", id and "subscribed; switch away and back to see it fire" or err)
            end },
            { id = "on_hide", label = "on_hide", auto = true, run = function(done)
                local count = 0
                local id, err = minigame.on_hide(function()
                    count = count + 1
                    done("pass", ("the game went to the background %d time(s)"):format(count))
                end)
                done(id and "pass" or "fail", id and "subscribed; switch away to see it fire" or err)
            end },
            { id = "restart", label = "restart", run = function(done)
                if not requires("restartMiniProgram", done) then return end
                accepted(done, minigame.restart(), "restart requested")
            end },
            { id = "exit", label = "exit", run = function(done)
                if not requires("exitMiniProgram", done) then return end
                accepted(done, minigame.exit(), "exit requested")
            end },
        },
    },
    {
        title = "Sharing",
        tests = {
            { id = "set_share_content", label = "share content", auto = true, run = function(done)
                -- TikTok has no hook for its share menu; "share now" is what works there.
                if not requires("onShareAppMessage", done) then return end
                local ok, err = minigame.set_share_content({ title = "Defold Mini Game API test" })
                done(ok and "pass" or "fail", ok and "the share menu will send this title" or err)
            end },
            { id = "share", label = "share now", run = function(done)
                if not requires("shareAppMessage", done) then return end
                accepted(done, minigame.share({ title = "Defold Mini Game API test" }), "share sheet requested")
            end },
        },
    },
    {
        title = "Ads",
        hint = "placeholder ad unit: expect the host's refusal",
        tests = {
            { id = "create_rewarded_video_ad", label = "rewarded", run = function(done)
                if not requires("createRewardedVideoAd", done) then return end
                local ad, err = minigame.create_rewarded_video_ad(M.PLACEHOLDER_AD_UNIT)
                if not ad then
                    done("info", "not created: " .. tostring(err))
                    return
                end
                ad:show(function(ended, show_err)
                    ad:destroy()
                    if show_err then
                        done("info", "the host answered: " .. brief(show_err))
                    else
                        done("pass", ended and "watched to the end" or "closed early")
                    end
                end)
            end },
            { id = "create_interstitial_ad", label = "interstitial", run = function(done)
                if not requires("createInterstitialAd", done) then return end
                local ad, err = minigame.create_interstitial_ad(M.PLACEHOLDER_AD_UNIT)
                if not ad then
                    done("info", "not created: " .. tostring(err))
                    return
                end
                ad:show(function(shown, show_err)
                    ad:destroy()
                    done(shown and "pass" or "info", shown and "shown" or ("the host answered: " .. brief(show_err)))
                end)
            end },
            { id = "create_banner_ad", label = "banner", run = function(done, env)
                if not requires("createBannerAd", done) then return end
                local banner, err = minigame.create_banner_ad(M.PLACEHOLDER_AD_UNIT, { left = 0, top = 0, width = 300 })
                if not banner then
                    done("info", "not created: " .. tostring(err))
                    return
                end
                banner:show(function(shown, show_err)
                    done(shown and "pass" or "info", shown and "shown for two seconds" or ("the host answered: " .. brief(show_err)))
                    env.delay(2, function()
                        banner:hide()
                        banner:destroy()
                    end)
                end)
            end },
        },
    },
    {
        title = "Payment",
        hint = "no payment is configured: expect the host's refusal",
        tests = {
            { id = "request_payment", label = "pay", run = function(done)
                minigame.request_payment({}, function(paid, err)
                    if paid then
                        done("pass", "paid")
                    else
                        done("info", "the host answered: " .. brief(err))
                    end
                end)
            end },
        },
    },
    {
        title = "Host audio",
        tests = {
            { id = "inner_audio", label = "inner_audio", auto = true, timeout = 8, run = function(done)
                if not requires("createInnerAudioContext", done) then return end
                local audio, err = minigame.inner_audio(M.TONE, { volume = 0.4 })
                if not audio then
                    done("fail", err)
                    return
                end
                audio.object:on("onError", function(event)
                    audio:destroy()
                    done("fail", "the host could not play " .. M.TONE .. ": " .. brief(event.errMsg or event.errCode))
                end)
                audio:on_ended(function()
                    audio:destroy()
                    done("pass", "played " .. M.TONE .. " to its end")
                end)
                audio:play()
            end },
        },
    },
    {
        title = "Subpackages",
        tests = {
            { id = "load_subpackage", label = "load engine", auto = true, timeout = 10, run = function(done)
                if not requires("loadSubpackage", done) then return end
                local progress = nil
                minigame.load_subpackage("engine", function(loaded, err)
                    if loaded then
                        done("pass", "loaded" .. (progress and (", progress reached " .. tostring(progress) .. "%") or ""))
                    else
                        done("fail", err)
                    end
                end, function(percent)
                    progress = percent
                end)
            end },
            { id = "subpackage_load", label = "load extras", auto = true, timeout = 15, run = function(done)
                with_extras(done, function(progress)
                    done("pass", "loaded '" .. M.EXTRAS .. "'" .. (progress and (", progress reached " .. tostring(progress) .. "%") or ""))
                end)
            end },
            { id = "subpackage_read", label = "read from extras", auto = true, timeout = 15, run = function(done)
                -- TikTok's file system is off limits to games; there the next test reads the subpackage.
                if not requires("getFileSystemManager", done) then return end
                with_extras(done, function()
                    local files, err = minigame.create("getFileSystemManager")
                    if not files then
                        done("fail", err)
                        return
                    end
                    local text, read_err = files:invoke("readFileSync", { M.EXTRAS_NOTE, "utf8" })
                    files:destroy()
                    if type(text) ~= "string" then
                        done("fail", "could not read " .. M.EXTRAS_NOTE .. ": " .. brief(read_err))
                    elseif text:gsub("%s+$", "") ~= M.EXTRAS_NOTE_TEXT then
                        done("fail", M.EXTRAS_NOTE .. " holds something else: " .. brief(text))
                    else
                        done("pass", "read " .. M.EXTRAS_NOTE .. ": " .. M.EXTRAS_NOTE_TEXT)
                    end
                end)
            end },
            { id = "subpackage_audio", label = "play from extras", auto = true, timeout = 15, run = function(done)
                if not requires("createInnerAudioContext", done) then return end
                with_extras(done, function()
                    local audio, err = minigame.inner_audio(M.EXTRAS_CHIME, { volume = 0.4 })
                    if not audio then
                        done("fail", err)
                        return
                    end
                    audio.object:on("onError", function(event)
                        audio:destroy()
                        done("fail", "the host could not play " .. M.EXTRAS_CHIME .. ": " .. brief(event.errMsg or event.errCode))
                    end)
                    audio:on_ended(function()
                        audio:destroy()
                        done("pass", "played " .. M.EXTRAS_CHIME .. " to its end")
                    end)
                    audio:play()
                end)
            end },
        },
    },
}

--- Every test in order, with its section.
function M.all()
    local list = {}
    for _, section in ipairs(M.sections) do
        for _, test in ipairs(section.tests) do
            list[#list + 1] = { section = section, test = test }
        end
    end
    return list
end

return M
