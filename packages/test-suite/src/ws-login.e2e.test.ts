import { describe, it, expect } from 'vitest'
import { connectWs } from '@fuman/net'
import { IntermediatePacketCodec, ObfuscatedPacketCodec, type TelegramTransport } from '@mtcute/core'
import { MemoryStorage, TelegramClient } from '@mtcute/node'
import { addPublicKey } from '@mtcute/core/utils.js'
import { NodeCryptoProvider } from '@mtcute/node/utils.js'
import { startApp } from './harness.js'

/**
 * Full bridge e2e over the WebSocket transport: a real mtcute TelegramClient
 * (QR login → RPC → updates) connected exclusively through `ws://`, the way a
 * modified Telegram Web client would. Serves as the probe for "which RPCs a
 * browser client actually needs".
 */

const wsTransport: TelegramTransport = {
  connect: (dc, abortSignal) =>
    connectWs({ url: `ws://${dc.ipAddress}:${dc.port}/apiws` }, abortSignal),
  packetCodec: () => new ObfuscatedPacketCodec(new IntermediatePacketCodec()),
}

describe('e2e: websocket transport login', () => {
  it('logs in via QR over websocket and serves core RPCs', async () => {
    const { ctx, wsPort, rsaKey, stop } = await startApp({ wsPort: 0 })
    expect(wsPort).not.toBeNull()
    try {
      addPublicKey(new NodeCryptoProvider(), rsaKey.publicKeyPem, false)
      const dc = { id: 1, ipAddress: '127.0.0.1', port: wsPort! }
      const client = new TelegramClient({
        apiId: 1,
        apiHash: 'crossgram-e2e',
        storage: new MemoryStorage(),
        defaultDcs: { main: dc, media: dc },
        transport: wsTransport,
        updates: {},
        logLevel: 1,
        initConnectionOptions: {
          deviceModel: 'Crossgram WS E2E',
          systemVersion: 'test',
          appVersion: '0.1.0',
          systemLangCode: 'en',
          langPack: '',
          langCode: 'en',
        },
      })

      const approvals: string[] = []
      const user = await client.start({
        qrCodeHandler: async (url) => {
          approvals.push(url)
          const response = await fetch(`http://127.0.0.1:${ctx.server.port}/api/login-tokens/static/approve`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token: url }),
          })
          expect(response.ok).toBe(true)
        },
      })
      expect(approvals.length).toBeGreaterThan(0)
      expect(user.isSelf).toBe(true)

      const me = await client.getMe()
      expect(me.id).toBe(user.id)

      const dialogs: unknown[] = []
      for await (const dialog of client.iterDialogs({ limit: 10 })) dialogs.push(dialog)
      expect(dialogs.length).toBeGreaterThan(0)

      await client.destroy()
    } finally {
      await stop()
    }
  })
})
