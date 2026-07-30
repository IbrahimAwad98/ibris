import { describe, expect, it, vi } from "vitest";
import { LruCache } from "./lru-cache";

const bySize = (v: { size: number }) => v.size;

describe("LruCache", () => {
  it("evicts least recently used first when over budget", () => {
    const evicted: string[] = [];
    const cache = new LruCache<string, { size: number }>(100, bySize, (k) =>
      evicted.push(k),
    );
    cache.set("a", { size: 40 });
    cache.set("b", { size: 40 });
    cache.set("c", { size: 40 }); // 120 > 100 → evict "a"
    expect(evicted).toEqual(["a"]);
    expect(cache.has("a")).toBe(false);
    expect(cache.has("b")).toBe(true);
    expect(cache.bytes).toBe(80);
  });

  it("get() bumps recency and changes eviction order", () => {
    const cache = new LruCache<string, { size: number }>(100, bySize);
    cache.set("a", { size: 40 });
    cache.set("b", { size: 40 });
    cache.get("a"); // now "b" is LRU
    cache.set("c", { size: 40 });
    expect(cache.has("a")).toBe(true);
    expect(cache.has("b")).toBe(false);
  });

  it("replacing a key updates the byte total instead of double counting", () => {
    const cache = new LruCache<string, { size: number }>(100, bySize);
    cache.set("a", { size: 40 });
    cache.set("a", { size: 60 });
    expect(cache.bytes).toBe(60);
    expect(cache.size).toBe(1);
  });

  it("stores an entry larger than the entire budget", () => {
    const onEvict = vi.fn();
    const cache = new LruCache<string, { size: number }>(100, bySize, onEvict);
    cache.set("a", { size: 40 });
    cache.set("huge", { size: 500 });
    expect(cache.has("huge")).toBe(true);
    expect(onEvict).toHaveBeenCalledWith("a", { size: 40 });
  });

  it("delete() releases bytes", () => {
    const cache = new LruCache<string, { size: number }>(100, bySize);
    cache.set("a", { size: 40 });
    cache.delete("a");
    expect(cache.bytes).toBe(0);
    expect(cache.has("a")).toBe(false);
  });

  it("evicts multiple entries to fit one large insert", () => {
    const cache = new LruCache<string, { size: number }>(100, bySize);
    cache.set("a", { size: 30 });
    cache.set("b", { size: 30 });
    cache.set("c", { size: 30 });
    cache.set("d", { size: 90 }); // must evict a, b, c
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(90);
  });
});
