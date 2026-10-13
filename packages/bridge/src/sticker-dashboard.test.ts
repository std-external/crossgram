import { describe, expect, it, vi } from 'vitest'
import {
  canSendStickerPacks, collectStickerDashboard, providerBelongsToAccount, saveStickerPackToAccount,
  setStickerPackAssignment, STICKER_PACK_SAVE_LIMIT, STICKER_PACK_SAVE_UNSUPPORTED_MESSAGE,
} from './sticker-dashboard.js'
import type { IMStickerProvider, StickerProviderRegistry } from './sticker-provider.js'
import type { PlatformCapabilities, PlatformSession } from './platform.js'

const qqSession = {
  platformId: 'qq/primary', platformSessionId: 'qq-session', userId: '10001', credentials: {}, metadata: {},
} as PlatformSession
const staticSession = {
  platformId: 'static/demo', platformSessionId: 'static-session', userId: 'demo', credentials: {}, metadata: {},
} as PlatformSession
const staticCapabilities = {
  history: true,
  send: { text: true, images: true, files: true, mixed: true, maxTextLength: 4096, maxMedia: 9 },
  conversations: { groups: true, channels: false, subchannels: false },
  stickers: { native: true, upload: true, formats: ['static', 'animated', 'video'] as const },
} as unknown as PlatformCapabilities
const qqCapabilities = {
  history: true,
  send: { text: true, images: true, files: true, mixed: true, maxTextLength: 20_000, maxMedia: 9 },
  conversations: { groups: true, channels: false, subchannels: false },
  // QQNT sends only native stickers, so another account's pack has no way out.
  stickers: { native: true, upload: false, formats: ['static', 'animated', 'video'] as const },
} as unknown as PlatformCapabilities

