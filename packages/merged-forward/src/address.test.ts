import { describe, expect, it, vi } from 'vitest'
import {
  stableId,
  type IMMessage,
  type IMMessageBundle,
  type IMMessageSnapshot,
  type IMPlatform,
  type MessageProjectionInput,
  type PlatformSession,
} from '@mtproto-relay/bridge'
import {
  decodeBundleChatId,
  encodeBundleChatId,
  makeMergedForwardProvider,
  type BundleSessionState,
} from './index.js'

const session: PlatformSession = {
  platformId: 'test', platformSessionId: 'address-session', userId: 'self',
  credentials: {}, metadata: {},
}

const outerBundle: IMMessageBundle = {
  id: 'bundle:outer', title: '群聊的聊天记录', preview: 'Alice: hi', locator: { root: 'outer' },
}
const secondBundle: IMMessageBundle = {
  id: 'bundle:second', title: '第二份聊天记录', preview: 'Bob: yo', locator: { root: 'second' },
}
const nestedBundle: IMMessageBundle = {
  id: 'bundle:nested', title: '嵌套的聊天记录', preview: 'Carol: deep', locator: { root: 'nested' },
}

const snapshots: Record<string, IMMessageSnapshot[]> = {
  outer: [
    { id: 'o1', senderId: 'alice', timestamp: 1, content: { parts: [{ type: 'text', text: 'hi' }] } },
    { id: 'o2', senderId: 'alice', timestamp: 2, content: { parts: [{ type: 'message-bundle', bundle: nestedBundle }] } },
  ],
  second: [
    { id: 's1', senderId: 'bob', timestamp: 1, content: { parts: [{ type: 'text', text: 'yo' }] } },
  ],
  nested: [
    { id: 'n1', senderId: 'carol', timestamp: 1, content: { parts: [{ type: 'text', text: 'deep' }] } },
  ],
}

function platform(load = vi.fn(async (_session: PlatformSession, locator: unknown) =>
  snapshots[(locator as { root: string }).root] ?? [])): IMPlatform {
  return {
    capabilities: {
      history: true,
      send: { text: false, images: false, files: false, mixed: false, maxTextLength: 0, maxMedia: 0 },
      conversations: { groups: true, channels: false, subchannels: false },
    },
    messageBundles: { load },
    async subscribe() { return () => {} },
    async sendMessage() { throw new Error('unused') },
  }
}

const stored: IMMessage = {
  id: 'outer-message', conversationId: 'group', senderId: 'alice', timestamp: 10,
  content: { parts: [
    { type: 'message-bundle', bundle: outerBundle },
    { type: 'message-bundle', bundle: secondBundle },
  ] },
}

function state(
  adapter: IMPlatform,
  readStoredMessage = vi.fn(async (id: number) => id === 4242 ? stored : undefined),
): BundleSessionState & { dialogs: { readStoredMessage: typeof readStoredMessage } } {
  return { platform: adapter, session, dialogs: { readStoredMessage } }
}

function projectInput(adapter: IMPlatform, storedMessageId?: number): MessageProjectionInput {
  return {
    mode: 'history', platform: adapter, session,
    target: {
      conversation: { id: 'group', kind: 'group', title: 'Group' },
      peer: { _: 'peerChannel', channelId: 1 }, title: 'Group',
    },
    tlMessageId: 10, ordinal: 0, storedMessageId,
    draft: { source: stored, chats: [] },
  }
}

async function render(projection: ReturnType<typeof makeMergedForwardProvider>, input: MessageProjectionInput) {
  await projection.project(input, async () => ({
    message: { _: 'message', id: input.tlMessageId, peerId: input.target.peer, date: 1, message: '' },
    chats: input.draft.chats,
  }))
  return input.draft.source.content.parts.map((part) =>
    part.type === 'text' ? part.entities?.[0] : undefined)
}

