import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import type { IMMessage, IMPlatform, PlatformSession } from './platform.js'

/**
 * The per-device message indexes are a cache in front of the durable
 * `mtproto_tl_message_part` table, so the bound that keeps them from growing for
 * the life of a device must not lose any address. These tests drop the whole
 * cache by hand — the same state a device reaches after enough traffic — and
 * assert that the id still resolves through the store.
 */

const session: PlatformSession = {
  platformSessionId: 'message-cache-session',
  platformId: 'message-cache',
  userId: 'self',
  credentials: {},
  metadata: {},
}

const conversation = { id: 'cache-peer', kind: 'direct' as const, title: 'Cache peer' }

const target: IMMessage = {
  id: 'cache-target',
  conversationId: conversation.id,
  senderId: session.userId,
  timestamp: 1_785_000_000,
  content: { parts: [{ type: 'text', text: 'the message being replied to' }] },
}

const reply: IMMessage = {
  id: 'cache-reply',
  conversationId: conversation.id,
  senderId: session.userId,
  timestamp: 1_785_000_010,
  replyToId: target.id,
  content: { parts: [{ type: 'text', text: 'a reply' }] },
}

const platform: IMPlatform = {
  capabilities: {
    history: true,
    send: {
      text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0,
    },
    conversations: { groups: true, channels: false, subchannels: false },
  },
  async subscribe() { return () => {} },
  async getDialogs() {
    return { dialogs: [{ conversation, unreadCount: 0, lastMessage: reply }], total: 1 }
  },
  async getHistory() { return { messages: [reply] } },
  async sendMessage() { throw new Error('send is disabled') },
}

interface DialogMessageIndexes {
  _messageToTl: Map<string, number>
  _tlToMessage: Map<number, unknown>
  _messageOutgoingByTl: Map<number, boolean>
}

/** Stands in for the bound having evicted everything the device once indexed. */
function dropDeviceMessageIndexes(rpc: DialogRpc): void {
  const indexes = rpc as unknown as DialogMessageIndexes
  indexes._messageToTl.clear()
  indexes._tlToMessage.clear()
  indexes._messageOutgoingByTl.clear()
}

const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

async function createStore(): Promise<MessageStore> {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  disposals.push(async () => {
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })
  return new MessageStore(ctx.database)
}

function getDialogsRequest(): tl.messages.RawGetDialogsRequest {
  return {
    _: 'messages.getDialogs', excludePinned: false, offsetDate: 0, offsetId: 0,
    offsetPeer: { _: 'inputPeerEmpty' }, limit: 100, hash: Long.ZERO,
  }
}

describe('dialog message index bound', () => {
  it('resolves messages.getMessages through the store after the index dropped the id', async () => {
    const store = await createStore()
    const [ingestedTarget] = await store.ingestMany(
      session, conversation, [target, reply], { allocation: 'history' },
    )
    const targetTlId = ingestedTarget.projection[0].tlMessageId
    expect(targetTlId).toBeGreaterThan(0)

    const rpc = new DialogRpc(platform, session, store)
    await rpc.getDialogs(getDialogsRequest())
    dropDeviceMessageIndexes(rpc)

    const messages = await rpc.getMessages({
      _: 'messages.getMessages',
      id: [{ _: 'inputMessageID', id: targetTlId }],
    })
    expect(messages._ === 'messages.messagesNotModified' ? [] : messages.messages).toMatchObject([
      { _: 'message', id: targetTlId, message: 'the message being replied to' },
    ])
    // The miss re-populated the index from the durable row.
    expect((rpc as unknown as DialogMessageIndexes)._tlToMessage.has(targetTlId)).toBe(true)
  })

  it('re-resolves a reply target from the store after the index dropped it', async () => {
    const store = await createStore()
    const [ingestedTarget] = await store.ingestMany(
      session, conversation, [target, reply], { allocation: 'history' },
    )
    const targetTlId = ingestedTarget.projection[0].tlMessageId

    const rpc = new DialogRpc(platform, session, store)
    await rpc.getDialogs(getDialogsRequest())
    dropDeviceMessageIndexes(rpc)

    const history = await rpc.getHistory({
      _: 'messages.getHistory',
      peer: { _: 'inputPeerUser', userId: rpc.peerTlId(conversation.id), accessHash: Long.ZERO },
      offsetId: 0, offsetDate: 0, addOffset: 0, limit: 10,
      maxId: 0, minId: 0, hash: Long.ZERO,
    })
    const messages = history._ === 'messages.messagesNotModified' ? [] : history.messages
    const rendered = messages.find((message) =>
      message._ === 'message' && message.message === 'a reply')
    expect(rendered).toMatchObject({
      _: 'message', replyTo: { _: 'messageReplyHeader', replyToMsgId: targetTlId },
    })
  })
})
