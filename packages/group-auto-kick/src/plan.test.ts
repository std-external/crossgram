import { describe, expect, it } from 'vitest'
import type { IMConversationMember, IMUser } from '@mtproto-relay/bridge'
import {
  conversationIdMatches,
  kickBudget,
  planKicks,
  rankSilentMembers,
  telegramChannelId,
  telegramChannelIdFor,
  type KickCandidate,
} from './plan.js'

const GROUP_CODE = '1002974327'

function member(id: string, role: IMConversationMember['role'] = 'member', name = id): IMConversationMember<unknown> {
  const user: IMUser<unknown> = { id, firstName: name, username: id.replace('u_', '') }
  return {
    user,
    role,
    permissions: {
      manageConversation: false, manageMembers: false, deleteAnyMessage: false,
      editAnyMessage: false, pinMessages: false, inviteMembers: false,
    },
  }
}

describe('telegramChannelId', () => {
  it('decodes the -100 channel prefix', () => {
    expect(telegramChannelId('-1000371852035')).toBe(371852035)
    expect(telegramChannelId('-1000000000001')).toBe(1)
    expect(telegramChannelId(String(-1_000_000_000_000 - telegramChannelIdFor('session', GROUP_CODE))))
      .toBe(telegramChannelIdFor('session', GROUP_CODE))
  })

  it('rejects ids that are not channel chat ids', () => {
    expect(telegramChannelId('1002974327')).toBeUndefined()
    expect(telegramChannelId('-100')).toBeUndefined()
    expect(telegramChannelId('-1000000000000')).toBeUndefined()
    expect(telegramChannelId('not-a-number')).toBeUndefined()
    expect(telegramChannelId('')).toBeUndefined()
  })
})

describe('conversationIdMatches', () => {
  it('accepts the platform conversation id', () => {
    expect(conversationIdMatches(GROUP_CODE, 'session', GROUP_CODE)).toBe(true)
    expect(conversationIdMatches(Number(GROUP_CODE), 'session', GROUP_CODE)).toBe(true)
    expect(conversationIdMatches(' 1002974327 ', 'session', GROUP_CODE)).toBe(true)
  })

  it('accepts the projected Telegram chat id', () => {
    const chatId = String(-1_000_000_000_000 - telegramChannelIdFor('session', GROUP_CODE))
    expect(chatId).toBe('-1001533512023')
    expect(conversationIdMatches(chatId, 'session', GROUP_CODE)).toBe(true)
    expect(conversationIdMatches(Number(chatId), 'session', GROUP_CODE)).toBe(true)
  })

  it('rejects other groups', () => {
    expect(conversationIdMatches('1053846443', 'session', GROUP_CODE)).toBe(false)
    expect(conversationIdMatches('-1001111111111', 'session', GROUP_CODE)).toBe(false)
    expect(conversationIdMatches('', 'session', GROUP_CODE)).toBe(false)
    expect(conversationIdMatches(GROUP_CODE, 'session', '')).toBe(false)
  })
})

describe('rankSilentMembers', () => {
  it('orders members by the oldest silence and puts never-seen members first', () => {
    const ranked = rankSilentMembers(
      [member('u_speaker'), member('u_quiet'), member('u_silent'), member('u_recent')],
      new Map([['u_speaker', 1_700_000_000], ['u_recent', 1_800_000_000], ['u_quiet', 1_650_000_000]]),
    )

    expect(ranked.map((item) => item.userId)).toEqual(['u_silent', 'u_quiet', 'u_speaker', 'u_recent'])
    expect(ranked[0]).toMatchObject({ lastSpokeAt: 0, account: 'silent', role: 'member' })
  })

  it('protects the owner, administrators and the logged-in account', () => {
    const ranked = rankSilentMembers(
      [member('u_owner', 'owner'), member('u_admin', 'administrator'), member('u_self'), member('u_member')],
      new Map(),
      { selfUserId: 'u_self' },
    )

    expect(ranked.map((item) => item.userId)).toEqual(['u_member'])
  })

  it('can target administrators when protection is disabled', () => {
    const ranked = rankSilentMembers(
      [member('u_owner', 'owner'), member('u_admin', 'administrator'), member('u_member')],
      new Map(),
      { protectAdministrators: false },
    )

    expect(ranked.map((item) => item.userId)).toEqual(['u_admin', 'u_member'])
  })

  it('breaks ties deterministically', () => {
    const ranked = rankSilentMembers([member('u_b'), member('u_a')], new Map())
    expect(ranked.map((item) => item.userId)).toEqual(['u_a', 'u_b'])
  })

  it('can rank members the relay never saw speak last', () => {
    const ranked = rankSilentMembers(
      [member('u_silent'), member('u_old'), member('u_new')],
      new Map([['u_old', 1_700_000_000], ['u_new', 1_800_000_000]]),
      { unknownLastSpoke: 'newest' },
    )

    expect(ranked.map((item) => [item.userId, item.lastSpokeAt]))
      .toEqual([['u_old', 1_700_000_000], ['u_new', 1_800_000_000], ['u_silent', 0]])
  })
})

describe('kickBudget', () => {
  it('removes exactly the overflow above the target', () => {
    expect(kickBudget({ total: 2000, targetMembers: 1995, maxKicksPerRound: 10 })).toBe(5)
  })

  it('does nothing when the group is at or below the target', () => {
    expect(kickBudget({ total: 1995, targetMembers: 1995, maxKicksPerRound: 10 })).toBe(0)
    expect(kickBudget({ total: 1900, targetMembers: 1995, maxKicksPerRound: 10 })).toBe(0)
  })

  it('honours the per-round cap', () => {
    expect(kickBudget({ total: 2000, targetMembers: 1900, maxKicksPerRound: 3 })).toBe(3)
    expect(kickBudget({ total: 2000, targetMembers: 1995, maxKicksPerRound: 0 })).toBe(0)
  })
})

describe('planKicks', () => {
  const ranked: KickCandidate[] = [
    { userId: 'u_1', name: '1', role: 'member', lastSpokeAt: 0 },
    { userId: 'u_2', name: '2', role: 'member', lastSpokeAt: 0 },
    { userId: 'u_3', name: '3', role: 'member', lastSpokeAt: 0 },
  ]

  it('takes the oldest silences up to the budget', () => {
    expect(planKicks(ranked, { total: 2000, targetMembers: 1998, maxKicksPerRound: 10 })
      .map((item) => item.userId)).toEqual(['u_1', 'u_2'])
  })

  it('never plans more members than it ranked', () => {
    expect(planKicks(ranked, { total: 2000, targetMembers: 1900, maxKicksPerRound: 10 }))
      .toHaveLength(3)
  })
})
