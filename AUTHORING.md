# Authoring a tvbox app

tvbox apps are **packages in this registry** — the Kodi model. The tvbox shell
ships only the SDK (a launcher shell + a host/runtime API); every app brings its
own code and UI here. This repo is **curated**: every app is merge-reviewed, and
that review *is* the trust boundary. An app updates independently of any tvbox
release — push a new version here and boxes pick it up (they poll `index.json`).

- [The two kinds of app](#the-two-kinds-of-app)
- [Package layout](#package-layout)
- [Manifest reference](#manifest-reference)
- [The web UI](#the-web-ui)
- [The host plugin](#the-host-plugin)
- [Dependencies — and the platform baseline](#dependencies--and-the-platform-baseline)
- [Hosting a download-dep binary](#hosting-a-download-dep-binary)
- [Versioning & updates](#versioning--updates)
- [Publishing](#publishing)

## The two kinds of app

1. **Manifest-only** — a single `apps/<id>.json`. Enough for a **remote** web app
   you don't host (YouTube, Jellyfin: the shell just loads their URL in a hardened
   window) or an app whose bundle its own install recipe fetches (Plex).
2. **Package** — a directory `apps/<id>/` that ships its own code/UI: a `web/`
   bundle, an optional host `plugin.js`, pairing pages, etc. This is what you
   want for a first-party app with a custom 10-foot UI (see `apps/livetv/`,
   `apps/spotify/`). The box installs the whole directory, each file
   sha256-verified.

## Package layout

```
apps/<id>/
  manifest.json        # required — the app manifest (see below)
  plugin.js            # optional — host-side Node code (a `service`), loaded at boot
  lib/*.js             # optional — modules your plugin.js requires
  web/                 # optional — the built UI, served at /<id>/ (serve:"local")
    index.html
    assets/…
  pairing/*.html       # optional — phone-pairing pages your plugin serves
```

The **source** for a `web/` UI lives under `apps-src/<id>/` (a small Vite app);
its build output lands in `apps/<id>/web/`. See [The web UI](#the-web-ui). Only
`apps/<id>/` is shipped to boxes — `apps-src/` is build-time only.

## Manifest reference

```jsonc
{
  "id": "myapp",                     // [a-z0-9_-]+, must equal the file/dir name
  "manifestVersion": 1,
  "name": { "hu": "…", "en": "…" },  // or a plain string
  "version": "1.0.0",                // bump this to offer users an Update
  "type": "webclient",               // the only type — apps are web apps the shell serves/loads
  "status": "ready",                 // or "coming_soon"
  "accent": "#39c0d6",               // hex only (interpolated into launcher CSS)
  "icon": "<svg …>",                 // inline SVG, no external refs/scripts
  "tagline": { "hu": "…", "en": "…" },
  "service": "myapp",                // optional — load apps/<id>/plugin.js at boot as this service
  "requires": { … },                 // optional — see Dependencies
  "runtime": {
    "serve": "local",                // local | remote | static  (see below)
    "entry": "index.html",           // local/static: the bundle entry
    "url": "https://…",              // remote: the site to load
    "urlConfig": "myapp",            // remote: config key holding a user-set base URL (self-hosted)
    "mount": "root",                 // static only: single root-mounted bundle (legacy, e.g. Plex)
    "bridge": "qwebchannel",         // optional SDK bridge adapter for a remote QtWebEngine client
    "capabilities": ["nav"],         // what the preload exposes — see below
    "origins": ["example.com"]       // hosts the `fetch` capability may reach (bare hostnames)
  }
}
```

**`runtime.serve`:**
- `local` — your package ships a `web/` bundle; the shell serves it at `/<id>/`
  in the privileged main window (full `window.tvbox` SDK). The usual choice for a
  first-party UI.
- `remote` — the shell loads `url` (or a user-set `urlConfig` base URL) in an
  isolated, sandboxed window. For third-party sites you don't host.
- `static` — the legacy single root-mounted bundle (`mount:"root"`). Only one per
  box; Plex uses it.

**`capabilities`** (what the preload bridge exposes to the page):
`nav` (always), `player` (shared mpv: play/stop/pip/onPlayer), `fetch`
(origin-locked server-side fetch), `storage` (per-app key/value), `config`,
`input`, `system`. A `local` app in the main window already gets the full
`window.tvbox` surface via the shell preload; declare only what you actually use.
A remote/sandboxed app gets exactly its declared capabilities and nothing else.

## The web UI

An app UI is a standalone Vite app that consumes **`@tvbox/app-sdk`** (the shared
10-foot UI: spatial-nav focus components, on-screen keyboard, PIN pad, i18n,
config/capability clients). It's bundled into `web/` at build time, so the shipped
bundle has no external dependency. Copy `apps-src/livetv/` as a template:

- `main.tsx` — `configureI18n(locales)`, `initSpatialNavigation(...)`, then render
  your root view with `onExit={() => tvbox().home()}`.
- `vite.config.ts` — `base:"./"` (served at `/<id>/`), `@sdk` alias →
  `../../../app-sdk/src`, `dedupe:["react","react-dom",…]`, `outDir` →
  `../../apps/<id>/web`.
- `index.css` — `@import "tailwindcss"` + `@source` the app-sdk + your source +
  the shared `@theme` token block (copy from `apps-src/livetv/index.css`).
- `locales/{hu,en}.json` — your app's strings (the user's launcher language
  carries over via a shared `localStorage` key).

> `@tvbox/app-sdk` lives in the **core tvbox repo** (`app-sdk/`), consumed as
> source via the Vite alias. Build apps from within a tvbox checkout that has
> `tvbox-apps/` cloned inside it (the sibling layout the alias expects).

Talk to your own host routes with a plain same-origin `fetch("/tvbox/api/<id>/…")`
— a `local` app is served from the same origin as the API.

### Shared SDK helpers worth knowing

- **`PinGate` + `verifyPin`** - the box has ONE central parental PIN (set in HOME
  Settings, stored salted+hashed in the shell, verified server-side). Gate any
  action with `<PinGate onSuccess={…} onCancel={…} />` instead of re-wiring
  `PinPad` + `verifyPin` + error state yourself; its strings default to the
  shared `parental.enterPin` / `parental.wrongPin` i18n keys (override with
  `title` / `wrongText`).
- **`isBackKey(e)`** - for raw `keydown` handlers outside the `useBackspace`
  stack (e.g. a fullscreen playback view with no focusable UI). Remotes report
  Back as `Backspace`, `Escape`, `BrowserBack` or `GoBack` depending on how the
  box is driven; never check a single key.

```tsx
import { PinGate, verifyPin, isBackKey, useBackspace } from "@sdk";
```

### In-playback tracks (`player` capability)

While the shared mpv player is playing, an app can list the stream's
audio/subtitle tracks and switch them (an in-playback language picker):

```ts
const tracks = await window.tvbox.tracks?.(); // [] when nothing plays
// [{ type: "audio" | "sub", id: number, lang: string, title: string, selected: boolean }, …]
window.tvbox.setTrack?.("audio", 2); // switch to audio track id 2
window.tvbox.setTrack?.("sub", "no"); // subtitles off ("auto" is also accepted)
```

Feature-detect with `?.` - shells older than the API don't expose the
functions at all. Apply optimistically, then re-query `tracks()` after ~500ms
to confirm what mpv actually selected. Live TV's `TrackMenu.tsx`
(`apps-src/livetv/`) is the reference implementation.

## The host plugin

If your app needs host-side Node (a daemon, an OAuth window, server routes),
ship `apps/<id>/plugin.js` and set `"service": "<id>"`. It's a factory the shell
calls at boot with the SDK `host`:

```js
module.exports = (host) => {
  host.registerRoutes("/tvbox/api/myapp", { "GET /state": (req, res) => host.json(res, {...}) });
  host.pairing.register("myapp", { page: (ctx) => "<html>…", routes: { "POST /save": … } });
  host.onConfigChange((sections) => { if (sections.includes("myapp")) reload(); });
  // host also gives: config, BrowserWindow, spawnService/stopService/restartService,
  // childEnv, audioSink, showLauncher, navTo, widget, base, log
  return {}; // optional { start, stop }
};
```

The plugin loads only when its deps resolve. Read config via `host.config`
(injected — never `require` a core config module). Serve pairing pages from your
own package dir (read the HTML with `fs`, don't rely on the core page dir).

### HOME widget + foregrounding

A service plugin (the only sanctioned background code) can put ONE card on the
HOME screen and bring its own app forward:

```js
host.widget.set({ title: "Now playing", subtitle: "Artist / Track" }); // upsert the app's card
host.widget.clear(); // remove it
host.navTo("myapp"); // foreground an app by id ("home" = the launcher)
```

The widget slot is per-app (a plugin can only ever write its OWN card),
sanitized host-side (title capped at 120 chars, subtitle at 160) and cleared on
uninstall. The launcher renders it as a card on HOME; Enter on the card opens
the app. `navTo` stops whatever else is playing when it switches apps. Spotify
uses the pair for casts: a now-playing card while a cast is active, `navTo` to
jump to its UI. `host.widget` is shell 1.5+ host API - feature-detect
(`if (host.widget) …`) so the plugin still loads on older shells.

## Dependencies — and the platform baseline

Declare what your app needs under `requires`:

- **`requires.bin: ["mpv"]`** — a binary you expect to be present. Gates loading:
  if it's missing the plugin doesn't load. Use this for anything **in the platform
  baseline** (below) — no download needed.
- **`requires.download: [{ bin, arch: { arm64: { url, sha256 } } }]`** — a no-root
  static binary the box fetches into `~/.tvbox/bin` and sha256-verifies. **The
  preferred way to ship a binary the baseline lacks** — installable from the UI,
  no sudo. See [Hosting a download-dep binary](#hosting-a-download-dep-binary).
- **`requires.apt: ["foo"]`** — a Debian package. Needs root (`tvbox deps <id>`),
  so it's a last resort. **`requires.aptRepo` is forbidden** (a third-party root
  apt source is risky and avoidable — ship a `download` binary instead).

### Platform baseline — what every box already ships

You do **not** need a dep for these; just `requires.bin` if you want the load-gate.
Shipped by the SD image (and `deploy/provision.sh`), kept in sync between them:

| Category | Ships |
| --- | --- |
| **Media** | `mpv` (the shared player — Live TV/Plex use it), `libpulse0`, `libasound2t64` (audio runtime) |
| **Audio stack** | `pipewire`, `pipewire-pulse`, `wireplumber` |
| **Runtime** | `nodejs`, `npm`, `python3`, `python3-evdev` |
| **Session** | `labwc`, `seatd`, `greetd`, `wlrctl`, `kanshi` (Wayland kiosk) |
| **Tooling** | `curl`, `git`, `unzip`, `jq`, `flatpak`, `ca-certificates`, `cec-utils` |

Notably **NOT shipped** (declare a `download` or `apt` dep if you need them):
the `ffmpeg` **CLI** (mpv links the libs, but the standalone `ffmpeg`/`ffprobe`
binaries aren't installed), `yt-dlp`, `librespot` (the Spotify package ships it as
a `download` dep), and anything language-specific beyond Node/Python. When unsure,
assume it's not there and ship it as a `download` dep.

## Hosting a download-dep binary

The `download` URL can be **any https host** — the box just fetches it and checks
the sha256. Two patterns:

1. **Host it on your own GitHub release** (recommended for third-party apps): tag
   a release on your repo, attach the static binary as an asset, and point
   `arch.<arch>.url` at the asset URL with its `sha256`. You own and update it.
2. **Registry-hosted** (first-party, like `librespot`): the binary is a **release
   asset on this repo** (e.g. tag `librespot-v0.8.0`, asset `librespot-aarch64`).
   Open a PR with the manifest referencing it; a maintainer uploads the asset.

Why release assets and not the git tree: they stay out of git history (no repo
bloat, no LFS metering), and the **sha256 pins them** — it's checked at install
and reviewable in the PR, so a swapped asset can't slip through. Compute it with
`sha256sum <file>`. The box's arch is `arm64` (Raspberry Pi 5); provide that key.

Example (`apps/spotify/manifest.json`):

```jsonc
"requires": {
  "bin": ["librespot"],
  "download": [{
    "bin": "librespot",
    "arch": { "arm64": {
      "url": "https://github.com/Andy1210/tvbox-apps/releases/download/librespot-v0.8.0/librespot-aarch64",
      "sha256": "3adf05fd4d203072437da90fa9f977b99ff78bc98cc37173debc40c5f4a47c51"
    }}
  }]
}
```

## Versioning & updates

Set `version` (semver) in your manifest and **bump it on every change**. The box
compares the registry version to what's installed; when yours is newer, the App
Store shows an **Update** button (a re-install of the package, sha256-verified,
swapped in atomically). No tvbox release involved — just merge a version bump here.

## Publishing

1. Add `apps/<id>.json` or the `apps/<id>/` package (build its `web/` from
   `apps-src/<id>/`).
2. Run `node scripts/build-index.mjs` — it validates every manifest against the
   trust rules and regenerates `index.json` (for a package it records each file's
   path + sha256). Commit the regenerated `index.json`.
3. Open a PR. CI validates the manifests against the JSON Schema and checks the
   index is current. A maintainer reviews (the trust boundary) and merges.
4. Boxes fetch the updated `index.json` and install/update on the user's action —
   independently of any tvbox/shell release.
