import { describe, it, expect, vi } from "vitest";
import { configureI18n, translate } from "@sdk";
import { apiErrorText } from "../Browser";
import en from "../locales/en.json";
import hu from "../locales/hu.json";

configureI18n({ hu, en }, { fallback: "en" });
const t = (k: string, p?: Record<string, string>): string => translate("en", k, p);

// A failed search is a Web API error. Put through the playback mapping it read
// "couldn't start playback" and lost the rate-limit and unregistered-account hints.
describe("search error text", () => {
  it("names the cause a search actually has", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(apiErrorText(t, "network")).toBe(t("spotify.apiUnreachable"));
    expect(apiErrorText(t, "HTTP 429 slow down")).toBe(t("spotify.rateLimited"));
    expect(apiErrorText(t, "user not registered in the app")).toBe(t("spotify.notRegistered"));
    expect(apiErrorText(t, "network")).not.toBe(t("spotify.playError"));
  });
});
