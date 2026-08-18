# Authoring a tvbox app

tvbox apps are **packages in this registry** — the Kodi model. The tvbox shell
ships only the SDK (a launcher shell + a host/runtime API); every app brings its
own code and UI here. This repo is **curated**: every app is merge-reviewed, and
that review _is_ the trust boundary. An app updates independently of any tvbox
release — push a new version here and boxes pick it up (they poll `index.json`).

- [The two kinds of app](#the-two-kinds-of-app)
- [Package layout](#package-layout)
- [Manifest reference](#manifest-reference)
- [The web UI](#the-web-ui)
- [The host plugin](#the-host-plugin)
- [Dependencies — and the platform baseline](#dependencies--and-the-platform-baseline)
- [Hosting a download-dep binary](#hosting-a-download-dep-binary)
- [Versioning & updates](#versioning--updates)
- [Trying it on a box before you publish](#trying-it-on-a-box-before-you-publish)
- [Publishing](#publishing)

## The two kinds of app

1. **Manifest-only** — a single `apps/<id>.json`. Enough for a **remote** web app
   you don't host (YouTube: the shell just loads their URL in a hardened
   window) or an app whose bundle its own install recipe fetches (the retired
   Plex app did this; nothing in the registry does today).
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

The **schema defines the shape**, and CI here validates every manifest against
it - then applies this registry's own rules on top, which are stricter (no
`requires.aptRepo`, a `bridge` that must be in the package, a `runtime.native`
flatpak that must also be a declared dep). A manifest can be schema-valid and
still be refused here; `scripts/build-index.mjs` is where those rules live. The
schema itself:
[docs/app-manifest.schema.json](https://github.com/Andy1210/tvbox/blob/main/docs/app-manifest.schema.json)
in the core repo, with the field-by-field prose next to it in
[docs/app-manifest.md](https://github.com/Andy1210/tvbox/blob/main/docs/app-manifest.md).
This is the working subset.

```jsonc
{
  "id": "myapp",                     // [a-z0-9_-]+, must equal the file/dir name
  "manifestVersion": 1,
  "name": { "hu": "…", "en": "…" },  // or a plain string
  "version": "1.0.0",                // semver; bumping it is what offers every box an Update
  "type": "webclient",               // webclient | native  (see below)
  "status": "ready",                 // or "coming_soon"
  "accent": "#39c0d6",               // hex only (interpolated into launcher CSS)
  "icon": "<svg …>",                 // inline SVG, no external refs/scripts
  "tagline": { "hu": "…", "en": "…" },
  "description": { "en": "…" },      // the store's detail view, under the tagline
  "changelog": [{ "version": "1.1.0", "notes": "What changed, for the person on the couch." }],
  "screenshots": ["https://…"],      // up to 8, shown in the detail view; host them in this repo
  "service": "myapp",                // optional — load apps/<id>/plugin.js at boot as this service
  "requires": { … },                 // optional — see Dependencies
  "pairing": [{ "kind": "roms", "label": { "en": "Upload games" } }], // phone actions; needs a service
  "backup": { … },                   // optional — what a settings backup carries (see below)
  "shares": { … },                   // optional — what another box may read (see below)
  "runtime": {
    "serve": "local",                // local | remote | static  (see below)
    "entry": "index.html",           // local/static: the bundle entry
    "url": "https://…",              // remote: the site to load
    "urlConfig": "myapp",            // remote: config key holding a user-set base URL (self-hosted)
    "mount": "root",                 // static only: single root-mounted bundle (legacy, e.g. Plex)
    "bridge": "./bridge.js",         // optional renderer bridge YOUR package ships (see below)
    "native": { "flatpak": "…" },    // a program of its own to launch (see below)
    "capabilities": ["nav"],         // what the preload exposes — see below
    "origins": ["example.com"]       // hosts the `fetch` capability may reach (bare hostnames)
  }
}
```

**`changelog` is what the store shows as "What's new"** before someone presses
Update, newest version first, `notes` one plain English string. Write it for the
person on the couch, like the box's own release notes.

**`runtime.serve`:**

- `local` — your package ships a `web/` bundle; the shell serves it at `/<id>/`
  in the privileged main window (full `window.tvbox` SDK). The usual choice for a
  first-party UI.
- `remote` — the shell loads `url` (or a user-set `urlConfig` base URL) in an
  isolated, sandboxed window. For third-party sites you don't host.
- `static` — the legacy single root-mounted bundle (`mount:"root"`). Only one per
  box; Plex uses it.

**`type` and a program of your own.** `webclient` covers everything above: the
shell serves or loads a page. `native` is the other kind - the app IS a program
that draws its own fullscreen Wayland window, the shell spawns it and hides its
own windows while it runs, and `runtime.native` says what to launch
(`{ flatpak }` or `{ bin }`, plus `args`).

A `webclient` app may declare `runtime.native` **as well**, and that is the more
useful shape: your own 10-foot UI, which launches the program per item. RetroArch
is exactly this - a covers grid of ours that starts the emulator on the game you
picked, and comes back to the grid when it exits. A flatpak named there must also
be in `requires.flatpak`, so the tile greys out until it is installed rather than
failing at launch; CI checks that pairing.

**`runtime.bridge`** is a renderer bridge **your package ships**, named as
`"./<file>.js"` next to the manifest - lowercase `[a-z0-9_-]`, no subdirectory,
and the file has to be in the package (CI checks both). It exists to emulate a foreign host API a
third-party client expects - Plex HTPC wants Qt's QWebChannel - which is one
client's shape, so it belongs to that app and updates from the registry with it.
The shell ships none of its own.

**`capabilities`** (what the preload bridge exposes to the page). Leave the field
out and you get `["nav"]`; an explicit `[]` grants nothing at all, which is what a
`native` app wants (it has no renderer of ours). The rest:
`nav` (home/back/launch), `player` (shared mpv: play/stop/pip/onPlayer), `fetch`
(origin-locked server-side fetch), `storage` (per-app key/value), `config`,
`display` (claim an output mode for video the app plays itself), `input`,
`system`, `shares` (this app's own folders, brought from a paired tvbox - what may
be offered is `shares.paths` below, and switching it on is a person's job in
Settings). Declare only what you actually use: an app gets exactly its declared
capabilities and nothing else, in the main window as well as a sandboxed one.

### What travels: `backup` and `shares`

Two blocks name paths of the app's OWN, and neither is a runtime call: the box
only ever acts on what the manifest declares, so an app cannot ask for a path
later. `backup.paths` takes files as well as folders (RetroArch carries its
`retroarch.cfg`); `shares.paths` is directories.

```jsonc
"backup": {
  "flatpak": "org.libretro.RetroArch", // anchor: the app's own flatpak data dir
  "paths": ["config/retroarch/saves", "config/retroarch/playlists"],
  "state": ["retroarch-share.json"]    // <id>-prefixed sidecars in ~/.tvbox/
},
"shares": {
  "flatpak": "org.libretro.RetroArch",
  "paths": ["config/retroarch/saves", "config/retroarch/states"],
  "exclude": ["**/Cache/**", "**/Logs/**"]
}
```

- **`backup`** is what the encrypted settings backup carries and a restore puts
  back. Use it for what a person would be sad to lose and the box cannot
  re-acquire: save files, playlists, a config the user tuned. Not caches, not
  anything re-downloadable - the file goes to a phone over the LAN and back.
- **`shares`** is what _another tvbox in the house_ may read, read-only, over its
  own credential: an emulator's saves, so a game started in one room can be
  continued in the other. It is off until someone turns it on in Settings, and a
  box only ever pulls.
- `state` names sidecar files in `~/.tvbox/` and they must start with `<id>-`.
  That prefix is a boundary, not a convention: an app id is only constrained to
  `[a-z0-9_-]`, so without it a manifest calling itself `config` could name the
  box's own `config.json`. The prefix is not the only gate either - the shell
  keeps a list of its own sidecars and refuses those names whatever the id is, so
  do not try to reach one.

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

### Files on the box, and USB sticks

The shell offers what there is to play locally, so an app does not need a plugin
(or any filesystem access of its own) to reach it. `apps/files/` is the reference
consumer; the design notes are in the core repo's
[docs/local-media.md](https://github.com/Andy1210/tvbox/blob/main/docs/local-media.md).

```ts
// The roots: the user's own folders (~/, ~/.tvbox user content), every partition
// of every removable drive (mounted or merely plugged in), and every mounted
// network share - `kind` says which, and a share needs no work from the app.
const { sources, removable } = await (await fetch("/tvbox/api/browse/sources")).json();
// One directory INSIDE one of those roots. Anything else is refused.
const listing = await (await fetch("/tvbox/api/browse/list?path=" + encodeURIComponent(p))).json();
// Nothing auto-mounts on this box: opening a stick IS the mount.
await fetch("/tvbox/api/browse/mount", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ device }),
});
```

Three things to build around:

- **These routes are newer than some shells in the field.** A 404 means the box
  cannot do this at all; say so on screen rather than showing an empty list. Same
  for `removable.supported: false`, which is a box without `udisks2`.
- **A path is checked, not trusted.** Both sides are resolved with `realpath` and
  compared as `root + separator`, so `..`, a symlink on the stick and a
  same-prefix sibling folder are all refused - do not try to construct paths, walk
  from what a listing gave you.
- **A file plays like any other URL:** `window.tvbox.play?.(entry.path, undefined,
startPos)` with the `player` capability, plus `pause`/`resume`/`seek` for
  something that is not a live stream. Feature-detect all of them with `?.` - a
  shell older than the API exposes none of them, and a screen that assumes they
  are there is a spinner nobody can leave.

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
  // childEnv, audioSink, showLauncher, navTo, appState, switchOn, widget, idle,
  // base, log
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
host.appState("myapp"); // { running, foreground } - is it alive, is it on screen
```

### Background work: wait for `host.idle()`

A plugin that wants to do something heavy on its own - download a library of
artwork, rebuild an index - should ask first:

```js
if (host.idle?.()) startTheSweep(); // nothing on screen, nothing playing
```

`host.idle()` is the box's own idleness test (no mpv, launcher focused, nothing
reported playing), the same one that gates the nightly auto-update - so it is
also false while a `native` app owns the screen. Poll it on a timer and stop
between units of work rather than assuming it stays true; a user-initiated
action should ignore it (they asked for it now). It is **shell 1.6+**, so
feature-detect with `?.` and decide what an older shell does. RetroArch's
artwork pass (`apps/retroarch/lib/art.js`) is the reference.

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
- **`requires.flatpak: ["org.libretro.RetroArch"]`** — a flathub app, installed
  `--user` with no root, from the UI like a download dep. The box's own arch is
  used and the install is retried, because an app plus its runtime is a large pull
  that can time out. A missing one greys the tile rather than failing at launch.
- **`requires.apt: ["foo"]`** — a Debian package. Needs root (`tvbox deps <id>`),
  so it's a last resort, and a box that only ever took OTA updates cannot install
  one at all. **`requires.aptRepo` is forbidden** (a third-party root apt source is
  risky and avoidable — ship a `download` binary instead).

### Platform baseline — what every box already ships

You do **not** need a dep for these; just `requires.bin` if you want the load-gate.
Shipped by the SD image (and `deploy/provision.sh`), kept in sync between them:

| Category        | Ships                                                                                                                                                                                                                                                                                                                             |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Media**       | `mpv` (the shared player — Live TV/Plex use it), `libpulse0`, `libasound2t64` (audio runtime)                                                                                                                                                                                                                                     |
| **Audio stack** | `pipewire`, `pipewire-pulse`, `wireplumber`                                                                                                                                                                                                                                                                                       |
| **Runtime**     | `nodejs`, `npm`, `python3`, `python3-evdev`                                                                                                                                                                                                                                                                                       |
| **Session**     | `tvbox-wc` (the box's own Wayland compositor), `seatd`, `greetd`. A box provisioned before 2.0 has `labwc` + `wlrctl` + `kanshi` instead; a package that cares about the difference should ask rather than assume - `TVBOX_WC_SOCKET` in the environment, or `$XDG_RUNTIME_DIR/tvbox-wc.sock`, is what says which one is running. |
| **Tooling**     | `curl`, `git`, `unzip`, `jq`, `flatpak`, `ca-certificates`, `cec-utils`                                                                                                                                                                                                                                                           |
| **Storage**     | `udisks2` - what mounts a USB stick with no root. Reach it through the shell's browse API (below), never directly. A box that only ever took OTA updates does not have it (OTA cannot install apt packages), so treat it as optional and degrade.                                                                                 |

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

## Trying it on a box before you publish

A box can install from any `index.json` it can reach, so serve this checkout:

```sh
npm run build:<id>     # your app's UI, if it has one
npm run store:serve    # prints http://<your LAN address>:8790/index.json
```

Add that address in **Settings → Apps → Store sources** on the box (tvbox 2.10.0
or newer), next to the official registry rather than instead of it. Your app then
appears in the store, installs the same way it will after publishing, and stays
tied to your local registry even if the official one carries the same id.

Two notes. Plain `http` works only because the address is on your own network:
the box refuses a public http registry. And the box will not update this app by
itself unless you turn unattended updates on for that source, which is off by
default for anything you add.

## Publishing

1. Add `apps/<id>.json` or the `apps/<id>/` package. For a package UI, the
   source is `apps-src/<id>/`; **`apps/<id>/web/` and `index.json` are generated
   and gitignored**, so there is nothing to build or commit for them.
2. Open a PR. CI builds every app UI from `apps-src/`, compiles `index.json`
   from what it built (recording each package file's path + sha256), validates
   the manifests against the JSON Schema, and stages the exact bytes it would
   serve - re-checking every sha256 against the file.
3. A maintainer reviews (the trust boundary) and merges. Merging to `main`
   deploys the registry to GitHub Pages.
4. Boxes fetch the updated `index.json` and install/update on the user's action —
   independently of any tvbox/shell release.
