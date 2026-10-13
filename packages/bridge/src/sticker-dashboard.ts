import type { Database } from '@cordisjs/plugin-database'
import type { PlatformCapabilities, PlatformSession } from './platform.js'
import type {
  IMStickerPackSummary, IMStickerProvider, IMStickerSaveSummary,
  StickerProviderContext, StickerProviderRegistry,
} from './sticker-provider.js'

import type { StickerDashboardAccount, StickerDashboardPack } from './dashboard-types.js'
export type {
  StickerDashboardAccount, StickerDashboardAssignment, StickerDashboardPack,
  StickerPackDashboardData, StickerPackSaveResult,
} from './dashboard-types.js'

export interface StickerDashboardSourceAccount {
  view: StickerDashboardAccount
  session: PlatformSession
  /** Target platform capabilities, needed to tell whether an assignment can be sent. */
  capabilities?: PlatformCapabilities
}

/**
 * Whether an account can ever send the stickers of a provider's packs.
 *
 * The bridge asks only the account's own provider for a native send plan and
 * uploads the asset for every other provider, so a platform without sticker
 * uploads can only send the collections it owns itself. This mirrors the rule
 * `DialogRpc` enforces with `STICKER_SEND_UNAVAILABLE`, evaluated before the
 * dashboard offers an assignment and before a session projects its catalog.
 */
export function canSendStickerPacks(
  provider: IMStickerProvider,
  target: { platformId: string, platformKind: string, capabilities?: PlatformCapabilities },
): boolean {
  const stickers = target.capabilities?.stickers
  if (stickers?.upload) return true
  if (!stickers?.native) return false
  return providerBelongsToAccount(provider, target.platformId, target.platformKind)
    && typeof provider.prepareSend === 'function'
}

/** Refusal message for linking a pack the target account can never send. */
export const STICKER_PACK_UNSENDABLE_MESSAGE =
  '该账号无法发送这个表情包，请改用来自该账号自己的表情包。'

/** Refusal message for saving a pack into an account that cannot collect it. */
export const STICKER_PACK_SAVE_UNSUPPORTED_MESSAGE =
  '该账号的平台没有收藏表情包的能力，请在该账号自己的客户端里收藏。'

/**
 * How many stickers one save request mirrors. Every sticker is a native
 * platform write that can hold QQ's serialized download slot for up to half a
 * minute, so the request is bounded by count and by time, and reports what is
 * left for the next one.
 */
export const STICKER_PACK_SAVE_LIMIT = 25

/**
 * The provider that can write to an account's own native collection. Only a
 * provider the account owns may touch it, and only platforms that implement
 * `saveStickers()` have such a collection at all.
 */
export function accountStickerSaver(
  registry: StickerProviderRegistry,
  account: { platformId: string, platformKind: string },
): [string, IMStickerProvider] | undefined {
  return registry.entries.find(([, provider]) =>
    providerBelongsToAccount(provider, account.platformId, account.platformKind)
    && typeof provider.saveStickers === 'function')
}

/**
 * Mirrors one pack into an account's own collection, so the account can send
 * those stickers itself instead of depending on the source account.
 */
export async function saveStickerPackToAccount(
  registry: StickerProviderRegistry,
  input: {
    providerId: string
    packId: string
    source: StickerDashboardSourceAccount
    account: StickerDashboardSourceAccount
    limit?: number
  },
): Promise<{ saverProviderId: string, summary: IMStickerSaveSummary }> {
  const source = registry.get(input.providerId)
  if (!source) throw new Error('表情包不存在，请刷新后重试。')
  const saver = accountStickerSaver(registry, {
    platformId: input.account.view.platformId,
    platformKind: input.account.view.platformKind,
  })
  if (!saver) throw new Error(STICKER_PACK_SAVE_UNSUPPORTED_MESSAGE)
  const pack = await source.getPack(providerContext(input.source), input.packId)
  if (!pack) throw new Error('表情包不存在，请刷新后重试。')
  // The pack is read through the account that exposes it and written through
  // the account that collects it: each provider sees its own session.
  const summary = await saver[1].saveStickers!(
    providerContext(input.account),
    pack.stickers,
    { limit: input.limit ?? STICKER_PACK_SAVE_LIMIT },
  )
  return { saverProviderId: saver[0], summary }
}

