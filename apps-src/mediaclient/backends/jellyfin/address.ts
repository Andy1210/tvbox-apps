/**
 * An address as somebody typed it, made into one that can be fetched.
 *
 * A person types what they read off a router or a phone - `192.168.1.19:8096` -
 * and a URL needs a scheme. http rather than https, because a server on the
 * house network is the ordinary case here and https would fail on a certificate
 * before anything else could be said about the address.
 *
 * Separate from the screen because it is the one part of typing an address that
 * can be wrong in a way nobody sees until a request fails.
 */
export function normaliseAddress(raw: string): string {
  // The trailing slash comes off AFTER the scheme is settled, not before: a
  // bare "http://" trimmed first becomes "http:", which no longer looks like a
  // scheme, and the prefix would then be added to it twice.
  const trimmed = raw.replace(/\s+/g, "");
  if (!trimmed) return "";
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    // Parsed rather than pattern-matched: this is what the request will do with
    // it, so anything it cannot read is not an address.
    const u = new URL(withScheme);
    if (!u.hostname) return "";
    return u.origin + (u.pathname === "/" ? "" : u.pathname.replace(/\/+$/, ""));
  } catch {
    return "";
  }
}
