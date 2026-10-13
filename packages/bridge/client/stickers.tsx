/** @jsxImportSource solid-js */
import { createEffect, createMemo, createSignal, For, Show } from 'solid-js'
import type {
  StickerPackDashboardData,
  StickerPackSaveResult,
} from '../src/dashboard-types.js'
import { useRpc, type PageProps } from 'cordis-webui-solidjs/client'
import { Icon } from 'cordis-webui-solidjs/icons'
import {
  ActionError,
  EmptyState,
  LiveContent,
  PageHeader,
  useAction,
} from 'cordis-webui-solidjs/components'
export default function StickersPage(props: PageProps) {
  const rpc = useRpc<StickerPackDashboardData>(props.entryId),
    action = useAction()
  const [selected, setSelected] = createSignal(''),
    [search, setSearch] = createSignal(''),
    [page, setPage] = createSignal(0),
    [saved, setSaved] = createSignal<Record<string, StickerPackSaveResult>>({})
  createEffect(() => {
    if (
      rpc.ready &&
      !rpc.data.stickerAccounts.some(
        (account) => account.platformSessionId === selected(),
      )
    )
      setSelected(rpc.data.stickerAccounts[0]?.platformSessionId ?? '')
  })
  const packs = createMemo(
    () =>
      new Map(
        (rpc.data.stickerPacks ?? []).map((pack) => [
          JSON.stringify([pack.providerId, pack.packId]),
          pack,
        ]),
      ),
  )
  const ids = createMemo(() =>
    [...packs().keys()].filter((key) => {
      const pack = packs().get(key)!
      return (pack.title + ' ' + pack.providerId + ' ' + pack.packId)
        .toLowerCase()
        .includes(search().toLowerCase())
    }),
  )
  return (
    <>
      <PageHeader
        title="Sticker collections"
        description="Choose the collections that make each account feel like yours."
        actions={
          <button
            class="button outlined"
            disabled={action.busy() || !rpc.ready}
            onClick={() =>
              void action.run(() => rpc.data.refreshStickerPacks())
            }
          >
            Refresh collections
          </button>
        }
      />
      <ActionError error={action.error()} />
      <LiveContent ready={rpc.ready}>
        <div class="panel toolbar sticker-controls">
          <label class="field grow">
            <span>Assign to account</span>
            <select
              aria-label="Assign to account"
              value={selected()}
              onChange={(event) => setSelected(event.currentTarget.value)}
            >
              <For each={rpc.data.stickerAccounts}>
                {(account) => (
                  <option value={account.platformSessionId}>
                    {account.displayName} · {account.platformKind} ·{' '}
                    {account.userId}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="field grow">
            <span>Find a collection</span>
            <input
              type="search"
              value={search()}
              onInput={(event) => {
                setSearch(event.currentTarget.value)
                setPage(0)
              }}
            />
          </label>
        </div>
        <Show
          when={selected()}
          fallback={
            <section class="panel empty-state">
              <h2>No accounts to manage yet</h2>
              <p>
                Connect a platform account before assigning sticker collections.
              </p>
            </section>
          }
        >
          <div class="sticker-grid">
            <For each={ids().slice(page() * 24, (page() + 1) * 24)}>
              {(id) => {
                const pack = () => packs().get(id)!,
                  assignment = () =>
                    pack().assignments.find(
                      (item) => item.platformSessionId === selected(),
                    ),
                  source = () =>
                    rpc.data.stickerAccounts.find(
                      (account) =>
                        account.platformSessionId ===
                        pack().sourcePlatformSessionId,
                    ),
                  sendable = () => assignment()?.sendable !== false,
                  saveable = () => assignment()?.saveable === true,
                  // A pack this account cannot send but can collect is worth
                  // saving; that native collection is what makes it sendable.
                  saveableAction = () =>
                    !sendable() && saveable() && !assignment()?.automatic,
                  removable = () => Boolean(assignment()?.assigned),
                  savedKey = () =>
                    [selected(), pack().providerId, pack().packId].join('|'),
                  saveResult = () => saved()[savedKey()],
                  save = () =>
                    void action.run(async () => {
                      const result = await rpc.data.saveStickerPackToAccount(
                        selected(),
                        pack().providerId,
                        pack().packId,
                      )
                      setSaved((value) => ({ ...value, [savedKey()]: result }))
                      await rpc.data.refreshStickerPacks()
                    })
                return (
                  <article
                    class="panel sticker-card"
                    classList={{ assigned: assignment()?.assigned }}
                    data-pack={pack().packId}
                  >
                    <div class="sticker-monogram" aria-hidden="true">
                      {pack().title.trim()[0] ?? (
                        <Icon name="smile" size={20} />
                      )}
                    </div>
                    <h2>{pack().title}</h2>
                    <p>
                      {pack().count === undefined
                        ? 'Count unavailable'
                        : pack().count + ' stickers'}
                    </p>
                    <div class="sticker-meta">
                      <span class="chip">
                        {pack().providerId} / {pack().packId}
                      </span>
                      <Show when={source()}>
                        <span class="chip">
                          From {source()!.displayName}
                        </span>
                      </Show>
                      <Show when={!sendable()}>
                        <span class="chip">Cannot send here</span>
                      </Show>
                    </div>
                    <div class="sticker-actions">
                      <button
                        class={
                          'button ' +
                          (assignment()?.assigned && !saveableAction()
                            ? 'tonal'
                            : 'outlined')
                        }
                        disabled={
                          !rpc.ready ||
                          action.busy() ||
                          assignment()?.automatic ||
                          (!sendable() && !removable() && !saveableAction())
                        }
                        aria-label={
                          (assignment()?.automatic
                            ? 'Automatically assigned '
                            : saveableAction()
                              ? 'Save '
                              : !sendable()
                                ? removable()
                                  ? 'Remove '
                                  : 'Cannot send '
                                : assignment()?.assigned
                                  ? 'Remove '
                                  : 'Add ') + pack().title
                        }
                        onClick={() => {
                          if (saveableAction()) return save()
                          const accountId = selected(),
                            value = pack(),
                            assigned = !assignment()?.assigned
                          void action.run(() =>
                            rpc.data.setStickerPackAssigned(
                              accountId,
                              value.providerId,
                              value.packId,
                              assigned,
                            ),
                          )
                        }}
                      >
                        {assignment()?.automatic
                          ? 'Automatically assigned'
                          : saveableAction()
                            ? 'Save to this account'
                            : !sendable()
                              ? removable()
                                ? 'Not sendable · remove'
                                : 'Cannot send on this account'
                              : assignment()?.assigned
                                ? 'Added · remove'
                                : 'Add to account'}
                      </button>
                      <Show when={saveableAction() && removable()}>
                        <button
                          class="button outlined"
                          disabled={!rpc.ready || action.busy()}
                          aria-label={'Remove ' + pack().title}
                          onClick={() => {
                            const accountId = selected(),
                              value = pack()
                            void action.run(() =>
                              rpc.data.setStickerPackAssigned(
                                accountId,
                                value.providerId,
                                value.packId,
                                false,
                              ),
                            )
                          }}
                        >
                          Remove
                        </button>
                      </Show>
                    </div>
                    <Show when={saveResult()}>
                      {(result) => (
                        <p class="sticker-save-result">
                          Saved {result().saved} · skipped {result().skipped}
                          {result().failed
                            ? ' · failed ' + result().failed
                            : ''}
                          {result().remaining
                            ? ' · ' + result().remaining + ' left'
                            : ''}
                        </p>
                      )}
                    </Show>
                  </article>
                )
              }}
            </For>
          </div>
          <Show when={!ids().length}>
            <EmptyState
              icon="search"
              title="No matching collections"
              description="Try a different search term."
            />
          </Show>
          <div class="pagination">
            <button
              class="button outlined"
              disabled={page() === 0}
              onClick={() => setPage(page() - 1)}
            >
              Previous page
            </button>
            <span>{ids().length} collections</span>
            <button
              class="button outlined"
              disabled={(page() + 1) * 24 >= ids().length}
              onClick={() => setPage(page() + 1)}
            >
              Next page
            </button>
          </div>
        </Show>
      </LiveContent>
    </>
  )
}
