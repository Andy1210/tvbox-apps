// The dialog the SERVER asks this client to draw.
//
// The handshake declares `19` (ShowMessageDialog) among the system UIs we can
// show, so xCloud hands over its own confirmations instead of drawing them into
// the video. A client that shows nothing leaves the session dimmed waiting for an
// answer - measured on the box: Quit in the Xbox guide left a dark overlay over a
// game that was still running and still making sound.
//
// The payload below is the real one, copied out of the box's log.
import { describe, expect, it } from "vitest";
import { parseDialog, transactionComplete } from "../stream/channels";

const REAL = JSON.stringify({
  content: JSON.stringify({
    TitleText: "Are you sure you want to quit?",
    ContentText: "You'll need to start a new session to play this game after quitting.",
    Options: 0,
    CommandLabel1: "Quit game",
    CommandLabel2: "Never mind",
    CommandLabel3: "",
    DefaultIndex: 1,
    CancelIndex: 1,
  }),
  cv: "nnZ23tz0AkytNxa7fVfIgA.1.2.1.1.0.0.27.1.5",
  id: "{b7947996-e50e-43ef-868e-4aa5ca1e2f7a}",
  target: "/streaming/systemUi/showmessagedialog",
  type: "Message",
});

describe("the quit confirmation", () => {
  it("is read out of the real payload", () => {
    const d = parseDialog(REAL)!;
    expect(d.title).toBe("Are you sure you want to quit?");
    expect(d.body).toMatch(/start a new session/);
    expect(d.id).toBe("{b7947996-e50e-43ef-868e-4aa5ca1e2f7a}");
  });

  it("drops the empty third label rather than drawing a blank button", () => {
    expect(parseDialog(REAL)!.buttons).toEqual(["Quit game", "Never mind"]);
  });

  it("keeps the server's own default, which is the SAFE option", () => {
    // 1 is "Never mind". Focusing the destructive one because it is first is how
    // a confirmation becomes a formality.
    const d = parseDialog(REAL)!;
    expect(d.defaultIndex).toBe(1);
    expect(d.buttons[d.defaultIndex]).toBe("Never mind");
    expect(d.cancelIndex).toBe(1);
  });
});

describe("what is not a dialog", () => {
  const message = (content: unknown, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ type: "Message", id: "{x}", content: JSON.stringify(content), ...extra });

  it("ignores the other messages on the same channel", () => {
    // These arrive constantly during a session and must not open anything.
    expect(parseDialog(message({ focused: true, state: 4, titleid: "4b71ee9b" }))).toBeNull();
    expect(parseDialog(message({ layoutId: "" }))).toBeNull();
    expect(parseDialog(JSON.stringify({ type: "HandshakeAck" }))).toBeNull();
  });

  it("ignores anything unparseable, on either level", () => {
    expect(parseDialog("not json")).toBeNull();
    expect(parseDialog(undefined)).toBeNull();
    expect(parseDialog(JSON.stringify({ type: "Message", id: "{x}", content: "not json" }))).toBeNull();
    expect(parseDialog(JSON.stringify({ type: "Message", content: "{}" }))).toBeNull();
  });

  it("ignores a dialog with no buttons - there would be no way out of it", () => {
    expect(parseDialog(message({ TitleText: "Hm", CommandLabel1: "" }))).toBeNull();
  });
});

describe("out-of-range indices", () => {
  it("fall back to the last button rather than to nothing", () => {
    const d = parseDialog(
      JSON.stringify({
        type: "Message",
        id: "{x}",
        content: JSON.stringify({ TitleText: "T", CommandLabel1: "A", CommandLabel2: "B", DefaultIndex: 9, CancelIndex: -1 }),
      }),
    )!;
    // A default pointing at a button that is not there would focus nothing, and a
    // screen with nothing focused is one a remote cannot answer.
    expect(d.defaultIndex).toBe(1);
    expect(d.cancelIndex).toBe(1);
  });
});

describe("the answer", () => {
  it("carries the question's own id and the pressed index", () => {
    const a = JSON.parse(transactionComplete("{b7947996}", 0));
    expect(a.type).toBe("TransactionComplete");
    expect(a.id).toBe("{b7947996}");
    expect(JSON.parse(a.content)).toEqual({ Result: 0 });
  });
});
