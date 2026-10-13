import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Database from '@cordisjs/plugin-database'
import SQLiteDriver from '@cordisjs/plugin-database-sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { tl } from '@mtcute/core'
import Long from 'long'
import { DialogRpc } from './dialogs.js'
import { MessageStore } from './message-store.js'
import { defineModels } from './models.js'
import type { IMConversation, IMMessage, IMPlatform, PlatformSession } from './platform.js'
import { StickerRpc } from './sticker-rpc.js'
import { StickerProviderRegistry, type IMSticker, type IMStickerProvider } from './sticker-provider.js'
import { UploadManager } from './upload-manager.js'

const session: PlatformSession = {
  platformSessionId: 'sticker-send-session', platformId: 'qq/secondary', userId: 'self',
  credentials: {}, metadata: {},
}
const conversation: IMConversation = { id: 'peer', kind: 'direct', title: 'Peer' }
const disposals: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(disposals.splice(0).map((dispose) => dispose()))
})

/**
 * The QQ account's sticker world: the pack and its documents belong to another
 * account (`qq/primary`), which the WebUI assigned to this session, while the
 * platform itself only sends native QQ stickers — the same refusal QQNT makes
 * in `packages/platform-crossgram`.
 */
async function stickerSendHarness() {
  const ctx = new Context()
  const fibers = [ctx.plugin(Database), ctx.plugin(SQLiteDriver, { path: ':memory:' })]
  await Promise.all(fibers)
  await new Promise((resolve) => setTimeout(resolve, 25))
  defineModels(ctx)
  await ctx.database.prepared()
  const directory = await mkdtemp(join(tmpdir(), 'bridge-sticker-send-'))
  disposals.push(async () => {
    await rm(directory, { recursive: true, force: true })
    for (const fiber of fibers.reverse()) await Promise.resolve((fiber as any).dispose?.())
  })

  const sticker: IMSticker = {
    providerId: 'qq/primary:stickers', stickerId: 'market:11690:wave', packId: '11690',
    title: 'Wave', format: 'static', mimeType: 'image/png', size: 321, version: 3,
  }
  const provider: IMStickerProvider = {
    capabilities: { platformKinds: ['qq'], ownerPlatformId: 'qq/primary', sessionScoped: true },
    listPacks: vi.fn(async () => ({
      packs: [{ providerId: sticker.providerId, packId: '11690', title: 'QQ Pack', count: 1, version: 7 }],
    })),
    getPack: vi.fn(async () => ({
      providerId: sticker.providerId, packId: '11690', title: 'QQ Pack', version: 7, stickers: [sticker],
    })),
    getSticker: vi.fn(async () => sticker),
    openAsset: vi.fn(async () => {
      const bytes = Uint8Array.of(1, 2, 3)
      return {
        mimeType: 'image/png', size: bytes.length,
        source: { size: bytes.length, async *stream() { yield bytes } },
      }
    }),
    prepareSend: vi.fn(async () => ({
      type: 'native' as const, providerId: sticker.providerId, stickerId: sticker.stickerId,
      reference: { native: true },
    })),
  }
  const registry = new StickerProviderRegistry()
  registry.register(sticker.providerId, provider)
  await ctx.database.create('mtproto_sticker_set_install', {
    platformSessionId: session.platformSessionId, providerId: sticker.providerId, providerPackId: '11690',
    installedAt: new Date('2026-08-02T00:00:00Z'), sortOrder: 0, archived: false, uninstalled: false,
  })

  const platformStickerPlans: string[] = []
  const platform: IMPlatform = {
    platformKind: 'qq',
    capabilities: {
      history: true,
      send: { text: true, images: true, files: true, mixed: true, maxTextLength: 20_000, maxMedia: 9 },
      conversations: { groups: true, channels: false, subchannels: false },
      stickers: { native: true, upload: false, formats: ['static', 'animated', 'video'] },
    },
    async subscribe() { return () => {} },
    async getDialogs() { return { dialogs: [{ conversation, unreadCount: 0 }] } },
    async getHistory() { return { messages: [] } },
    async getUser(_session, id) { return { id, firstName: id } },
    async sendMessage(): Promise<IMMessage> {
      platformStickerPlans.push('send')
      throw new Error('QQNT only accepts native QQ sticker send plans')
    },
    async *downloadMedia() {},
  }
  const store = new MessageStore(ctx.database)
  const peerId = (await store.upsertUser(session, { id: conversation.id, firstName: conversation.title })).id
  const stickers = new StickerRpc(ctx.database, registry, platform, session)
  const rpc = new DialogRpc(
    platform, session, store, new UploadManager(directory), undefined, 1, stickers,
  )
  return { rpc, stickers, provider, sticker, platformStickerPlans, peerId }
}

describe('sticker send capability', () => {
  it('refuses a native-only platform the sticker of a pack another account owns', async () => {
    const { rpc, stickers, provider, sticker, platformStickerPlans, peerId } = await stickerSendHarness()
    const media = stickers.makeMessageMedia(sticker)
    if (!media.document || media.document._ !== 'document') throw new Error('expected sticker document')
    const document = media.document

    // A client that cached the document while the pack was still visible sends
    // it back to the relay: the bridge has no native plan for this account and
    // QQNT cannot upload a sticker, so the send is rejected before the platform.
    await expect(rpc.sendMedia({
      _: 'messages.sendMedia',
      peer: { _: 'inputPeerUser', userId: peerId, accessHash: Long.ZERO },
      randomId: Long.fromNumber(1), message: '',
      media: {
        _: 'inputMediaDocument',
        id: {
          _: 'inputDocument', id: document.id, accessHash: document.accessHash,
          fileReference: document.fileReference,
        },
      },
    })).rejects.toMatchObject({ code: 400, text: 'STICKER_SEND_UNAVAILABLE' })
    expect(provider.prepareSend).not.toHaveBeenCalled()
    expect(platformStickerPlans).toEqual([])
  })

  it('never projects the pack into a catalog whose sends would be refused', async () => {
    const { stickers, provider } = await stickerSendHarness()

    await expect(stickers.getAllStickers({
      _: 'messages.getAllStickers', hash: Long.ZERO,
    })).resolves.toMatchObject({ _: 'messages.allStickers', sets: [] })
    expect(provider.listPacks).not.toHaveBeenCalled()
  })
})