describe('Bridge sticker pack dashboard', () => {
  it('lists the global catalog, preserves manual assignments, and locks QQ favorites to their owner', async () => {
    const qqProvider = provider('qq/primary', [
      { providerId: 'ignored', packId: 'qq-favorites', title: 'QQ 收藏表情', automaticAssociation: 'provider-account' },
      { providerId: 'ignored', packId: 'market-1', title: 'QQ 商店包', count: 24 },
    ])
    const staticProvider = provider('static/demo', [
      { providerId: 'ignored', packId: 'stars', title: 'Stars', count: 2 },
    ], 'static')
    const registry = stickerRegistry([
      ['qq/primary:stickers', qqProvider],
      ['static/demo:stickers', staticProvider],
    ])
    const rows = [{
      platformSessionId: 'static-session', providerId: 'qq/primary:stickers', providerPackId: 'market-1',
      installedAt: new Date(), sortOrder: 0, archived: false, uninstalled: false,
    }]
    const database = { get: vi.fn(async () => rows) }

    const result = await collectStickerDashboard(database as never, registry, [
      source(qqSession, 'qq', 'QQ Alice', qqCapabilities),
      source(staticSession, 'static', 'Static Demo', staticCapabilities),
    ])

    expect(result.accounts.map(account => account.displayName)).toEqual(['QQ Alice', 'Static Demo'])
    expect(result.packs).toHaveLength(3)
    const favorites = result.packs.find(pack => pack.packId === 'qq-favorites')!
    expect(favorites.sourcePlatformId).toBe('qq/primary')
    expect(favorites.assignments).toEqual([
      { platformSessionId: 'qq-session', automatic: true, assigned: true, sendable: true, saveable: false },
      // A platform that uploads sticker assets can send any provider's pack.
      { platformSessionId: 'static-session', automatic: false, assigned: false, sendable: true, saveable: false },
    ])
    expect(result.packs.find(pack => pack.packId === 'market-1')!.assignments).toEqual([
      { platformSessionId: 'qq-session', automatic: false, assigned: false, sendable: true, saveable: false },
      { platformSessionId: 'static-session', automatic: false, assigned: true, sendable: true, saveable: false },
    ])
    expect(qqProvider.listPacks).toHaveBeenCalledWith(
      expect.objectContaining({ session: qqSession, platformKind: 'qq' }),
      { cursor: undefined, limit: 200 },
    )
  })

  it('refuses to offer another QQ account a pack this account could never send', async () => {
    const primaryProvider = provider('qq/primary', [
      { providerId: 'ignored', packId: 'market-1', title: 'QQ 商店包', count: 24 },
    ])
    const secondaryProvider = provider('qq/secondary', [
      { providerId: 'ignored', packId: 'market-1', title: 'QQ 商店包', count: 24 },
    ])
    const registry = stickerRegistry([
      ['qq/primary:stickers', primaryProvider],
      ['qq/secondary:stickers', secondaryProvider],
    ])
    const secondarySession = {
      platformId: 'qq/secondary', platformSessionId: 'qq-second-session', userId: '10002',
      credentials: {}, metadata: {},
    } as PlatformSession
    // A dashboard from before the send path was checked may have written this
    // row; the account must still learn from the assignment that QQ cannot send
    // a collection which belongs to another account.
    const rows = [{
      platformSessionId: 'qq-second-session', providerId: 'qq/primary:stickers', providerPackId: 'market-1',
      installedAt: new Date(), sortOrder: 0, archived: false, uninstalled: false,
    }]
    const database = { get: vi.fn(async () => rows) }

    const result = await collectStickerDashboard(database as never, registry, [
      source(qqSession, 'qq', 'QQ Alice', qqCapabilities),
      source(secondarySession, 'qq', 'QQ Bob', qqCapabilities),
    ])

    const primaryPack = result.packs.find(pack => pack.providerId === 'qq/primary:stickers')!
    expect(primaryPack.assignments).toEqual([
      { platformSessionId: 'qq-session', automatic: false, assigned: false, sendable: true, saveable: false },
      { platformSessionId: 'qq-second-session', automatic: false, assigned: true, sendable: false, saveable: false },
    ])
    const ownPack = result.packs.find(pack => pack.providerId === 'qq/secondary:stickers')!
    expect(ownPack.assignments[1]).toEqual({
      platformSessionId: 'qq-second-session', automatic: false, assigned: false, sendable: true,
      saveable: false,
    })
  })

  it('decides sendability from the target platform capabilities and provider ownership', () => {
    const qqProvider = provider('qq/primary', [])
    const sharedProvider: IMStickerProvider = {
      // A platform-independent provider (an imported or company collection)
      // has no native expression on any account.
      listPacks: vi.fn(async () => ({ packs: [] })),
      getPack: vi.fn(async () => null),
      getSticker: vi.fn(async () => null),
      openAsset: vi.fn(async () => { throw new Error('not used') }),
    }

    expect(canSendStickerPacks(qqProvider, {
      platformId: 'qq/primary', platformKind: 'qq', capabilities: qqCapabilities,
    })).toBe(true)
    expect(canSendStickerPacks(qqProvider, {
      platformId: 'qq/secondary', platformKind: 'qq', capabilities: qqCapabilities,
    })).toBe(false)
    expect(canSendStickerPacks(qqProvider, {
      platformId: 'static/demo', platformKind: 'static', capabilities: staticCapabilities,
    })).toBe(true)
    expect(canSendStickerPacks(sharedProvider, {
      platformId: 'qq/primary', platformKind: 'qq', capabilities: qqCapabilities,
    })).toBe(false)
    expect(canSendStickerPacks(sharedProvider, {
      platformId: 'static/demo', platformKind: 'static', capabilities: staticCapabilities,
    })).toBe(true)
  })

  it('reports which accounts can mirror a foreign pack into their own collection', async () => {
    const sourceProvider = provider('qq/primary', [
      { providerId: 'ignored', packId: 'market-1', title: 'QQ 商店包', count: 2 },
    ], 'qq')
    const collector = saver('qq/secondary')
    const registry = stickerRegistry([
      ['qq/primary:stickers', sourceProvider],
      ['qq/secondary:stickers', collector.provider],
      ['static/demo:stickers', provider('static/demo', [], 'static')],
    ])
    const secondarySession = {
      platformId: 'qq/secondary', platformSessionId: 'qq-second-session', userId: '10002',
      credentials: {}, metadata: {},
    } as PlatformSession
    const database = { get: vi.fn(async () => []) }

    const result = await collectStickerDashboard(database as never, registry, [
      source(qqSession, 'qq', 'QQ Alice', qqCapabilities),
      source(secondarySession, 'qq', 'QQ Bob', qqCapabilities),
      source(staticSession, 'static', 'Static Demo', staticCapabilities),
    ])

    // Only the account whose own provider implements saveStickers() can collect
    // a pack another account exposes.
    expect(result.packs.find(pack => pack.providerId === 'qq/primary:stickers')!.assignments)
      .toEqual([
        { platformSessionId: 'qq-session', automatic: false, assigned: false, sendable: true, saveable: false },
        {
          platformSessionId: 'qq-second-session', automatic: false, assigned: false, sendable: false,
          saveable: true,
        },
        {
          platformSessionId: 'static-session', automatic: false, assigned: false, sendable: true,
          saveable: false,
        },
      ])
  })

  it('mirrors a pack through the collection of the account that collects it', async () => {
    const stickers = [
      { providerId: 'qq/primary:stickers', stickerId: 'market:11690:a', packId: '11690', format: 'static' as const, mimeType: 'image/png' },
      { providerId: 'qq/primary:stickers', stickerId: 'market:11690:b', packId: '11690', format: 'static' as const, mimeType: 'image/png' },
    ]
    const sourceProvider = provider('qq/primary', [
      { providerId: 'ignored', packId: 'market-1', title: 'QQ 商店包', count: 2 },
    ], 'qq')
    sourceProvider.getPack = vi.fn(async () => ({
      providerId: 'qq/primary:stickers', packId: 'market-1', title: 'QQ 商店包', stickers,
    }))
    const collector = saver('qq/secondary')
    const registry = stickerRegistry([
      ['qq/primary:stickers', sourceProvider],
      ['qq/secondary:stickers', collector.provider],
    ])
    const secondarySession = {
      platformId: 'qq/secondary', platformSessionId: 'qq-second-session', userId: '10002',
      credentials: {}, metadata: {},
    } as PlatformSession
    const sourceAccount = source(qqSession, 'qq', 'QQ Alice', qqCapabilities)

    const result = await saveStickerPackToAccount(registry, {
      providerId: 'qq/primary:stickers',
      packId: 'market-1',
      source: sourceAccount,
      account: source(secondarySession, 'qq', 'QQ Bob', qqCapabilities),
    })

    expect(result).toEqual({
      saverProviderId: 'qq/secondary:stickers',
      summary: { saved: 2, skipped: 0, failed: 0, remaining: 0 },
    })
    expect(collector.saveStickers).toHaveBeenCalledWith(
      { session: secondarySession, platformKind: 'qq' },
      stickers,
      { limit: STICKER_PACK_SAVE_LIMIT },
    )
  })

  it('refuses to mirror a pack into an account whose platform cannot collect', async () => {
    const registry = stickerRegistry([['qq/primary:stickers', provider('qq/primary', [])]])

    await expect(saveStickerPackToAccount(registry, {
      providerId: 'qq/primary:stickers',
      packId: 'market-1',
      source: source(qqSession, 'qq', 'QQ Alice', qqCapabilities),
      account: source(staticSession, 'static', 'Static Demo', staticCapabilities),
    })).rejects.toThrow(STICKER_PACK_SAVE_UNSUPPORTED_MESSAGE)

    await expect(saveStickerPackToAccount(registry, {
      providerId: 'missing:stickers',
      packId: 'market-1',
      source: source(qqSession, 'qq', 'QQ Alice', qqCapabilities),
      account: source(qqSession, 'qq', 'QQ Alice', qqCapabilities),
    })).rejects.toThrow('表情包不存在，请刷新后重试。')
  })

  it('loads every provider page and rejects repeated cursors', async () => {
    const paged = provider('qq/primary', [])
    vi.mocked(paged.listPacks)
      .mockResolvedValueOnce({
        packs: [{ providerId: 'ignored', packId: 'one', title: 'One' }], nextCursor: 'next',
      })
      .mockResolvedValueOnce({ packs: [{ providerId: 'ignored', packId: 'two', title: 'Two' }] })
    const database = { get: vi.fn(async () => []) }
    const accounts = [source(qqSession, 'qq', 'QQ Alice')]

    await expect(collectStickerDashboard(
      database as never, stickerRegistry([['qq:stickers', paged]]), accounts,
    )).resolves.toMatchObject({ packs: [{ packId: 'one' }, { packId: 'two' }] })

    const broken = provider('qq/primary', [])
    vi.mocked(broken.listPacks).mockResolvedValue({ packs: [], nextCursor: 'same' })
    await expect(collectStickerDashboard(
      database as never, stickerRegistry([['broken', broken]]), accounts,
    )).rejects.toThrow('sticker pack pagination repeated cursor: same')
  })

  it('upserts bridge-local account assignments without invoking a provider', async () => {
    const rows: Array<Record<string, any>> = []
    const database = {
      get: vi.fn(async (_table: string, query: Record<string, unknown>) => rows.filter(row =>
        Object.entries(query).every(([key, value]) => row[key] === value))),
      upsert: vi.fn(async (_table: string, values: Array<Record<string, any>>) => {
        const value = values[0]!
        const existing = rows.find(row => row.platformSessionId === value.platformSessionId
          && row.providerId === value.providerId && row.providerPackId === value.providerPackId)
        if (existing) Object.assign(existing, value)
        else rows.push({ id: rows.length + 1, ...value })
      }),
    }

    await setStickerPackAssignment(database as never, 'target', 'provider', 'pack', true)
    expect(rows).toMatchObject([{
      platformSessionId: 'target', providerId: 'provider', providerPackId: 'pack',
      sortOrder: 0, archived: false, uninstalled: false,
    }])
    await setStickerPackAssignment(database as never, 'target', 'provider', 'pack', false)
    expect(rows[0]).toMatchObject({ uninstalled: true })
  })

  it('distinguishes an owned provider from a foreign provider with the same platform kind', () => {
    const owned = provider('qq/primary', [])
    expect(providerBelongsToAccount(owned, 'qq/primary', 'qq')).toBe(true)
    expect(providerBelongsToAccount(owned, 'qq/secondary', 'qq')).toBe(false)
  })
})

