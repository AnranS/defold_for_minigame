--- Mini-game platform SDK for Defold: WeChat, Douyin, and TikTok Native.
--
-- One module, three hosts. Every call goes through the bridge the exporter
-- installs behind html5.run(), is checked against what the host supports, and
-- is safe to make when the game is not running in a mini game at all (the
-- editor, a desktop build, a plain HTML5 build): getters return defaults and
-- callbacks receive an error string.
--
-- Usage:
--   local minigame = require "minigame.minigame"
--   -- add /minigame/minigame.go to your bootstrap collection, or call
--   -- minigame.update() once per frame yourself.
--   minigame.login(function(code, err) ... end)
--
-- Callback convention: the first argument is the result (nil on failure), the
-- last one is an error string (nil on success).

local M = {}

--- Bridge ABI this module speaks. The exported runtime must match exactly.
M.ABI = 1
M.VERSION = "0.1.0"

local HANDSHAKE = "typeof DefoldMiniGameBridge==='object'?DefoldMiniGameBridge.handshake():''"
local BRAND = "defold-mini-game-bridge"
local NOT_AVAILABLE = "not running in a mini game"

-- Every Lua state that loads this module is a client of its own. Defold runs
-- game object scripts and GUI scripts in separate Lua states unless
-- script.shared_state is set, and each state polls the bridge for itself, so
-- ids and object handles carry the client's name and update() asks only for
-- this client's results.
local state = {
    initialized = false,
    ready = false,
    info = nil,
    client = nil,
    next_id = 0,
    next_handle = 0,
    owners = {},        -- id -> the script that registered the callback
    pollers = {},       -- script -> the tick of its last update()
    tick = 0,
    backlog = {},       -- events waiting for the script that owns them
    pending = {},       -- id -> one-shot callback
    listeners = {},     -- id -> persistent handler
    share_bound = false,
}

local function new_id()
    state.next_id = state.next_id + 1
    return state.client .. ":" .. state.next_id
end

local function new_handle()
    state.next_handle = state.next_handle + 1
    return state.client .. ":h" .. state.next_handle
end

local send

--- Warnings go to the host's console once the bridge is there: a release
-- build of the engine drops print(), and that is the build players get.
local function warn(message)
    message = "[minigame] " .. tostring(message)
    if state.ready and send({ op = "log", level = "warn", message = message }) then
        return
    end
    print(message)
end

--- Sends one bridge command and returns the decoded reply.
-- @return reply table, or nil and an error string
send = function(command)
    local ok, reply = pcall(html5.run, json.encode(command))
    if not ok then
        return nil, tostring(reply)
    end
    if reply == nil or reply == "" then
        return nil, nil
    end
    local decoded_ok, decoded = pcall(json.decode, reply)
    if not decoded_ok or type(decoded) ~= "table" then
        return nil, "malformed bridge reply"
    end
    return decoded, nil
end

--- Sends a command and reduces the reply to data, error.
local function request(command)
    local reply, err = send(command)
    if not reply then
        return nil, err or "the bridge did not reply"
    end
    if reply.ok ~= true then
        return nil, tostring(reply.error or "the bridge reported a failure")
    end
    return reply, nil
end

local function safe_call(fn, ...)
    if type(fn) ~= "function" then
        return
    end
    local ok, err = pcall(fn, ...)
    if not ok then
        warn("callback failed: " .. tostring(err))
    end
end

--- Names the script that is running, or returns nil outside the engine.
local function running_script()
    if type(msg) ~= "table" or type(msg.url) ~= "function" then
        return nil
    end
    local ok, url = pcall(msg.url)
    if ok and url ~= nil then
        return tostring(url)
    end
    return nil
end

--- How many update() calls by other scripts a script may miss before its
-- results are handed to whoever polls. A script that was deleted never polls
-- again; a script whose collection is only paused will.
local ABANDONED_AFTER = 240

