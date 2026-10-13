import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { QQNTPlatform } from './index.js'

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).reverse().map((dispose) => dispose()))
})

/**
 * `getAccount` is the gate every provisioned session passes through, so a
 * bridge revision the adapter already understands must not be refused there.
 */
describe('QQNT bridge protocol range E2E', () => {
  it('provisions and sends through a bridge that speaks protocol 35', async () => {
    const manifests: Array<Record<string, any>> = []
    const server: Server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json')
      if (request.url === '/v1/status') {
        response.end(JSON.stringify({
          protocolVersion: 35, ready: true, selfUin: '10000', selfUid: 'u_self',
        }))
        return
      }
      if (request.url === '/v1/users/u_self') {
        response.end(JSON.stringify({ id: 'u_self', numericId: '10000', name: 'Owner' }))
        return
      }
      if (request.method === 'POST' && request.url === '/v1/messages') {
        const encoded = String(request.headers['x-qqnt-manifest'])
        manifests.push(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')))
        response.end(JSON.stringify({
          id: 'm', conversationId: 'u_peer', senderId: 'u_self', timestamp: 1,
          outgoing: true, parts: [{ type: 'text', text: 'lead' }],
        }))
        return
      }
      response.statusCode = 404
      response.end(JSON.stringify({ error: 'not found' }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('missing test server address')
    disposals.push(async () => {
      if (!server.listening) return
      const closed = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })
      server.closeAllConnections()
      await closed
    })

    const platform = new QQNTPlatform({ endpoint: `http://127.0.0.1:${address.port}/v1` })

    // A protocol 35 bridge is the revision the adapter's ordered send body is
    // written for, so provisioning must resolve instead of failing closed.
    await expect(platform.getAccount()).resolves.toMatchObject({
      user: { id: 'u_self', firstName: 'Owner', username: '10000' },
    })

    await platform.client.sendMessage('u_peer', [{ type: 'text', text: 'lead' }])
    // The bridge keeps the caller's element order, so the request carries the
    // ordered body instead of the flat text-then-media shape.
    expect(manifests).toHaveLength(1)
    expect(manifests[0]?.parts).toEqual([{ type: 'text', text: 'lead' }])
    expect(manifests[0]?.text).toBeUndefined()
    expect(manifests[0]?.media).toBeUndefined()
  })
})
