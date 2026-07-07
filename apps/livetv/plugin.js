// Live TV app plugin — the host-side entry point the shell loads at boot when
// this package is installed (manifest `service: "livetv"`, deps resolved). It
// ships in the app PACKAGE, not the core shell (Kodi model): the shell only
// provides the SDK (`host`), the package brings the implementation.
//
// Responsibilities:
//   • register the /tvbox/api/livetv/* data routes (channels/guide/nownext/epg)
//     over the packaged IPTV provider (./lib/provider)
//   • register the "iptv" phone-pairing kind (Xtream / M3U source setup), serving
//     its page from the package and saving via the shell's config store
// Playback is NOT here — it's the shell's shared mpv, driven by the app's web UI
// through window.tvbox.play(). This is purely the IPTV data + setup surface.
const fs = require("fs");
const path = require("path");
const livetv = require("./lib/provider");

// {{token}} substitution — same contract as the shell's pairing renderPage, but
// reading the page from THIS package (the core PAGES_DIR no longer carries it).
function renderTemplate(html, vars) {
  return html.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : ""));
}

const PAIRING_STR = {
  hu: {
    title: "tvbox — Élő TV beállítás",
    code: "Kód (a TV-ről)",
    xtream: "Xtream API",
    m3u: "M3U lista",
    host: "Szerver (host:port)",
    user: "Felhasználónév",
    pass: "Jelszó",
    m3uUrl: "M3U URL",
    epgUrl: "EPG URL (nem kötelező)",
    save: "Mentés",
    done: "Kész! Visszatérhetsz a TV-hez.",
    errCode: "Hibás kód",
    err: "Hiba a mentéskor",
  },
  en: {
    title: "tvbox — Live TV setup",
    code: "Code (from the TV)",
    xtream: "Xtream API",
    m3u: "M3U playlist",
    host: "Server (host:port)",
    user: "Username",
    pass: "Password",
    m3uUrl: "M3U URL",
    epgUrl: "EPG URL (optional)",
    save: "Save",
    done: "Done! Return to the TV.",
    errCode: "Wrong code",
    err: "Failed to save",
  },
};

function sanitizeIptv(d) {
  if (!d) return null;
  if (d.mode === "xtream" && d.xtream && d.xtream.base && d.xtream.user) {
    return {
      mode: "xtream",
      xtream: {
        base: String(d.xtream.base).trim().replace(/\/+$/, ""),
        user: String(d.xtream.user).trim(),
        pass: String(d.xtream.pass || "").trim(),
      },
    };
  }
  if (d.mode === "m3u" && d.m3u && d.m3u.url) {
    return { mode: "m3u", m3u: { url: String(d.m3u.url).trim(), epgUrl: String(d.m3u.epgUrl || "").trim() } };
  }
  return null;
}

module.exports = (host) => {
  livetv.setConfig(host.config); // read the active IPTV source from the shell config store

  const routes = {
    // channel list (from the configured IPTV source in ~/.tvbox)
    "GET /channels": (req, res) => {
      livetv
        .getChannels()
        .then((channels) => host.json(res, { channels }))
        .catch((err) => host.json(res, { error: String(err.message || err), channels: [] }));
    },
    // EPG guide grid: programmes per channel overlapping [from,to]
    "GET /guide": (req, res) => {
      const q = new URL(req.url, host.base).searchParams;
      const now = Math.floor(Date.now() / 1000);
      const from = Number(q.get("from")) || now - 1800;
      const to = Number(q.get("to")) || now + 6 * 3600;
      livetv
        .getGuide(from, to)
        .then((guide) => host.json(res, { guide, from, to, now }))
        .catch((err) => host.json(res, { error: String(err.message || err), guide: {}, from, to, now }));
    },
    // now/next for ALL channels (parsed from the XMLTV guide)
    "GET /nownext": (req, res) => {
      livetv
        .getNowNext()
        .then((nownext) => host.json(res, { nownext }))
        .catch((err) => host.json(res, { error: String(err.message || err), nownext: {} }));
    },
    // now/next EPG for one channel (Xtream get_short_epg)
    "GET /epg": (req, res) => {
      const id = new URL(req.url, host.base).searchParams.get("id") || "";
      livetv
        .getShortEpg(id, 2)
        .then((epg) => host.json(res, { epg }))
        .catch((err) => host.json(res, { error: String(err.message || err), epg: [] }));
    },
  };
  host.registerRoutes("/tvbox/api/livetv", routes);

  // Drop the channel/EPG cache when the IPTV source changes. The app's settings
  // save through the generic POST /tvbox/api/config (not our routes), so the
  // shell notifies us via onConfigChange rather than us seeing the write.
  if (host.onConfigChange) {
    host.onConfigChange((sections) => {
      if (sections.includes("iptv")) livetv.clearCache();
    });
  }

  // Phone pairing: Live TV source setup (Xtream / M3U). The page lives in this
  // package; the shell gives us the code-gate, lifecycle, and config store.
  const pageHtml = fs.readFileSync(path.join(__dirname, "pairing", "iptv.html"), "utf8");
  host.pairing.register("iptv", {
    page: (ctx) => renderTemplate(pageHtml, { lang: ctx.locale, ...(PAIRING_STR[ctx.locale] || PAIRING_STR.en) }),
    routes: {
      "POST /save": (req, res, ctx) => {
        const iptv = sanitizeIptv(ctx.body);
        if (!iptv) return ctx.json(res, { ok: false, error: "invalid" });
        host.config.setIptv(iptv);
        livetv.clearCache();
        ctx.json(res, { ok: true });
        ctx.stopSoon(); // the TV polls config/status and closes; then pairing shuts down
      },
    },
  });

  return {};
};
