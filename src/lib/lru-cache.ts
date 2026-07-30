// Byte-budgeted LRU built on Map's insertion order: re-inserting on access
// makes the first key the least recently used.

export class LruCache<K, V> {
  private map = new Map<K, V>();
  private totalBytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly sizeOf: (value: V) => number,
    private readonly onEvict?: (key: K, value: V) => void,
  ) {}

  /** Returns the value and marks it most recently used. */
  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  /**
   * Inserts (or replaces) and evicts least-recently-used entries until the
   * budget holds. A single entry larger than the whole budget is still
   * stored — rejecting it would make the caller re-render it forever.
   */
  set(key: K, value: V): void {
    const existing = this.map.get(key);
    if (existing !== undefined) {
      this.totalBytes -= this.sizeOf(existing);
      this.map.delete(key);
    }
    this.map.set(key, value);
    this.totalBytes += this.sizeOf(value);

    for (const [k, v] of this.map) {
      if (this.totalBytes <= this.maxBytes || k === key) break;
      this.map.delete(k);
      this.totalBytes -= this.sizeOf(v);
      this.onEvict?.(k, v);
    }
  }

  delete(key: K): void {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.totalBytes -= this.sizeOf(value);
    }
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }

  get bytes(): number {
    return this.totalBytes;
  }

  get size(): number {
    return this.map.size;
  }
}
