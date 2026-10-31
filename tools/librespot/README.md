# librespot build for the Spotify app

The binary behind `requires.download` in `apps/spotify/manifest.json`. It is librespot commit `ea81314`, on the dev branch five commits after the 0.8.0 tag, plus two patches:

- `0001` is upstream's fix for picking a track in a list ([#1795](https://github.com/librespot-org/librespot/pull/1795)), which is not in a release yet. The Spotify app sends an empty `track_uri` next to the `track_uid`, and 0.8.0 plays the first track of the list because of it.
- `0002` is ours and not upstream. It stops a run of skips from turning into a skip storm. Spotify answers too many audio key requests with error code 2. A track without a key fails to load, librespot marks it unavailable and moves on, and that asks for another key, so the limit never clears and the player runs through the list. With the patch key requests are at least a second apart, a refused one is retried after 3, 5 and 10 seconds, and a load is cancelled when another track replaces it, so it does not spend a key. The numbers are a working guess, Spotify does not document the limit.

Build it from the repo root (needs Docker with BuildKit):

    docker build --output out tools/librespot

Upload `out/librespot-tvbox-aarch64` as a release asset and put its sha256 in the manifest. The build is not bit for bit reproducible, so a rebuild will not match the published sha256. librespot is MIT licensed, the notice is in `LICENSE` here and next to the binary in the release.

A box downloads a binary only when it is missing. `apps/spotify/lib/daemonbin.js` is what moves a box that already has one to the build in the manifest.
