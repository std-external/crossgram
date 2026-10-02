import { describe, it, expect } from 'vitest'
import { Bytes } from '@fuman/io'
import { ObfuscatedPacketCodec } from '@mtcute/core'
import {
  addPublicKey, LogManager, __tlReaderMap, __tlWriterMap,
} from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { NodePlatform } from '@mtcute/node'
import Long from 'long'
import { get as httpGet } from 'node:http'
import { Context } from 'cordis'
import WebSocket, { type RawData } from 'ws'
import { Mtproto } from '../service.js'
import { AbridgedPacketCodec } from './server-obfuscation.js'
import { generateRsaKeyPair } from '../crypto/rsa-keygen.js'

/**
 * Full-stack e2e for the WebSocket transport: drives a real Mtproto service
 * (TCP disabled via port 0, WS enabled) through a `ws` client speaking the same
 * obfuscated + abridged byte stream Telegram Web clients send over
 * `wss://…/apiws`. Frame boundaries in WS messages are meaningless to MTProto,
 * so the tests also exercise split and coalesced frames.
 */

const crypto = new NodeCryptoProvider()
const log = new LogManager('e2e', new NodePlatform())
log.level = LogManager.OFF
const clientLog = log.create('client')

function nowSec() { return Math.floor(Date.now() / 1000) }
function makeMsgId(sub: number) { return Long.fromBits((Date.now() % 1000 << 21) | sub, nowSec()) }

/** Serialize a plaintext (auth_key_id=0) MTProto message carrying legacy req_pq. */
function plainReqPq(nonce: Uint8Array, sub: number): Uint8Array {
  const body = TlBinaryWriter.manual(20)
  body.uint(0x60469778)
  body.raw(nonce)
  const w = TlBinaryWriter.manual(40)
  w.long(Long.ZERO)
  w.long(makeMsgId(sub))
  w.uint(20)
  w.raw(body.result())
  return w.result()
}

async function readPlainMessage(client: WsTestClient): Promise<{ messageId: Long, object: any }> {
  const frame = await client.read()
  const reader = new TlBinaryReader(__tlReaderMap, frame, 8)
  const messageId = reader.long()
  reader.uint()
  return { messageId, object: reader.object() }
}

/** A test client speaking obfuscated + abridged transport over a WebSocket. */
class WsTestClient {
  private _codec = new ObfuscatedPacketCodec(new AbridgedPacketCodec())
  private _recv = Bytes.alloc(65536)
  private _frames: Uint8Array[] = []
  private _waiter: ((f: Uint8Array) => void) | null = null
  private _processing = Promise.resolve()
  private _tag!: Uint8Array

  private constructor(private _ws: WebSocket) {}

  static async connect(port: number, path = '/'): Promise<WsTestClient> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    await new Promise<void>((res, rej) => { ws.once('open', res); ws.once('error', rej) })
    const client = new WsTestClient(ws)
    client._codec.setup(crypto, clientLog)
    ws.on('message', (data: RawData) => client._onData(data as Buffer))
    client._tag = await client._codec.tag()
    return client
  }

  private _onData(d: Buffer): void {
    const view = this._recv.writeSync(d.length)
    view.set(new Uint8Array(d))
    this._recv.disposeWriteSync(d.length)
    this._processing = this._processing.then(() => this._drain())
  }

  private async _drain(): Promise<void> {
    for (;;) {
      const f = await this._codec.decode(this._recv, false)
      if (f === null) break
      const frame = new Uint8Array(f)
      if (this._waiter) { const w = this._waiter; this._waiter = null; w(frame) }
      else this._frames.push(frame)
    }
    this._recv.reclaim()
  }

  private async _encode(frame: Uint8Array): Promise<Buffer> {
    const into = Bytes.alloc(frame.length + 64)
    await this._codec.encode(frame, into)
    return Buffer.from(into.result())
  }

  /** Transport tag and payload in one WS message (mtcute's style). */
  async send(frame: Uint8Array): Promise<void> {
    this._ws.send(Buffer.concat([Buffer.from(this._tag), await this._encode(frame)]))
  }

  /** Transport tag split from the payload across two WS messages. */
  async sendTagSplit(frame: Uint8Array): Promise<void> {
    this._ws.send(this._tag)
    this._ws.send(await this._encode(frame))
  }

  /** Transport tag cut in half mid-header, then the payload. */
  async sendTagHalves(frame: Uint8Array): Promise<void> {
    this._ws.send(this._tag.subarray(0, 32))
    this._ws.send(this._tag.subarray(32))
    this._ws.send(await this._encode(frame))
  }

  /** Several MTProto frames coalesced into a single WS message. */
  async sendBatch(frames: readonly Uint8Array[]): Promise<void> {
    const packets: Buffer[] = []
    for (const frame of frames) packets.push(await this._encode(frame))
    this._ws.send(Buffer.concat([Buffer.from(this._tag), ...packets]))
  }

  read(): Promise<Uint8Array> {
    if (this._frames.length > 0) return Promise.resolve(this._frames.shift()!)
    return new Promise((res) => { this._waiter = res })
  }

  close(): void { this._ws.terminate() }
}

