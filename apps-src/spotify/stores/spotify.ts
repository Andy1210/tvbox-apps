import { create } from "zustand";
import type { SpState } from "../api";

// Live Spotify playback state, fed by the shell's SSE stream (pushed on every
// change). `at` is when the snapshot arrived, so the UI can tick the progress
// bar locally between pushes. Cast-only: there are no controls here — playback
// is driven from the casting phone.
interface SpotifyStore {
  state: SpState | null;
  at: number;
  connect: () => void;
  disconnect: () => void;
}

let es: EventSource | null = null;

export const useSpotifyStore = create<SpotifyStore>((set) => ({
  state: null,
  at: 0,
  connect: () => {
    if (es) return;
    es = new EventSource("/tvbox/api/spotify/stream");
    es.onmessage = (e) => {
      try {
        set({ state: JSON.parse(e.data) as SpState, at: Date.now() });
      } catch {
        /* ignore */
      }
    };
    es.onerror = () => {
      /* EventSource auto-reconnects */
    };
  },
  disconnect: () => {
    if (es) {
      es.close();
      es = null;
    }
  },
}));
