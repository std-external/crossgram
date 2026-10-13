# Saving another account's sticker pack into an account (2026-10-13)

Follow-up to [sticker-assignment-send.md](./sticker-assignment-send.md), which removed links the target account
could never send. This records what "让账号收藏这个贴纸包" can and cannot mean in this codebase, because the
WebUI can now trigger it (`Save to this account`).

## What the model has

| layer | "collected" means | code |
| --- | --- | --- |
| bridge | one `mtproto_sticker_set_install` row per `(platformSessionId, providerId, packId)` — visibility only, no platform call | `sticker-dashboard.ts` (`setStickerPackAssignment`), `sticker-rpc.ts` (`installStickerSet`) |
| Telegram client | `messages.installStickerSet` / `messages.faveSticker` are answered by the bridge, which **is** the server; there is no upstream Telegram account to install into | `sticker-rpc.ts` |
| QQ account | only the account's own native collections exist: its panel catalog (`GET /stickers/packs`) and its favorite collection (`GET/POST /stickers/saved`) | `platform-crossgram/src/client.ts`, `protocol.ts` |
| other platforms | no sticker collection at all: no provider, and `capabilities.stickers` is absent | `platform-discord`, `platform-matrix`, `platform-satori`, `platform-wechat` |

The only native write the relay can make is `POST /stickers/saved` with one sticker reference, which is what
`faveSticker` (the ⭐ in a Telegram client) already does through `IMStickerProvider.setSavedSticker()`. CrossGram
speaks no API that adds a *pack* to an account's QQ panel, so a pack can only move between accounts one sticker
at a time, into that account's favorites.

## Implementation

- `IMStickerProvider.saveStickers(context, stickers, { limit })` → `IMStickerSaveSummary`
  (`packages/bridge/src/sticker-provider.ts`): an optional batch sibling of `setSavedSticker()`, because only the
  provider can tell which of its references another account may use.
- `QQStickerProvider.saveStickers()` (`packages/platform-crossgram/src/sticker-provider.ts`): keeps references the
  target account resolves from the face itself — `market` (store faces) and `sysface` (system faces) — and reports
  the rest as `skipped`: a `favorite` copy carries the res id (and `<uin>_…` prefix) of the account that saved it,
  `deferred` references have no bytes yet, and imported Telegram documents carry no QQ expression at all. Writes
  are sequential, counted per sticker (`failed`), and bounded by `limit`; the remainder comes back as `remaining`.
- `saveStickerPackToAccount()` + `accountStickerSaver()` + `STICKER_PACK_SAVE_LIMIT` (`packages/bridge/src/sticker-dashboard.ts`):
  the bridge reads the pack through the account that exposes it and writes it through the account that collects it,
  so nothing is copied between sessions. The dashboard reports `saveable` per account and refuses with
  `STICKER_PACK_SAVE_UNSUPPORTED` when the account's platform has no such collection.
- `packages/bridge/src/index.ts`: the WebUI RPC and `BridgeManagementService` entry both call it, then
  `ctx.imSticker.touch(saverProviderId, platformSessionId)` and republish the dashboard, so the stickers show up in
  that account's `qq-favorites` set and are sendable natively from then on.
- `packages/bridge/client/stickers.tsx`: a card whose pack is not sendable but is `saveable` gets
  **Save to this account** (plus Remove when an association exists) and reports the summary
  (`Saved 20 · already owned 3 · 2 left`).

## Boundaries (measured, not guessed)

- A QQ pack whose stickers are only this account's favorites cannot move: their res ids are account scoped. The
  relay can serve the bytes, but QQ offers no way to create a favorite from bytes.
- Imported Telegram packs (`telegram-sticker-importer`) cannot move to a QQ account: no QQ reference exists for
  them, so they stay visible-and-unsendable on QQ and are reported as skipped.
- One request mirrors at most `STICKER_PACK_SAVE_LIMIT` (100) stickers, each a native QQ write; the summary's
  `remaining` says how many are left, and running the action again continues where it stopped.
  A pack larger than a QQ account's own favorite limit will keep failing there — `failed` reports it.
- An account that already owns the pack (its own provider lists the same `packId`) does not need this: linking its
  own card is enough, and the WebUI still offers that.

## Verification

- `packages/platform-crossgram/src/sticker-provider.test.ts`: market/system faces are saved in order, favorite
  copies, deferred references and imported documents are skipped, `limit` reports `remaining`, a rejected native
  write is counted and logged without losing the rest.
- `packages/bridge/src/sticker-dashboard.test.ts`: `saveable` per account, the pack is read through the source
  account and written through the collector (`saveStickers` called with the source session and the pack's
  stickers), and unsupported accounts / unknown packs are refused with a message.
- `packages/bridge/src/management-service.test.ts`: the management seam delegates and returns the summary.
- `packages/cordis-webui-solidjs/src/bridge.browser.e2e.test.ts`: on a phone viewport the card of an account that
  cannot send the pack offers **Save to this account**, calls the RPC and shows the summary.
- Not covered: the native effect itself (QQ adding those faces to the account's 收藏表情) needs a real QQ account;
  the endpoint and its reference kinds are the ones `faveSticker` already uses in production.
