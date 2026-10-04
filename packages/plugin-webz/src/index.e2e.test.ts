import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { connect } from 'node:net'
import { apply, type Config } from './index.js'

/** Send a raw HTTP/1.1 GET so the path reaches the server un-normalized. */
function rawGet(baseUrl: string, path: string): Promise<string> {
  const { hostname, port } = new URL(baseUrl)
  return new Promise((resolve, reject) => {
    const socket = connect(Number(port), hostname, () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: ${hostname}\r\nConnection: close\r\n\r\n`)
    })
    let data = ''
    socket.on('data', (chunk) => { data += chunk.toString() })
    socket.on('end', () => resolve(data))
    socket.on('error', reject)
  })
}

/** Serve a temp site directory through a real cordis server over HTTP. */
async function startSite(config: Partial<Config> & Pick<Config, 'root'>) {
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
    ctx.plugin(apply, { path: '', spa: true, ...config }),
  ]
  await Promise.all(fibers)
  return {
    url: ctx.server.baseUrl,
    stop: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

describe('plugin-webz static site', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'plugin-webz-'))
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>WebZ</title>')
    await writeFile(join(dir, 'app.js'), 'console.log("webz")')
    await mkdir(join(dir, 'assets'), { recursive: true })
    await writeFile(join(dir, 'assets', 'chunk.css'), 'body{color:red}')
    await writeFile(join(dir, 'inside.txt'), 'inside-root')
    await writeFile(join(dirname(dir), 'plugin-webz-secret.txt'), 'OUTSIDE-ROOT-SECRET')
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('serves index.html at the root with the html content type', async () => {
    const site = await startSite({ root: dir })
    try {
      const response = await fetch(`${site.url}/`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/html')
      expect(response.headers.get('cache-control')).toBe('no-cache')
      expect(await response.text()).toContain('WebZ')
    } finally {
      await site.stop()
    }
  })

  it('serves nested assets with the right mime type and an immutable cache header', async () => {
    const site = await startSite({ root: dir })
    try {
      const response = await fetch(`${site.url}/assets/chunk.css`)
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toContain('text/css')
      expect(response.headers.get('cache-control')).toContain('immutable')
      expect(await response.text()).toBe('body{color:red}')
    } finally {
      await site.stop()
    }
  })

  it('falls back to index.html for client-side routes', async () => {
    const site = await startSite({ root: dir })
    try {
      const response = await fetch(`${site.url}/some/deep/route`)
      expect(response.status).toBe(200)
      expect(await response.text()).toContain('WebZ')
    } finally {
      await site.stop()
    }
  })

  it('does not fall back when spa is disabled', async () => {
    const site = await startSite({ root: dir, spa: false })
    try {
      const response = await fetch(`${site.url}/missing`)
      expect(response.status).toBe(404)
    } finally {
      await site.stop()
    }
  })

  it('honours a url prefix and leaves other paths untouched', async () => {
    const site = await startSite({ root: dir, path: '/webz' })
    try {
      const served = await fetch(`${site.url}/webz/app.js`)
      expect(served.status).toBe(200)
      expect(await served.text()).toContain('webz')
      expect(await (await fetch(`${site.url}/app.js`)).text()).not.toContain('webz')
    } finally {
      await site.stop()
    }
  })

  it('refuses to read files outside the served root', async () => {
    const site = await startSite({ root: dir, spa: false })
    try {
      // fetch() normalizes literal "../" client-side, so drive the raw socket to
      // make sure the server itself never serves above its root.
      for (const attack of [
        '/../plugin-webz-secret.txt',
        '/..%2fplugin-webz-secret.txt',
        '/%2e%2e%2fplugin-webz-secret.txt',
        '/a/../../plugin-webz-secret.txt',
      ]) {
        expect(await rawGet(site.url, attack), attack).not.toContain('OUTSIDE-ROOT-SECRET')
      }
      // sanity: a file inside the root is still readable
      expect(await (await fetch(`${site.url}/inside.txt`)).text()).toBe('inside-root')
    } finally {
      await site.stop()
    }
  })

  it('picks up a rebuilt file without a restart', async () => {
    const site = await startSite({ root: dir })
    try {
      expect(await (await fetch(`${site.url}/app.js`)).text()).toBe('console.log("webz")')
      await writeFile(join(dir, 'app.js'), 'console.log("rebuilt")')
      expect(await (await fetch(`${site.url}/app.js`)).text()).toBe('console.log("rebuilt")')
    } finally {
      await site.stop()
    }
  })
})
