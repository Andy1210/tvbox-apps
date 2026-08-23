// The SDP edits, which are the only levers over stream quality this client has -
// the account is told `allowRegionSelection: false` and the offering lists no
// selectable server types, so region and server are not ours to choose.
import { describe, expect, it } from "vitest";
import { setBitrate, setStereo } from "../stream/sdp";

const OFFER = [
  "v=0",
  "o=- 1 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "m=video 9 UDP/TLS/RTP/SAVPF 102",
  "c=IN IP4 0.0.0.0",
  "a=rtpmap:102 H264/90000",
].join("\r\n");

const lines = (s: string) => s.split("\r\n");

describe("the bandwidth cap", () => {
  it("goes after the m-line and its c= line, where the grammar puts it", () => {
    const out = lines(setBitrate(OFFER, "video", 8000));
    const m = out.indexOf("m=video 9 UDP/TLS/RTP/SAVPF 102");
    expect(out[m + 1]).toBe("c=IN IP4 0.0.0.0");
    expect(out[m + 2]).toBe("b=AS:8000");
  });

  it("caps the section it was asked for and no other", () => {
    const out = setBitrate(OFFER, "video", 8000);
    const audio = lines(out).indexOf("m=audio 9 UDP/TLS/RTP/SAVPF 111");
    expect(lines(out)[audio + 2]).not.toMatch(/^b=/);
  });

  it("replaces an existing cap rather than adding a second", () => {
    const once = setBitrate(OFFER, "video", 8000);
    const twice = setBitrate(once, "video", 4000);
    expect(lines(twice).filter((l) => l.startsWith("b=AS:")).length).toBe(1);
    expect(twice).toContain("b=AS:4000");
  });

  it("keeps every line CRLF-delimited", () => {
    // The reference splits on "\n" and rejoins the same way, which leaves the
    // inserted line as the only one without its carriage return.
    const out = setBitrate(OFFER, "video", 8000);
    expect(out.includes("\n\r")).toBe(false);
    for (const l of out.split("\r\n")) expect(l.includes("\r")).toBe(false);
  });

  it("leaves the offer alone when there is nothing to cap", () => {
    expect(setBitrate(OFFER, "video", 0)).toBe(OFFER);
    expect(setBitrate(OFFER, "video", -1)).toBe(OFFER);
    const noVideo = "v=0\r\nm=application 9 DTLS/SCTP 5000";
    expect(setBitrate(noVideo, "video", 8000)).toBe(noVideo);
  });
});

describe("stereo", () => {
  it("rides on the fmtp line the offer already has", () => {
    expect(setStereo(OFFER, true)).toContain("minptime=10;useinbandfec=1;stereo=1");
  });

  it("is not added twice", () => {
    const once = setStereo(OFFER, true);
    expect(setStereo(once, true)).toBe(once);
  });

  it("invents no fmtp line when the offer has none", () => {
    // Mono is the default; an fmtp line of our own would be a claim about a codec
    // configuration nobody offered.
    const bare = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2";
    expect(setStereo(bare, true)).toBe(bare);
  });

  it("does nothing when it is not wanted", () => {
    expect(setStereo(OFFER, false)).toBe(OFFER);
  });
});
