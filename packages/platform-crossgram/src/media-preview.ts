import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Context } from 'cordis'
import type { Database } from '@cordisjs/plugin-database'
import { stripTelegramJpegThumbnail, type IMMedia } from '@mtproto-relay/bridge'
import sharp from 'sharp'
import type { QQMediaLocator } from './protocol.js'
import type { RemoteVideoFrame } from './video-frame.js'

export interface QQMediaInlinePreviewRow {
  key: string
  bytes: ArrayBuffer
  /** Display dimensions recovered from a decoded video frame. */
  width: number | null
  height: number | null
  /** Whole-second container duration recovered alongside a video frame. */
  duration: number | null
  updatedAt: Date
}

declare module '@cordisjs/plugin-database' {
  interface Tables {
    mtproto_qqnt_inline_preview: QQMediaInlinePreviewRow
  }
}

export function defineQQMediaPreviewModel(ctx: Context): void {
  ctx.model.extend('mtproto_qqnt_inline_preview', {
    key: 'string', bytes: 'binary',
    width: { type: 'unsigned', nullable: true },
    height: { type: 'unsigned', nullable: true },
    duration: { type: 'unsigned', nullable: true },
    updatedAt: 'timestamp',
  }, { primary: 'key', indexes: ['updatedAt'] })
}

export interface QQMediaPreviewOptions {
  enabled?: boolean
  concurrency?: number
  /**
   * Pixel ceiling for one decode. Defaults to `MAX_INPUT_PIXELS`; tests lower it
   * to exercise the limit without generating a megapixel fixture.
   */
  maxInputPixels?: number
  database?: Database
  /** Clock used for the failed-extraction backoff; injectable for tests. */
  now?: () => number
}

/** Opens a short-lived direct URL for the original video bytes. */
export type VideoFrameUrlResolver = (signal?: AbortSignal) => Promise<string>

/** Decodes the first frame of the video behind a direct URL. */
export type VideoFrameReader = (url: string, signal?: AbortSignal) => Promise<RemoteVideoFrame>

interface InlinePreview {
  bytes: Uint8Array
  width?: number
  height?: number
  duration?: number
}

const MAX_PREVIEW_SOURCE_BYTES = 64 * 1024 * 1024
/**
 * Pixel ceiling for one decode. The preview only ever needs a 40px JPEG, but
 * libvips allocates the decoded raster before it resizes, so this is a direct
 * limit on peak native memory: the previous 64 megapixels allowed a ~256 MiB
 * RGBA allocation for a single oversized image on a host that runs nine other
 * services and swaps. Sixteen megapixels still covers 4K video frames and every
 * phone photo the platform carries, and an image above it only loses its own
 * thumbnail — `scheduleInlinePreview` logs the failure and keeps the message.
 */
export const MAX_INPUT_PIXELS = 16 * 1024 * 1024
const MEMORY_PREVIEW_CACHE_LIMIT = 4096
const FAILED_PREVIEW_CACHE_LIMIT = 4096
const FAILED_FRAME_RETRY_MS = 30 * 60 * 1000

/**
 * Bound libvips' own caches and worker threads for this process.
 *
 * Nothing configured them here, so the relay inherited libvips' defaults: a
 * 50 MiB pixel-operation cache, up to 20 cached file loaders, and one worker
 * thread per core. This module is imported statically, so the native addon and
 * its caches live in the relay process whether or not previews are enabled.
 * Previews are background work on a shared host, so 32 MiB, no file cache (the
 * sources are streams and buffers, never reusable paths), and a single worker
 * are the right trade. Exported so a test can assert the applied values without
 * depending on another test file's global sharp state.
 */
export function applyNativeImageLimits(): void {
  sharp.cache({ memory: 32, files: 0, items: 32 })
  sharp.concurrency(1)
}

applyNativeImageLimits()

/**
 * Generates Telegram's tiny photoStrippedSize payload in an isolated worker
 * path. Mapping is synchronous and memory-only; cache lookup, source download,
 * decode and persistence happen only in prepare(), which callers schedule
 * after the original history/live message has already been delivered.
 */