describe('merged-forward durable bundle addresses', () => {
  it('round-trips stored message rows and bundle paths through the chat id', () => {
    const cases = [
      { storedMessageId: 1, path: [0] },
      { storedMessageId: 1_234_995, path: [0] },
      { storedMessageId: 1_234_995, path: [1] },
      { storedMessageId: 77, path: [0, 0] },
      { storedMessageId: 77, path: [0, 3] },
      { storedMessageId: 77, path: [2, 1, 0] },
      { storedMessageId: 77, path: [0, 0, 0, 0, 0, 0, 0] },
      { storedMessageId: 900_000_000, path: [0] },
    ]
    const ids = new Set<number>()
    for (const address of cases) {
      const chatId = encodeBundleChatId(address)
      expect(chatId, JSON.stringify(address)).toBeTypeOf('number')
      // Telegram basic groups: TDLib rejects ids above 999999999999, and the
      // id must stay clear of every stableId-allocated ordinary peer.
      expect(chatId!).toBeGreaterThan(0x7fffffff)
      expect(chatId!).toBeLessThanOrEqual(999_999_999_999)
      expect(decodeBundleChatId(chatId!)).toEqual(address)
      ids.add(chatId!)
    }
    expect(ids.size).toBe(cases.length)
    // The first bundle of a message is the common case and takes code 0, and
    // the scheme starts above every id the previous one handed out.
    expect(encodeBundleChatId({ storedMessageId: 5, path: [0] })).toBe(2 ** 32 + 5 * 1024)
    expect(2 ** 32).toBeGreaterThan(2 ** 31 + 1_406_235 * 1024)
  })

  it('refuses addresses that do not fit instead of colliding', () => {
    expect(encodeBundleChatId({ storedMessageId: 0, path: [0] })).toBeUndefined()
    expect(encodeBundleChatId({ storedMessageId: -1, path: [0] })).toBeUndefined()
    expect(encodeBundleChatId({ storedMessageId: 1, path: [] })).toBeUndefined()
    expect(encodeBundleChatId({ storedMessageId: 1, path: [-1] })).toBeUndefined()
    expect(encodeBundleChatId({ storedMessageId: 1, path: [1000] })).toBeUndefined()
    expect(encodeBundleChatId({ storedMessageId: 1, path: Array(12).fill(0) })).toBeUndefined()
    expect(encodeBundleChatId({ storedMessageId: 1e10, path: [0] })).toBeUndefined()
  })

  it('never decodes ordinary peer ids, process-local ids or a retired scheme', () => {
    for (const chatId of [1, 42, 0x7fffffff, stableId('merged-forward-chat:bundle:outer')]) {
      expect(decodeBundleChatId(chatId), String(chatId)).toBeUndefined()
    }
    // The scheme that preceded ordered message ids: a client still holding one
    // of those ids must not find a transcript it would then mix with the
    // pages it already cached.
    for (const chatId of [2 ** 31, 2 ** 31 + 1023, 2 ** 31 + 1_406_235 * 1024]) {
      expect(decodeBundleChatId(chatId), String(chatId)).toBeUndefined()
    }
    // ... and the current scheme starts above every id that one produced, so
    // the two ranges can never overlap.
    for (const chatId of [2 ** 32 - 1024, 2 ** 32 - 1, 2 ** 32]) {
      expect(decodeBundleChatId(chatId), String(chatId)).toBeUndefined()
    }
    expect(decodeBundleChatId(1_000_000_000_000)).toBeUndefined()
    expect(decodeBundleChatId(1.5)).toBeUndefined()
  })

  it('addresses stored bundles by their message row and keeps unstored ones process-local', async () => {
    const adapter = platform()
    const projection = makeMergedForwardProvider()
    const links = await render(projection, projectInput(adapter, 4242))
    const outerId = encodeBundleChatId({ storedMessageId: 4242, path: [0] })!
    const secondId = encodeBundleChatId({ storedMessageId: 4242, path: [1] })!
    expect(links[0]).toMatchObject({ url: expect.stringMatching(new RegExp(`/bridgebundle_${outerId}/\\d+$`)) })
    expect(links[1]).toMatchObject({ url: expect.stringMatching(new RegExp(`/bridgebundle_${secondId}/\\d+$`)) })

    const local = makeMergedForwardProvider()
    const localLinks = await render(local, projectInput(adapter))
    expect(localLinks[0]).toMatchObject({
      url: expect.stringContaining(`/bridgebundle_${stableId(`merged-forward-chat:${outerBundle.id}`)}/`),
    })
  })

  it('rebuilds a transcript from the stored message after the registry is gone', async () => {
    const adapter = platform()
    const current = state(adapter)
    const restarted = makeMergedForwardProvider()
    const secondId = encodeBundleChatId({ storedMessageId: 4242, path: [1] })!

    const record = await restarted.lookup(current, secondId)
    expect(record).toMatchObject({ chatId: secondId, bundle: { id: secondBundle.id } })
    expect(current.dialogs.readStoredMessage).toHaveBeenCalledWith(4242)
    await expect(restarted.resolveUsername(current, `bridgebundle_${secondId}`)).resolves.toBe(record)
    await expect(restarted.resolveUsername(current, `BridgeChat_${secondId}`)).resolves.toBe(record)
    // Cached afterwards: no second store read.
    expect(current.dialogs.readStoredMessage).toHaveBeenCalledOnce()
  })

  it('rebuilds nested transcripts through the parent archive', async () => {
    const load = vi.fn(async (_session: PlatformSession, locator: unknown) =>
      snapshots[(locator as { root: string }).root] ?? [])
    const adapter = platform(load)
    const nestedId = encodeBundleChatId({ storedMessageId: 4242, path: [0, 0] })!
    const record = await makeMergedForwardProvider().lookup(state(adapter), nestedId)
    expect(record).toMatchObject({ chatId: nestedId, bundle: { id: nestedBundle.id } })
    expect(load).toHaveBeenCalledWith(session, outerBundle.locator)
  })

  it('links nested bundles to their durable address while the parent renders', async () => {
    const adapter = platform()
    const projection = makeMergedForwardProvider()
    const outerId = encodeBundleChatId({ storedMessageId: 4242, path: [0] })!
    const nestedId = encodeBundleChatId({ storedMessageId: 4242, path: [0, 0] })!
    const record = await projection.lookup(state(adapter), outerId)
    const nested = { ...projectInput(adapter), mode: 'bundle' as const, storedMessageId: undefined }
    nested.draft = { source: { ...snapshots.outer[1]!, conversationId: 'bundle' }, chats: [] }
    // Rendering the parent registers where its nested bundles live.
    await projection.materialize({
      ...state(adapter),
      projection: { plan: async (_input: unknown, fallback: () => unknown) => fallback(), project: async (_input: unknown, fallback: () => unknown) => fallback(), rememberMedia() {} },
      stickers: {},
    } as never, record!)
    const links = await render(projection, nested)
    expect(links[0]).toMatchObject({ url: expect.stringContaining(`/bridgebundle_${nestedId}/`) })
  })

  it('answers nothing for deleted rows, missing bundles and sessions without a store', async () => {
    const adapter = platform()
    const projection = makeMergedForwardProvider()
    await expect(projection.lookup(state(adapter),
      encodeBundleChatId({ storedMessageId: 1, path: [0] })!)).resolves.toBeUndefined()
    await expect(projection.lookup(state(adapter),
      encodeBundleChatId({ storedMessageId: 4242, path: [5] })!)).resolves.toBeUndefined()
    await expect(projection.lookup(state(adapter),
      encodeBundleChatId({ storedMessageId: 4242, path: [1, 0] })!)).resolves.toBeUndefined()
    await expect(projection.lookup({ platform: adapter, session },
      encodeBundleChatId({ storedMessageId: 4242, path: [0] })!)).resolves.toBeUndefined()
    const failing = state(adapter, vi.fn(async () => { throw new Error('database offline') }))
    await expect(projection.lookup(failing,
      encodeBundleChatId({ storedMessageId: 4242, path: [0] })!)).resolves.toBeUndefined()
  })

  it('deduplicates concurrent rebuilds and bounds the cache without losing links', async () => {
    const adapter = platform()
    const current = state(adapter)
    const projection = makeMergedForwardProvider()
    const outerId = encodeBundleChatId({ storedMessageId: 4242, path: [0] })!
    const [one, two] = await Promise.all([projection.lookup(current, outerId), projection.lookup(current, outerId)])
    expect(one).toBe(two)
    expect(current.dialogs.readStoredMessage).toHaveBeenCalledOnce()

    for (let index = 0; index < 300; index++) {
      projection.remember(session.platformSessionId, { ...outerBundle, id: `bundle:${index}` },
        { storedMessageId: 10_000 + index, path: [0] })
    }
    expect([...projection.records(session.platformSessionId)].length).toBeLessThanOrEqual(256)
    expect(projection.resolve(session.platformSessionId, outerId)).toBeUndefined()
    await expect(projection.lookup(current, outerId)).resolves.toMatchObject({ bundle: { id: outerBundle.id } })
  })
})
