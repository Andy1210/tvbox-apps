import type { Plugin } from "vite";

/**
 * A Content-Security-Policy for a built app page.
 *
 * Every local app is served from the shell's one origin, and that origin is what
 * the shell's API trusts. So the property that matters is that no script runs on
 * the page except the bundle itself: text from a media server, a playlist or a
 * search result that ever reached the DOM as markup could not execute. Images,
 * media and requests stay open, because these apps read them from servers the
 * user chose (a media server, an IPTV provider, a CDN) and those are not known at
 * build time.
 *
 * Build only: the dev server injects inline scripts of its own.
 */
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src * data: blob:",
  "media-src * data: blob:",
  "font-src 'self' data:",
  "connect-src * data: blob:",
  "worker-src 'self' blob:",
].join("; ");

export function appCsp(): Plugin {
  return {
    name: "tvbox-app-csp",
    apply: "build",
    transformIndexHtml() {
      return [
        { tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: APP_CSP }, injectTo: "head-prepend" },
      ];
    },
  };
}
