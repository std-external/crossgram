/**
 * Map that never holds more than `maximum` entries: the oldest insertion is
 * dropped once the limit is exceeded.
 *
 * Writes refresh an existing key's position, so an entry that is still being
 * written by the request in flight is not evicted while older siblings go. That
 * matters for the dialog caches this serves: the reply-target pre-pass
 * re-inserts every entry a page needs immediately before the page is projected,
 * which only protects it if re-insertion counts as recent.
 */
export class BoundedMap<K, V> extends Map<K, V> {
  constructor(private readonly maximum: number) {
    if (maximum !== Number.POSITIVE_INFINITY
      && (!Number.isInteger(maximum) || maximum < 1)) {
      throw new RangeError('maximum must be a positive integer or Infinity')
    }
    super()
  }

  /** The configured entry ceiling; `Infinity` means unbounded. */
  get limit(): number {
    return this.maximum
  }

  override set(key: K, value: V): this {
    // Deleting first moves a rewritten key to the newest position.
    super.delete(key)
    super.set(key, value)
    while (this.size > this.maximum) {
      const oldest = this.keys().next()
      if (oldest.done) break
      super.delete(oldest.value)
    }
    return this
  }
}
