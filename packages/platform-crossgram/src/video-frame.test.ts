import { execFile } from 'node:child_process'
import { createReadStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { extractRemoteVideoFrame, parseFfmpegDuration } from './video-frame.js'

const execFileAsync = promisify(execFile)
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg'
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

async function hasFfmpeg(): Promise<boolean> {
  try {
    await execFileAsync(ffmpeg, ['-version'])
    return true
  } catch {
    return false
  }
}

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'crossgram-video-frame-'))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return directory
}

/** Minimal Range-capable file server that records every requested range. */
async function serve(path: string): Promise<{ url: string, ranges: string[], bytesSent: () => number }> {
  const size = (await stat(path)).size
  const ranges: string[] = []
  let sent = 0
  const server: Server = createServer((request, response) => {
    const header = request.headers.range
    ranges.push(header ?? 'none')
    const match = header ? /^bytes=(\d+)-(\d*)$/.exec(header) : null
    const start = match ? Number(match[1]) : 0
    const end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1
    response.writeHead(match ? 206 : 200, {
      'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': String(end - start + 1),
      ...(match ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    })
    const stream = createReadStream(path, { start, end })
    stream.on('data', (chunk) => { sent += chunk.length })
    stream.pipe(response)
    response.on('close', () => stream.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise((resolve) => {
    server.closeAllConnections()
    server.close(() => resolve())
  }))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/clip.mp4`, ranges, bytesSent: () => sent }
}

describe('parseFfmpegDuration', () => {
  it('reads the container duration from the ffmpeg banner', () => {
    expect(parseFfmpegDuration('  Duration: 00:01:07.62, start: 0.000000, bitrate: 900 kb/s')).toBeCloseTo(67.62)
    expect(parseFfmpegDuration('  Duration: 01:00:00.00, start: 0')).toBe(3600)
  })

  it('ignores missing or unknown durations', () => {
    expect(parseFfmpegDuration('Input #0, mpegts, from pipe:')).toBeUndefined()
    expect(parseFfmpegDuration('  Duration: N/A, bitrate: N/A')).toBeUndefined()
    expect(parseFfmpegDuration('  Duration: 00:00:00.00, start: 0')).toBeUndefined()
  })
})

describe('extractRemoteVideoFrame', () => {
  it('rejects non-HTTP sources before spawning ffmpeg', async () => {
    await expect(extractRemoteVideoFrame('file:///etc/passwd', undefined, 'definitely-not-ffmpeg'))
      .rejects.toThrow('HTTP(S)')
    await expect(extractRemoteVideoFrame('not a url', undefined, 'definitely-not-ffmpeg'))
      .rejects.toThrow('HTTP(S)')
  })

  it('reports a missing ffmpeg binary as a failure', async () => {
    await expect(extractRemoteVideoFrame('http://127.0.0.1:9/clip.mp4', undefined, 'definitely-not-ffmpeg'))
      .rejects.toThrow()
  })

  it('decodes the first frame of a tail-indexed MP4 over HTTP ranges at display size', async () => {
    if (!await hasFfmpeg()) return
    const directory = await tempDir()
    const path = join(directory, 'tail-moov.mp4')
    // No +faststart: the moov index sits after 3 s of noisy media data, the
    // layout most QQ file-transfer recordings (OBS, phones) actually use.
    await execFileAsync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=s=480x270:r=30:d=3',
      '-f', 'lavfi', '-i', 'anoisesrc=d=3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '15',
      '-c:a', 'aac', '-shortest', path,
    ])
    const size = (await stat(path)).size
    const server = await serve(path)

    const frame = await extractRemoteVideoFrame(server.url)

    await expect(sharp(frame.bytes).metadata()).resolves.toMatchObject({ format: 'jpeg', width: 480, height: 270 })
    expect(frame.duration).toBeGreaterThan(2.5)
    expect(frame.duration).toBeLessThan(3.5)
    expect(server.ranges.some((range) => range !== 'none' && !range.startsWith('bytes=0-'))).toBe(true)
    expect(server.bytesSent()).toBeLessThan(size * 2)
  })

  it('applies rotation metadata so portrait phone videos keep their shape', async () => {
    if (!await hasFfmpeg()) return
    const directory = await tempDir()
    const source = join(directory, 'landscape.mp4')
    const rotated = join(directory, 'rotated.mp4')
    await execFileAsync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=green:s=320x180:d=0.3',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', source,
    ])
    await execFileAsync(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-y', '-display_rotation', '90', '-i', source, '-c', 'copy', rotated,
    ]).catch(() => undefined)
    if (!(await stat(rotated).catch(() => undefined))?.size) return
    const server = await serve(rotated)

    const frame = await extractRemoteVideoFrame(server.url)

    await expect(sharp(frame.bytes).metadata()).resolves.toMatchObject({ width: 180, height: 320 })
  })

  it('fails on a URL that serves no decodable video', async () => {
    if (!await hasFfmpeg()) return
    const directory = await tempDir()
    const path = join(directory, 'garbage.mp4')
    await import('node:fs/promises').then(({ writeFile }) => writeFile(path, Buffer.alloc(4096, 7)))
    const server = await serve(path)
    await expect(extractRemoteVideoFrame(server.url)).rejects.toThrow('ffmpeg video frame extraction failed')
  })

  it('stops ffmpeg when the caller aborts', async () => {
    if (!await hasFfmpeg()) return
    const server: Server = createServer(() => undefined)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanups.push(() => new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    }))
    const controller = new AbortController()
    const pending = extractRemoteVideoFrame(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/stall.mp4`, controller.signal,
    )
    setTimeout(() => controller.abort(new Error('caller gave up')), 200)
    await expect(pending).rejects.toThrow('caller gave up')
  })
})
