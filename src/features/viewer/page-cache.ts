import { cancelRenders } from "../../ipc/pdf";
import { LruCache } from "../../lib/lru-cache";

/**
 * Rendered 512px tiles, bounded by memory. Keys come from tileKey() and
 * include scale, so a zoom change simply stops hitting old entries — LRU
 * pressure retires them; no explicit purge is needed for correctness.
 */
export const tileCache = new LruCache<string, ImageData>(
  256 * 1024 * 1024,
  (img) => img.data.byteLength,
);

/**
 * Tiles currently being rendered, tile key → request id. This map is also
 * the generation marker: a zoom or rotation-relayout sweep cancels
 * everything in it, because anything outstanding is stale by definition.
 */
const inFlight = new Map<string, number>();

export function isInFlight(key: string): boolean {
  return inFlight.has(key);
}

export function markInFlight(key: string, requestId: number): void {
  inFlight.set(key, requestId);
}

export function clearInFlight(key: string): void {
  inFlight.delete(key);
}

/**
 * Cancels every in-flight tile whose key matches `predicate` in one batched
 * IPC call. Used per page on viewport exit (key prefix) and globally on
 * zoom change (always-true predicate).
 */
export function sweepInFlight(predicate: (key: string) => boolean): void {
  const ids: number[] = [];
  for (const [key, id] of inFlight) {
    if (predicate(key)) {
      ids.push(id);
      inFlight.delete(key);
    }
  }
  void cancelRenders(ids).catch(() => undefined);
}
