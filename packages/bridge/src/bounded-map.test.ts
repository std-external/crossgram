import { describe, expect, it } from 'vitest'
import { BoundedMap } from './bounded-map.js'

describe('BoundedMap', () => {
  it('rejects a limit that is neither a positive integer nor Infinity', () => {
    for (const maximum of [0, -1, 1.5, Number.NaN]) {
      expect(() => new BoundedMap(maximum)).toThrow(RangeError)
    }
  })

  it('reports its ceiling, including the unbounded case', () => {
    expect(new BoundedMap(4).limit).toBe(4)
    expect(new BoundedMap(Number.POSITIVE_INFINITY).limit).toBe(Number.POSITIVE_INFINITY)
  })

  it('keeps every entry when the ceiling is Infinity', () => {
    const map = new BoundedMap<string, number>(Number.POSITIVE_INFINITY)
    for (let index = 0; index < 100; index++) map.set(`key-${index}`, index)
    expect(map.size).toBe(100)
    expect(map.get('key-0')).toBe(0)
  })

  it('drops the oldest insertion once the ceiling is exceeded', () => {
    const map = new BoundedMap<string, number>(3)
    for (const key of ['a', 'b', 'c', 'd']) map.set(key, 1)
    expect([...map.keys()]).toEqual(['b', 'c', 'd'])
    expect(map.has('a')).toBe(false)
    expect(map.size).toBe(3)
  })

  it('never grows past the ceiling', () => {
    const map = new BoundedMap<number, number>(64)
    for (let index = 0; index < 1_000; index++) {
      map.set(index, index)
      expect(map.size).toBeLessThanOrEqual(64)
    }
    expect([...map.keys()]).toEqual(Array.from({ length: 64 }, (_, index) => 936 + index))
  })

  it('treats a rewrite as the newest insertion so a live entry survives eviction', () => {
    const map = new BoundedMap<string, number>(3)
    map.set('a', 1)
    map.set('b', 1)
    map.set('c', 1)
    // The reply-target pre-pass rewrites the entries a page needs; that must
    // protect them from the evictions the page's own new entries trigger.
    map.set('a', 2)
    map.set('d', 1)
    expect(map.has('a')).toBe(true)
    expect(map.get('a')).toBe(2)
    expect([...map.keys()]).toEqual(['c', 'a', 'd'])
  })

  it('returns itself from set, like Map', () => {
    const map = new BoundedMap<string, number>(2)
    expect(map.set('a', 1)).toBe(map)
  })
})
