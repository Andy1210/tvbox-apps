// This client's identity on a media server, and why it cannot travel between
// boxes.
//
// A media server identifies a client by a stable id the client mints once. Two
// boxes must never present the same one: an account then treats them as a single
// device, and a command meant for one room acts on the other.
//
// The hazard is the box's own backup, not carelessness. Per-app storage is
// carried wholesale by a restore and replayed with no same-box gate, so
// restoring one box's backup onto another would hand it the first box's identity
// AND its tokens.
//
// The defence uses a guarantee the shell already provides. localStorage IS
// clone-gated on restore: when the payload came from a different box, only keys
// prefixed "tvbox." survive and everything else is dropped. So the identity is
// written in two places at once - the app's storage, which travels, and a
// localStorage witness, which does not - and is only trusted when both agree.
//
// On the same box both survive and match. On another box the storage arrives
// without its witness, the mismatch is detected, and the identity plus every
// token is re-minted. That holds even for two freshly-flashed boxes, which share
// the default hostname and which a hostname check therefore cannot tell apart.

import { readJson, removeRaw, writeJson } from "./storage";
import { log } from "./redact";

const KEY = "identity";
/** Deliberately NOT prefixed "tvbox." - that prefix is what survives a restore
 *  from another box, and surviving is exactly what this value must not do. */
const WITNESS_KEY = "mediaclient.witness";

interface StoredIdentity {
  clientId: string;
  /** Matched against the localStorage witness; a mismatch means another box. */
  witness: string;
  /** Recorded for diagnostics, and as a second signal when it is known. */
  host: string;
  mintedAt: number;
}

export interface Identity {
  clientId: string;
  host: string;
  /** True when this run had to mint a new one, so anything stored under the old
   *  identity - tokens above all - belongs to a different box. */
  fresh: boolean;
}

// The in-flight promise, not the resolved value: two overlapping calls must not
// both mint. They would race on two stores written at different speeds -
// localStorage is synchronous while app storage is an IPC round trip - and could
// leave the two halves disagreeing, which the next launch reads as "this came
// from another box" and signs everyone out.
let pending: Promise<Identity> | null = null;

/** The box's hostname, or "" when the shell cannot be reached (dev, tests). */
export async function boxHostname(): Promise<string> {
  try {
    const r = await fetch("/tvbox/api/system/info");
    if (!r.ok) return "";
    const info = (await r.json()) as { hostname?: string };
    return typeof info.hostname === "string" ? info.hostname : "";
  } catch {
    return "";
  }
}

function randomHex(bytes: number): string {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const a = new Uint8Array(bytes);
    crypto.getRandomValues(a);
    return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return Array.from({ length: bytes * 2 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function readWitness(): string | null {
  try {
    return localStorage.getItem(WITNESS_KEY);
  } catch {
    return null;
  }
}

function writeWitness(value: string): boolean {
  try {
    localStorage.setItem(WITNESS_KEY, value);
    return true;
  } catch {
    return false;
  }
}

/**
 * The identity for this box, minting one on first run and re-minting it when the
 * stored one came from somewhere else.
 *
 * `fresh: true` is the caller's signal to drop every stored credential.
 */
export function getIdentity(): Promise<Identity> {
  if (!pending) pending = resolveIdentity();
  return pending;
}

async function resolveIdentity(): Promise<Identity> {
  const [host, stored] = await Promise.all([boxHostname(), readJson<StoredIdentity>(KEY)]);
  const witness = readWitness();

  if (stored?.clientId && stored.witness && witness && stored.witness === witness) {
    // Both halves agree: this store belongs to this box.
    if (!stored.host && host) {
      // Fill in a hostname that was unknown when the identity was minted, so the
      // diagnostic value is not blank forever.
      void writeJson(KEY, { ...stored, host });
    }
    return { clientId: stored.clientId, host: stored.host || host, fresh: false };
  }

  if (stored?.clientId) {
    log.warn(
      witness
        ? "stored identity does not match this box - re-minting"
        : "stored identity has no local witness (restored from another box?) - re-minting",
    );
    // Whatever else this store holds was written by another box. Dropping the
    // identity without dropping the credentials beside it would leave the worse
    // half behind.
    await removeRaw("session");
  }

  const identity: StoredIdentity = { clientId: randomHex(16), witness: randomHex(8), host, mintedAt: Date.now() };
  const persistedWitness = writeWitness(identity.witness);
  const persisted = await writeJson(KEY, identity);
  if (!persisted.ok || !persistedWitness) {
    // Without both halves the identity cannot be recognised next time and will
    // be re-minted, which shows up as an extra device on the account each boot.
    log.warn("identity could not be persisted; it will be re-minted next launch");
  }

  return { clientId: identity.clientId, host, fresh: true };
}

/** Test seam. */
export function __resetIdentity(): void {
  pending = null;
}

/**
 * What this client calls itself on a server. The product name is deliberately
 * absent: the app id is frozen while the display name is branding, so the two
 * must not be the same string.
 */
export const CLIENT_PRODUCT = "tvbox";
export const CLIENT_PLATFORM = "Linux";
/**
 * Required by the companion poll, which answers 400 without it and says which
 * header is missing only in the SERVER's log. The value is not inspected - what
 * matters is that it is there.
 */
export const CLIENT_PLATFORM_VERSION = "1";
export const CLIENT_VERSION = "0.1.0";

/** Device name shown on the account. The room is what a person recognises. */
export function deviceName(host: string): string {
  return host || "tvbox";
}
