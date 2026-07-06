# tvbox-apps — the app registry

The community app registry for [tvbox](https://github.com/Andy1210/tvbox):
one vetted manifest per app, compiled by CI into a single **`index.json`**
that every box fetches over HTTPS (Settings → Store on the TV).

> **Status:** live. Boxes fetch `index.json` from this repo's `main` over
> GitHub raw — the URL the shell hardcodes as `DEFAULT_REGISTRY`
> (`shell/store.js` in the main [tvbox](https://github.com/Andy1210/tvbox)
> repo): <https://raw.githubusercontent.com/Andy1210/tvbox-apps/main/index.json>.
> Merging to `main` publishes; no box update needed.

## How a box consumes it

```
box (Settings → Store) ──HTTPS──▶ index.json  (registryVersion 1, apps: [manifests])
        │ install
        ▼
~/.tvbox/apps/<id>.json   ← manifest written locally; tile appears live
```

Bundles/binaries still follow tvbox's normal opt-in paths (UI bundle install,
`tvbox deps`) — the store only distributes **manifests**.

## Trust rules (enforced by CI _and_ by the box)

Store apps are **manifest-only**:

- ❌ no `service` — a shell plugin is arbitrary Node code in the host process;
  plugins are only accepted into the main tvbox repo where they get code review.
- ❌ no `requires.aptRepo` — no third-party root apt repos via the store.
- ❌ no `type: builtin` — built-in views live in the launcher.
- ✔ `remote` sites run in tvbox's isolated, sandboxed window, locked to their
  declared `origins`; `static` bundles are served locally with
  capability-scoped bridges. `requires.apt`/`download` deps are fine — the
  user runs `tvbox deps <id>` explicitly.

## Submitting an app

1. Write `apps/<id>.json` — field reference:
   [docs/app-manifest.md](https://github.com/Andy1210/tvbox/blob/main/docs/app-manifest.md).
2. Validate locally:
   ```sh
   node scripts/build-index.mjs          # validates every manifest + rebuilds index.json
   ```
3. Open a PR. Review checklist: trust rules above, the URL/origins are sane,
   the icon is inline SVG (no external fetches), name/tagline localized
   (`en` minimum).

## Layout

```
apps/<id>.json        one manifest per app (the PR unit)
scripts/build-index.mjs   validator + index builder (no dependencies)
index.json            generated — DO NOT edit by hand (CI rebuilds it)
.github/workflows/ci.yml  validator + index-freshness + JSON Schema check
```