async function startServer(): Promise<{
  wsPort: number
  fingerprint: Long
  stop: () => Promise<void>
}> {
  await crypto.initialize?.()
  const rsaKey = generateRsaKeyPair()
  addPublicKey(crypto, rsaKey.publicKeyPem, false)
  const ctx = new Context()
  const fiber = ctx.plugin(Mtproto, {
    port: 0, wsPort: 0, host: '127.0.0.1', rsaKey, log,
  })
  await fiber
  const wsPort = ctx.mtproto.wsPort
  if (wsPort === null) throw new Error('WebSocket transport was not enabled')
  return {
    wsPort,
    fingerprint: Long.fromString(rsaKey.fingerprint, true, 16),
    stop: () => fiber.dispose(),
  }
}

function httpStatus(port: number, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    httpGet({ host: '127.0.0.1', port, path }, (response) => {
      response.resume()
      response.on('end', () => resolve(response.statusCode ?? 0))
    }).once('error', reject)
  })
}

describe('websocket transport', () => {
  it('answers req_pq over websocket (mtcute-style single message)', async () => {
    const { wsPort, fingerprint, stop } = await startServer()
    try {
      const client = await WsTestClient.connect(wsPort)
      const nonce = crypto.randomBytes(16)
      await client.send(plainReqPq(nonce, 3))
      const { object } = await readPlainMessage(client)
      expect(object._).toBe('mt_resPQ')
      expect(object.nonce).toEqual(nonce)
      expect(object.serverNonce).toHaveLength(16)
      expect(object.serverPublicKeyFingerprints.some((fp: Long) => fp.low === fingerprint.low && fp.high === fingerprint.high)).toBe(true)
      client.close()
    } finally {
      await stop()
    }
  })

  it('answers req_pq on the /apiws path Telegram Web clients use', async () => {
    const { wsPort, fingerprint, stop } = await startServer()
    try {
      const client = await WsTestClient.connect(wsPort, '/apiws')
      const nonce = crypto.randomBytes(16)
      await client.send(plainReqPq(nonce, 3))
      const { object } = await readPlainMessage(client)
      expect(object._).toBe('mt_resPQ')
      expect(object.serverPublicKeyFingerprints.some((fp: Long) => fp.low === fingerprint.low && fp.high === fingerprint.high)).toBe(true)
      client.close()
    } finally {
      await stop()
    }
  })

  it('reassembles a transport header split across WS messages', async () => {
    const { wsPort, stop } = await startServer()
    try {
      const client = await WsTestClient.connect(wsPort)
      const nonce = crypto.randomBytes(16)
      await client.sendTagSplit(plainReqPq(nonce, 3))
      const { object } = await readPlainMessage(client)
      expect(object._).toBe('mt_resPQ')
      expect(object.nonce).toEqual(nonce)
      client.close()
    } finally {
      await stop()
    }
  })

  it('reassembles a transport header cut in half mid-header', async () => {
    const { wsPort, stop } = await startServer()
    try {
      const client = await WsTestClient.connect(wsPort)
      const nonce = crypto.randomBytes(16)
      await client.sendTagHalves(plainReqPq(nonce, 3))
      const { object } = await readPlainMessage(client)
      expect(object._).toBe('mt_resPQ')
      expect(object.nonce).toEqual(nonce)
      client.close()
    } finally {
      await stop()
    }
  })

  it('decodes several MTProto frames coalesced into one WS message', async () => {
    const { wsPort, stop } = await startServer()
    try {
      const client = await WsTestClient.connect(wsPort)
      const first = crypto.randomBytes(16)
      const second = crypto.randomBytes(16)
      await client.sendBatch([
        plainReqPq(first, 3),
        plainReqPq(second, 4),
      ])
      const answers = [
        (await readPlainMessage(client)).object,
        (await readPlainMessage(client)).object,
      ]
      expect(answers.map(o => o._)).toEqual(['mt_resPQ', 'mt_resPQ'])
      expect(answers.map(o => Buffer.from(o.nonce))).toContainEqual(Buffer.from(second))
      client.close()
    } finally {
      await stop()
    }
  })

  it('rejects plain HTTP requests with 426', async () => {
    const { wsPort, stop } = await startServer()
    try {
      expect(await httpStatus(wsPort, '/')).toBe(426)
    } finally {
      await stop()
    }
  })
})
