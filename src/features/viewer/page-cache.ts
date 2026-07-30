import { LruCache } from "../../lib/lru-cache";

/** Sharp page bitmaps, bounded by memory. Previews live in the store. */
export const sharpCache = new LruCache<string, ImageData>(
  256 * 1024 * 1024,
  (img) => img.data.byteLength,
);

export function cacheKey(docId: number, pageIndex: number, scale: number): string {
  return `${docId}:${pageIndex}@${scale}`;
}
