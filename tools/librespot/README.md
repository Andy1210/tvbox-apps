# librespot build for the Spotify app

The binary behind `requires.download` in `apps/spotify/manifest.json`. It is librespot 0.8.0 (commit `ea81314`) plus two patches:

- `0001` is upstream's fix for picking a track in a list ([#1795](https://github.com/librespot-org/librespot/pull/1795)), which is not in a release yet. The Spotify app sends an empty `track_uri` next to the `track_uid`, and 0.8.0 plays the first track of the list because of it.
- `0002` stops a run of skips from turning into a skip storm. Spotify answers too many audio key requests with error code 2. A track without a key fails to load, librespot marks it unavailable and moves on, and that asks for another key, so the limit never clears and the player runs through the list. With the patch key requests are at least a second apart, a refused one is retried after 3, 5 and 10 seconds, and a load is cancelled when another track replaces it, so it does not spend a key. The numbers are a working guess, Spotify does not document the limit.

Build it from the repo root (needs Docker with BuildKit):

    docker build --output out tools/librespot

Upload `out/librespot-tvbox-aarch64` as a release asset and put its sha256 in the manifest. librespot is MIT licensed, see [its license](https://github.com/librespot-org/librespot/blob/dev/LICENSE).

A box never downloads a binary it already has, whatever the manifest's url and sha256 say. A new build therefore needs a new bin name to reach the boxes, in the manifest and in `LIBRESPOT_BIN` in `plugin.js`.
