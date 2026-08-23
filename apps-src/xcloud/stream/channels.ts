// The JSON handshake on the message and control channels.
//
// This is the half of the protocol that is easy to miss entirely, because
// skipping it looks like everything working: the video plays, the channels open,
// input packets go out at 60 Hz - and the game ignores every one of them. The
// server does not act on input for a pad it has not been TOLD about.
//
// The order is the contract:
//
//   message channel opens  ->  { type: "Handshake", version: "messageV1", … }
//   server                 ->  { type: "HandshakeAck" }
//   then, and only then:
//     message   ->  the session's configuration (system UI, dimensions, touch, …)
//     control   ->  authorizationRequest, then gamepadChanged { wasAdded: true }
//     input     ->  the client metadata packet, then the 60 Hz state stream
//
// Every constant here is the reference client's. They are not secrets and not
// things to improvise on: an id or a key the server does not recognise is
// refused silently, which is the failure mode this whole file exists to avoid.
const ACCESS_KEY = "4BDB3609-C1F1-4195-9B37-FEFF45DA8B8E";
const HANDSHAKE_ID = "f9c5f412-0e69-4ede-8e62-92c7f5358c56";
const MESSAGE_ID = "41f93d5a-900f-4d33-b7a1-2d4ca6747072";
const CLIENT_APP_INSTALL_ID = "c11ddb2e-c7e3-4f02-a62b-fd5448e0b851";

// Which of the server's own overlays this client accepts - and it accepts only
// the ONE it can actually draw.
//
// This list is a promise. Declaring a UI and then rendering nothing is exactly
// what left a dimmed screen over a running game waiting for an answer nobody
// could give: the server handed over its "quit the game?" confirmation because
// `19` said we would show it. xCloud's web player sends
// `[10, 19, 31, 27, 32, -41]` - a virtual keyboard, a message dialog, show
// application, a PURCHASE, timer extensions - and we have a renderer for exactly
// one of those.
//
// 27 is the one worth naming: a purchase confirmation handed to a client with a
// generic dialog renderer would be a spend confirmable with a D-pad. Not
// declaring it means the server keeps that flow to itself or refuses it, which is
// the right answer on a television.
//
// The cost is that a feature behind an undeclared UI is simply unavailable -
// text entry inside a game, for one. Unavailable beats frozen.
const SYSTEM_UIS = [19];
const SYSTEM_UI_VERSION = [0, 1, 0];

export const handshake = (): string =>
  JSON.stringify({ type: "Handshake", version: "messageV1", id: HANDSHAKE_ID, cv: "" });

export const isHandshakeAck = (raw: unknown): boolean => {
  try {
    return JSON.parse(String(raw)).type === "HandshakeAck";
  } catch {
    return false;
  }
};

// A message on the message channel: the payload is a JSON STRING inside a JSON
// object, not a nested object.
export const streamingMessage = (target: string, data: unknown): string =>
  JSON.stringify({ type: "Message", content: JSON.stringify(data), id: MESSAGE_ID, target, cv: "" });

export interface SessionShape {
  width: number;
  height: number;
  touch?: boolean;
}

/** Everything the message channel sends once the handshake is acknowledged. */
export function sessionConfig(shape: SessionShape): string[] {
  const w = Math.max(1, Math.round(shape.width));
  const h = Math.max(1, Math.round(shape.height));
  return [
    streamingMessage("/streaming/systemUi/configuration", {
      version: SYSTEM_UI_VERSION,
      systemUis: SYSTEM_UIS,
    }),
    streamingMessage("/streaming/properties/clientappinstallidchanged", {
      clientAppInstallId: CLIENT_APP_INSTALL_ID,
    }),
    streamingMessage("/streaming/characteristics/orientationchanged", { orientation: 0 }),
    streamingMessage("/streaming/characteristics/touchinputenabledchanged", {
      touchInputEnabled: !!shape.touch,
    }),
    streamingMessage("/streaming/characteristics/clientdevicecapabilities", {}),
    // The safe area is the whole screen: a television's overscan is the set's
    // business, and cropping here would letterbox the game a second time.
    streamingMessage("/streaming/characteristics/dimensionschanged", {
      horizontal: w,
      vertical: h,
      preferredWidth: w,
      preferredHeight: h,
      safeAreaLeft: 0,
      safeAreaTop: 0,
      safeAreaRight: w,
      safeAreaBottom: h,
      supportsCustomResolution: true,
    }),
  ];
}

export const authorizationRequest = (): string =>
  JSON.stringify({ message: "authorizationRequest", accessKey: ACCESS_KEY });

/**
 * Tell the server a pad appeared or went away.
 *
 * This is the message whose absence makes a controller do nothing at all while
 * the input channel carries a correct 60 Hz state stream - measured on the box:
 * 3500 packets sent, button masks changing as buttons were pressed, and the game
 * unmoved.
 */