export class QQMediaPreviewer {
  readonly enabled: boolean
  readonly concurrency: number
  private readonly maxInputPixels: number
  private readonly active = new Map<string, Promise<InlinePreview>>()
  private readonly memory = new Map<string, InlinePreview>()
  private readonly failedFrames = new Map<string, number>()
  private readonly waiters: Array<() => void> = []
  private readonly now: () => number
  private running = 0

  constructor(private readonly options: QQMediaPreviewOptions = {}) {
    this.enabled = options.enabled ?? false
    this.concurrency = Math.max(1, Math.min(8, Math.trunc(options.concurrency ?? 2)))
    this.maxInputPixels = Math.max(1, Math.trunc(options.maxInputPixels ?? MAX_INPUT_PIXELS))
    this.now = options.now ?? Date.now
  }

  /** Attach only an already-memory-resident inline preview; never perform I/O. */
  project(media: IMMedia<QQMediaLocator>): IMMedia<QQMediaLocator> {
    if (!this.enabled || !isInlinePreviewMedia(media) || !media.locator || media.strippedThumbnail) return media
    const key = mediaPreviewKey(media.locator)
    const preview = this.memory.get(key)
    return preview ? withPreview(media, remember(this.memory, key, preview)) : media
  }

  async prepare(
    media: IMMedia<QQMediaLocator>,
    source: (signal?: AbortSignal) => AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): Promise<IMMedia<QQMediaLocator>> {
    if (!this.enabled || !isInlinePreviewMedia(media) || !media.locator || media.strippedThumbnail) return media
    const key = mediaPreviewKey(media.locator)
    const preview = await this.open(key, async () => ({
      bytes: await this.create(source(signal), signal),
    }))
    return withPreview(media, preview)
  }

  /**
   * Builds the inline preview for a video that arrived without any native
   * thumbnail (QQ file-transfer videos, or native videos whose thumbnail was
   * never cached locally) by decoding its first frame straight from QQ's CDN.
   * The decoded frame also supplies the display dimensions and duration QQ
   * does not report for file transfers, so clients can lay the bubble out at
   * the real aspect ratio instead of a 1x1 placeholder.
   */
  async prepareVideoFrame(
    media: IMMedia<QQMediaLocator>,
    resolveUrl: VideoFrameUrlResolver,
    readFrame: VideoFrameReader,
    signal?: AbortSignal,
  ): Promise<IMMedia<QQMediaLocator>> {
    if (!this.enabled || !isVideoMedia(media) || !media.locator || media.strippedThumbnail) return media
    const key = mediaPreviewKey(media.locator)
    if (!this.memory.has(key) && !this.active.has(key)) {
      const failedAt = this.failedFrames.get(key)
      if (failedAt !== undefined && this.now() - failedAt < FAILED_FRAME_RETRY_MS) {
        throw new Error('video frame extraction recently failed; retry deferred')
      }
    }
    try {
      const preview = await this.open(key, async () => {
        const frame = await readFrame(await resolveUrl(signal), signal)
        const metadata = await sharp(frame.bytes, { limitInputPixels: this.maxInputPixels }).metadata()
        return {
          bytes: await this.create(singleChunk(frame.bytes), signal),
          width: positiveInteger(metadata.width),
          height: positiveInteger(metadata.height),
          duration: frame.duration === undefined ? undefined : positiveInteger(Math.round(frame.duration)),
        }
      })
      this.failedFrames.delete(key)
      return withPreview(media, preview)
    } catch (error) {
      if (!signal?.aborted) remember(this.failedFrames, key, this.now(), FAILED_PREVIEW_CACHE_LIMIT)
      throw error
    }
  }

  private async open(key: string, generate: () => Promise<InlinePreview>): Promise<InlinePreview> {
    const cached = this.memory.get(key)
    if (cached) return remember(this.memory, key, cached)
    const current = this.active.get(key)
    if (current) return current
    const pending = this.openOnce(key, generate)
    this.active.set(key, pending)
    try {
      return await pending
    } finally {
      if (this.active.get(key) === pending) this.active.delete(key)
    }
  }

