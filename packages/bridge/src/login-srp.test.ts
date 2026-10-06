import { describe, expect, it } from 'vitest'
import Long from 'long'
import { computeSrpParams } from '@mtcute/core/utils.js'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import {
  SRP_PRIME_HEX, SrpChallengeStore, generateSrpVerifier, verifySrpChallenge,
} from './login-srp.js'

const crypto = new NodeCryptoProvider()
const AUTH_KEY = '0123456789abcdef'

function toBufferHex(value: bigint): Uint8Array {
  return Buffer.from(value.toString(16).padStart(512, '0'), 'hex')
}

/** Client side of the exchange, byte-for-byte what mtcute clients compute. */
async function clientCheck(
  verifierPassword: string,
  challengeB: bigint,
  srpId: Long,
  salt1: string,
  salt2: string,
): Promise<{ srpId: Long, A: Uint8Array, M1: Uint8Array }> {
  return await computeSrpParams(crypto, {
    currentAlgo: {
      _: 'passwordKdfAlgoSHA256SHA256PBKDF2HMACSHA512iter100000SHA256ModPow',
      salt1: Buffer.from(salt1, 'hex'),
      salt2: Buffer.from(salt2, 'hex'),
      g: 3,
      p: Buffer.from(SRP_PRIME_HEX, 'hex'),
    },
    srpB: toBufferHex(challengeB),
    srpId,
  } as never, verifierPassword)
}

describe('two-step verification SRP', () => {
  it('round-trips a correct password against the mtcute client computation', async () => {
    const verifier = await generateSrpVerifier('hunter2')
    const store = new SrpChallengeStore()
    const challenge = store.begin(AUTH_KEY, verifier)
    expect(challenge.B).toBeGreaterThan(0n)

    const check = await clientCheck(
      'hunter2', challenge.B, challenge.srpId, verifier.salt1, verifier.salt2,
    )
    expect(verifySrpChallenge(challenge, check)).toBe(true)
  })

  it('rejects a wrong password, wrong srp id, and out-of-range A', async () => {
    const verifier = await generateSrpVerifier('hunter2')
    const store = new SrpChallengeStore()
    const challenge = store.begin(AUTH_KEY, verifier)

    const good = await clientCheck(
      'hunter2', challenge.B, challenge.srpId, verifier.salt1, verifier.salt2,
    )
    const badPassword = await clientCheck(
      'hunter3', challenge.B, challenge.srpId, verifier.salt1, verifier.salt2,
    )
    expect(verifySrpChallenge(challenge, badPassword)).toBe(false)
    expect(verifySrpChallenge(challenge, { ...good, srpId: Long.fromInt(1) })).toBe(false)
    expect(verifySrpChallenge(challenge, { ...good, A: Buffer.alloc(256, 0xff) })).toBe(false)
  })

  it('keeps one challenge per auth key and expires stale ones', async () => {
    let now = 0
    const verifier = await generateSrpVerifier('hunter2')
    const store = new SrpChallengeStore(() => now)
    store.begin(AUTH_KEY, verifier)
    const second = store.begin(AUTH_KEY, verifier)
    expect(store.get(AUTH_KEY)?.srpId.eq(second.srpId)).toBe(true)

    now = 5 * 60_001
    expect(store.get(AUTH_KEY)).toBeUndefined()

    store.delete(AUTH_KEY)
    expect(store.get(AUTH_KEY)).toBeUndefined()
  })
})
