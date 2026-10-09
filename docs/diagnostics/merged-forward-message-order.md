# Merged-forward transcripts came back in the wrong order (2026-10-09)

## Symptom

A nested merged forward could not be opened from the workstation's desktop
client — clicking "查看聊天记录" did nothing — and transcripts regularly listed
their messages in the wrong order on Android.

## Evidence from production

The transcript of the merged forward QQ user `2071065243` sent in the private
chat (`u_dhICFIcSBUcNondA0Dqv3w`, `mtproto_im_message.id = 1406235`) was read
through a real MTProto client (`work/mtproto-e2e/probe-merged-forward-nested.ts`,
profile `production`).  The archive holds seven records, all of whose timestamps
land in a seven-second window, and the transcript's message ids were:

```
1698105084@1790642359  1137588937@1790642358  781977134@1790642357
54036500@1790642357    2043326725@1790642353  1801992961@1790642353
590835634@1790642353
```

Those ids were `stableId("merged-forward-message:<bundle>:<record>:<ordinal>")`
hashes, so they carry no relation to the order of the messages.  Two things
followed from that:

- **Cursors selected arbitrary subsets.**  `messages.getHistory` with
  `max_id = 590835634` (the id of the newest page's last message) returned a
  single message out of seven, and `min_id = 590835634` returned five — clients
  page history by id (`offset_id`, `max_id`, `min_id`), so their pages had
  holes and duplicates.  A 22-record nested transcript answered
  `max_id = 1628174457` with 16 of 22 records and `min_id` with 5.
- **Same-second records were ordered randomly.**  QQ timestamps only resolve to
  whole seconds, so clients break ties between messages that share one second
  by id.  Comparing the relay's response with the archive order showed three of
  the four same-second groups in the wrong order:

  ```
  1789987844  archive 0913>0917  relay 0917>0913
  1789987845  archive 0921>0925  relay 0925>0921
  1789987979  archive 0973>0977  relay 0977>0973
  1789988063  archive 0985>0989  relay 0985>0989   (accidentally right)
  ```

The desktop client's own behaviour matched the broken contract: while the
transcript was stuck it issued the same
`messages.getHistory(peer = 3587468288, offsetId = newest + 1)` request in a
tight loop (~25 requests/s, caught by a temporary RPC trace on the relay),
which is the "load newer messages" request a client repeats while it cannot
assemble a consistent page.

## Root cause

`bundleMessageId` hashed the bundle id, the archived record id and the part
ordinal.  A hash is stable and unique, but it is not *ordered*, and Telegram
history is a cursor protocol over message ids:

- `offset_id` is an exclusive cursor, `add_offset` shifts the window and
  `max_id`/`min_id` bound it, so a server must resolve them against the id
  order of the chat.
- Clients sort messages that share a date by id, which is how a second's worth
  of records keeps the order QQ stored them in.

## Fix

Transcript message ids are allocated in the transcript's chronological order
instead of being hashed:

```
id = 1000 + rank * 1000 + ordinal
```

- `rank` is the record's position in `chronologicalSnapshots()`, i.e. ordered by
  (timestamp, archive position).  The archive order is QQ's send order, so the
  ids reproduce exactly what the archive shows.
- `ordinal` keeps every rendered part of one message (an album, a card plus its
  parts) on its own id; a QQ message renders a handful of parts, far below the
  stride.
- The base `1000` keeps ids above offset id `1`, which clients (and the patched
  desktop client) use as the "beginning of the history" sentinel.
- `selectHistory` now resolves the window against the ids themselves: the page
  starts at the first message below `offset_id` (or at the transcript edge when
  the cursor sits outside it) and is then shifted by `add_offset`, so the
  newest-page refresh (`offset_id = newest + 1`, `add_offset = -limit`), a deep
  link opened around the anchor (`add_offset = -limit / 2`) and a forward walk
  from a gap all land on the messages the client asked for.

Links are unaffected: the anchor is still the transcript's first message, it now
has the id `1000`.  A client that cached message content from an older relay
keeps a stale anchor, which is what the desktop patch's sentinel request
(`offset_id = 1`) answers.

## Tests

- `packages/merged-forward/src/history-page.e2e.test.ts` drives the real RPC
  route with an eight-record archive (two records per second, one of them a
  nested merged forward) and asserts the ids, the same-second order, the
  `max_id`/`min_id` windows, the newest-page refresh, the deep-link window, the
  sentinel and the nested transcript.  Against the hashed ids it fails with
  `m6, m7` instead of `m7, m6` and hash ids in the page.
- `packages/merged-forward/src/index.test.ts` keeps the anchor and id contract.
- `packages/test-suite/src/login.e2e.test.ts` covers the live push path, whose
  transcript belongs to the pushed message's own stored row.
