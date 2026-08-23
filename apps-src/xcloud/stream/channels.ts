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

// Which of the server's own overlays this client accepts. xCloud's web player
// sends this set; the Xbox app on Windows sends [33] instead, which disables the
// nexus menu. 10 = virtual keyboard, 19 = message dialog, 31 = show application,
// 27 = purchase, 32 = timer extensions.
const SYSTEM_UIS = [10, 19, 31, 27, 32, -41];
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
  /** In order. The index of the pressed one is what goes back. */
  buttons: string[];
  /** Which to focus. The server points at the safe one for a destructive ask. */
  defaultIndex: number;
  /** What Back means here. */
  cancelIndex: number;
}

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
  if (!outer.id) {
    console.warn("[xcloud] a dialog arrived with no id to answer:", String(raw).slice(0, 600));
    return null;
  }

  const buttons = [c.CommandLabel1, c.CommandLabel2, c.CommandLabel3]
    .map((b) => (typeof b === "string" ? b.trim() : ""))
    .filter(Boolean);
  if (!buttons.length) return null;

  const clamp = (n: unknown, fallback: number) =>
    typeof n === "number" && n >= 0 && n < buttons.length ? n : fallback;

  return {
    id: outer.id,
    title: c.TitleText,
    body: typeof c.ContentText === "string" ? c.ContentText : "",
    buttons,
    // The server's own default, and it points at the SAFE option for a
    // destructive question - "Never mind" rather than "Quit game".
    defaultIndex: clamp(c.DefaultIndex, buttons.length - 1),
    cancelIndex: clamp(c.CancelIndex, buttons.length - 1),
  };
}

/**
 * The answer. Carries the message's own id, which is how the server matches it to
 * the question it asked.
 */
export const transactionComplete = (id: string, result: number): string =>
  JSON.stringify({ type: "TransactionComplete", content: JSON.stringify({ Result: result }), id, cv: "" });
