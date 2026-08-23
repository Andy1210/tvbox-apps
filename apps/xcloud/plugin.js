// Xbox Cloud Gaming - host-side plugin.
//
// Everything that touches a credential lives here, and the split is forced rather
// than chosen. A renderer cannot call gssv-play-prod.xboxlive.com at all (it sends
// no CORS for our origin), and the streaming token is a live credential we have no
// reason to hand a page. So the plugin owns every Xbox HTTP call and all token
// custody, and the app's UI reaches it over same-origin routes under
// /tvbox/api/xcloud - the shape Live TV's plugin already uses.
//
// No route ever returns a token. The device code is not a credential (it is
// worthless without the person's own sign-in) and is the one secret-looking thing
// that does go out.
//
// State-changing routes are POST deliberately: the shell gates every non-GET
// behind a same-origin check, and this API listens unauthenticated on loopback -
// so a `signout` reachable by GET would be a page on the internet signing the
// television out.
const auth = require("./lib/xboxauth");
const library = require("./lib/library");
const api = require("./lib/xcloudapi");
const sessions = require("./lib/session");
const settings = require("./lib/settings");

// One sign-in at a time, and it is deliberately not persisted: a device code dies
// with the process that requested it, so a code surviving a shell restart in a
// file would be a code the person types in vain.
let signin = null;

// One television, one screen, so one session. The signalling lives here and the
// WebRTC lives in the page: Node has no RTCPeerConnection without a native
// module, and the video and the input channel belong in the renderer anyway. So
// the offer and the candidates pass THROUGH these routes, and the streaming token
// never does.
let live = null;

// Module scope, because the timers below are module scope too. It was defined
// inside the factory and called from `startKeepalive`, which is a ReferenceError
// on a path with no catch - it fires about five seconds into every stream, and it
// is why the "the server ended the session" detection this polling exists for
// never once ran.
let log = (...a) => console.log("[xcloud]", ...a);

// How often to ask the server whether the session is still there. Nothing tells
// us when someone quits from the Xbox guide, and the only thing that eventually
// notices is WebRTC's own ICE timeout - about thirty seconds of a frozen picture
// before anything is said.
const ALIVE_POLL_MS = 5000;

// How long a session may go unasked-about before the plugin ends it.
//
// A page signals its own departure best-effort, and best-effort is not good
// enough for something the account is charged a slot for: measured, quitting the
// app left a Provisioned session running, and the keepalive pulse this plugin
// sends kept the server from reaping it either - it was still there fifty seconds
// later. The screen polls every 3 s while it is up, so nobody asking for a minute
// means nobody is watching.
const ABANDONED_MS = 60000;

// The server states how often it wants a pulse (measured: 60 s) and how long it
// waits without a connection (300 s), so the timer is set from its answer rather
// than from a number of ours. It runs HERE because a page that reloads mid-stream
// would otherwise let the session lapse.
function startKeepalive(cfg) {
  stopKeepalive();
  if (!live) return;
  // Captured, because both callbacks re-read module scope after an await: a tick
  // that fired before a replacement was adopted can still be waiting on a 15 s
  // request when `live` changes, and its answer would then be written onto the
  // NEW session - which the screen reads as `ended` and tears down.
  const own = live.session;
  const mine = () => live && live.session.id === own.id;

  live.keepaliveTimer = setInterval(() => {
    if (!mine()) return stopKeepalive();
    sessions
      .keepalive(own)
      .then((r) => {
        if (!mine()) return;
        // The pulse answers with a reason, and "None" is the healthy one. Anything
        // else is the server saying why it is about to stop.
        if (r && r.reason && r.reason !== "None") {
          log("keepalive says the session is ending:", r.reason);
          live.ended = String(r.reason);
        }
      })
      .catch(() => {
        /* one missed pulse is not a dropped session; the state poll is the truth */
      });
  }, (cfg && cfg.keepAliveMs) || 60000);
  if (live.keepaliveTimer.unref) live.keepaliveTimer.unref();

  live.aliveTimer = setInterval(() => {
    if (!mine()) return;
    if (Date.now() - live.lastAsked > ABANDONED_MS) {
      log("no screen has asked about this session for a minute - ending it");
      endSession().catch(() => {});
      return;
    }
    sessions.alive(own).then((r) => {
      if (!mine()) return;
      // Logged on CHANGE only. Measured after a quit from the Xbox guide: the
      // state stays `Provisioned` and nothing here ever fires, which is why the
      // page watches its own frame counter instead.
      if (r.state && r.state !== live.serverState) {
        live.serverState = r.state;
        log("server session state:", r.state);
      }
      if (r.alive) return;
      log("session ended on the server:", r.state);
      live.ended = r.state || "Gone";
    }).catch(() => {
      /* alive() swallows its own failures; this is the belt for a future change */
    });
  }, ALIVE_POLL_MS);
  if (live.aliveTimer.unref) live.aliveTimer.unref();
}

