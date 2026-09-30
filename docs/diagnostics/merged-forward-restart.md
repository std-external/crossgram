# Merged-forward links broke on every relay restart (2026-09-30)

## Symptom

After any restart of `crossgram.service`, every "查看聊天记录" link a client
had already received stopped opening: `contacts.resolveUsername` for
`bridgebundle_<id>` fell through to the ordinary username route, and clients
with the transcript chat cached got no dialog or history for it.

## Root cause

The transcript chat id was `stableId("merged-forward-chat:" + bundle.id)`, a
hash. A hash cannot be inverted, so the relay had to map it back to the bundle
through `MergedForwardProjection._records`, a process-local `Map` filled only
while the outer message was projected. A restart emptied it; until the client
happened to re-fetch the outer message (and re-project it), the id resolved to
nothing.

## Fix

The chat id now *encodes* where the bundle lives instead of hashing it:

```
chatId = 2^31 + storedMessageId * 1024 + pathCode
```

- `storedMessageId` is the durable `mtproto_im_message` row of the message
  that carries the bundle. The bridge now passes it to the
  `bridge/message/project` waterfall (`MessageProjectionInput.storedMessageId`)
  and exposes `DialogRpc.readStoredMessage(rowId)` to read it back.
- `pathCode` packs the bundle path: the ordinal of the bundle part in the
  stored message, then for nested forwards the ordinal among the bundle parts
  of the parent transcript's archived messages. Each ordinal is an Elias-gamma
  code; the first bundle of a message (the common case) is code 0, and several
  nesting levels still fit in the 10 reserved bits.
- The base `2^31` keeps transcript ids clear of every `stableId`-allocated
  peer, and the upper bound `999999999999` is the largest basic-group id TDLib
  accepts (production had ~1.2M message rows, leaving room for ~970M).

After a restart, any RPC for such a chat id (`resolveUsername`, `getHistory`,
`getPeerDialogs`, `getFullChat`, peer-photo `upload.getFile`, …) decodes the
id, reads the stored message, walks the path (loading parent transcripts from
the adapter for nested steps) and rebuilds the record. The in-memory registry
is now only a bounded cache (256 addressed transcripts per session).

Bundles without a stored row (for example projections without a
MessageStore) or with a path too long to encode keep the old hashed,
process-local id.

The link URL shape and the `bridgebundle_`/`bridgechat_` username prefixes are
unchanged, so no client patch is needed. Links generated before this change
still carry hashed ids and keep the old behaviour until the outer message is
projected again, after which the client receives the durable id.
