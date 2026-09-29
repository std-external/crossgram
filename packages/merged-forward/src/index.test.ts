import { describe, expect, it, vi } from 'vitest'
import {
  stableId,
  type IMMessageBundle,
  type IMPlatform,
  type MessageProjectionInput,
  type PlatformSession,
} from '@mtproto-relay/bridge'
import { makeMergedForwardProvider, snapshotPreview } from './index.js'

const session: PlatformSession = {
  platformId: 'test', platformSessionId: 'session-1', userId: 'self',
  credentials: {}, metadata: {},
}

const bundle: IMMessageBundle = {
  id: 'bundle:test',
  title: 'Alice 和 Bob 的聊天记录',
  preview: 'Alice: hello\nBob: world',
  locator: { root: 'forward-1' },
}

function platform(load: NonNullable<IMPlatform['messageBundles']>['load'] = vi.fn(async () => [{
  id: 'latest', senderId: 'bob', timestamp: 100,
  sender: { id: 'bob', firstName: 'Bob' },
  content: { parts: [{ type: 'text' as const, text: 'world' }] },
}])): IMPlatform {
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

function input(adapter: IMPlatform): MessageProjectionInput {
  return {
    mode: 'history', platform: adapter, session,
    target: {
      conversation: { id: 'outer', kind: 'group', title: 'Outer' },
      peer: { _: 'peerChannel', channelId: 1 },
      title: 'Outer',
    },
    tlMessageId: 10,
    ordinal: 0,
    draft: {
      source: {
        id: 'outer-message', conversationId: 'outer', senderId: 'alice', timestamp: 1,
        content: { parts: [{ type: 'message-bundle', bundle }] },
      },
      chats: [],
    },
  }
}

describe('merged-forward projection', () => {
  it('owns only ephemeral bundle addressing and never needs a conversation/store record', async () => {
    const projection = makeMergedForwardProvider()
    const record = projection.remember(session.platformSessionId, bundle)
    const chatId = stableId(`merged-forward-chat:${bundle.id}`)

    expect(record.chatId).toBe(chatId)
    expect(projection.makeLink(record, 456)).toBe(`https://t.me/bridgebundle_${chatId}/456`)
    expect(projection.makePreview(record)).toMatchObject({
      webpage: {
        url: `https://t.me/bridgebundle_${chatId}`,
        title: bundle.title,
        description: bundle.preview,
      },
    })
    // A `telegram_message` card never carries an image: Telegram Android would
    // draw it as a full-width banner above the title.
    const card = projection.makePreview(record).webpage
    if (card._ !== 'webPage') throw new Error('merged-forward preview is not a web page')
    expect(card.photo).toBeUndefined()
    expect(projection.makeChat(record)).toMatchObject({
      _: 'chat', left: true, id: chatId, title: bundle.title,
    })
    expect(projection.resolveUsername(session.platformSessionId, `bridgebundle_${chatId}`)).toBe(record)
    expect(projection.resolveUsername(session.platformSessionId, `bridgechat_${chatId}`)).toBe(record)
    expect(projection.resolveUsername(session.platformSessionId, 'bridgebundle_999')).toBeUndefined()
  })

  it('anchors the deep link at the first bundle message instead of the newest one', async () => {
    const projection = makeMergedForwardProvider()
    const adapter = platform(vi.fn(async () => [{
      id: 'middle', senderId: 'bob', timestamp: 200,
      content: { parts: [{ type: 'text' as const, text: 'middle' }] },
    }, {
      id: 'latest', senderId: 'bob', timestamp: 300,
      content: { parts: [{ type: 'text' as const, text: 'latest' }] },
    }, {
      id: 'first', senderId: 'alice', timestamp: 100,
      content: { parts: [{ type: 'text' as const, text: 'first' }] },
    }]))
    const value = input(adapter)
    await projection.project(value, async () => ({
      message: {
        _: 'message', id: value.tlMessageId, peerId: value.target.peer,
        date: 1, message: '查看聊天记录', entities: [],
      },
      chats: value.draft.chats,
    }))

    const chatId = stableId(`merged-forward-chat:${bundle.id}`)
    const firstId = stableId(`merged-forward-message:${bundle.id}:first:0`)
    const newestId = stableId(`merged-forward-message:${bundle.id}:latest:0`)
    expect(firstId).not.toBe(newestId)
    expect(value.draft.source.content.parts[0]).toMatchObject({
      type: 'text',
      entities: [{ type: 'text-link', url: `https://t.me/bridgebundle_${chatId}/${firstId}` }],
    })
    expect(value.draft.media).toMatchObject({
      webpage: { url: `https://t.me/bridgebundle_${chatId}/${firstId}` },
    })
  })

  it('projects bundle parts through the message waterfall and deduplicates complete bundle loading', async () => {
    const projection = makeMergedForwardProvider()
    let release!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    const load = vi.fn(async () => {
      await wait
      return [{
        id: 'latest', senderId: 'bob', timestamp: 100,
        content: { parts: [{ type: 'text' as const, text: 'latest' }] },
      }]
    })
    const adapter = platform(load)
    const first = input(adapter)
    const second = input(adapter)
    const render = (value: MessageProjectionInput) => projection.project(value, async () => ({
      message: {
        _: 'message', id: value.tlMessageId, peerId: value.target.peer,
        date: 1, message: '查看聊天记录', entities: [],
      },
      chats: value.draft.chats,
    }))
    const pending = [render(first), render(second)]
    release()
    const [one, two] = await Promise.all(pending)

    const chatId = stableId(`merged-forward-chat:${bundle.id}`)
    const messageId = stableId(`merged-forward-message:${bundle.id}:latest:0`)
    expect(load).toHaveBeenCalledOnce()
    for (const [result, value] of [[one, first], [two, second]] as const) {
      expect(value.draft.source.content.parts[0]).toMatchObject({
        type: 'text',
        entities: [{ type: 'text-link', url: `https://t.me/bridgebundle_${chatId}/${messageId}` }],
      })
      expect(value.draft.media).toMatchObject({ _: 'messageMediaWebPage' })
      expect(result.chats).toMatchObject([{ _: 'chat', left: true, id: chatId }])
    }
  })

  it('never invents placeholder text when the platform supplies no summary', () => {
    const projection = makeMergedForwardProvider()
    const record = projection.remember(session.platformSessionId, { ...bundle, preview: undefined })
    const webpage = projection.makePreview(record).webpage
    if (webpage._ !== 'webPage') throw new Error('merged-forward preview is not a webpage')
    expect(webpage.description).toBeUndefined()
    expect(JSON.stringify(webpage)).not.toMatch(/转发消息/)
  })

  it('builds the card preview from the archived messages when the bundle has none', async () => {
    const projection = makeMergedForwardProvider()
    const adapter = platform(vi.fn(async () => [{
      id: 'second', senderId: 'bob', timestamp: 200,
      sender: { id: 'bob', firstName: 'Bob' },
      content: { parts: [{ type: 'media' as const, media: { id: 'p', kind: 'image' as const, locator: {} } }] },
    }, {
      id: 'first', senderId: 'alice', timestamp: 100,
      sender: { id: 'alice', firstName: 'Alice' },
      content: { parts: [{ type: 'text' as const, text: '  第一条\n内容 ' }] },
    }]))
    const value = input(adapter)
    value.draft.source = {
      ...value.draft.source,
      content: { parts: [{ type: 'message-bundle', bundle: { ...bundle, id: 'bundle:bare', preview: undefined } }] },
    }
    await projection.project(value, async () => ({
      message: { _: 'message', id: value.tlMessageId, peerId: value.target.peer, date: 1, message: '' },
      chats: value.draft.chats,
    }))
    expect(value.draft.media).toMatchObject({
      webpage: { description: 'Alice: 第一条 内容\nBob: [图片]' },
    })
  })

  it('renders at most four archived lines in sender order of time', () => {
    const snapshots = Array.from({ length: 6 }, (_, index) => ({
      id: `m${index}`, senderId: `u${index}`, timestamp: 10 - index,
      content: { parts: [{ type: 'text' as const, text: `t${index}` }] },
    }))
    expect(snapshotPreview(snapshots)).toBe('u5: t5\nu4: t4\nu3: t3\nu2: t2')
    expect(snapshotPreview([])).toBeUndefined()
    expect(snapshotPreview([{
      id: 'empty', senderId: 'x', timestamp: 1, content: { parts: [{ type: 'text', text: '  ' }] },
    }])).toBeUndefined()
  })
})
