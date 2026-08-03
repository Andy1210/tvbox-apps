// Plex HTPC bridge: the Qt host API its web bundle expects, backed by tvbox.
//
// Plex's 10-foot client is a Qt application whose UI is a web bundle talking to
// the native side over `window.QWebChannel`, and that native side is an mpv
// frontend. This adapter IS that native side:
//   • storage -> window.localStorage (persisted in Electron userData)
//   • player  -> the shell's shared mpv over the `player` IPC broker
//   • input   -> remote media keys re-routed as semantic onKeyReceived events
//   • system  -> exit; anything else is logged rather than acted on
//
// It ships inside this app package (manifest `runtime.bridge: "./bridge.js"`),
// not in the shell, because everything in here is shaped by one client: a Plex
// fix goes out as an app update to the boxes that have Plex, instead of an OTA
// to every box. The shell side it calls is deliberately generic (queue with
// stream ordinals, select, an allowlisted prop) - nothing below knows about mpv
// option names, and nothing in the shell knows about Plex.
module.exports.setup = function setup(ctx) {
  "use strict";
  var ipcRenderer = ctx.ipcRenderer;

  // The client builds `X-Plex-Device-Screen-Resolution` from
  // `${window.screen.width}x${window.screen.height}`, once, when it starts - and
  // the server picks the stream from that header. On this box the UI runs at
  // 1080p on a 4K panel and the mode only switches to 4K once a video starts, so
  // the honest-looking answer is the wrong one: a 4K film arrives as a 1080p
  // transcode, decided before anything could have switched.
  //
  // Tell it what the panel can show. The shell reads that from the output's
  // preferred mode; the window is still whatever size it is, and layout uses that,
  // not this.
  if (ctx.panel && ctx.panel.width && ctx.panel.height) {
    try {
      if (window.screen.width < ctx.panel.width || window.screen.height < ctx.panel.height) {
        Object.defineProperty(window.screen, "width", {
          get: function () {
            return ctx.panel.width;
          },
        });
        Object.defineProperty(window.screen, "height", {
          get: function () {
            return ctx.panel.height;
          },
        });
      }
    } catch (e) {}
  }
  var caps = ctx.caps || [];
  function has(c) {
    return caps.indexOf(c) >= 0;
  }
  var Success = 0;
  var Denied = 1; // any non-zero errorCode reads as a failure to a QWebChannel client

  // Null-prototype: the keys are QWebChannel paths the CLIENT chooses, so a
  // plain object would let "__proto__" reach Object.prototype instead of
  // becoming an entry, poisoning every later lookup.
  var signals = Object.create(null); // QWebChannel signal path -> connected callbacks
  var playing = false; // an mpv session is active (used to pause video on Back)
  // A Plex URL carries the account's X-Plex-Token as a query parameter, and this
  // goes to the shell's log FILE. The shell redacts too, but a credential is not
  // something to hand over and hope: strip it at the source.
  var SECRETS = /([?&](?:x-plex-token|token|access_token|api_key|apikey|password)=)([^&\s"']*)/gi;
  function log(what, detail) {
    try {
      ipcRenderer.send("plog", what, typeof detail === "string" ? detail.replace(SECRETS, "$1REDACTED") : detail);
    } catch (e) {}
  }
  // The device identity the Qt host used to answer `system.describe` with. The
  // client turns it into its X-Plex-* dimensions, so what is missing here is
  // missing from every request it makes.
  //
  // `platform` is load-bearing, not cosmetic: a Plex Media Server REQUIRES
  // X-Plex-Platform on the Companion poll (`/player/proxy/poll`) and answers 400
  // without it - "request didn't contain required header: X-Plex-Platform" in the
  // server log. The client's poll loop catches that and retries a second later,
  // forever, reporting nothing, so the only symptom is a box that never appears
  // as a Plex player: no casting from a phone, no remote control. Supplying it
  // cannot be done from the shell side either, because Chromium strips a header
  // added to a cross-origin request after the fact.
  //
  // `machineHostName` is the name a person then picks from Plex's cast list, so
  // the real host name is worth reaching for Node - this file runs in the
  // preload's context, where `require` exists, but stays defensive about it.
  function describe() {
    var host = "tvbox";
    var release = "";
    try {
      var os = require("os");
      host = os.hostname() || host;
      release = os.release() || "";
    } catch (e) {
      log("system.describe", "(no os module: " + (e && e.message ? e.message : e) + ")");
    }
    // No applicationVersion: the client falls back to the web bundle's own
    // version, which is the honest answer - the bridge doesn't ship it.
    return { product: "tvbox", platform: "Linux", platformVersion: release, machineHostName: host };
  }

  // Most callers here fire and forget, and `invoke` returns a PROMISE - a
  // rejection from the main process with nothing attached becomes an unhandled
  // rejection (noisy at best, fatal depending on the runtime's settings). The
  // catch belongs here rather than at 20 call sites.
  function player(action, payload) {
    try {
      var p = ipcRenderer.invoke("player", action, payload || {});
      if (p && typeof p.catch === "function") {
        p.catch(function (e) {
          log("player." + action, "(broker rejected: " + (e && e.message ? e.message : e) + ")");
        });
      }
      return p;
    } catch (e) {
      return null;
    }
  }
  // A signal can have MORE THAN ONE listener, and removing one must not remove
  // the others: the client tears a finished player down asynchronously, so the
  // NEXT playback can connect its own handler before the previous one
  // disconnects. With a single callback per path that late disconnect deleted
  // the live listener instead of the dead one, and the new session then got no
  // position or state events at all - a film that plays while its UI sits there
  // unresponsive.
  function fire(path) {
    var list = signals[path];
    if (!list || !list.length) return;
    var args = [].slice.call(arguments, 1);
    list.slice().forEach(function (cb) {
      try {
        cb.apply(null, args);
      } catch (e) {
        console.warn("[bridge] signal " + path + " threw", e);
      }
    });
  }

  // player state events from the shell (mpv) -> QWebChannel player signals
  if (has("player")) {
    ipcRenderer.on("player-event", function (_e, ev) {
      if (ev.type === "playing") {
        playing = true;
        fire("player.onPlaying");
      } else if (ev.type === "duration") fire("player.onDurationUpdate", ev.ms);
      else if (ev.type === "position") fire("player.onPositionUpdate", ev.ms);
      else if (ev.type === "buffering") fire("player.onBuffering", !!ev.on);
      else if (ev.type === "finished") {
        playing = false;
        fire("player.onFinish");
      } else if (ev.type === "error") fire("player.onError");
    });
  }

  // Remote media keys: the client ignores raw DOM MediaXxx keys but accepts
  // SEMANTIC commands via input.onKeyReceived. Re-route so they work and the
  // client stays in sync.
  if (has("input")) {
    var MEDIA_MAP = {
      MediaPlayPause: "play_pause",
      MediaPlay: "play",
      MediaPause: "pause",
      MediaStop: "stop",
      Cancel: "stop", // this remote's Stop button arrives as DOM key "Cancel"
      MediaTrackNext: "seek_forward",
      MediaTrackPrevious: "seek_backward", // this remote's seek buttons send these
      MediaFastForward: "seek_forward",
      MediaRewind: "seek_backward",
    };
    window.addEventListener(
      "keydown",
      function (ev) {
        var name = MEDIA_MAP[ev.key];
        if (name && signals["input.onKeyReceived"] && signals["input.onKeyReceived"].length) {
          ev.preventDefault();
          ev.stopImmediatePropagation();
          // An ARRAY of key names, not a bare one: the client's handler is
          // `(e) => { const t = e.map(this._getKeyEvent); ... }`, so a string
          // would die on `.map` and take every media key with it. It reads like
          // a wrapping mistake; it is the contract.
          fire("input.onKeyReceived", [name]);
          return;
        }
        // Backing out of the player: PAUSE mpv (freeze the frame) rather than
        // stop (kill) it. The client's first Back shows its OSD + pauses, and it
        // sends its own player.pause/player.stop over QWebChannel (verified in the
        // logs); killing mpv here left the client on the player screen with a
        // LOADER where the (gone) video was. Pause = frozen frame, no loader, and
        // no orphaned *playing* mpv (a later player.stop, the next queue, or
        // returning Home stops it). Don't preventDefault -> the client still gets
        // Back to drive its own pause/navigate.
        if (ev.key === "Backspace" && playing) {
          playing = false;
          player("pause");
        }
      },
      true,
    );
  }

  // ---- stream selection ------------------------------------------------
  // The client resolves audio/subtitle server-side and hands the result to the
  // host; `index` is the 0-based ordinal WITHIN its type (audio 0 = the file's
  // first audio track). -1 is NOT symmetric: on a subtitle it means "none", on
  // audio it means the client could not match its chosen stream, which is a
  // reason to leave the track to the player and never a request to mute - so it
  // is passed on as "no opinion". The shell's player broker speaks the same
  // ordinals, so this is a rename, not a translation - except for the two cases
  // that are not an index at all:
  //   • `url` - a sidecar subtitle the server serves as its own file
  //   • `embeddedInVideo` - the transcoder burned the subtitles into the video,
  //     so the player must add none of its own
  // Passing NOTHING is not the same as passing "none": without an explicit
  // selection mpv enables whichever subtitle track carries the container's
  // default flag, which is how a film started with subtitles off in Plex came up
  // with Hungarian subtitles anyway.
  function ordinal(v) {
    return typeof v === "number" && v >= 0 && v === Math.floor(v) ? v : null;
  }
  function streamsFrom(item) {
    var sel = { audio: null, sub: null, subFile: null };
    if (!item || typeof item !== "object") return sel;
    if (item.audio) sel.audio = ordinal(item.audio.index);
    var s = item.subtitle;
    if (!s) return sel;
    if (typeof s.url === "string" && s.url) sel.subFile = s.url;
    else if (s.embeddedInVideo) sel.sub = -1;
    else sel.sub = ordinal(s.index) === null ? -1 : s.index;
    return sel;
  }

  // ---- live attribute changes (player.set) ------------------------------
  // What the client changes mid-playback: the selected streams, A/V sync, speed,
  // volume and how subtitles look. Delays arrive in MILLISECONDS and the shell
  // speaks mpv's seconds. Everything else in the attribute set describes the
  // box's own video output (hardware decoding, HDR and refresh-rate switching,
  // audio device, deinterlacing) - the shell decides all of that per file, so
  // those are logged and ignored rather than half-honoured. The call still
  // answers success for them: they are the client's preferences, not commands
  // that failed.
  var HANDLED = {
    audio: 1,
    subtitle: 1,
    subtitleDelay: 1,
    audioDelay: 1,
    subtitleDisplay: 1,
    playbackRate: 1,
    volume: 1,
  };
  function prop(name, value) {
    player("prop", { name: name, value: value });
  }
  function applyAttributes(attrs) {
    if (!attrs || typeof attrs !== "object") return;
    if (attrs.audio || attrs.subtitle) {
      var sel = streamsFrom(attrs);
      // Only what this call actually carried: a set() that changes the audio
      // track must not also re-assert (or clear) the subtitle.
      var out = {};
      if (attrs.audio) out.audio = sel.audio;
      if (attrs.subtitle) {
        if (sel.subFile) out.subFile = sel.subFile;
        else out.sub = sel.sub;
      }
      player("select", out);
    }
    if (typeof attrs.subtitleDelay === "number") prop("sub-delay", attrs.subtitleDelay / 1000);
    if (typeof attrs.audioDelay === "number") prop("audio-delay", attrs.audioDelay / 1000);
    if (typeof attrs.playbackRate === "number") prop("speed", attrs.playbackRate);
    if (typeof attrs.volume === "number") prop("volume", Math.max(0, Math.min(100, attrs.volume)));
    var d = attrs.subtitleDisplay;
    if (d && typeof d === "object") {
      // size is a PERCENTAGE of the client's normal size (tiny 50 … huge 200),
      // which is exactly what mpv's sub-scale is a factor of; the colours come
      // through as #RRGGBB.
      if (typeof d.size === "number" && d.size > 0) prop("sub-scale", d.size / 100);
      if (typeof d.textColor === "string") prop("sub-color", d.textColor);
      if (typeof d.textBorderColor === "string") prop("sub-border-color", d.textBorderColor);
    }
    var rest = Object.keys(attrs).filter(function (k) {
      return !HANDLED[k];
    });
    if (rest.length) log("player.set", "(not acted on: " + rest.join(",") + ")");
  }

  function defaultFor(key) {
    if (/List$/.test(key)) return [];
    if (/^can[A-Z]/.test(key)) return false;
    if (key === "visibility") return "visible";
    if (/Port$/.test(key)) return 0;
    if (/Size$/.test(key)) return 0;
    return null;
  }

  function hybrid(path) {
    var fn = function () {
      var args = [].slice.call(arguments);
      var cb = args.length ? args[args.length - 1] : null;
      var hasCb = typeof cb === "function";

      // storage -> raw window.localStorage passthrough. A THROW here (quota, or
      // storage disabled) used to fall out of the block and reach the generic
      // responder below, which reports Success - so a write that never happened
      // was answered as if it had. Report the failure instead; the client can
      // then say so rather than trusting a setting it does not have.
      if (has("storage") && path.indexOf("storage.") === 0) {
        var atomic = {
          "storage.itemKeys": function () {
            return Object.keys(localStorage);
          },
          "storage.setItem": function () {
            localStorage.setItem(args[0], args[1]);
            return {};
          },
          "storage.getItem": function () {
            return localStorage.getItem(args[0]);
          },
          "storage.removeItem": function () {
            localStorage.removeItem(args[0]);
            return {};
          },
          "storage.clear": function () {
            localStorage.clear();
            return {};
          },
        };
        if (Object.prototype.hasOwnProperty.call(atomic, path)) {
          try {
            var value = atomic[path]();
            if (hasCb) cb({ errorCode: Success, result: value === undefined ? null : value });
          } catch (e) {
            log(path, "(failed: " + (e && e.message ? e.message : e) + ")");
            if (hasCb) cb({ errorCode: Denied, result: {} });
          }
          return;
        }
      }

      // system.exit / quit / closeApp -> really CLOSE the app, then HOME.
      // The client's "Exit?" confirmation calls one of these expecting the host to
      // tear the app down; without this it hit the generic no-op below, so the
      // dialog's OK did nothing. It must be "exit" and not "home": home only
      // backgrounds the app (instant resume), which left it in the app switcher
      // with its exit dialog still on screen. Anything else under system.* is
      // logged (not acted on) so an unknown exit verb on a new client build is
      // visible in ~/.tvbox/shell.log and easy to wire up. Tearing the app down is
      // a host action, so it needs the declared `system` capability like every
      // other surface here - and a denial ANSWERS the call: falling through to the
      // generic responder below would report success for a teardown that never
      // happened, which is the one thing worse than not gating it at all.
      if (path.indexOf("system.") === 0) {
        var leaf = path.slice("system.".length);
        // Answered for every app: this is the client describing ITSELF, not a
        // host action, so there is nothing here to gate on the `system`
        // capability the way exit is.
        if (leaf === "describe") {
          if (hasCb) cb({ errorCode: Success, result: describe() });
          return;
        }
        if (leaf === "exit" || leaf === "quit" || leaf === "closeApp" || leaf === "close") {
          if (!has("system")) {
            log(path, "(denied: app did not declare the system capability)");
            if (hasCb) cb({ errorCode: Denied, result: {} });
            return;
          }
          try {
            ipcRenderer.send("nav", "exit");
          } catch (e) {}
          if (hasCb) cb({ errorCode: Success, result: {} });
          return;
        }
        log(path, "(system call, not handled)");
      }

      // player -> the shell's mpv service
      if (has("player") && path.indexOf("player.") === 0) {
        log(
          path,
          JSON.stringify(
            args.filter(function (a) {
              return typeof a !== "function";
            }),
          ).slice(0, 280),
        );
        if (path === "player.queue") {
          var item = Array.isArray(args[0]) ? args[0][0] : args[0];
          if (item && item.url)
            player("queue", {
              url: item.url,
              startPos: item.startPositionSeconds || 0,
              streams: streamsFrom(item),
            });
        } else if (path === "player.play") player("play");
        else if (path === "player.stop" || path === "player.teardown") player("stop");
        else if (path === "player.pause") player("pause");
        else if (path === "player.resume" || path === "player.unpause") player("resume");
        else if (path === "player.seekTo")
          player("seek", { posSec: typeof args[0] === "number" ? args[0] / 1000 : 0 }); // seekTo is in ms
        else if (path === "player.seek") player("seek", { posSec: typeof args[0] === "number" ? args[0] : 0 });
        else if (path === "player.set") applyAttributes(args[0]);
        // .set and .get still fall through: their reply is a per-KEY result map,
        // built by the generic responder below.
        if (path !== "player.set" && path !== "player.get") {
          if (hasCb) cb({ errorCode: Success, result: {} });
          return;
        }
      }

      if (!hasCb) return;
      // The bulk get/set form of the same surface. It reaches real localStorage,
      // so it is gated on the SAME capability as the atomic calls above - an app
      // that never declared `storage` must not get a back door to it just
      // because it asked in the plural.
      var store = has("storage");
      var result = {};
      if (/\.get$/.test(path) && Array.isArray(args[0])) {
        args[0].forEach(function (k) {
          var v = path === "storage.get" && store ? localStorage.getItem(k) : defaultFor(k);
          result[k] = { errorCode: Success, result: v === undefined ? null : v };
        });
      } else if (/\.set$/.test(path) && args[0] && typeof args[0] === "object") {
        Object.keys(args[0]).forEach(function (k) {
          var stored = true;
          if (path === "storage.set") {
            if (!store) stored = false;
            else {
              try {
                localStorage.setItem(k, typeof args[0][k] === "string" ? args[0][k] : JSON.stringify(args[0][k]));
              } catch (e) {
                stored = false;
              }
            }
          }
          result[k] = stored ? { errorCode: Success, result: true } : { errorCode: Denied, result: false };
        });
      }
      cb({ errorCode: Success, result: result });
    };
    fn.connect = function (cb) {
      if (typeof cb !== "function") return;
      (signals[path] = signals[path] || []).push(cb);
    };
    fn.disconnect = function (cb) {
      var list = signals[path];
      if (!list) return;
      if (typeof cb !== "function") {
        delete signals[path]; // a client that disconnects everything on this signal
        return;
      }
      var i = list.indexOf(cb);
      if (i >= 0) list.splice(i, 1);
    };
    var children = Object.create(null); // same reason as `signals`: client-chosen keys
    return new Proxy(fn, {
      get: function (t, prop) {
        if (
          prop === "connect" ||
          prop === "disconnect" ||
          prop === "apply" ||
          prop === "call" ||
          prop === "bind" ||
          prop === "name" ||
          prop === "length" ||
          prop === "prototype"
        )
          return t[prop];
        if (typeof prop !== "string") return undefined;
        if (prop === "then" || prop === "toJSON") return undefined;
        var cp = path ? path + "." + prop : prop;
        if (!children[prop]) children[prop] = hybrid(cp);
        return children[prop];
      },
      apply: function (t, thisArg, a) {
        return t.apply(thisArg, a);
      },
    });
  }

  function QWebChannel(transport, callback) {
    this.objects = hybrid("");
    if (typeof callback === "function") {
      try {
        callback(this);
      } catch (e) {
        console.error("[bridge] init callback threw", e);
      }
    }
  }

  window.qt = window.qt || { webChannelTransport: { send: function () {}, onmessage: null } };
  window.QWebChannel = QWebChannel;
  console.log("[bridge] plex qwebchannel adapter ready (caps:", caps.join(",") || "none", ")");
};
