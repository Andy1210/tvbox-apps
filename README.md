# tvbox-apps — the app registry

The app registry for [tvbox](https://github.com/Andy1210/tvbox). Apps are
**packages** here (the Kodi model): the tvbox shell ships only the SDK, each app
brings its own code + UI. CI compiles the registry into a single **`index.json`**
that every box fetches over HTTPS (HOME → "Get more apps", or Settings → Store).

> **Status:** live. Boxes fetch `index.json` from this repo's **GitHub Pages
> site** — the URL the shell hardcodes as `DEFAULT_REGISTRY` (`shell/store.js`):
> <https://andy1210.github.io/tvbox-apps/index.json>. Merging to `main` builds
> and publishes it; **no tvbox/box release needed** to add or update an app.
> Package files are fetched relative to that URL, so the whole registry moves
> with the index if it is ever hosted elsewhere (a box can be pointed at its own
> via `store.registry` in `~/.tvbox/config.json`).

## What is in it

| id                             | Kind                                   | What it is                                                    |
| ------------------------------ | -------------------------------------- | ------------------------------------------------------------- |
| [files](apps/files/)           | package (own UI)                       | The box's own folders, USB sticks, a NAS share, and photos    |
| [livetv](apps/livetv/)         | package (own UI + plugin)              | IPTV over Xtream Codes or M3U, with an XMLTV guide            |
| [plex](apps/plex/)             | manifest + bridge, bundle from flatpak | The official Plex HTPC client, driven by the box's mpv        |
| [jellyfin](apps/jellyfin.json) | manifest only (remote)                 | Your own Jellyfin server                                      |
| [youtube](apps/youtube.json)   | manifest only (remote)                 | `youtube.com/tv`, with a smart-TV user agent                  |
| [xcloud](apps/xcloud.json)     | manifest only (remote)                 | Xbox Cloud Gaming                                             |
| [spotify](apps/spotify/)       | package (own UI + plugin)              | A Spotify Connect speaker, and optional account browsing      |
| [retroarch](apps/retroarch/)   | package (own UI + plugin + native)     | A covers grid that starts the emulator on the game you picked |

Versions live in each manifest; CI publishes whatever is on `main`.

## 📦 Writing an app → [AUTHORING.md](AUTHORING.md)

The full guide: package layout, the manifest reference, the web UI (`@tvbox/app-sdk`),
the host plugin API, dependencies + **the platform baseline** (what the box already
ships), **hosting a download-dep binary** (+ sha256), versioning/updates, and
publishing. Start there.

## How a box consumes it

```
box (Store) ──HTTPS──▶ index.json   { registryVersion:1, apps:[manifests], packages:{<id>:{files:[{path,sha256}]}} }
     │ install
     ├─ manifest-only app → ~/.tvbox/apps/<id>.json          (tile appears live)
     └─ package app       → ~/.tvbox/apps/<id>/               (whole dir fetched,
                              manifest.json + plugin.js + web/…  each file sha256-verified)
```

## Trust rules (enforced by CI _and_ by the box)

This is a **curated** repo: **every app is merge-reviewed** (only maintainers
merge), so the review — not a sandbox — is the trust boundary, the way Kodi's
official repo works. An app here MAY carry real power:

- ✔ `service` — a host-side plugin (Node: daemons, HTTP routes, OAuth windows),
  shipped as `plugin.js` **inside the app package**. (e.g. Spotify's librespot
  supervisor, Live TV's IPTV data proxy.)
- ✔ its own `web/` UI (`serve:"local"`), a `remote` site, or the legacy `static`
  root bundle; capability-scoped preload + bridges.
- ✔ deps, in order of preference: `requires.download` (a no-root static binary,
  sha256-pinned, installs from the UI), `requires.flatpak` (a flathub app,
  `--user`, also from the UI), then `requires.apt` — the one step that asks for
  sudo, and one an OTA-updated box cannot take at all.
- ❌ `requires.aptRepo` — a third-party **root** apt source is risky and avoidable;
  ship binaries as `requires.download`. The one hard line CI keeps.
- `type` is `webclient` or `native` (a program that draws its own fullscreen
  window); `serve` is `local | remote | static`. There is no `builtin` — apps are
  packages, not launcher-compiled views.

## Submitting

1. Add `apps/<id>.json` (manifest-only) or the `apps/<id>/` package — see
   [AUTHORING.md](AUTHORING.md).
2. Open a PR. **Do not build or commit `index.json` or `apps/<id>/web/`** —
   both are generated. CI builds every app UI from `apps-src/`, compiles the
   index from what it produced, validates it against the JSON Schema, and stages
   the exact bytes it would serve (re-checking every sha256).
3. A maintainer reviews (the trust boundary) and merges. Merging to `main`
   deploys the site.

Locally, `node scripts/build-index.mjs` (after `npm run build:<id>`) does the
same thing if you want to see the index; it is ignored by git.

## Trying it on a real box first

```sh
npm run build:<id>          # only if your app has a web/ UI
npm run store:serve         # builds the index, stages the site, serves it on :8790
```

It prints a `http://<your LAN address>:8790/index.json` line. Add that in
**Settings → Apps → Store sources** on a box (tvbox 2.10.0 or newer) and this
checkout becomes a registry the box installs from, next to the official one. Add
it rather than replacing the official registry: the box merges both, and an app
you install from here stays with this registry even if the same id later appears
in the official one.

This is the way to test anything that changes what a box installs, including a
breaking change, without publishing it first. Flags go after `--`, so npm passes
them on: `npm run store:serve -- --watch` rebuilds the index when a manifest
changes, and `npm run store:serve -- --port 9000` moves it off 8790.

## Layout

```
apps/<id>.json            manifest-only app
apps/<id>/                package app: manifest.json + plugin.js + lib/ + pairing/ (web/ is BUILT)
apps-src/<id>/            source for a package's web/ UI (Vite) - the only copy in git
scripts/build-index.mjs   validator + index builder (no dependencies)
scripts/stage-site.mjs    assembles _site/ from index.json: what CI publishes
scripts/serve-store.mjs   serves this checkout as a registry (npm run store:serve)
index.json                generated, gitignored - CI builds and serves it
apps/<id>/web/            generated, gitignored - built from apps-src/<id>/
package.json              build tooling (build:<id> per app UI)
.github/workflows/ci.yml  build + validate, and publish to Pages on main
```
