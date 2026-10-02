import { describe, expect, it } from 'vitest'
import type { tl } from '@mtcute/core'
import { __tlReaderMap, __tlWriterMap } from '@mtcute/core/utils.js'
import { TlBinaryReader, TlBinaryWriter } from '@mtcute/tl-runtime'
import { isBareVector } from '@mtproto-relay/mtproto'
import { startupRpcHandlers } from './startup.js'

function roundTrip(object: tl.TlObject): tl.TlObject {
  const bytes = TlBinaryWriter.serializeObject(__tlWriterMap, object)
  return new TlBinaryReader(__tlReaderMap, bytes).object() as tl.TlObject
}

describe('post-login startup responses', () => {
  it('covers every optional RPC repeatedly requested by Telegram Desktop', () => {
    expect(Object.keys(startupRpcHandlers).sort()).toEqual([
      'account.getCollectibleEmojiStatuses',
      'account.getContentSettings',
      'account.getDefaultEmojiStatuses',
      'account.getReactionsNotifySettings',
      'aicompose.getTones',
      'communities.getJoinedCommunities',
      'help.getCountriesList',
      'help.getPeerColors',
      'help.getPeerProfileColors',
      'help.getPremiumPromo',
      'help.getPromoData',
      'help.getTermsOfServiceUpdate',
      'langpack.getLangPack',
      'langpack.getLanguage',
      'langpack.getStrings',
      'messages.getEmojiGroups',
      'messages.getEmojiStickerGroups',
      'messages.getFeaturedEmojiStickers',
      'messages.getFeaturedStickers',
      'messages.getPaidReactionPrivacy',
      'messages.getPinnedSavedDialogs',
      'messages.getSavedGifs',
      'messages.getSavedReactionTags',
      'payments.getStarGiftActiveAuctions',
      'payments.getStarsStatus',
      'payments.getStarsTopupOptions',
      'stories.getAllStories',
      'stories.getStoriesArchive',
    ])
  })

  it.each(Object.entries(startupRpcHandlers))('%s returns a serializable non-error TL object', (_method, handler) => {
    const response = handler()
    expect(response._).not.toBe('mt_rpc_error')
    if (isBareVector(response)) {
      expect(response.items).toEqual([])
      return
    }
    expect(roundTrip(response)._).toBe(response._)
  })
})
