// The two things worth changing in an SDP offer before it goes out.
//
// Both are requests rather than commands - the server answers with what it will
// actually do - but they are the only levers over quality this client has, since
// the account is told `allowRegionSelection: false` and the offering exposes no
// selectable server types.
//
// An SDP is CRLF-delimited. The reference client splits on "\n" and rejoins the
// same way, which leaves the inserted line as the only one without its carriage
// return; parsers are lenient about it, but there is no reason to emit it.

const EOL = "\r\n";

const split = (sdp: string): string[] => sdp.split(/\r?\n/);

/**
 * Cap a media section's bandwidth, in kilobits per second.
 *
 * `b=AS:` goes directly after the m-line and its i=/c= lines, which is where the
 * grammar puts it - anywhere else and it is ignored or the section is rejected.
 */
export function setBitrate(sdp: string, media: "video" | "audio", kbps: number): string {
  if (!(kbps > 0)) return sdp;
  const lines = split(sdp);
  const m = lines.findIndex((l) => l.startsWith("m=" + media));
  if (m < 0) return sdp;

  let at = m + 1;
  while (at < lines.length && (lines[at].startsWith("i=") || lines[at].startsWith("c="))) at++;

  const line = "b=AS:" + Math.round(kbps);
  if (at < lines.length && lines[at].startsWith("b=")) lines[at] = line;
  else lines.splice(at, 0, line);
  return lines.join(EOL);
}

/**
 * Ask for stereo Opus.
 *
 * The default is mono, and the flag rides on the fmtp line the offer already has
 * - so a session whose offer carries no `useinbandfec=1` is left alone rather
 * than being given an fmtp line of our own invention.
 */
export function setStereo(sdp: string, stereo: boolean): string {
  if (!stereo) return sdp;
  if (sdp.includes("stereo=1")) return sdp;
  return sdp.replace(/useinbandfec=1/g, "useinbandfec=1;stereo=1");
}
