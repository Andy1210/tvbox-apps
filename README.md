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
- ✔ deps: `requires.download` (no-root static binary, installs from the UI) or
  `requires.apt` (the one `tvbox deps` sudo step). Prefer `download`.
- ❌ `requires.aptRepo` — a third-party **root** apt source is risky and avoidable;
  ship binaries as `requires.download`. The one hard line CI keeps.
- `type` is `webclient` only; `serve` is `local | remote | static` (no `builtin` —
  apps are packages now, not launcher-compiled views).

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

## Layout

```
apps/<id>.json            manifest-only app
apps/<id>/                package app: manifest.json + plugin.js + lib/ + pairing/ (web/ is BUILT)
apps-src/<id>/            source for a package's web/ UI (Vite) - the only copy in git
scripts/build-index.mjs   validator + index builder (no dependencies)
scripts/stage-site.mjs    assembles _site/ from index.json: what CI publishes
index.json                generated, gitignored - CI builds and serves it
apps/<id>/web/            generated, gitignored - built from apps-src/<id>/
package.json              build tooling (build:<id> per app UI)
.github/workflows/ci.yml  build + validate, and publish to Pages on main
```
