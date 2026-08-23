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

// One sign-in at a time, and it is deliberately not persisted: a device code dies
// with the process that requested it, so a code surviving a shell restart in a
// file would be a code the person types in vain.
let signin = null;

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
  const log = (...a) => (host.log ? host.log("xcloud", ...a) : console.log("[xcloud]", ...a));

  // The account, and what it can reach. Deliberately says nothing about tokens
  // beyond whether they work.
  async function status() {
    if (!auth.isSignedIn()) return { ok: true, signedIn: false, signingIn: !!signin, code: signin ? signin.public : null };
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
      if (signin) return host.json(res, { ok: true, ...signin.public });
      auth
        .startDeviceCodeAuth()
        .then((dc) => {
          const controller = new AbortController();
          signin = {
            public: { userCode: dc.userCode, verificationUri: dc.verificationUri, expiresIn: dc.expiresIn },
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
              library.refresh({ language: locale() }).catch((e) => log("library warm-up failed:", e.message));
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
      auth.signOut();
      // The library is what this account may stream, so it goes with the account.
      library.invalidate();
      log("signed out");
      host.json(res, { ok: true });
    },

    // The whole playable library, from cache when it is fresh. `stale` means the
    // rows are usable and a refresh is already running behind this answer, so the
    // UI can draw now and re-read later rather than showing a spinner.
    "GET /library": (req, res) => {
      library
        .get({ language: locale() })
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

  host.registerRoutes("/tvbox/api/xcloud", routes);

  // The catalogue language follows the box, the market does not: the market comes
  // from the streaming token because it is the account's, not the box's.
  function locale() {
    try {
      const l = host.config && host.config.get ? host.config.get("locale") : null;
      return l && /^[a-z]{2}(-[A-Z]{2})?$/.test(l) ? l : "en-US";
    } catch {
      return "en-US";
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
    library.get({ language: locale() }).catch((e) => log("background library refresh failed:", e.message));
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
    },
  };
};
