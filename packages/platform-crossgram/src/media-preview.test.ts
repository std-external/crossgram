import { describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'
import { expandTelegramStrippedThumbnail, type IMMedia } from '@mtproto-relay/bridge'
import { QQMediaPreviewer, mediaPreviewKey } from './media-preview.js'
import type { QQMediaLocator } from './protocol.js'

function media(id = 'one', kind: IMMedia['kind'] = 'image'): IMMedia<QQMediaLocator> {
  return {
    id, kind, name: `${id}.${kind === 'image' ? 'png' : 'mp4'}`,
    mimeType: kind === 'image' ? 'image/png' : 'video/mp4', size: 123_456,
    width: 640, height: 360,
    locator: {
      messageId: `message-${id}`, elementId: `element-${id}`, chatType: 2,
      peerUid: 'group', kind: 'image', fileName: `${id}.png`, md5: `MD5-${id}`,
    },
  }
}

async function png(width = 64, height = 40): Promise<Uint8Array> {
  return sharp({
    create: { width, height, channels: 4, background: { r: 20, g: 80, b: 160, alpha: 1 } },
  }).png().toBuffer()
}

describe('QQMediaPreviewer', () => {
  it('is disabled by default and leaves original media untouched', async () => {
    const original = media()
    const previewer = new QQMediaPreviewer()
    expect(previewer.project(original)).toBe(original)
    await expect(previewer.prepare(original, async function* () {
      throw new Error('source must stay closed')
    })).resolves.toBe(original)
  })

  it('does not advertise a separate m-size preview or perform I/O while projecting', () => {
    const original = media()
    const previewer = new QQMediaPreviewer({ enabled: true })
    expect(previewer.project(original)).toBe(original)
    expect(mediaPreviewKey(original.locator!)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('generates and single-flights a tiny inline stripped JPEG in the background path', async () => {
    const input = await png()
    const previewer = new QQMediaPreviewer({ enabled: true })
    const original = media()
    let opens = 0
    const source = async function* () {
      opens++
      yield input.subarray(0, 20)
      yield input.subarray(20)
    }

    const [first, second] = await Promise.all([
      previewer.prepare(original, source),
      previewer.prepare(original, source),
    ])

    expect(opens).toBe(1)
    expect(first.preview).toBeUndefined()
    expect(first.strippedThumbnail).toEqual(second.strippedThumbnail)
    expect(first.strippedThumbnail!.byteLength).toBeLessThan(1024)
    await expect(sharp(expandTelegramStrippedThumbnail(first.strippedThumbnail!)).metadata())
      .resolves.toMatchObject({ format: 'jpeg', width: 40, height: 25 })

    const projected = previewer.project(media())
    expect(projected.strippedThumbnail).toEqual(first.strippedThumbnail)
    expect(opens).toBe(1)
  })

  it('bounds independent inline preview work', async () => {
    const input = await png()
    const previewer = new QQMediaPreviewer({ enabled: true, concurrency: 1 })
    const firstGate = Promise.withResolvers<void>()
    let opened = 0
    let running = 0
    let maximumRunning = 0
    const source = (gate?: Promise<void>) => async function* () {
      opened++
      running++
      maximumRunning = Math.max(maximumRunning, running)
      if (gate) await gate
      yield input
      running--
    }

    const first = previewer.prepare(media('first'), source(firstGate.promise))
    const second = previewer.prepare(media('second'), source())
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(opened).toBe(1)
    firstGate.resolve()
    await Promise.all([first, second])
    expect(opened).toBe(2)
    expect(maximumRunning).toBe(1)
  })

  it('isolates decoder failures from the original media object', async () => {
    const original = media()
    const previewer = new QQMediaPreviewer({ enabled: true })
    await expect(previewer.prepare(original, async function* () {
      yield new Uint8Array([1, 2, 3])
    })).rejects.toThrow()
    expect(original.strippedThumbnail).toBeUndefined()
    expect(original.preview).toBeUndefined()
  })

  it('generates inline previews for videos from their native thumbnail source', async () => {
    const input = await png()
    const previewer = new QQMediaPreviewer({ enabled: true })
    const original = media('video', 'file')
    const result = await previewer.prepare(original, async function* () { yield input })
    expect(result.strippedThumbnail).toBeDefined()
    await expect(sharp(expandTelegramStrippedThumbnail(result.strippedThumbnail!)).metadata())
      .resolves.toMatchObject({ format: 'jpeg', width: 40, height: 25 })
  })
})

function fileVideo(id = 'transfer', extra: Partial<IMMedia<QQMediaLocator>> = {}): IMMedia<QQMediaLocator> {
  return {
    id, kind: 'file', name: `${id}.mp4`, mimeType: 'video/mp4', size: 857_325,
    locator: {
      messageId: `message-${id}`, elementId: `element-${id}`, chatType: 1, peerUid: 'friend',
      kind: 'file', fileName: `${id}.mp4`, fileUuid: `uuid-${id}`, file10MMd5: `md5-${id}`,
    },
    ...extra,
  }
}

async function jpeg(width: number, height: number): Promise<Uint8Array> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 40 } },
  }).jpeg().toBuffer()
}

