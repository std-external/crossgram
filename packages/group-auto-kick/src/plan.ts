import type { IMConversationMember, IMConversationRole, IMUser } from '@mtproto-relay/bridge'
import { stableId } from '@mtproto-relay/bridge'

/**
 * Telegram renders a channel as a chat whose id is `-100` followed by the
 * channel id. The bridge allocates that channel id from the platform
 * conversation id, so a configured Telegram chat id can be matched back by
 * recomputing {@link stableId} for every stored conversation.
 */
export const TELEGRAM_CHANNEL_OFFSET = 1_000_000_000_000

/** Largest value {@link stableId} can return. */
export const MAX_STABLE_ID = 0x7ffffffe

/** Channel id encoded by a `-100…` Telegram chat id, or undefined for other ids. */
export function telegramChannelId(value: string | number): number | undefined {
  const text = String(value).trim()
  if (!/^-\d+$/u.test(text)) return
  const chatId = Number(text)
  if (!Number.isSafeInteger(chatId) || chatId >= -TELEGRAM_CHANNEL_OFFSET) return
  const channelId = -chatId - TELEGRAM_CHANNEL_OFFSET
  return channelId > 0 && channelId <= MAX_STABLE_ID ? channelId : undefined
}

/** The channel id the bridge exposes for one platform conversation id. */
export function telegramChannelIdFor(platformConversationId: string): number {
  return stableId(`peer:${platformConversationId}`)
}

/**
 * Whether a configured group selector addresses this platform conversation.
 *
 * Both the platform conversation id (`1002974327`, the QQ group code) and the
 * Telegram chat id (`-1000371852035`) are accepted, so a configuration can be
 * written the way the group appears in a Telegram client.
 */
export function conversationIdMatches(
  configured: string | number,
  platformConversationId: string,
): boolean {
  const raw = String(configured).trim()
  if (!raw || !platformConversationId) return false
  if (raw === platformConversationId) return true
  const channelId = telegramChannelId(raw)
  return channelId !== undefined && telegramChannelIdFor(platformConversationId) === channelId
}

export interface KickCandidate {
  userId: string
  /** Display name carried by the member list, used only for logs. */
  name: string
  /** Platform account number (QQ number) when the adapter exposes one. */
  account?: string
  role: IMConversationRole
  /**
   * Unix seconds of the newest message the relay stored for this member in the
   * conversation. `0` means the relay never saw this member speak, which ranks
   * as the longest silence.
   */
  lastSpokeAt: number
}

export interface RankOptions {
  /** Account the bridge itself is logged in as; never a kick target. */
  selfUserId?: string
  /** Administrators are protected by default. The owner always is. */
  protectAdministrators?: boolean
}

/** Members ordered from the longest silence to the most recent speaker. */
export function rankSilentMembers(
  members: readonly IMConversationMember<unknown>[],
  lastSpokeAt: ReadonlyMap<string, number>,
  options: RankOptions = {},
): KickCandidate[] {
  const protectedRoles = new Set<IMConversationRole>(['owner'])
  if (options.protectAdministrators !== false) protectedRoles.add('administrator')
  const ranked: KickCandidate[] = []
  for (const member of members) {
    const userId = member.user?.id
    if (!userId || userId === options.selfUserId) continue
    if (protectedRoles.has(member.role)) continue
    ranked.push({
      userId,
      name: displayName(member.user),
      ...(member.user.username ? { account: member.user.username } : {}),
      role: member.role,
      lastSpokeAt: lastSpokeAt.get(userId) ?? 0,
    })
  }
  return ranked.sort((left, right) =>
    left.lastSpokeAt - right.lastSpokeAt || left.userId.localeCompare(right.userId))
}

export interface KickBudget {
  /** Member count believed to be current. */
  total: number
  /** Count the group is reduced to when it is over capacity. */
  targetMembers: number
  maxKicksPerRound: number
}

/** How many members this round may remove, bounded by the configured cap. */
export function kickBudget(budget: KickBudget): number {
  const wanted = Math.floor(budget.total) - Math.floor(budget.targetMembers)
  if (!Number.isFinite(wanted) || wanted <= 0) return 0
  return Math.max(0, Math.min(wanted, Math.floor(budget.maxKicksPerRound)))
}

/** The members this round removes: the oldest silences first. */
export function planKicks(
  ranked: readonly KickCandidate[],
  budget: KickBudget,
): KickCandidate[] {
  return ranked.slice(0, Math.min(kickBudget(budget), ranked.length))
}

function displayName(user: IMUser<unknown>): string {
  return [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || user.id
}
