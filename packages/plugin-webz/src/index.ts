import type { Context } from 'cordis'
import { readFile, stat } from 'node:fs/promises'
import { extname, normalize, resolve, sep } from 'node:path'
import z from 'schemastery'

export interface Config {
  /** Directory holding the built site (index.html plus its assets). */
  root: string
  /** URL prefix to serve under (default: ''). */
  path?: string
  /** Serve index.html for unknown paths so client-side routing works (default: true). */
  spa?: boolean
}

export const Config = z.object({
  root: z.string().required(),
  path: z.string().default(''),
  spa: z.boolean().default(true),
})

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
  '.tgs': 'application/gzip',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Serve a built single-page site (Telegram Web and similar) straight from the
 * crossgram process, so no separate static server or proxy needs to exist.
 *
 * Files are read from disk per request — a rebuilt site is picked up without a
 * restart, and nothing is held in memory. Only paths that stay inside `root`
 * after normalization are served; everything else falls back to index.html.
 */
function apply(ctx: Context, config: Config): void {
  const root = resolve(config.root)
  const prefix = normalizePrefix(config.path ?? '')
  const spa = config.spa ?? true

  ctx.server.get('{/*path}', async (req, res, next) => {
    // Only engage for our own prefix; every other path belongs to the plugins
    // around us (the WebUI keeps the site root, for instance).
    if (prefix && req.path !== prefix && !req.path.startsWith(`${prefix}/`)) return next()
    if (!prefix) {
      // Mounted at the root: defer once so a co-mounted plugin can claim first.
      const prior = await next()
      if (prior || res.claimed) return prior
    }

    // A relative base (`./assets/...`) only resolves under the trailing-slash
    // form, so redirect the bare prefix before serving anything.
    if (prefix && req.path === prefix) return redirect(`${prefix}/`)

    const route = req.path.slice(prefix.length) || '/'
    const target = resolveFile(root, route)
    let file = target
    try {
      if (!file || !(await stat(file)).isFile()) throw new Error('not a file')
    } catch {
      file = spa ? resolve(root, 'index.html') : undefined
      try {
        if (!file || !(await stat(file)).isFile()) throw new Error('no index')
      } catch {
        return new Response('Not Found', { status: 404 })
      }
    }

    const body = await readFile(file)
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': MIME_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': cacheControl(file),
      },
    })
  })
}

/** Temporary redirect that keeps the browser on the same host and scheme. */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } })
}

/** Resolve a URL path to a file inside `root`, or `undefined` if it escapes. */
function resolveFile(root: string, route: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(route)
  } catch {
    return undefined
  }
  const candidate = resolve(root, `.${normalize(decoded)}`)
  if (candidate !== root && !candidate.startsWith(root + sep)) return undefined
  return candidate
}

/** Content-addressed asset filenames are immutable; HTML must revalidate. */
function cacheControl(file: string): string {
  return file.endsWith('.html')
    ? 'no-cache'
    : 'public, max-age=31536000, immutable'
}

function normalizePrefix(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed || trimmed === '/') return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

// Attach the Cordis inject declaration to the plugin function itself so both
// `ctx.plugin(apply)` and the config loader see it.
apply.inject = ['server']

export const inject = ['server']
export default apply
export { apply }