function stopKeepalive() {
  if (!live) return;
  if (live.keepaliveTimer) clearInterval(live.keepaliveTimer);
  if (live.aliveTimer) clearInterval(live.aliveTimer);
  live.keepaliveTimer = null;
  live.aliveTimer = null;
}

// Always through here, so a session can never be left behind by a code path that
// forgot the timer. Stopping is worth doing even though the server reattaches a
// second /play to the same session: an abandoned one holds a real machine.
async function endSession() {
  const l = live;
  // Cleared first, so a keepalive tick or a state callback racing this cannot
  // resurrect the session it is about to stop.
  live = null;
  if (!l) return;
  if (l.keepaliveTimer) clearInterval(l.keepaliveTimer);
  if (l.aliveTimer) clearInterval(l.aliveTimer);
  if (l.controller) l.controller.abort();
  await sessions.stop(l.session).catch(() => {
    /* a stop that failed leaves a session the next /play will reattach to */
  });
}

function errorPayload(e) {
  return {
    ok: false,
    // A stable code, so the UI can choose its own Hungarian wording instead of
    // reading an English sentence out of a token endpoint.
    code: (e && e.code) || "error",
    error: String((e && e.message) || e),
  };
}

module.exports = (host) => {
  log = (...a) => (host.log ? host.log("xcloud", ...a) : console.log("[xcloud]", ...a));

  // The account, and what it can reach. Deliberately says nothing about tokens
  // beyond whether they work.
  async function status() {
    // `pending` rather than `code`: everywhere else in this API `code` is a
    // stable ERROR code, and a field whose type depends on which state you are in
    // is how a caller ends up passing an object to a message lookup.
    if (!auth.isSignedIn()) return { ok: true, signedIn: false, signingIn: !!signin, pending: signin ? signin.public : null };
    try {
      const [web, tok] = await Promise.all([auth.getWebToken(), auth.getCloudStreamingToken()]);
      return {
        ok: true,
        signedIn: true,
        gamertag: web.gamertag,
        market: tok.market,
        offering: tok.offering,
        region: (tok.regions.find((r) => r.isDefault) || {}).name || "",
      };
    } catch (e) {
      // Signed in but unusable is its own state: a suspended account, a child
      // account, a region without Game Pass. "Sign in again" is wrong advice for
      // all three, so the code travels.
      return { ...errorPayload(e), signedIn: true, usable: false };
    }
  }

  const routes = {
    "GET /status": (req, res) => status().then((s) => host.json(res, s)),

    // Starts the device-code flow and returns the code to put on screen. The poll
    // runs HERE rather than in the page: it lasts up to fifteen minutes, and a
    // page that navigates away mid-sign-in would otherwise abandon it.
    "POST /signin/start": (req, res) => {
      // A sign-in that FAILED is not one to hand back: its code is dead, so
      // "Retry" re-showed the same dead code and failed again, and the only way
      // out was Retry then Cancel then Start - which nobody would find.
      if (signin && signin.state === "failed") signin = null;
      if (signin) return host.json(res, { ok: true, ...signin.public });
      auth
        .startDeviceCodeAuth()
        .then((dc) => {
          const controller = new AbortController();
          signin = {
            // `expiresAt` as well as the lifetime: this sign-in outlives the page (a
            // reload picks it back up), so a screen that counts from when IT opened
            // reports a code as fresh minutes after it died.
            public: {
              userCode: dc.userCode,
              verificationUri: dc.verificationUri,
              expiresIn: dc.expiresIn,
              expiresAt: Date.now() + dc.expiresIn * 1000,
            },
            controller,
            state: "waiting",
            error: null,
          };
          host.json(res, { ok: true, ...signin.public });

          auth
            .pollForDeviceCode(dc.deviceCode, { ...dc, signal: controller.signal })
            .then(() => {
              signin = null;
              log("signed in");
              // Warm the library while the person is still looking at the
              // "signed in" screen, so the grid is not the next wait.
              library
                .refresh({ language: library.askedLanguage() || locale() })
                .catch((e) => log("library warm-up failed:", e.message));
            })
            .catch((e) => {
              // Kept, not cleared: the screen has to be able to say WHY, and a
              // cleared state reads as "never started".
              if (signin) {
                signin.state = "failed";
                signin.error = { code: e.code || "error", error: String(e.message || e) };
              }
              log("sign-in failed:", e.code || "", e.message);
            });
        })
        .catch((e) => host.json(res, errorPayload(e)));
    },

    "GET /signin/state": (req, res) => {
      if (!signin) return host.json(res, { ok: true, state: auth.isSignedIn() ? "done" : "idle" });
      host.json(res, { ok: true, state: signin.state, ...signin.public, ...(signin.error || {}) });
    },

    "POST /signin/cancel": (req, res) => {
      if (signin) signin.controller.abort();
      signin = null;
      host.json(res, { ok: true });
    },

    "POST /signout": (req, res) => {
      if (signin) signin.controller.abort();
      signin = null;
      // The session goes FIRST. `signOut()` clears the refresh token and every
      // cached one, and the DELETE needs a streaming token it can no longer mint -
      // measured, the request was simply never made and the account kept holding
      // the session.
      endSession()
        .catch(() => {})
        .then(() => {
          auth.signOut();
          // The library is what this account may stream, so it goes with it.
          library.invalidate();
          log("signed out");
          host.json(res, { ok: true });
        });
    },

    // The whole playable library, from cache when it is fresh. `stale` means the
    // rows are usable and a refresh is already running behind this answer, so the
    // UI can draw now and re-read later rather than showing a spinner.
    "GET /library": (req, res) => {
      library
        .get({ language: locale(req) })
        .then((r) => host.json(res, { ok: true, ...r }))
        .catch((e) => host.json(res, errorPayload(e)));
    },

    "GET /search": (req, res) => {
      const q = new URL(req.url, host.base).searchParams.get("q") || "";
      host.json(res, { ok: true, results: library.search(q) });
    },

    "GET /title": (req, res) => {
      const id = new URL(req.url, host.base).searchParams.get("id") || "";
      const t = library.find(id);
      host.json(res, t ? { ok: true, title: t } : { ok: false, code: "not_found", error: "no such title" });
    },

    // What this client can decide for itself. Short on purpose: region and server
    // are Microsoft's choice on this account (`allowRegionSelection: false`), so
    // what is left is what we put in the offer and in the session request.
    "GET /settings": (req, res) =>
      host.json(res, { ok: true, settings: settings.get(), allowed: settings.ALLOWED }),

    "POST /settings": (req, res, ctx) => {
      try {
        host.json(res, { ok: true, settings: settings.set((ctx && ctx.body) || {}) });
      } catch (e) {
        // The key is named rather than reported as a generic failure - a screen
        // that says "could not save" about one bad field is a screen you cannot
        // fix anything from.
        host.json(res, { ok: false, code: "bad_setting", error: String(e.message || e) });
      }
    },

    // Forget the catalogue, so the next open fetches it again. For when Game Pass
    // has changed and the day-long cache has not caught up.
    "POST /library/refresh": (req, res) => {
      library.invalidate();
      host.json(res, { ok: true });
    },

    // Game Pass's own curated lists - what was just added, what is about to
    // leave. Answered together because the screen wants them together and each is
    // one small request behind an hour's cache.
    //
    // A list that fails does not fail the others: these are extra rows, and a row
    // that cannot be drawn is better than a screen that cannot.
    "GET /collections": (req, res) => {
      const language = locale(req);
      const wanted = ["recentlyAdded", "leavingSoon"];
      Promise.all(
        wanted.map((name) =>
          library
            .collection(name, { language })
            .then((titles) => [name, titles])
            .catch((e) => {
              log("collection " + name + " failed:", e.message);
              return [name, []];
            }),
        ),
      ).then((pairs) => host.json(res, { ok: true, collections: Object.fromEntries(pairs) }));
    },

    // The continue-playing row. Straight from the API rather than the cache: what
    // was played last is the one thing that changes between two launches.
    "GET /recent": (req, res) => {
      api
        .fetchRecentTitles(25)
        .then((rows) => host.json(res, {
          ok: true,
          // Names and art come from the cached library, so this costs one request.
          titles: rows.map((r) => library.find(r.titleId) || { ...r, name: "", hydrated: false }),
        }))
        .catch((e) => host.json(res, errorPayload(e)));
    },

    // Starts a stream and drives the ladder to Provisioned. Answers as soon as the
    // session EXISTS rather than when it is ready, because the wait is the part
    // that needs a screen: a queue was measured at 224 s on this account, and the
    // page has to be able to draw it.
    // The shell reads a POST body itself and hands it over as the third argument -
    // it does NOT put it on the request. Reading the stream here waits on a
    // request that has already ended, so the route never answers and the screen
    // sits on "starting" for ever. That is what it did.
    "POST /session/start": (req, res, ctx) => {
      Promise.resolve((ctx && ctx.body) || {})
        .then(async (data) => {
          const titleId = String((data && data.titleId) || "");
          if (!/^[A-Za-z0-9._-]{1,120}$/.test(titleId)) {
            return host.json(res, { ok: false, code: "bad_request", error: "titleId missing or malformed" });
          }
          const chosen = settings.get();
          // The page's own language, which is the only honest source: the box's
          // `config.locale` is unset and the UI language lives in a localStorage
          // key no plugin can read. An explicit setting still wins.
          const pageLocale = settings.LANGUAGES.includes(String(data.locale || "")) ? String(data.locale) : "";
          // A game's language is fixed when the session starts; there is no
          // changing it once it runs.
          const width = Number(data.width) || 1920;
          const height = Number(data.height) || 1080;
          const cap = chosen.maxHeight || height;
          const scale = Math.min(1, cap / height);
          // The running session is ended only once the new one EXISTS. Ending it
          // first meant a start that could not succeed - an expired token, no
          // capacity, a name the server refuses - took the game that was playing
          // with it.
          const controller = new AbortController();
          const session = await sessions.start(titleId, {
            locale: chosen.gameLocale || pageLocale || locale(),
            width: Math.round(width * scale),
            height: Math.round(height * scale),
            timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
          });
          // One screen, one stream - but only if it is a DIFFERENT one. A second
          // /play for the same title returns the same session id (the server
          // reattaches), so ending "the old one" here would delete the very
          // session just adopted and leave the page negotiating against a dead id.
          if (live && live.session.id !== session.id) await endSession();
          // The timers hang off the object `live` POINTS AT, and `stopKeepalive`
          // finds them through `live` - so replacing it without stopping them
          // first orphans a keepalive and an alive poll that nothing can reach
          // again. That is the same-id path above: it deliberately does not end
          // the session, so nothing else clears them, and a second play of one
          // title left two pairs of intervals pulsing the server.
          stopKeepalive();
          live = { session, controller, state: "Provisioning", queueSeconds: null, queuedFor: 0, error: null, config: null, ended: null, lastAsked: Date.now() };
          host.json(res, { ok: true, id: session.id, type: session.type, titleId });

          // Every callback below asks whether it is still THIS session's. A
          // ladder that was abandoned answers late - its state GET is already in
          // flight when the abort lands, so up to a request timeout later - and
          // "is there a live session" is not the same question as "is it mine".
          // Measured: an abandoned pass's `cancelled` was written onto a healthy
          // new session, which then showed an error over a running game.
          const mine = () => live && live.session.id === session.id;
          sessions
            .waitReady(session, {
              signal: controller.signal,
              onState: (st) => { if (mine()) live.state = st; },
              onQueue: (secs, elapsed) => { if (mine()) { live.queueSeconds = secs; live.queuedFor = elapsed; } },
            })
            .then(async () => {
              const cfg = await sessions.configuration(session);
              if (!mine()) return;
              live.config = cfg;
              live.state = "Provisioned";
              startKeepalive(cfg);
            })
            .catch((e) => {
              log("session failed:", e.code || "", e.message);
              if (!mine()) return;
              live.state = "Failed";
              live.error = { code: e.code || "error", error: String(e.message || e) };
              // A session that failed is still a session the account is holding.
              endSession().catch(() => {});
            });
        })
        .catch((e) => host.json(res, errorPayload(e)));
    },

    // Polled by the page while it waits, and again after it connects. `config` is
    // null until the session is Provisioned - that is the signal to offer.
    "GET /session/state": (req, res) => {
      if (!live) return host.json(res, { ok: true, active: false });
      // Someone is watching. See ABANDONED_MS.
      //
      // This is a liveness signal, so it has to come from a page of OURS: the read
      // is open (an `<img src>` needs no credential and carries no Origin), and a
      // clock anything on the box can refresh does not keep the promise the reaper
      // exists for - a session the account is charged a slot for, running with
      // nobody watching. A fetch from our own page sends `Sec-Fetch-Dest: empty`;
      // an image, a frame or a stylesheet does not, and neither does a navigation.
      const dest = String(((req && req.headers) || {})["sec-fetch-dest"] || "");
      if (dest === "" || dest === "empty") live.lastAsked = Date.now();
      host.json(res, {
        ok: true,
        active: true,
        id: live.session.id,
        state: live.state,
        // The server ended it - somebody quit from the Xbox guide, or the session
        // timed out. Said plainly, because the alternative is a frozen picture
        // until WebRTC's own ICE timeout gives up half a minute later.
        ended: live.ended || null,
        // Deliberately not a countdown: the server's estimate said 10 s for a wait
        // that took 224, so it is an order of magnitude and nothing more.
        queueSeconds: live.queueSeconds,
        queuedFor: live.queuedFor,
        ...(live.error || {}),
        // The renderer applies these to its own offer, so they travel with the
        // session rather than being fetched separately at the moment it matters.
        quality: { maxVideoKbps: settings.get().maxVideoKbps, stereo: settings.get().stereo },
        // No `serverDetails`: nothing in the page reads it, and it is the one field
        // here that is an unmodelled object straight from Microsoft - so handing it
        // through made the guard the shape of THEIR response rather than a list of
        // ours. Anything new it carries would reach the renderer unexamined.
        config: live.config
          ? {
              overrides: live.config.overrides,
              keepAliveMs: live.config.keepAliveMs,
              noConnectionTimeoutMs: live.config.noConnectionTimeoutMs,
            }
          : null,
      });
    },

    // The offer/answer and the candidates. POST for the same-origin gate, and
    // because both change server-side state.
    "POST /session/sdp": (req, res, ctx) => {
      if (!live) return host.json(res, { ok: false, code: "no_session", error: "no session" });
      Promise.resolve((ctx && ctx.body) || {})
        .then((data) => {
          const sdp = String((data && data.sdp) || "");
          if (!sdp) throw new sessions.SessionError("bad_request", "no sdp");
          const send = data.chat ? sessions.sendChatSdp : sessions.sendSdp;
          return send(live.session, sdp, { signal: live.controller.signal });
        })
        .then((answer) => host.json(res, { ok: true, answer }))
        .catch((e) => host.json(res, errorPayload(e)));
    },

    "POST /session/ice": (req, res, ctx) => {
      if (!live) return host.json(res, { ok: false, code: "no_session", error: "no session" });
      Promise.resolve((ctx && ctx.body) || {})
        .then((data) => sessions.sendIce(live.session, data && data.candidate, { signal: live.controller.signal }))
        .then((candidates) => host.json(res, { ok: true, candidates }))
        .catch((e) => host.json(res, errorPayload(e)));
    },

    "POST /session/stop": (req, res) => {
      endSession()
        .then(() => host.json(res, { ok: true }))
        .catch((e) => host.json(res, errorPayload(e)));
    },

    // How long the queue is. Only worth showing when it is not zero, which for an
    // Ultimate account is most of the time.
    "GET /waittime": (req, res) => {
      const id = new URL(req.url, host.base).searchParams.get("id") || "";
      api
        .fetchWaitTime(id)
        .then((seconds) => host.json(res, { ok: true, seconds }))
        .catch((e) => host.json(res, errorPayload(e)));
    },
  };

  // Two of these reads SPEND something upstream, so they get the same-origin gate
  // that every non-GET has (shell 3.10+; an older shell ignores the argument).
  // `/library` is ~101 authenticated requests to Microsoft on a cold cache and it
  // rewrites the cached language; `/waittime` is one authenticated request per
  // distinct id, and an <img src> can fire either from any page the box loads.
  host.registerRoutes("/tvbox/api/xcloud", routes, { guard: ["GET /library", "GET /waittime"] });

  // The catalogue language follows the PAGE, the market does not: the market comes
  // from the streaming token because it is the account's, not the box's.
  //
  // The page is asked because it is the only side that knows. The box's own
  // `config.locale` is unset (measured on this box), and the language the whole UI
  // is in lives in a localStorage key the launcher and every local app share -
  // which a host-side plugin cannot read. Without this the catalogue's categories,
  // which the server localises, came back in English on a Hungarian box.
  // Held to the list of languages this app can be in, not to a pattern: see
  // settings.js. Anything else falls back rather than being fetched.
  function locale(req) {
    if (req) {
      try {
        const asked = new URL(req.url, host.base).searchParams.get("lang") || "";
        if (settings.LANGUAGES.includes(asked)) return asked;
      } catch {
        /* a url we cannot parse is not a language */
      }
    }
    try {
      // `uiLocale`, which is what the shell's config actually exposes - there is no
      // `get`, so this branch threw and every caller fell back to en-US. It answers
      // with a short id ("hu"), which `language()` maps to the tag we ship.
      const l = host.config && host.config.uiLocale ? host.config.uiLocale() : "";
      return settings.language(l);
    } catch {
      return settings.DEFAULT_LANGUAGE;
    }
  }

  // A signed-in box refreshes the library in the background, but only when nothing
  // is on screen and nothing is playing: the pass is ~17 s of requests, and
  // host.idle() is the box's own answer to "is now a good time" (shell 1.6+, hence
  // the optional call).
  let idleTimer = null;
  const IDLE_CHECK_MS = 15 * 60 * 1000;

  function maybeRefresh() {
    if (!auth.isSignedIn()) return;
    if (host.idle && !host.idle()) return;
    // The language the SCREEN last asked for, not the box's own - which is unset
    // here, so this asked for en-US every fifteen minutes and threw away the
    // Hungarian catalogue each time.
    const language = library.askedLanguage() || locale();
    library
      .get({ language, remember: false })
      .catch((e) => log("background library refresh failed:", e.message));
  }

  return {
    start() {
      idleTimer = setInterval(maybeRefresh, IDLE_CHECK_MS);
      // Unref so a shell shutdown is never held open by this timer.
      if (idleTimer.unref) idleTimer.unref();
      log("ready");
    },
    stop() {
      if (idleTimer) clearInterval(idleTimer);
      idleTimer = null;
      if (signin) signin.controller.abort();
      signin = null;
      // A shell shutdown must not leave a stream running on a real machine.
      endSession().catch(() => {});
    },
  };
};
