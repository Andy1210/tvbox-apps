# tvbox-apps — the app registry

The app registry for [tvbox](https://github.com/Andy1210/tvbox). Apps are
**packages** here (the Kodi model): the tvbox shell ships only the SDK, each app
brings its own code + UI. CI compiles the registry into a single **`index.json`**
that every box fetches over HTTPS (HOME → "Get more apps", or Settings → Store).

> **Status:** live. Boxes fetch `index.json` from this repo's `main` over GitHub
> raw — the URL the shell hardcodes as `DEFAULT_REGISTRY` (`shell/store.js`):
> <https://raw.githubusercontent.com/Andy1210/tvbox-apps/main/index.json>.
> Merging to `main` publishes; **no tvbox/box release needed** to add or update
> an app.

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
2. `node scripts/build-index.mjs` — validates every manifest + rebuilds
   `index.json` (records each package file's path + sha256). Commit `index.json`.
3. Open a PR. CI validates against the JSON Schema + checks the index is current;
   a maintainer reviews (the trust boundary) and merges.

## Layout

```
apps/<id>.json            manifest-only app
apps/<id>/                package app: manifest.json + plugin.js + lib/ + web/ + pairing/
apps-src/<id>/            build-time source for a package's web/ UI (Vite; not shipped)
scripts/build-index.mjs   validator + index builder (no dependencies)
index.json                generated — DO NOT edit by hand
package.json              build tooling (build:<id> per app UI)
.github/workflows/ci.yml  validator + index-freshness + JSON Schema check
```
