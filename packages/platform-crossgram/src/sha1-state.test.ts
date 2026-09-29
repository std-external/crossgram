import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Sha1CompressionState } from './sha1-state.js'

// Independently computed with a reference SHA-1 compressor over bytes i % 251.
const ONE_MIB_STATE = '463935c7eea4ca2705d0f481ecedb31f4d0f3a96'

function pattern(length: number): Buffer {
  const bytes = Buffer.alloc(length)
  for (let index = 0; index < length; index++) bytes[index] = index % 251
  return bytes
}

describe('Sha1CompressionState', () => {
  it('exposes the unpadded little-endian state that QQ video checkpoints require', () => {
    const state = new Sha1CompressionState()
    state.update(pattern(1024 * 1024))
    const checkpoint = state.stateLittleEndian().toString('hex')
    expect(checkpoint).toBe(ONE_MIB_STATE)
    // The padded prefix digest is what the old code sent; QQ never stores those uploads.
    expect(checkpoint).not.toBe(createHash('sha1').update(pattern(1024 * 1024)).digest('hex'))
  })

  it('is independent of how the input is chunked', () => {
    const bytes = pattern(1024 * 1024)
    const state = new Sha1CompressionState()
    let offset = 0
    const sizes = [1, 63, 65, 1000, 333_333, 7]
    for (let index = 0; offset < bytes.length; index++) {
      const next = Math.min(bytes.length, offset + sizes[index % sizes.length]!)
      state.update(bytes.subarray(offset, next))
      offset = next
    }
    expect(state.stateLittleEndian().toString('hex')).toBe(ONE_MIB_STATE)
  })

  it('starts from the SHA-1 initial vector and rejects unaligned reads', () => {
    const state = new Sha1CompressionState()
    expect(state.stateLittleEndian().toString('hex'))
      .toBe('0123456789abcdeffedcba9876543210f0e1d2c3')
    state.update(Buffer.alloc(10))
    expect(() => state.stateLittleEndian()).toThrow('not aligned')
  })
})
