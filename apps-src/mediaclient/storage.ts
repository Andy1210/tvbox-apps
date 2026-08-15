// Persistence, with the two properties the shell's storage does not give for
// free.
//
// 1. WRITES ARE CHECKED. The broker answers { ok: false, error } when over quota
//    (256 KB and 200 keys per app) and does not throw, so an unchecked write is
//    a silent drop - a token that looks saved and is not.
//
// 2. KEYS ARE NAMESPACED PER PROFILE. Several people share a box; resume
//    positions and subtitle choices must not leak between them.
//
// Nothing large belongs here. A cached library index would eat the whole budget,
// so caches live in memory for the session instead.

import { log } from "./redact";

export interface WriteResult {
  ok: boolean;
  error?: string;
}

function bridge(): NonNullable<Window["tvbox"]>["storage"] | undefined {
  return typeof window === "undefined" ? undefined : window.tvbox?.storage;
}

/** Read a raw string. Returns null when absent or when storage is unavailable. */
export async function readRaw(key: string): Promise<string | null> {
  const s = bridge();
  if (!s) return null;
  try {
    return await s.get(key);
  } catch (e) {
    log.warn("storage read failed", key, e);
    return null;
  }
}

/** Write a raw string, reporting whether it actually landed. */
export async function writeRaw(key: string, value: string): Promise<WriteResult> {
  const s = bridge();
  if (!s) return { ok: false, error: "no storage capability" };
  try {
    const r = (await s.set(key, value)) as WriteResult | undefined;
    // The broker returns { ok: false, error } rather than throwing; treat a
    // missing answer as success only because older shells returned nothing.
    if (r && r.ok === false) {
      log.warn("storage write rejected", key, r.error);
      return { ok: false, error: r.error };
    }
    return { ok: true };
  } catch (e) {
    log.warn("storage write failed", key, e);
    return { ok: false, error: String(e) };
  }
}

/**
 * Delete a key, reporting whether it actually went.
 *
 * The result matters as much as it does for a write: removal is how a token is
 * revoked, and the broker answers { ok: false } rather than throwing. A caller
 * that ignores it can believe it signed someone out while their credential is
 * still on disk.
 */
export async function removeRaw(key: string): Promise<WriteResult> {
  const s = bridge();
  if (!s) return { ok: false, error: "no storage capability" };
  try {
    const r = (await s.remove(key)) as WriteResult | undefined;
    if (r && r.ok === false) {
      log.warn("storage remove rejected", key, r.error);
      return { ok: false, error: r.error };
    }
    return { ok: true };
  } catch (e) {
    log.warn("storage remove failed", key, e);
    return { ok: false, error: String(e) };
  }
}

export async function readJson<T>(key: string): Promise<T | null> {
  const raw = await readRaw(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A corrupt value is not worth keeping; the caller will re-derive.
    log.warn("storage value is not JSON, dropping", key);
    await removeRaw(key);
    return null;
  }
}

export async function writeJson(key: string, value: unknown): Promise<WriteResult> {
  return writeRaw(key, JSON.stringify(value));
}

/**
 * A view of storage scoped to one profile. Keys are prefixed, so two household
 * members can hold the same logical key without seeing each other's value.
 */
export function profileScope(profileId: string): {
  read<T>(key: string): Promise<T | null>;
  write(key: string, value: unknown): Promise<WriteResult>;
  remove(key: string): Promise<WriteResult>;
} {
  const p = `p:${profileId}:`;
  return {
    read: <T>(key: string) => readJson<T>(p + key),
    write: (key: string, value: unknown) => writeJson(p + key, value),
    remove: (key: string) => removeRaw(p + key),
  };
}
