/**
 * A test-only probe for runs in WeChat DevTools. It is never part of an
 * export: scripts/devtools_probe.mjs copies it into an exported project and
 * makes game.js load it first.
 *
 * A mini game's console cannot be read from outside the developer tool, so
 * the probe mirrors it to a file in the game's user data folder, which the
 * simulator keeps on disk. It also saves what the canvas shows at chosen
 * moments and can replay touches, so that a run leaves evidence that can be
 * checked afterwards:
 *
 *   <user data>/dmg-probe/<label>-<time>/console.log
 *   <user data>/dmg-probe/<label>-<time>/frame-<n>.rgba   width, height, then RGBA rows, top row first
 *   <user data>/dmg-probe/<label>-<time>/summary.json
 *
 * Times in the configuration are milliseconds after the loader reports that
 * the engine is running.
 *
 * A probed run is silent unless the configuration says mute: false. The
 * engine's mixer still runs and its blocks are still counted; they are sent
 * to a gain node at zero instead of the speakers, and host audio players are
 * held at volume 0.
 *
 * storage: { key: value } is written to the host's key-value storage before
 * the game starts and removed when the run finishes; the API test app reads
 * apitest.autorun that way.
 */
;(function () {
  var CONFIG = /*CONFIG*/{ label: "run", captures: [1500, 4000], touches: [], finishAt: 6000, mute: true, storage: {}, captureSize: 720 };

  var api = typeof wx !== "undefined" ? wx : null;
  if (!api || typeof api.getFileSystemManager !== "function") return;
  var G = typeof GameGlobal !== "undefined" ? GameGlobal : globalThis;
  var fs = api.getFileSystemManager();
  var started = Date.now();
  var directory = api.env.USER_DATA_PATH + "/dmg-probe/" + CONFIG.label + "-" + started;
  try { fs.mkdirSync(directory, true); } catch (error) { /* reported below when the first write fails */ }
  var logPath = directory + "/console.log";
  try { fs.writeFileSync(logPath, "", "utf8"); } catch (error) { return; }

  var audioContexts = [];
  var summary = {
    label: CONFIG.label, startedAt: new Date(started).toISOString(),
    engineRunningAfterMs: null, frames: 0, captures: [], touches: [], errors: 0, warnings: 0, notes: [],
  };

  function describe(value) {
    if (value instanceof Error) return value.stack || (value.name + ": " + value.message);
    if (typeof value === "string") return value;
    try { return JSON.stringify(value); } catch (error) { return String(value); }
  }
  function write(line) {
    try { fs.appendFileSync(logPath, "[" + (Date.now() - started) + "ms] " + line + "\n", "utf8"); } catch (error) { /* nowhere to report it */ }
  }
  function note(text) { summary.notes.push(text); write("[probe] " + text); }
  function saveSummary() {
    try { fs.writeFileSync(directory + "/summary.json", JSON.stringify(summary, null, 2), "utf8"); } catch (error) { /* ignored */ }
  }

  // ── console ────────────────────────────────────────────────────────────
  var engineAt = 0;
  var onEngineRunning = [];
  ["log", "info", "warn", "error", "debug"].forEach(function (level) {
    var original = console[level];
    if (typeof original !== "function") return;
    console[level] = function () {
      var text = Array.prototype.map.call(arguments, describe).join(" ");
      write("[" + level + "] " + text);
      if (level === "error") summary.errors += 1;
      if (level === "warn") summary.warnings += 1;
      if (!engineAt && text.indexOf("5/5 the engine is running") !== -1) {
        engineAt = Date.now();
        summary.engineRunningAfterMs = engineAt - started;
        onEngineRunning.forEach(function (callback) { callback(); });
      }
      return original.apply(console, arguments);
    };
  });
  if (typeof api.onError === "function") {
    api.onError(function (error) { summary.errors += 1; write("[wx.onError] " + describe(error && (error.message || error))); });
  }
  if (typeof api.onUnhandledRejection === "function") {
    api.onUnhandledRejection(function (event) { summary.errors += 1; write("[unhandled rejection] " + describe(event && event.reason)); });
  }

  try {
    var info = api.getSystemInfoSync();
    summary.system = {
      platform: info.platform, model: info.model, system: info.system, version: info.version, SDKVersion: info.SDKVersion,
      pixelRatio: info.pixelRatio, windowWidth: info.windowWidth, windowHeight: info.windowHeight,
    };
    write("[probe] system " + JSON.stringify(summary.system));
  } catch (error) { note("getSystemInfoSync failed: " + describe(error)); }

  // ── storage the game should find at start ──────────────────────────────
  var presetKeys = Object.keys(CONFIG.storage || {});
  presetKeys.forEach(function (key) {
    try { api.setStorageSync(key, String(CONFIG.storage[key])); } catch (error) { note("cannot preset storage key " + key + ": " + describe(error)); }
  });

  // ── audio: count what the engine's mixer hands to the host, and mute it ─
  // Sound cannot be captured from here, but an engine that is mixing asks
  // the host's audio context for a buffer source per block and starts it.
  var muted = CONFIG.mute !== false;
  if (typeof api.createWebAudioContext === "function") {
    var createAudio = api.createWebAudioContext;
    var audioWrapper = function () {
      var context = createAudio.apply(api, arguments);
      summary.audio = summary.audio || { contexts: 0, bufferSources: 0, started: 0, muted: muted };
      summary.audio.contexts += 1;
      audioContexts.push(context);
      try {
        var silence = null;
        if (muted) {
          silence = context.createGain();
          silence.gain.value = 0;
          silence.connect(context.destination);
        }
        var createSource = context.createBufferSource;
        context.createBufferSource = function () {
          var source = createSource.apply(context, arguments);
          summary.audio.bufferSources += 1;
          try {
            var start = source.start;
            source.start = function () { summary.audio.started += 1; return start.apply(source, arguments); };
            if (silence) {
              // Whatever the engine connects a block to, it goes to the silent node instead.
              var connect = source.connect;
              source.connect = function () { return connect.call(source, silence); };
            }
          } catch (error) { note("an audio source cannot be instrumented: " + describe(error)); }
          return source;
        };
      } catch (error) { note("the audio context cannot be instrumented: " + describe(error)); }
      return context;
    };
    try { api.createWebAudioContext = audioWrapper; } catch (error) { /* checked next */ }
    if (api.createWebAudioContext !== audioWrapper) note("wx.createWebAudioContext cannot be wrapped; audio is neither counted nor muted");
  }
  if (typeof api.createInnerAudioContext === "function") {
    var createInner = api.createInnerAudioContext;
    var innerWrapper = function () {
      var player = createInner.apply(api, arguments);
      summary.hostAudio = summary.hostAudio || { players: 0, plays: 0, muted: muted };
      summary.hostAudio.players += 1;
      try {
        var play = player.play;
        player.play = function () {
          summary.hostAudio.plays += 1;
          // The game may have set a volume after the player was created.
          if (muted) { try { player.volume = 0; } catch (error) { /* reported once below */ } }
          return play.apply(player, arguments);
        };
        if (muted) player.volume = 0;
        // What the player reports, for telling "did not play" from "played, and nobody was told".
        ["onCanplay", "onPlay", "onEnded", "onStop", "onError", "onWaiting"].forEach(function (name) {
          if (typeof player[name] !== "function") return;
          player[name](function (event) {
            write("[probe] host audio " + name + (event && (event.errMsg || event.errCode) ? " " + describe(event.errMsg || event.errCode) : ""));
          });
        });
      } catch (error) { note("a host audio player cannot be instrumented: " + describe(error)); }
      return player;
    };
    try { api.createInnerAudioContext = innerWrapper; } catch (error) { /* checked next */ }
    if (api.createInnerAudioContext !== innerWrapper) note("wx.createInnerAudioContext cannot be wrapped; host audio is neither counted nor muted");
  }

  // ── touches: remember the handlers the adapter registers ───────────────
  var handlers = { onTouchStart: [], onTouchMove: [], onTouchEnd: [] };
  Object.keys(handlers).forEach(function (name) {
    var original = api[name];
    if (typeof original !== "function") return;
    var wrapper = function (callback) { handlers[name].push(callback); return original.call(api, callback); };
    try { api[name] = wrapper; } catch (error) { /* checked next */ }
    if (api[name] !== wrapper) note("wx." + name + " cannot be wrapped; replayed touches are unavailable");
  });
  function touch(name, x, y) {
    var point = { identifier: 0, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y, force: 1 };
    var ended = name === "onTouchEnd";
    var event = { touches: ended ? [] : [point], changedTouches: [point], timeStamp: Date.now() };
    handlers[name].forEach(function (callback) { callback(event); });
    return handlers[name].length;
  }

  // ── frames ─────────────────────────────────────────────────────────────
  var captures = (CONFIG.captures || []).slice().sort(function (a, b) { return a - b; });
  var nativeFrame = G.requestAnimationFrame || (typeof requestAnimationFrame === "function" ? requestAnimationFrame : null);
  var frameTimes = [];
  var lastFrame = 0;
  function afterFrame() {
    summary.frames += 1;
    var now = Date.now();
    if (engineAt) {
      if (lastFrame) frameTimes.push(now - lastFrame);
      lastFrame = now;
      while (captures.length > 0 && now - engineAt >= captures[0]) capture(captures.shift());
    }
  }
  if (nativeFrame) {
    var wrappedFrame = function (callback) {
      return nativeFrame.call(G, function (time) {
        try { return callback(time); } finally { afterFrame(); }
      });
    };
    try { G.requestAnimationFrame = wrappedFrame; } catch (error) { /* checked next */ }
    if (G.requestAnimationFrame !== wrappedFrame) note("requestAnimationFrame cannot be wrapped; frames are not counted and not captured");
  } else {
    note("no requestAnimationFrame on the global object");
  }

  /** Copies the frame that was just drawn, top row first, at most captureSize pixels on its longer side. */
  function capture(at) {
    var record = { atMs: at, takenAfterMs: Date.now() - engineAt, frame: summary.frames };
    try {
      var adapter = G.__defoldMiniGameAdapter;
      var canvas = adapter && adapter.canvas;
      var gl = canvas && (canvas.getContext("webgl2") || canvas.getContext("webgl"));
      if (!gl) throw new Error("no WebGL context on the adapter's canvas");
      var width = gl.drawingBufferWidth;
      var height = gl.drawingBufferHeight;
      var pixels = new Uint8Array(width * height * 4);
      var bound = gl.getParameter(gl.FRAMEBUFFER_BINDING);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      gl.bindFramebuffer(gl.FRAMEBUFFER, bound);

      var step = Math.max(1, Math.ceil(Math.max(width, height) / (CONFIG.captureSize || 720)));
      var outWidth = Math.floor(width / step);
      var outHeight = Math.floor(height / step);
      var out = new Uint8Array(8 + outWidth * outHeight * 4);
      var header = new DataView(out.buffer);
      header.setUint32(0, outWidth, true);
      header.setUint32(4, outHeight, true);
      var colours = {};
      var distinct = 0;
      for (var row = 0; row < outHeight; row += 1) {
        var source = (height - 1 - row * step) * width * 4; // WebGL rows start at the bottom
        var target = 8 + row * outWidth * 4;
        for (var column = 0; column < outWidth; column += 1) {
          var s = source + column * step * 4;
          var t = target + column * 4;
          out[t] = pixels[s]; out[t + 1] = pixels[s + 1]; out[t + 2] = pixels[s + 2]; out[t + 3] = 255;
          var key = (pixels[s] << 16) | (pixels[s + 1] << 8) | pixels[s + 2];
          if (distinct < 4096 && !colours[key]) { colours[key] = 1; distinct += 1; }
        }
      }
      var name = "frame-" + (summary.captures.length + 1) + ".rgba";
      fs.writeFileSync(directory + "/" + name, out.buffer);
      record.file = name;
      record.drawingBuffer = [width, height];
      record.saved = [outWidth, outHeight];
      record.distinctColours = distinct;
      record.webgl2 = typeof gl.createVertexArray === "function";
    } catch (error) {
      record.error = describe(error);
    }
    summary.captures.push(record);
    write("[probe] capture " + JSON.stringify(record));
    saveSummary();
  }

  // ── schedule ───────────────────────────────────────────────────────────
  onEngineRunning.push(function () {
    var viewport = { width: (summary.system && summary.system.windowWidth) || 375, height: (summary.system && summary.system.windowHeight) || 667 };
    (CONFIG.touches || []).forEach(function (step) {
      setTimeout(function () {
        var x = Math.round(step.x * viewport.width);
        var y = Math.round(step.y * viewport.height);
        var delivered = touch(step.type, x, y);
        var record = { atMs: step.at, type: step.type, x: x, y: y, handlers: delivered };
        summary.touches.push(record);
        write("[probe] touch " + JSON.stringify(record));
      }, step.at);
    });
    setTimeout(function () {
      if (frameTimes.length > 0) {
        var sorted = frameTimes.slice().sort(function (a, b) { return a - b; });
        var total = frameTimes.reduce(function (sum, value) { return sum + value; }, 0);
        summary.frameTime = {
          samples: sorted.length,
          averageMs: Math.round((total / sorted.length) * 10) / 10,
          medianMs: sorted[Math.floor(sorted.length / 2)],
          p95Ms: sorted[Math.floor(sorted.length * 0.95)],
        };
      }
      if (summary.audio) {
        summary.audio.state = audioContexts.map(function (context) { return context.state; });
        summary.audio.sampleRate = audioContexts.map(function (context) { return context.sampleRate; });
      }
      presetKeys.forEach(function (key) {
        try { api.removeStorageSync(key); } catch (error) { /* the next run sets it again anyway */ }
      });
      summary.finished = true;
      summary.finishedAfterMs = Date.now() - started;
      write("[probe] finished " + JSON.stringify({ frames: summary.frames, errors: summary.errors, frameTime: summary.frameTime, audio: summary.audio, hostAudio: summary.hostAudio }));
      saveSummary();
    }, CONFIG.finishAt || 6000);
  });

  // Something to look at when the engine never comes up.
  setTimeout(function () {
    if (!engineAt) { note("the engine was not running 30 s after start"); saveSummary(); }
  }, 30000);

  write("[probe] started " + JSON.stringify(CONFIG));
  saveSummary();
})();
