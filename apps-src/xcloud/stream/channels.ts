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