describe('QQMediaPreviewer video frames', () => {
  it('stays disabled and never resolves a URL unless previews are enabled', async () => {
    const previewer = new QQMediaPreviewer()
    const original = fileVideo()
    const resolveUrl = vi.fn(async () => 'https://cdn.test/clip.mp4')
    await expect(previewer.prepareVideoFrame(original, resolveUrl, async () => {
      throw new Error('must not decode')
    })).resolves.toBe(original)
    expect(resolveUrl).not.toHaveBeenCalled()
  })

  it('ignores non-video media', async () => {
    const previewer = new QQMediaPreviewer({ enabled: true })
    const archive = fileVideo('archive', { mimeType: 'application/zip' })
    const resolveUrl = vi.fn(async () => 'https://cdn.test/a.zip')
    await expect(previewer.prepareVideoFrame(archive, resolveUrl, vi.fn())).resolves.toBe(archive)
    expect(resolveUrl).not.toHaveBeenCalled()
  })

  it('builds the stripped preview and fills missing dimensions and duration from the frame', async () => {
    const frame = await jpeg(1568, 882)
    const previewer = new QQMediaPreviewer({ enabled: true })
    const readFrame = vi.fn(async (url: string) => {
      expect(url).toBe('https://cdn.test/clip.mp4')
      return { bytes: frame, duration: 7.6 }
    })

    const result = await previewer.prepareVideoFrame(fileVideo(), async () => 'https://cdn.test/clip.mp4', readFrame)

    expect(result).toMatchObject({ width: 1568, height: 882, duration: 8 })
    await expect(sharp(expandTelegramStrippedThumbnail(result.strippedThumbnail!)).metadata())
      .resolves.toMatchObject({ format: 'jpeg', width: 40, height: 22 })
    // The projected cache reapplies the same facts on the next mapping.
    expect(previewer.project(fileVideo())).toMatchObject({
      width: 1568, height: 882, duration: 8, strippedThumbnail: result.strippedThumbnail,
    })
    expect(readFrame).toHaveBeenCalledTimes(1)
  })

  it('never overrides dimensions or duration QQ reported itself', async () => {
    const previewer = new QQMediaPreviewer({ enabled: true })
    const native = fileVideo('native', { width: 1138, height: 640, duration: 10 })
    const result = await previewer.prepareVideoFrame(native, async () => 'https://cdn.test/n.mp4', async () => ({
      bytes: await jpeg(1920, 1080), duration: 10.7,
    }))
    expect(result).toMatchObject({ width: 1138, height: 640, duration: 10 })
    expect(result.strippedThumbnail).toBeDefined()
  })

  it('single-flights concurrent frame extraction for the same video', async () => {
    const frame = await jpeg(64, 36)
    const previewer = new QQMediaPreviewer({ enabled: true })
    const gate = Promise.withResolvers<void>()
    const readFrame = vi.fn(async () => {
      await gate.promise
      return { bytes: frame }
    })
    const resolveUrl = vi.fn(async () => 'https://cdn.test/clip.mp4')
    const first = previewer.prepareVideoFrame(fileVideo(), resolveUrl, readFrame)
    const second = previewer.prepareVideoFrame(fileVideo(), resolveUrl, readFrame)
    gate.resolve()
    const [a, b] = await Promise.all([first, second])
    expect(a.strippedThumbnail).toEqual(b.strippedThumbnail)
    expect(resolveUrl).toHaveBeenCalledTimes(1)
    expect(readFrame).toHaveBeenCalledTimes(1)
  })

  it('backs off after a failed extraction and retries once the window passes', async () => {
    let now = 1_000
    const previewer = new QQMediaPreviewer({ enabled: true, now: () => now })
    const readFrame = vi.fn(async (): Promise<{ bytes: Uint8Array }> => {
      throw new Error('moov atom not found')
    })
    await expect(previewer.prepareVideoFrame(fileVideo(), async () => 'https://cdn.test/x', readFrame))
      .rejects.toThrow('moov atom not found')
    await expect(previewer.prepareVideoFrame(fileVideo(), async () => 'https://cdn.test/x', readFrame))
      .rejects.toThrow('retry deferred')
    expect(readFrame).toHaveBeenCalledTimes(1)

    now += 31 * 60 * 1000
    readFrame.mockResolvedValueOnce({ bytes: await jpeg(32, 18) })
    await expect(previewer.prepareVideoFrame(fileVideo(), async () => 'https://cdn.test/x', readFrame))
      .resolves.toMatchObject({ width: 32, height: 18 })
  })

  it('persists frame metadata and restores it without decoding again', async () => {
    const rows = new Map<string, any>()
    const database = {
      get: vi.fn(async (_table: string, query: { key: string }) => rows.has(query.key) ? [rows.get(query.key)] : []),
      upsert: vi.fn(async (_table: string, values: any[]) => {
        for (const value of values) rows.set(value.key, value)
      }),
    }
    const readFrame = vi.fn(async () => ({ bytes: await jpeg(720, 1280), duration: 12.2 }))
    await new QQMediaPreviewer({ enabled: true, database: database as never })
      .prepareVideoFrame(fileVideo(), async () => 'https://cdn.test/p.mp4', readFrame)
    expect([...rows.values()][0]).toMatchObject({ width: 720, height: 1280, duration: 12 })

    const restarted = new QQMediaPreviewer({ enabled: true, database: database as never })
    const restored = await restarted.prepareVideoFrame(fileVideo(), async () => {
      throw new Error('must not resolve a URL for a persisted preview')
    }, readFrame)
    expect(restored).toMatchObject({ width: 720, height: 1280, duration: 12 })
    expect(readFrame).toHaveBeenCalledTimes(1)
  })
})
