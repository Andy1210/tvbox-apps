import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { configureI18n } from "@sdk";
import { Home } from "../Home";
import { Detail } from "../Detail";
import { Person } from "../Person";
import { PlexBackend } from "../backends/plex/backend";
import { useApp } from "../state";
import { setupRemote } from "./remote";
import en from "../locales/en.json";
import hu from "../locales/hu.json";
import type { ItemDetail, Session } from "../backends/types";

// The screens, against a real server.
//
// The unit tests hold the mapper to a fixture and the live backend suite holds
// the requests to a server; neither notices if a screen reads a field nobody
// fills in, or renders nothing while quietly succeeding. This mounts the actual
// components on actual data and looks for the words.
//
// Skipped unless PLEX_URL and PLEX_TOKEN are set.

const BASE = process.env.PLEX_URL;
const TOKEN = process.env.PLEX_TOKEN;

const session: Session = {
  profileId: "test",
  profileName: "test",
  token: TOKEN ?? "",
  accountToken: TOKEN ?? "",
  serverId: "test",
  serverName: "test",
  baseUrl: BASE ?? "",
  location: "lan",
};

configureI18n({ hu, en }, { fallback: "en" });
setupRemote();

describe.skipIf(!BASE || !TOKEN)("screens against a live server", () => {
  const backend = new PlexBackend(session, { clientId: "mediaclient-ui-test", deviceName: "test" });

  beforeAll(() => {
    // Artwork goes through URL.createObjectURL, which the test DOM does not
    // implement. The images are not what is being checked here.
    if (!globalThis.URL.createObjectURL) {
      globalThis.URL.createObjectURL = () => "blob:stub";
      globalThis.URL.revokeObjectURL = () => {};
    }
  });

  beforeEach(() => {
    vi.unstubAllGlobals();
    useApp.setState({ backend, session, screen: { name: "home" }, history: [], failure: null });
  });

  it("home shows something to carry on watching", async () => {
    render(<Home />);

    await waitFor(() => expect(screen.getByText(en.home.continue)).toBeInTheDocument(), { timeout: 20_000 });

    // A row renders only when it has items, so the heading being there IS the
    // assertion that on-deck came back with something.
    const deck = await backend.onDeck();
    if (deck.length > 0) {
      const first = deck[0];
      const label = first.seriesTitle ?? first.title;
      await waitFor(() => expect(screen.getAllByTitle(new RegExp(escapeRe(label))).length).toBeGreaterThan(0), {
        timeout: 20_000,
      });
    }
  }, 60_000);

  it("an item page shows its cast and whatever scores the server holds", async () => {
    // Walk until a film with both is found: not every title has reviews.
    const libs = await backend.libraries();
    const movies = libs.find((l) => l.kind === "movie")!;
    const page = await backend.libraryPage(movies.id, { offset: 0, limit: 10, sort: "titleSort" });

    let chosen: ItemDetail | null = null;
    for (const item of page.items) {
      const d = await backend.item(item.id);
      if (d.roles.length > 0 && d.scores.length > 0) {
        chosen = d;
        break;
      }
    }
    expect(chosen, "no film with both a cast and a score in the first ten").not.toBeNull();

    render(<Detail itemId={chosen!.id} />);

    await waitFor(() => expect(screen.getByText(en.detail.cast)).toBeInTheDocument(), { timeout: 20_000 });
    // The cast member's name, i.e. the thing that opens a person page.
    expect(screen.getAllByText(chosen!.roles[0].name).length).toBeGreaterThan(0);
    // A score renders as its number to one decimal.
    expect(screen.getAllByText(chosen!.scores[0].value.toFixed(1)).length).toBeGreaterThan(0);
  }, 120_000);

  it("a person page lists work from more than one library", async () => {
    // The whole point of the screen: an actor's series, opened from a film.
    const libs = await backend.libraries();
    const movies = libs.find((l) => l.kind === "movie")!;
    const page = await backend.libraryPage(movies.id, { offset: 0, limit: 12, sort: "titleSort" });

    for (const item of page.items) {
      const d = await backend.item(item.id);
      for (const role of d.roles.slice(0, 4)) {
        const credits = await backend.personCredits(role);
        if (!credits.items.some((c) => c.kind === "show")) continue;

        render(<Person personId={role.id} personName={role.name} />);
        await waitFor(() => expect(screen.getByText(en.person.series)).toBeInTheDocument(), { timeout: 20_000 });
        expect(screen.getByText(role.name)).toBeInTheDocument();
        return;
      }
    }
    throw new Error("no actor with a series credit found in the first twelve films");
  }, 180_000);
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