export async function collectStickerDashboard(
  database: Database,
  registry: StickerProviderRegistry,
  accounts: StickerDashboardSourceAccount[],
): Promise<{ accounts: StickerDashboardAccount[], packs: StickerDashboardPack[] }> {
  const rows = await database.get('mtproto_sticker_set_install', {})
  const rowByKey = new Map(rows.map((row) => [
    assignmentKey(row.platformSessionId, row.providerId, row.providerPackId), row,
  ]))
  const packs: StickerDashboardPack[] = []

  for (const [providerId, provider] of registry.entries) {
    const source = sourceAccount(provider, accounts)
    if (!source) continue
    for (const pack of await listEveryPack(provider, providerContext(source))) {
      packs.push({
        providerId,
        packId: pack.packId,
        title: pack.title,
        count: pack.count,
        version: pack.version,
        sourcePlatformId: source.view.platformId,
        sourcePlatformSessionId: source.view.platformSessionId,
        assignments: accounts.map(({ view, capabilities }) => {
          const automatic = isAutomaticallyAssociated(provider, pack, view.platformId)
          const row = rowByKey.get(assignmentKey(view.platformSessionId, providerId, pack.packId))
          return {
            platformSessionId: view.platformSessionId,
            automatic,
            assigned: automatic || !!row && !row.uninstalled,
            sendable: canSendStickerPacks(provider, {
              platformId: view.platformId, platformKind: view.platformKind, capabilities,
            }),
            // The account can mirror this pack into the platform collection it
            // owns, which is how a pack it cannot send still becomes sendable.
            saveable: !!accountStickerSaver(registry, {
              platformId: view.platformId, platformKind: view.platformKind,
            }),
          }
        }),
      })
    }
  }

  packs.sort((left, right) => left.title.localeCompare(right.title, 'zh-CN')
    || left.providerId.localeCompare(right.providerId)
    || left.packId.localeCompare(right.packId))
  return { accounts: accounts.map(({ view }) => view), packs }
}

export async function setStickerPackAssignment(
  database: Database,
  platformSessionId: string,
  providerId: string,
  providerPackId: string,
  assigned: boolean,
): Promise<void> {
  const query = { platformSessionId, providerId, providerPackId }
  const [existing] = await database.get('mtproto_sticker_set_install', query)
  if (!assigned && !existing) return
  const rows = assigned
    ? await database.get('mtproto_sticker_set_install', { platformSessionId })
    : []
  const sortOrder = existing?.sortOrder
    ?? rows.reduce((maximum, row) => Math.max(maximum, row.sortOrder), -1) + 1
  await database.upsert('mtproto_sticker_set_install', [{
    ...query,
    installedAt: existing?.installedAt ?? new Date(),
    sortOrder,
    archived: false,
    uninstalled: !assigned,
  }], ['platformSessionId', 'providerId', 'providerPackId'])
}

export function isAutomaticallyAssociated(
  provider: IMStickerProvider,
  pack: IMStickerPackSummary,
  targetPlatformId: string,
): boolean {
  return pack.automaticAssociation === 'provider-account'
    && provider.capabilities?.ownerPlatformId === targetPlatformId
}

export function providerBelongsToAccount(
  provider: IMStickerProvider,
  targetPlatformId: string,
  targetPlatformKind: string,
): boolean {
  const owner = provider.capabilities?.ownerPlatformId
  if (owner) return owner === targetPlatformId
  const kinds = provider.capabilities?.platformKinds
  return !kinds?.length || kinds.includes(targetPlatformKind)
}

function sourceAccount(
  provider: IMStickerProvider,
  accounts: StickerDashboardSourceAccount[],
): StickerDashboardSourceAccount | undefined {
  const owner = provider.capabilities?.ownerPlatformId
  if (owner) return accounts.find((account) => account.view.platformId === owner)
  const kinds = provider.capabilities?.platformKinds
  return accounts.find((account) => !kinds?.length || kinds.includes(account.view.platformKind))
}

function providerContext(account: StickerDashboardSourceAccount): StickerProviderContext {
  return { session: account.session, platformKind: account.view.platformKind }
}

async function listEveryPack(
  provider: IMStickerProvider,
  context: StickerProviderContext,
): Promise<IMStickerPackSummary[]> {
  const result: IMStickerPackSummary[] = []
  const seen = new Set<string>()
  let cursor: string | undefined
  for (let page = 0; page < 100; page++) {
    const response = await provider.listPacks(context, { cursor, limit: 200 })
    result.push(...response.packs)
    if (!response.nextCursor) return result
    if (seen.has(response.nextCursor)) throw new Error(`sticker pack pagination repeated cursor: ${response.nextCursor}`)
    seen.add(response.nextCursor)
    cursor = response.nextCursor
  }
  throw new Error('sticker pack pagination exceeded 100 pages')
}

function assignmentKey(platformSessionId: string, providerId: string, packId: string): string {
  return JSON.stringify([platformSessionId, providerId, packId])
}
