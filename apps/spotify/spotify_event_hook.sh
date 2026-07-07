#!/usr/bin/env bash
# tvbox — librespot ONEVENT hook. The tvbox shell spawns librespot itself
# (main.js) with `--onevent <this script>`, so it runs on every player event and
# POSTs the event (WITH full track metadata) to the shell's Spotify bridge, which
# holds playback state and pushes it to the launcher over SSE. No Spotify Web API
# / credentials and no root are involved — librespot 0.6+ exports the track
# metadata in the hook environment, so casting alone drives the UI.
#
# Deployed next to main.js (user-owned, no system install). librespot re-execs it
# per event, so edits take effect live.
#
# librespot env vars (0.8): PLAYER_EVENT, TRACK_ID, URI, NAME, ARTISTS (newline
# separated), ALBUM, ALBUM_ARTISTS, COVERS (newline separated, largest first),
# DURATION_MS, POSITION_MS, VOLUME (0-65535), ITEM_TYPE, IS_EXPLICIT, NUMBER.
set -euo pipefail

URL="${TVBOX_SPOTIFY_EVENT_URL:-http://127.0.0.1:8097/tvbox/api/spotify/event}"

# Build JSON safely from the environment (names/albums may contain quotes,
# backslashes, unicode; ARTISTS/COVERS are newline-separated lists).
payload=$(python3 - <<'PY'
import json, os
def first(s): return (s or "").split("\n")[0].strip()
def join(s): return ", ".join(x.strip() for x in (s or "").split("\n") if x.strip())
def num(s):
    try: return int(s or 0)
    except ValueError: return 0
print(json.dumps({
    "player_event": os.environ.get("PLAYER_EVENT", ""),
    "track_id":     os.environ.get("TRACK_ID", ""),
    "uri":          os.environ.get("URI", ""),
    "name":         os.environ.get("NAME", ""),
    "artists":      join(os.environ.get("ARTISTS", "")) or os.environ.get("ALBUM_ARTISTS", ""),
    "album":        os.environ.get("ALBUM", ""),
    "cover_url":    first(os.environ.get("COVERS", "")),
    "duration_ms":  num(os.environ.get("DURATION_MS")),
    "position_ms":  num(os.environ.get("POSITION_MS")),
    "volume":       num(os.environ.get("VOLUME")),
    "item_type":    os.environ.get("ITEM_TYPE", ""),
}))
PY
)

curl --silent --max-time 2 --request POST \
  --header "Content-Type: application/json" --data "$payload" "$URL" \
  >/dev/null 2>&1 || true