  private async openOnce(key: string, generate: () => Promise<InlinePreview>): Promise<InlinePreview> {
    const [stored] = await this.options.database?.get('mtproto_qqnt_inline_preview', { key }) ?? []
    if (stored) {
      return remember(this.memory, key, {
        bytes: new Uint8Array(stored.bytes),
        width: stored.width ?? undefined,
        height: stored.height ?? undefined,
        duration: stored.duration ?? undefined,
      })
    }
    return this.withSlot(async () => {
      const preview = await generate()
      await this.options.database?.upsert('mtproto_qqnt_inline_preview', [{
        key,
        bytes: exactArrayBuffer(preview.bytes),
        width: preview.width ?? null,
        height: preview.height ?? null,
        duration: preview.duration ?? null,
        updatedAt: new Date(),
      }], ['key'])
      return remember(this.memory, key, preview)
    })
  }

  private async create(source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<Uint8Array> {
    const transformer = sharp({ limitInputPixels: this.maxInputPixels, sequentialRead: true })
      .rotate()
      .resize({ width: 40, height: 40, fit: 'inside', withoutEnlargement: true })
      .jpeg({
        quality: 20, chromaSubsampling: '4:2:0', progressive: false, optimizeCoding: false,
      })
    const output = transformer.toBuffer()
    await pipeline(Readable.from(limitedSource(source, signal)), transformer)
    return stripTelegramJpegThumbnail(await output)
  }

  private async withSlot<T>(run: () => Promise<T>): Promise<T> {
    if (this.running >= this.concurrency) await new Promise<void>((resolve) => this.waiters.push(resolve))
    this.running++
    try {
      return await run()
    } finally {
      this.running--
      this.waiters.shift()?.()
    }
  }
}

/** Images and native video thumbnails can be reduced to Telegram's inline JPEG. */
function isInlinePreviewMedia(media: Pick<IMMedia, 'kind' | 'mimeType'>): boolean {
  return media.kind === 'image' || isVideoMedia(media)
}

function isVideoMedia(media: Pick<IMMedia, 'mimeType'>): boolean {
  return media.mimeType?.toLowerCase().startsWith('video/') === true
}

/**
 * Attach the stripped bytes and fill only the layout facts the platform left
 * out. Values QQ reported itself always win over the decoded frame.
 */
function withPreview(media: IMMedia<QQMediaLocator>, preview: InlinePreview): IMMedia<QQMediaLocator> {
  const fillDimensions = !(media.width && media.height) && preview.width && preview.height
  return {
    ...media,
    strippedThumbnail: preview.bytes,
    ...(fillDimensions ? { width: preview.width, height: preview.height } : {}),
    ...(!media.duration && preview.duration ? { duration: preview.duration } : {}),
  }
}

export function mediaPreviewKey(locator: QQMediaLocator): string {
  const raw = rawLocator(locator)
  const identity = raw.sha3
    ? `sha3:${raw.sha3.toLowerCase()}`
    : raw.sha
      ? `sha:${raw.sha.toLowerCase()}`
      : raw.md5
        ? `md5:${raw.md5.toLowerCase()}`
        : `locator:${stableJson(raw)}`
  return createHash('sha256').update(`qq-inline-preview-v1\0${identity}`).digest('hex')
}

function rawLocator(locator: QQMediaLocator): QQMediaLocator {
  const { cachedPath: _cachedPath, previewKey: _previewKey, deferred: _deferred, ...raw } = locator
  return raw
}

async function* singleChunk(bytes: Uint8Array): AsyncIterable<Uint8Array> {
  yield bytes
}

async function* limitedSource(
  source: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): AsyncIterable<Uint8Array> {
  let total = 0
  for await (const chunk of source) {
    if (signal?.aborted) throw signal.reason ?? new Error('inline preview generation aborted')
    total += chunk.byteLength
    if (total > MAX_PREVIEW_SOURCE_BYTES) {
      throw new Error(`QQ inline preview source exceeds ${MAX_PREVIEW_SOURCE_BYTES} bytes`)
    }
    yield chunk
  }
}

function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function remember<T>(cache: Map<string, T>, key: string, value: T, limit = MEMORY_PREVIEW_CACHE_LIMIT): T {
  cache.delete(key)
  cache.set(key, value)
  if (cache.size > limit) cache.delete(cache.keys().next().value!)
  return value
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`
}
