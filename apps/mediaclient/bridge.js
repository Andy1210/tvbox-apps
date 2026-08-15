// Renderer bridge for the media client.
//
// It exists for ONE fact the page cannot otherwise learn: the panel's native
// resolution. The shell computes it in the main process and hands it to the
// preload, which passes it to a manifest-declared bridge adapter and nowhere
// else - it is never written onto `window.tvbox`. So an app that needs it must
// ship a bridge, even when it needs nothing else from one.
//
// Why the media client needs it: the UI runs at 1080p while a 4K panel is
// attached, and the output mode only switches once video starts. A media server
// picks the stream from the resolution the client reports, i.e. BEFORE anything
// could have switched. Reporting the window's own size therefore asks for a
// 1080p transcode of a 4K file - the honest-looking answer is the wrong one.
//
// The adapter publishes the panel and stops. Everything else this app does goes
// through the ordinary capability surface (player/storage/nav), because that is
// the part the shell actually enforces.

module.exports.setup = function setup(ctx) {
  const panel = (ctx && ctx.panel) || null;

  // A NEW object carrying the old one's contents, which is not the same thing as
  // merging into it: the surface the preload exposed through contextBridge
  // cannot be extended, so a property cannot simply be added to it. Every reader
  // in this app and in the SDK looks `window.tvbox` up at call time rather than
  // holding it, which is what makes replacing it safe - the values it already
  // carried (player, storage, nav) are copied over, and dropping those is the
  // failure this is written to avoid.
  if (typeof window !== "undefined") {
    window.tvbox = Object.assign({}, window.tvbox, {
      // { width, height } of the connected panel, or null when the shell could
      // not determine it (no CEC/EDID answer). Null means "do not claim a
      // resolution" - a server left to its own default beats a wrong assertion.
      panel: panel && panel.width && panel.height ? { width: panel.width, height: panel.height } : null,
    });
  }
};