--- Remembers which script registered a callback. Results are delivered by
-- update(), and gui.*, go.*, and msg.post(".") act on the script that is
-- running, so a result has to be delivered while its own script runs.
local function own(id)
    state.owners[id] = running_script()
end

--- Finds the bridge. Called lazily by every function; calling it yourself is optional.
-- @return true when the game runs in a supported mini-game host
function M.init()
    if state.initialized then
        return state.ready
    end
    state.initialized = true
    if type(html5) ~= "table" or type(html5.run) ~= "function" then
        return false
    end
    local ok, reply = pcall(html5.run, HANDSHAKE)
    if not ok or type(reply) ~= "string" or reply == "" then
        return false
    end
    local decoded_ok, info = pcall(json.decode, reply)
    if not decoded_ok or type(info) ~= "table" or info.brand ~= BRAND then
        return false
    end
    if info.abi ~= M.ABI then
        warn("bridge ABI " .. tostring(info.abi) .. " does not match this module's ABI " .. M.ABI
            .. "; update the minigame library and the exporter together")
        return false
    end
    state.info = info
    -- The bridge names each client. A runtime from before it did so is told
    -- apart by the address of a table that belongs to this Lua state.
    state.client = tostring(info.client or tostring({}):match("0x(%x+)") or os.time())
    state.ready = true
    return true
end

--- True when the game runs in a mini-game host this module can talk to.
function M.is_available()
    return M.init()
end

--- "wechat", "douyin", "tiktok", or nil outside a mini game.
function M.platform()
    if not M.init() then
        return nil
    end
    return state.info.platform
end

--- What the bridge reported at start-up: platform, capabilities, system, persistence, engineAudio,
-- and subpackages, the names the export declared with --subpackage.
function M.info()
    if not M.init() then
        return nil
    end
    return state.info
end

--- True when the engine's own sound components produce audio on this host.
-- It is false on TikTok by default; use minigame.inner_audio() there.
function M.has_engine_audio()
    return M.init() and state.info.engineAudio == true
end

--- True when the host implements the named API.
function M.has(api)
    if not M.init() then
        return false
    end
    local reply = request({ op = "has", apis = { api } })
    return reply ~= nil and type(reply.data) == "table" and reply.data[api] == true
end