export const gamepadChanged = (index: number, added: boolean): string =>
  JSON.stringify({ message: "gamepadChanged", gamepadIndex: index, wasAdded: added });

export const keyframeRequest = (): string =>
  JSON.stringify({ message: "videoKeyframeRequested", ifrRequested: true });


/**
 * A dialog the SERVER asks this client to draw.
 *
 * The handshake declares `19` (ShowMessageDialog) among the system UIs this
 * client can show, so xCloud hands over its own confirmations rather than drawing
 * them into the video - and a client that shows nothing leaves the session
 * dimmed, waiting for an answer that never comes. Measured on the box: pressing
 * Quit in the Xbox guide left a dark overlay over a game that was still running
 * and still making sound.
 *
 * Recognised by its CONTENT rather than by its target string: the shape is
 * unmistakable, and it is the part that decides what has to be drawn.
 */
export interface ServerDialog {
  id: string;
  title: string;
  body: string;
  /**
   * What to draw, each with the index the SERVER gave it.
   *
   * Not a compacted list: `filter(Boolean)` on an empty middle label renumbered
   * everything after it, so pressing the third button reported the second, and
   * `DefaultIndex`/`CancelIndex` - which are in the server's numbering - pointed
   * at the wrong one.
   */
  buttons: Array<{ index: number; label: string }>;
  /** Which to focus. The server points at the safe one for a destructive ask. */
  defaultIndex: number;
  /** What Back means here. */
  cancelIndex: number;
}

// The text comes from the stream server and is drawn on a television. Nothing
// bounds it at the source: a 200,000-character title pushes the buttons off the
// screen of a panel that has no scroll, and the same string went into
// `~/.tvbox/shell.log`, which is never rotated.
const MAX_TITLE = 200;
const MAX_BODY = 600;
const MAX_LABEL = 60;
const MAX_ID = 100;
const cut = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

export function parseDialog(raw: unknown): ServerDialog | null {
  let outer: { type?: string; id?: string; content?: string; target?: string };
  try {
    outer = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!outer || typeof outer.content !== "string") return null;

  let c: Record<string, unknown>;
  try {
    c = JSON.parse(outer.content);
  } catch {
    return null;
  }
  // The CONTENT is what identifies it. An earlier cut of this also required
  // `type === "Message"` and an id, both of which were inferred from a log line
  // truncated before those fields - the dialog then went unrecognised on the box
  // while the test, built on the same assumption, passed. Recognise by what is
  // actually being looked at; the envelope is checked below, where it matters.
  if (!c || typeof c.TitleText !== "string" || typeof c.CommandLabel1 !== "string") return null;
  // Without an id there is nothing to answer, and a dialog that cannot be
  // answered is worse than none: it would take the screen and never give it back.
  // The id is echoed back to the server and used as a React key; a non-string
  // here is typed away rather than checked.
  if (typeof outer.id !== "string" || !outer.id) {
    console.warn("[xcloud] a dialog arrived with no id to answer:", String(raw).slice(0, 600));
    return null;
  }

  const buttons = [c.CommandLabel1, c.CommandLabel2, c.CommandLabel3]
    .map((b, index) => ({ index, label: typeof b === "string" ? cut(b.trim(), MAX_LABEL) : "" }))
    .filter((b) => b.label);
  if (!buttons.length) return null;
  const answerable = new Set(buttons.map((b) => b.index));

  // An INTEGER in range. `0.5` passes a range check and then focuses `dlg-0.5`,
  // which does not exist - spatial navigation gives up silently and the D-pad has
  // no origin, so the dialog cannot be answered at all.
  // Against the server's own numbering, and only onto a button that exists: a
  // default pointing at a dropped label would focus nothing, and a screen with
  // nothing focused is one a remote cannot answer.
  const last = buttons[buttons.length - 1].index;
  const clamp = (n: unknown, fallback: number) =>
    typeof n === "number" && Number.isInteger(n) && answerable.has(n) ? n : fallback;

  return {
    id: cut(outer.id, MAX_ID),
    title: cut(c.TitleText, MAX_TITLE),
    body: typeof c.ContentText === "string" ? cut(c.ContentText, MAX_BODY) : "",
    buttons,
    // The server's own default, and it points at the SAFE option for a
    // destructive question - "Never mind" rather than "Quit game".
    defaultIndex: clamp(c.DefaultIndex, last),
    cancelIndex: clamp(c.CancelIndex, last),
  };
}

/**
 * The answer. Carries the message's own id, which is how the server matches it to
 * the question it asked.
 */
export const transactionComplete = (id: string, result: number): string =>
  JSON.stringify({ type: "TransactionComplete", content: JSON.stringify({ Result: result }), id, cv: "" });
