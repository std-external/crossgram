import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { type AssetRef, TelegramResources } from './store.js'

describe('TelegramResources', () => {
  it('builds the complete reaction catalog when optional animations are absent', () => {
    const resources = new TelegramResources()
    const catalog = resources.availableReactions()
    const laugh = catalog.reactions.find((reaction) => reaction.reaction === '😂')

    expect(catalog.reactions.length).toBeGreaterThan(0)
    expect(laugh).toBeDefined()
    expect(laugh?.aroundAnimation).toBeUndefined()
    expect(laugh?.centerIcon).toBeUndefined()
  })

  it('returns the exact bytes referenced by reaction documents', () => {
    const resources = new TelegramResources()
    const [reaction] = resources.availableReactions().reactions
    expect(reaction.staticIcon._).toBe('document')
    if (reaction.staticIcon._ !== 'document') throw new Error('expected reaction document')
    const file = resources.getFile(reaction.staticIcon.id)

    expect(file?.mimeType).toBe(reaction.staticIcon.mimeType)
    expect(file?.bytes.byteLength).toBe(reaction.staticIcon.size)
    expect([...file!.bytes.subarray(0, 4)]).toEqual([0x52, 0x49, 0x46, 0x46])
  })

  it('advertises the exact served size for every reaction asset', () => {
    const resources = new TelegramResources()
    const documents = resources.availableReactions().reactions.flatMap((reaction) => [
      reaction.staticIcon,
      reaction.appearAnimation,
      reaction.selectAnimation,
      reaction.activateAnimation,
      reaction.effectAnimation,
      reaction.aroundAnimation,
      reaction.centerIcon,
    ]).filter((document) => document?._ === 'document')

    expect(documents.length).toBeGreaterThan(0)
    for (const document of documents) {
      if (!document || document._ !== 'document') continue
      const file = resources.getFile(document.id)
      expect(file, `missing bytes for ${document.id.toString()}`).toBeDefined()
      expect(document.size, `stale size for ${document.id.toString()}`)
        .toBe(file!.bytes.byteLength)
    }
  })

  it('builds effects with optional document IDs omitted', () => {
    const resources = new TelegramResources()
    const effects = resources.availableEffects()

    expect(effects.effects.length).toBeGreaterThan(0)
    expect(effects.effects.some((effect) => effect.staticIconId === undefined)).toBe(true)
    expect(effects.effects.some((effect) => effect.effectAnimationId === undefined)).toBe(true)
  })

  it('serves every bundled document as the exact bytes Telegram published', () => {
    // A TGS is gzip. Committing one as text strips the CR of each CRLF pair
    // inside the compressed stream: the file shrinks by a few bytes and
    // clients show the animation as an empty frame or drop it after playing.
    const assets = new URL('../assets/', import.meta.url)
    const index = JSON.parse(readFileSync(new URL('index.json', assets), 'utf-8')) as {
      [group: string]: unknown
    }
    const resources = new TelegramResources()
    const checked = new Set<string>()
    const failures: string[] = []
    for (const group of ['reactions', 'emoji', 'emoji_animations', 'emoji_generic', 'effects']) {
      for (const item of index[group] as { assets: AssetRef[] | Record<string, AssetRef> }[]) {
        const refs = Array.isArray(item.assets) ? item.assets : Object.values(item.assets)
        for (const { file, doc } of refs) {
          if (checked.has(doc.id)) continue
          checked.add(doc.id)
          const bytes = resources.getFile(doc.id)?.bytes
          if (!bytes) {
            failures.push(`${file}: missing`)
            continue
          }
          if (bytes.byteLength !== doc.size) failures.push(`${file}: ${bytes.byteLength} != ${doc.size}`)
          if (doc.mimeType === 'application/x-tgsticker') {
            try {
              JSON.parse(gunzipSync(bytes).toString('utf-8'))
            } catch (error) {
              failures.push(`${file}: ${(error as Error).message}`)
            }
          }
        }
      }
    }
    expect(checked.size).toBeGreaterThan(1000)
    expect(failures).toEqual([])
  })

  it('keeps bundled binary assets out of git text normalisation', () => {
    const root = fileURLToPath(new URL('../../../', import.meta.url))
    const sample = 'packages/telegram-resources/assets/reactions/whale-effect.tgs'
    const attributes = execFileSync('git', ['check-attr', 'text', '--', sample], { cwd: root, encoding: 'utf-8' })
    expect(attributes.trim()).toBe(`${sample}: text: unset`)
  })
})
