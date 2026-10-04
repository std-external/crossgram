import { Context } from 'cordis'
import Server from '@cordisjs/plugin-server'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, type Config } from './index.js'

/** Stands in for the admin UI behind the gate. */
function adminPage(ctx: Context): void {
  ctx.server.get('/admin', async () => new Response('admin area', { status: 200 }))
}
adminPage.inject = ['server']

/** Real cordis server with the password gate plus a stand-in admin page. */
async function startAuth(config: Partial<Config> = {}) {
  const ctx = new Context()
  const fibers = [
    ctx.plugin(Server, { host: '127.0.0.1', port: 0 }),
    ctx.plugin(apply, { password: 'hunter2', ...config }),
    ctx.plugin(adminPage),
  ]
  await Promise.all(fibers)
  return {
    url: ctx.server.baseUrl,
    stop: async () => {
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}

describe('plugin-webui-auth', () => {
  const running: Array<() => Promise<void>> = []
  afterEach(async () => {
    while (running.length) await running.pop()!()
  })
  const launch = async (config: Partial<Config> = {}) => {
    const site = await startAuth(config)
    running.push(site.stop)
    return site
  }

  it('shows a login form instead of the admin page for anonymous browsers', async () => {
    const site = await launch()
    const response = await fetch(`${site.url}/admin`, { headers: { accept: 'text/html' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    const body = await response.text()
    expect(body).toContain('<form')
    expect(body).not.toContain('admin area')
  })

  it('refuses anonymous data requests with 401 instead of html', async () => {
    const site = await launch()
    const response = await fetch(`${site.url}/admin`)
    expect(response.status).toBe(401)
  })

  it('rejects a wrong password and keeps the gate closed', async () => {
    const site = await launch()
    const response = await fetch(`${site.url}/__auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=nope',
      redirect: 'manual',
    })
    expect(response.status).toBe(401)
    expect(await response.text()).toContain('Wrong password')
    expect(response.headers.get('set-cookie')).toBeNull()
  })

  it('sets a cookie on the right password, then serves the admin page', async () => {
    const site = await launch()
    const login = await fetch(`${site.url}/__auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=hunter2',
      redirect: 'manual',
    })
    expect(login.status).toBe(303)
    const cookie = login.headers.get('set-cookie')
    expect(cookie).toContain('crossgram_auth=')
    expect(cookie).toContain('HttpOnly')

    const authed = await fetch(`${site.url}/admin`, { headers: { cookie: cookie!.split(';')[0] } })
    expect(authed.status).toBe(200)
    expect(await authed.text()).toBe('admin area')
  })

  it('accepts a JSON login body as well', async () => {
    const site = await launch()
    const login = await fetch(`${site.url}/__auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'hunter2' }),
      redirect: 'manual',
    })
    expect(login.status).toBe(303)
  })

  it('leaves public paths open to anonymous visitors', async () => {
    const site = await launch({ publicPaths: ['/webz'] })
    const response = await fetch(`${site.url}/webz/`, { headers: { accept: 'text/html' } })
    expect(response.status).not.toBe(200) // no /webz route registered, but not gated
    expect(await response.text()).not.toContain('<form method="POST" action="/__auth"')
  })

  it('opens a bare-prefix entry only when it carries a trailing star', async () => {
    const site = await launch({ publicPaths: ['/bot*'] })
    try {
      // `/bot<token>/<method>` has no separator after the prefix
      const allowed = await fetch(`${site.url}/bot123:abc/getMe`, { headers: { accept: 'text/html' } })
      expect(await allowed.text()).not.toContain('<form method="POST" action="/__auth"')
      // a path that merely shares the prefix is still gated
      const gated = await fetch(`${site.url}/bot`, { headers: { accept: 'text/html' } })
      expect(await gated.text()).not.toContain('admin area')
    } finally {
      await site.stop()
    }
  })

  it('treats a boundary prefix as a whole segment', async () => {
    const site = await launch({ publicPaths: ['/webz'] })
    try {
      // `/webz` must not open up `/webzx`, which the catch-all would otherwise serve
      const response = await fetch(`${site.url}/webzx`, { headers: { accept: 'text/html' } })
      expect(await response.text()).toContain('<form method="POST" action="/__auth"')
    } finally {
      await site.stop()
    }
  })

  it('does not accept a forged cookie', async () => {
    const site = await launch()
    const response = await fetch(`${site.url}/admin`, {
      headers: { cookie: 'crossgram_auth=deadbeef', accept: 'text/html' },
    })
    expect(await response.text()).toContain('<form')
  })
})
