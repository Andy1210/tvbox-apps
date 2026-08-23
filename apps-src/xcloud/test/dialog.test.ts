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
    expect(parseDialog(REAL)!.buttons).toEqual([
      { index: 0, label: "Quit game" },
      { index: 1, label: "Never mind" },
    ]);
  });

  it("keeps the SERVER's numbering when a middle label is empty", () => {
    // Compacting the list renumbered everything after the gap: pressing the third
    // button reported the second, and DefaultIndex/CancelIndex - which are in the
    // server's numbering - pointed at the wrong one.
    const d = parseDialog(
      JSON.stringify({
        type: "Message",
        id: "{x}",
        content: JSON.stringify({ TitleText: "T", CommandLabel1: "A", CommandLabel2: "", CommandLabel3: "C", DefaultIndex: 2, CancelIndex: 2 }),
      }),
    )!;
    expect(d.buttons).toEqual([
      { index: 0, label: "A" },
      { index: 2, label: "C" },
    ]);
    expect(d.defaultIndex).toBe(2);
    expect(d.cancelIndex).toBe(2);
  });

  it("never points its default at a button that was dropped", () => {
    const d = parseDialog(
      JSON.stringify({
        type: "Message",
        id: "{x}",
        content: JSON.stringify({ TitleText: "T", CommandLabel1: "A", CommandLabel2: "", CommandLabel3: "C", DefaultIndex: 1 }),
      }),
    )!;
    expect(d.buttons.some((b) => b.index === d.defaultIndex)).toBe(true);
  });

  it("keeps the server's own default, which is the SAFE option", () => {
    // 1 is "Never mind". Focusing the destructive one because it is first is how
    // a confirmation becomes a formality.
    const d = parseDialog(REAL)!;
    expect(d.defaultIndex).toBe(1);
    expect(d.buttons.find((b) => b.index === d.defaultIndex)!.label).toBe("Never mind");
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

describe("what the server sends is bounded before it is drawn", () => {
  const huge = (n: number) => "x".repeat(n);
  const big = JSON.stringify({
    type: "Message",
    id: "{x}",
    content: JSON.stringify({
      TitleText: huge(200000),
      ContentText: huge(200000),
      CommandLabel1: huge(200000),
      CommandLabel2: "B",
    }),
  });

  it("caps the title, the body and the labels", () => {
    // Nothing bounds this at the source, the panel has no scroll, and the same
    // string went into a log that is never rotated.
    const d = parseDialog(big)!;
    expect(d.title.length).toBeLessThan(220);
    expect(d.body.length).toBeLessThan(620);
    expect(d.buttons[0].label.length).toBeLessThan(80);
    expect(d.buttons[1].label).toBe("B");
  });

  it("caps the id it will echo back", () => {
    const d = parseDialog(JSON.stringify({ type: "Message", id: huge(5000), content: JSON.stringify({ TitleText: "T", CommandLabel1: "A" }) }))!;
    expect(d.id.length).toBeLessThan(120);
  });

  it("refuses an id that is not a string", () => {
    // It is echoed back to the server and used as a key; the type said string and
    // nothing checked.
    expect(parseDialog(JSON.stringify({ type: "Message", id: { a: 1 }, content: JSON.stringify({ TitleText: "T", CommandLabel1: "A" }) }))).toBeNull();
  });

  it("refuses a fractional index rather than focusing nothing", () => {
    // 0.5 passes a range check, and `setFocus("dlg-0.5")` finds no such key -
    // spatial navigation gives up silently, so the D-pad has no origin and the
    // dialog cannot be answered at all.
    const d = parseDialog(
      JSON.stringify({
        type: "Message",
        id: "{x}",
        content: JSON.stringify({ TitleText: "T", CommandLabel1: "A", CommandLabel2: "B", DefaultIndex: 0.5, CancelIndex: 1.5 }),
      }),
    )!;
    expect(Number.isInteger(d.defaultIndex)).toBe(true);
    expect(Number.isInteger(d.cancelIndex)).toBe(true);
  });
});

describe("the declared system UIs", () => {
  it("are only the ones this client can draw", async () => {
    // The list is a promise. Declaring a UI and rendering nothing is what left a
    // dimmed screen over a running game waiting for an answer nobody could give -
    // and 27 is a PURCHASE, which a generic dialog renderer would make
    // confirmable with a D-pad.
    const { sessionConfig } = await import("../stream/channels");
    const ui = JSON.parse(JSON.parse(sessionConfig({ width: 1920, height: 1080 })[0]).content);
    expect(ui.systemUis).toEqual([19]);
  });
});

describe("the envelope", () => {
  const content = JSON.stringify({ TitleText: "T", CommandLabel1: "A", CommandLabel2: "B" });

  it("is recognised by its CONTENT, with or without a type field", () => {
    // An earlier cut required `type === "Message"`, inferred from a log line that
    // had been truncated before that field. The dialog then went unrecognised on
    // the box while this test, built on the same guess, passed.
    expect(parseDialog(JSON.stringify({ id: "{x}", content }))!.title).toBe("T");
    expect(parseDialog(JSON.stringify({ type: "Message", id: "{x}", content }))!.title).toBe("T");
  });

  it("is refused without an id, because there would be nothing to answer", () => {
    // A dialog that cannot be answered is worse than none: it takes the screen
    // and never gives it back.
    expect(parseDialog(JSON.stringify({ type: "Message", content }))).toBeNull();
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