--- Delivers queued results and host events. Call once per frame.
-- /minigame/minigame.go does this for you. A callback runs in the script that
-- calls update(): a script that calls it gets its own results and no other
-- script's, and a script that never calls it is served by one that does.
-- So a GUI script whose callbacks use gui.* calls update() in its own update().
function M.update()
    if not state.ready then
        return
    end
    local me = running_script()
    state.tick = state.tick + 1
    if me then
        state.pollers[me] = state.tick
    end

    local events = send({ op = "poll", client = state.client })
    local backlog = state.backlog
    if type(events) == "table" then
        for index = 1, #events do
            backlog[#backlog + 1] = events[index]
        end
    end
    if #backlog == 0 then
        return
    end

    local waiting = {}
    state.backlog = waiting
    for index = 1, #backlog do
        local event = backlog[index]
        local id = event.id
        local owner = state.owners[id]
        local last_poll = owner and state.pollers[owner]
        if owner and owner ~= me and last_poll and state.tick - last_poll <= ABANDONED_AFTER then
            -- Its own script polls; the result waits for it.
            waiting[#waiting + 1] = event
        else
            local once = state.pending[id]
            if once then
                state.pending[id] = nil
                state.owners[id] = nil
                if event.ok then
                    safe_call(once, event.data or {}, nil)
                else
                    safe_call(once, nil, tostring(event.error or "failed"))
                end
            else
                local listener = state.listeners[id]
                if listener then
                    safe_call(listener, event.data or {})
                end
            end
        end
    end
end

--- Writes a line to the host's console. print() is dropped by a release build of the engine; this is not.
-- @param level "info" (the default), "warn", or "error"
-- @return true when the line was written, false outside a mini game
function M.log(message, level)
    if not M.init() then
        return false
    end
    local _, err = request({ op = "log", level = level or "info", message = tostring(message) })
    return err == nil
end

-- ---------------------------------------------------------------------------
-- Generic access: anything the host offers, whether or not it has a wrapper
-- ---------------------------------------------------------------------------

--- Calls an asynchronous host API (one that takes success / fail callbacks).
-- @param api name, for example "login"
-- @param args options table, may be nil
-- @param callback function(result, err), may be nil
function M.call(api, args, callback)
    if not M.init() then
        safe_call(callback, nil, NOT_AVAILABLE)
        return false
    end
    local id = new_id()
    local _, err = request({ op = "call", api = api, args = args or {}, id = id })
    if err then
        safe_call(callback, nil, err)
        return false
    end
    if callback then
        state.pending[id] = callback
        own(id)
    end
    return true
end

--- Calls a synchronous host API with positional arguments.
-- @return the host's return value, or nil and an error string
function M.call_sync(api, ...)
    if not M.init() then
        return nil, NOT_AVAILABLE
    end
    local reply, err = request({ op = "sync", api = api, args = { ... } })
    if err then
        return nil, err
    end
    return reply.data, nil
end

--- Subscribes to a host event such as "onShow". The handler receives the event table.
-- @return a subscription id for minigame.off(), or nil and an error string
function M.on(event, handler)
    if not M.init() then
        return nil, NOT_AVAILABLE
    end
    local id = new_id()
    local _, err = request({ op = "on", event = event, id = id })
    if err then
        return nil, err
    end
    state.listeners[id] = handler
    own(id)
    return id, nil
end

--- Cancels a subscription made with minigame.on() or object:on().
function M.off(id)
    if id == nil then
        return
    end
    state.listeners[id] = nil
    state.owners[id] = nil
    if state.ready then
        request({ op = "off", id = id })
    end
end

local Object = {}
Object.__index = Object

--- Calls a method of a host object.
-- @param method name, for example "show"
-- @param args array of positional arguments, may be nil
-- @param callback function(result, err) for methods that return a promise, may be nil
-- @return the method's return value for synchronous methods
function Object:invoke(method, args, callback)
    if self.destroyed then
        safe_call(callback, nil, "the object was destroyed")
        return nil, "the object was destroyed"
    end
    local id = callback and new_id() or nil
    local reply, err = request({ op = "invoke", handle = self.handle, method = method, args = args or {}, id = id })
    if err then
        safe_call(callback, nil, err)
        return nil, err
    end
    if callback then
        if reply.async then
            state.pending[id] = callback
            own(id)
        else
            safe_call(callback, reply.data or {}, nil)
        end
    end
    return reply.data, nil
end

--- Subscribes to an event of a host object, for example "onClose".
function Object:on(event, handler)
    if self.destroyed then
        return nil, "the object was destroyed"
    end
    local id = new_id()
    local _, err = request({ op = "listen", handle = self.handle, event = event, id = id })
    if err then
        return nil, err
    end
    state.listeners[id] = handler
    own(id)
    self.subscriptions[#self.subscriptions + 1] = id
    return id, nil
end

--- Reads a property of the host object.
function Object:get(prop)
    if self.destroyed then
        return nil, "the object was destroyed"
    end
    local reply, err = request({ op = "get", handle = self.handle, prop = prop })
    if err then
        return nil, err
    end
    return reply.data, nil
end

--- Writes a property of the host object. Returns true, or false and an error string.
function Object:set(prop, value)
    if self.destroyed then
        return false, "the object was destroyed"
    end
    local _, err = request({ op = "set", handle = self.handle, prop = prop, value = value })
    return err == nil, err
end

--- Releases the host object and its subscriptions.
function Object:destroy()
    if self.destroyed then
        return
    end
    self.destroyed = true
    for index = 1, #self.subscriptions do
        state.listeners[self.subscriptions[index]] = nil
        state.owners[self.subscriptions[index]] = nil
    end
    self.subscriptions = {}
    request({ op = "release", handle = self.handle })
end

--- Creates a host object, for example minigame.create("createRewardedVideoAd", { adUnitId = "..." }).
-- @return an object with :invoke, :on, :get, :set, :destroy, or nil and an error string
function M.create(api, args)
    if not M.init() then
        return nil, NOT_AVAILABLE
    end
    local handle = new_handle()
    local _, err = request({ op = "new", api = api, args = args, handle = handle })
    if err then
        return nil, err
    end
    return setmetatable({ handle = handle, api = api, subscriptions = {}, destroyed = false }, Object), nil
end

-- ---------------------------------------------------------------------------
-- Account
-- ---------------------------------------------------------------------------

--- Logs in. callback(code, err): send the code to your server to exchange it for a session.
function M.login(callback)
    M.call("login", {}, function(result, err)
        if err then
            safe_call(callback, nil, err)
        else
            safe_call(callback, result.code, nil)
        end
    end)
end

--- callback(valid): whether the login session is still valid.
function M.check_session(callback)
    M.call("checkSession", {}, function(_, err)
        safe_call(callback, err == nil, err)
    end)
end

-- ---------------------------------------------------------------------------
-- Key-value storage (small strings; use sys.save() for save files)
-- ---------------------------------------------------------------------------

--- Stores a string under a key. Returns true, or false and an error string.
function M.storage_set(key, value)
    local _, err = M.call_sync("setStorageSync", tostring(key), tostring(value))
    return err == nil, err
end

--- Reads a stored string; returns `default` when the key is missing or the host is unavailable.
function M.storage_get(key, default)
    local value, err = M.call_sync("getStorageSync", tostring(key))
    if err or value == nil or value == "" then
        return default
    end
    return value
end

--- Removes one key.
function M.storage_remove(key)
    local _, err = M.call_sync("removeStorageSync", tostring(key))
    return err == nil, err
end

--- Removes every key the game stored.
function M.storage_clear()
    local _, err = M.call_sync("clearStorageSync")
    return err == nil, err
end

-- ---------------------------------------------------------------------------
-- Native UI
-- ---------------------------------------------------------------------------

--- options: icon ("success" | "error" | "loading" | "none"), duration (ms), mask
function M.show_toast(title, options)
    local args = { title = tostring(title), icon = "none", duration = 1500 }
    for key, value in pairs(options or {}) do
        args[key] = value
    end
    return M.call("showToast", args)
end

--- Hides the toast shown by show_toast().
function M.hide_toast()
    return M.call("hideToast", {})
end

--- options: title, content, showCancel, confirmText, cancelText. callback(confirmed, err)
function M.show_modal(options, callback)
    M.call("showModal", options or {}, function(result, err)
        if err then
            safe_call(callback, nil, err)
        else
            safe_call(callback, result.confirm == true, nil)
        end
    end)
end

--- Shows the host's modal loading indicator with a title.
function M.show_loading(title)
    return M.call("showLoading", { title = tostring(title or ""), mask = true })
end

--- Hides the loading indicator.
function M.hide_loading()
    return M.call("hideLoading", {})
end

--- kind: "heavy" | "medium" | "light"
function M.vibrate_short(kind)
    return M.call("vibrateShort", { type = kind or "medium" })
end

--- A long vibration, about 400 ms.
function M.vibrate_long()
    return M.call("vibrateLong", {})
end

--- Copies text to the clipboard. callback(ok, err)
function M.set_clipboard(text, callback)
    M.call("setClipboardData", { data = tostring(text) }, function(_, err)
        safe_call(callback, err == nil, err)
    end)
end

--- callback(text, err)
function M.get_clipboard(callback)
    M.call("getClipboardData", {}, function(result, err)
        if err then
            safe_call(callback, nil, err)
        else
            safe_call(callback, tostring(result.data or ""), nil)
        end
    end)
end

--- Keeps the screen awake while the game is in the foreground.
function M.set_keep_screen_on(keep_on)
    return M.call("setKeepScreenOn", { keepScreenOn = keep_on == true })
end

-- ---------------------------------------------------------------------------
-- System
-- ---------------------------------------------------------------------------

--- brand, model, platform, system, language, pixelRatio, windowWidth, windowHeight, safeArea, ...
function M.get_system_info()
    if not M.init() then
        return {}
    end
    local data = M.call_sync("getSystemInfoSync")
    if type(data) == "table" then
        return data
    end
    return state.info.system or {}
end

--- top, bottom, left, right, width, height of the area not covered by notches, in logical pixels.
function M.get_safe_area()
    local info = M.get_system_info()
    return info.safeArea
end

--- The rectangle of the host's menu capsule; keep UI out of it. nil where the host has none.
function M.get_menu_button_rect()
    local rect = M.call_sync("getMenuButtonBoundingClientRect")
    if type(rect) == "table" then
        return rect
    end
    return nil
end

--- scene, query, and referrer the game was opened with.
function M.get_launch_options()
    local options = M.call_sync("getLaunchOptionsSync")
    if type(options) == "table" then
        return options
    end
    return {}
end

--- handler(event) when the game returns to the foreground. Returns a subscription id.
function M.on_show(handler)
    return M.on("onShow", handler)
end

--- handler(event) when the game goes to the background.
function M.on_hide(handler)
    return M.on("onHide", handler)
end

--- Closes the mini game.
function M.exit()
    return M.call("exitMiniProgram", {})
end

--- Restarts the mini game.
function M.restart()
    return M.call("restartMiniProgram", {})
end

-- ---------------------------------------------------------------------------
-- Sharing
-- ---------------------------------------------------------------------------

--- Sets what the host's share menu sends: title, imageUrl, query.
-- Hosts ask for this content synchronously, so it is set ahead of time.
function M.set_share_content(content)
    if not M.init() then
        return false, NOT_AVAILABLE
    end
    local _, err = request({ op = "share", content = content or {} })
    if err then
        return false, err
    end
    M.call("showShareMenu", {})
    return true, nil
end

--- Opens the share sheet now: title, imageUrl, query.
function M.share(content)
    return M.call("shareAppMessage", content or {})
end

-- ---------------------------------------------------------------------------
-- Ads
-- ---------------------------------------------------------------------------

--- Rewarded video. ad:show(function(ended, err) ... end) reports whether the player watched to the end.
function M.create_rewarded_video_ad(ad_unit_id)
    local object, err = M.create("createRewardedVideoAd", { adUnitId = ad_unit_id })
    if not object then
        return nil, err
    end
    local ad = { object = object, waiting = nil }
    object:on("onClose", function(event)
        local waiting = ad.waiting
        ad.waiting = nil
        -- Hosts older than the isEnded flag always report a finished video.
        safe_call(waiting, event.isEnded == nil or event.isEnded == true, nil)
    end)
    object:on("onError", function(event)
        local waiting = ad.waiting
        ad.waiting = nil
        safe_call(waiting, false, tostring(event.errMsg or event.errCode or "ad error"))
    end)
    function ad:load(callback)
        self.object:invoke("load", {}, function(_, load_err)
            safe_call(callback, load_err == nil, load_err)
        end)
    end
    function ad:show(callback)
        self.waiting = callback
        self.object:invoke("show", {}, function(_, show_err)
            if show_err then
                local waiting = self.waiting
                self.waiting = nil
                safe_call(waiting, false, show_err)
            end
        end)
    end
    function ad:destroy()
        self.object:destroy()
    end
    return ad, nil
end

--- Interstitial. ad:show(function(shown, err) ... end)
function M.create_interstitial_ad(ad_unit_id)
    local object, err = M.create("createInterstitialAd", { adUnitId = ad_unit_id })
    if not object then
        return nil, err
    end
    local ad = { object = object }
    function ad:show(callback)
        self.object:invoke("show", {}, function(_, show_err)
            safe_call(callback, show_err == nil, show_err)
        end)
    end
    function ad:destroy()
        self.object:destroy()
    end
    return ad, nil
end

--- Banner. style: left, top, width (logical pixels). banner:show(), banner:hide(), banner:destroy()
function M.create_banner_ad(ad_unit_id, style)
    local object, err = M.create("createBannerAd", { adUnitId = ad_unit_id, style = style or { left = 0, top = 0, width = 300 } })
    if not object then
        return nil, err
    end
    local banner = { object = object }
    function banner:show(callback)
        self.object:invoke("show", {}, function(_, show_err)
            safe_call(callback, show_err == nil, show_err)
        end)
    end
    function banner:hide()
        self.object:invoke("hide", {})
    end
    function banner:destroy()
        self.object:destroy()
    end
    return banner, nil
end

-- ---------------------------------------------------------------------------
-- Payment
-- ---------------------------------------------------------------------------

local PAYMENT_API = { wechat = "requestMidasPayment", douyin = "requestGamePayment", tiktok = "pay" }

--- Starts the host's payment flow. The options are host-specific and passed through unchanged;
-- see each platform's payment documentation. callback(paid, err)
function M.request_payment(options, callback)
    local api = PAYMENT_API[M.platform() or ""]
    if not api then
        safe_call(callback, false, NOT_AVAILABLE)
        return
    end
    M.call(api, options or {}, function(_, err)
        safe_call(callback, err == nil, err)
    end)
end

-- ---------------------------------------------------------------------------
-- Audio played by the host (works where the engine mixer is off, such as TikTok)
-- ---------------------------------------------------------------------------

--- Creates a host audio player for a file in the package or a URL.
-- options: loop, volume, autoplay. Returns an object with :play, :pause, :stop, :seek,
-- :set_volume, :set_loop, :on_ended, :destroy.
function M.inner_audio(src, options)
    local object, err = M.create("createInnerAudioContext", {})
    if not object then
        return nil, err
    end
    options = options or {}
    object:set("src", tostring(src))
    if options.loop ~= nil then object:set("loop", options.loop == true) end
    if options.volume ~= nil then object:set("volume", options.volume) end
    if options.autoplay ~= nil then object:set("autoplay", options.autoplay == true) end
    local audio = { object = object }
    function audio:play() self.object:invoke("play", {}) end
    function audio:pause() self.object:invoke("pause", {}) end
    function audio:stop() self.object:invoke("stop", {}) end
    function audio:seek(seconds) self.object:invoke("seek", { seconds }) end
    function audio:set_volume(volume) self.object:set("volume", volume) end
    function audio:set_loop(loop) self.object:set("loop", loop == true) end
    function audio:on_ended(handler) return self.object:on("onEnded", handler) end
    function audio:destroy() self.object:destroy() end
    return audio, nil
end

-- ---------------------------------------------------------------------------
-- Subpackages
-- ---------------------------------------------------------------------------

--- Loads a subpackage the export declared with --subpackage name=dir.
-- Once loaded, its files are in the package under name/, for example as the
-- source of minigame.inner_audio(). callback(loaded, err), progress(percent)
function M.load_subpackage(name, callback, progress)
    if not M.init() then
        safe_call(callback, false, NOT_AVAILABLE)
        return
    end
    local handle = new_handle()
    local id = new_id()
    local _, err = request({ op = "call", api = "loadSubpackage", args = { name = name }, id = id, handle = handle })
    if err then
        safe_call(callback, false, err)
        return
    end
    local task = setmetatable({ handle = handle, api = "loadSubpackage", subscriptions = {}, destroyed = false }, Object)
    if progress then
        task:on("onProgressUpdate", function(event)
            safe_call(progress, tonumber(event.progress) or 0)
        end)
    end
    state.pending[id] = function(_, load_err)
        task:destroy()
        safe_call(callback, load_err == nil, load_err)
    end
    own(id)
end

return M