function provider(
  ownerPlatformId: string,
  packs: Awaited<ReturnType<IMStickerProvider['listPacks']>>['packs'],
  kind = 'qq',
): IMStickerProvider {
  return {
    capabilities: { platformKinds: [kind], ownerPlatformId, sessionScoped: true },
    listPacks: vi.fn(async () => ({ packs })),
    getPack: vi.fn(async () => null),
    getSticker: vi.fn(async () => null),
    openAsset: vi.fn(async () => { throw new Error('not used') }),
    prepareSend: vi.fn(async () => null),
  }
}

/** A provider of a platform that can mirror packs into its own collection. */
function saver(ownerPlatformId: string, kind = 'qq') {
  const saveStickers = vi.fn(async (
    _context: unknown,
    stickers: readonly unknown[],
    _options?: unknown,
  ) => ({ saved: stickers.length, skipped: 0, failed: 0, remaining: 0 }))
  return { saveStickers, provider: { ...provider(ownerPlatformId, [], kind), saveStickers } as IMStickerProvider }
}

function stickerRegistry(entries: Array<[string, IMStickerProvider]>): StickerProviderRegistry {
  return {
    entries,
    get: (id: string) => entries.find(([providerId]) => providerId === id)?.[1],
  } as unknown as StickerProviderRegistry
}

function source(
  session: PlatformSession,
  platformKind: string,
  displayName: string,
  capabilities?: PlatformCapabilities,
) {
  return {
    session,
    capabilities,
    view: {
      platformId: session.platformId,
      platformSessionId: session.platformSessionId,
      platformKind,
      displayName,
      userId: session.userId,
    },
  }
}
