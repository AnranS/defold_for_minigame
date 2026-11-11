# Lua SDK 参考

<!-- 本文件由 scripts/generate_api_docs.mjs 根据 minigame/minigame.lua 的注释生成，不要手工修改。 -->

`minigame` 模块共有 45 个函数。回调约定：第一个参数是结果（失败时为 nil），最后一个参数是错误信息（成功时为 nil）。不在小游戏里时，取值函数返回默认值，回调立即收到 `"not running in a mini game"`。

```lua
local minigame = require "minigame.minigame"
```

这里列出的是模块提供的函数，不代表每个宿主都支持其中的每一个。封装函数底层调用同名的宿主接口，宿主没有实现时，回调会收到“is not supported”的错误。

## 初始化与状态

### `minigame.init()`

查找桥。每个函数都会按需调用它，自己调用不是必须的。在受支持的小游戏宿主里返回 true。

### `minigame.is_available()`

游戏是否运行在本模块能对接的小游戏宿主里。

### `minigame.platform()`

返回 "wechat"、"douyin"、"tiktok"，不在小游戏里时返回 nil。

### `minigame.info()`

启动时桥上报的信息：平台、能力表、系统信息、存档后端、引擎音频是否可用，以及 subpackages：导出时用 --subpackage 声明的分包名。

### `minigame.has_engine_audio()`

引擎自带的 sound 组件在当前宿主上是否有声音。TikTok 默认是 false，这时请用 inner_audio()。

### `minigame.has(api)`

宿主是否实现了指定名称的接口。

### `minigame.update()`

派发排队的异步结果和宿主事件，每帧调用一次。/minigame/minigame.go 已经替你调用。回调在调用 update() 的那个脚本里执行：自己调用 update() 的脚本只收到自己的结果，从不调用的脚本由别的脚本代为派发。所以回调里要用 gui.* 的 GUI 脚本，应当在自己的 update() 里调用它。

### `minigame.log(message, level)`

向宿主的控制台写一行日志。引擎的 release 版会丢弃 print()，这个函数不会。level 取 "info"（默认）、"warn" 或 "error"。不在小游戏里时返回 false。

## 通用访问：宿主提供的任何接口，不论有没有封装

### `minigame.call(api, args, callback)`

调用宿主的异步接口（带 success / fail 回调的那类）。callback(result, err)。

### `minigame.call_sync(api, ...)`

用位置参数调用宿主的同步接口，返回宿主的返回值；失败返回 nil 和错误信息。

### `minigame.on(event, handler)`

订阅宿主事件，比如 "onShow"。返回订阅 id，用于 off()。

### `minigame.off(id)`

取消 on() 或 object:on() 建立的订阅。

### `minigame.create(api, args)`

创建宿主对象，比如 create("createRewardedVideoAd", { adUnitId = "..." })。返回带 :invoke、:on、:get、:set、:destroy 的对象。

## 账号

### `minigame.login(callback)`

登录。callback(code, err)：把 code 发给自己的服务器换取会话。

### `minigame.check_session(callback)`

检查登录态是否仍然有效。callback(valid)。

## 键值存储（存小字符串；存档请用 sys.save()）

### `minigame.storage_set(key, value)`

按键存一个字符串。成功返回 true，失败返回 false 和错误信息。

### `minigame.storage_get(key, default)`

读取字符串；键不存在或不在小游戏里时返回 default。

### `minigame.storage_remove(key)`

删除一个键。

### `minigame.storage_clear()`

删除游戏存过的所有键。

## 原生界面

### `minigame.show_toast(title, options)`

显示轻提示。options：icon（"success"、"error"、"loading"、"none"）、duration（毫秒）、mask。

### `minigame.hide_toast()`

隐藏 show_toast() 显示的提示。

### `minigame.show_modal(options, callback)`

显示模态对话框。options：title、content、showCancel、confirmText、cancelText。callback(confirmed, err)。

### `minigame.show_loading(title)`

显示宿主的模态加载提示。

### `minigame.hide_loading()`

隐藏加载提示。

### `minigame.vibrate_short(kind)`

短振动。kind："heavy"、"medium"、"light"。

### `minigame.vibrate_long()`

长振动，约 400 毫秒。

### `minigame.set_clipboard(text, callback)`

把文本复制到剪贴板。callback(ok, err)。

### `minigame.get_clipboard(callback)`

读取剪贴板文本。callback(text, err)。

### `minigame.set_keep_screen_on(keep_on)`

游戏在前台时保持屏幕常亮。

## 系统信息与生命周期

### `minigame.get_system_info()`

返回 brand、model、platform、system、language、pixelRatio、windowWidth、windowHeight、safeArea 等。

### `minigame.get_safe_area()`

未被刘海遮挡的区域：top、bottom、left、right、width、height，单位是逻辑像素。

### `minigame.get_menu_button_rect()`

宿主右上角胶囊按钮的矩形，界面要避开它。宿主没有胶囊时返回 nil。

### `minigame.get_launch_options()`

游戏被打开时的 scene、query 和来源信息。

### `minigame.on_show(handler)`

游戏回到前台时调用 handler(event)。返回订阅 id。

### `minigame.on_hide(handler)`

游戏进入后台时调用 handler(event)。

### `minigame.exit()`

关闭小游戏。

### `minigame.restart()`

重启小游戏。

## 分享

### `minigame.set_share_content(content)`

设置宿主分享菜单发出的内容：title、imageUrl、query。宿主是同步索取这份内容的，所以要提前设置。

### `minigame.share(content)`

立即拉起分享面板：title、imageUrl、query。

## 广告

### `minigame.create_rewarded_video_ad(ad_unit_id)`

激励视频。ad:show(function(ended, err) ... end) 告诉你玩家是否看完。

### `minigame.create_interstitial_ad(ad_unit_id)`

插屏广告。ad:show(function(shown, err) ... end)。

### `minigame.create_banner_ad(ad_unit_id, style)`

Banner 广告。style：left、top、width（逻辑像素）。banner:show()、banner:hide()、banner:destroy()。

## 支付

### `minigame.request_payment(options, callback)`

拉起宿主的支付流程。参数原样透传，各平台不同，见各平台的支付文档。callback(paid, err)。

| 平台 | 实际调用的宿主接口 |
|---|---|
| WeChat | `wx.requestMidasPayment` |
| Douyin | `tt.requestGamePayment` |
| TikTok | `TTMinis.game.pay` |

## 宿主播放的音频（在引擎混音器关闭的平台上也能用，比如 TikTok）

### `minigame.inner_audio(src, options)`

为包内文件或 URL 创建宿主音频播放器。options：loop、volume、autoplay。返回带 :play、:pause、:stop、:seek、:set_volume、:set_loop、:on_ended、:destroy 的对象。

## 分包

### `minigame.load_subpackage(name, callback, progress)`

加载导出时用 --subpackage 名字=目录 声明的分包。加载完成后，分包里的文件就在包内的 名字/ 目录下，比如可以作为 minigame.inner_audio() 的音源。callback(loaded, err)，progress(percent)。

## 宿主对象

`minigame.create()` 返回的对象，以及广告、音频封装内部的 `object` 字段，都有这些方法。

### `object:invoke(method, args, callback)`

调用宿主对象的方法。args 是位置参数数组；返回 Promise 的方法通过 callback(result, err) 回报。

### `object:on(event, handler)`

订阅宿主对象的事件，比如 "onClose"。

### `object:get(prop)`

读取宿主对象的属性。

### `object:set(prop, value)`

写入宿主对象的属性。成功返回 true，失败返回 false 和错误信息。

### `object:destroy()`

释放宿主对象及其订阅。
