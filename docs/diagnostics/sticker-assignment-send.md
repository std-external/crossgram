# Sticker packs assigned across accounts showed up but could not be sent (2026-10-13)

## Symptom

A sticker pack that one account had installed was linked to another account in the WebUI
(**Sticker collections → Assign to account → Add to account**). The target account's Telegram client then
listed the whole pack — every cell rendered, previews loaded — but tapping any sticker failed to send.

## Root cause

The assignment only decided *visibility*; the account that could send the pack never changed.

1. `setStickerPackAssignment()` (`packages/bridge/src/sticker-dashboard.ts`) writes one
   `mtproto_sticker_set_install` row for the target session, keyed by `(platformSessionId, providerId,
   providerPackId)`.
2. `StickerRpc.getAllStickers()` (`packages/bridge/src/sticker-rpc.ts`) lists every provider's packs and
   keeps those with an install row for the session, so the target account's catalog contained the **other
   account's provider** pack. The documents it projected came from that provider's client
   (`QQStickerProvider.getPack()` ignores its `StickerContext`), which is why previews and downloads worked.
3. `StickerRpc.resolveSend()` only asks the account's own provider for a native plan
   (`_providerBelongsToCurrentAccount()`), and falls back to an asset upload for every other provider. The
   cross-account pack therefore became an `upload` plan — the behaviour
   `packages/bridge/src/sticker-rpc.test.ts` ("uses an upload plan … across QQ accounts") pins down.
4. QQNT declares `capabilities.stickers = { native: true, upload: false }`
   (`packages/platform-crossgram/src/index.ts`), so `DialogRpc._assertSendableMedia()`
   (`packages/bridge/src/dialogs.ts`) rejected the send with
   `400 STICKER_SEND_UNAVAILABLE` before the platform was ever called. Without that guard the adapter would
   have thrown `QQNT only accepts native QQ sticker send plans` instead.

So the pack was never broken on the QQ side and no `file_reference`/`access_hash` was missing: the relay
simply offered an assignment whose send path its own platform capabilities refuse. The same shape hit any
pack owned by a session-scoped provider that a native-only account tried to use, including the
`qq-favorites` set of another QQ account.

## Fix

- `packages/bridge/src/sticker-dashboard.ts`: new `canSendStickerPacks(provider, target)` rule —
  a pack is sendable when the platform uploads sticker assets, or when the pack belongs to the account's own
  provider and that provider can express a native plan. `collectStickerDashboard()` reports it per account as
  `StickerDashboardAssignment.sendable`, and refuses nothing itself (the callers do).
- `packages/bridge/src/index.ts`: both assignment handlers (WebUI dashboard and `BridgeManagementService`,
  which the admin bot uses) reject enabling an assignment that is not sendable
  (`STICKER_PACK_UNSENDABLE`), while removal stays possible.
- `packages/bridge/src/sticker-rpc.ts`: `_listPackSummaries()` skips providers this session's platform can
  never send, both for the provider catalog and for persisted install rows. Existing rows written by an older
  dashboard therefore stop projecting a dead pack, and the client loses it on its next catalog refresh — no
  data migration is needed, and nothing is deleted.
- `packages/bridge/client/stickers.tsx`: the sticker page disables "Add to account" for such an account
  ("Cannot send on this account"), marks the card with a "Cannot send here" chip, and still allows removing an
  assignment that already exists.
- `docs/IM_PLATFORM.zh.md`: the send-plan section now states the rule.

## Verification

- `packages/bridge/src/sticker-send-capability.test.ts` (new): sends a cross-account sticker document through
  the real `DialogRpc.sendMedia` path on a QQNT-shaped platform and asserts `400 STICKER_SEND_UNAVAILABLE`
  with the platform never called — the reported symptom; plus the catalog assertion that the pack is never
  projected.
- `packages/bridge/src/sticker-rpc.test.ts`: a foreign provider's install row yields an empty
  `getAllStickers`/`getStickers` on a native-only platform and the whole pack on a platform that uploads;
  the account-owned pack of a native-only platform stays installed.
- `packages/bridge/src/sticker-dashboard.test.ts`: `sendable` per account for owned, foreign and
  platform-independent providers, and the refusal case (assigned `true` but `sendable` `false`).
- `packages/cordis-webui-solidjs/src/bridge.browser.e2e.test.ts`: the sticker page renders the disabled
  button for a non-sendable account on a phone viewport.
- `packages/test-suite/src/login.e2e.test.ts` (39 tests), the platform-crossgram sticker e2e files and the
  importer e2e pass unchanged; the dashboard assignment helper those tests use goes through the new guard.

## Remaining

- A client that cached the pack before this change keeps its cells until its next `messages.getAllStickers`
  refresh; sending one of them still answers `STICKER_SEND_UNAVAILABLE`.
- Cross-account **native** sends are deliberately not implemented. QQ market faces are global and could be
  sent from another account's reference, but `qq-favorites` ids are account-scoped, and the bridge would have
  to trust a foreign provider's reference on the target account's connection.
- The admin bot's sticker screen still offers the toggle for a non-sendable account; the shared management
  handler rejects it with `STICKER_PACK_UNSENDABLE` and the refusal message.
