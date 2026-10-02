import type { Duplex } from 'node:stream'

/**
 * The socket surface `ServerConnection` and the Mtproto service need from a
 * transport. `net.Socket` satisfies it structurally; the WebSocket bridge
 * implements it on top of a `Duplex` so browser clients (which cannot open TCP
 * sockets) speak the same MTProto byte stream over `ws://`/`wss://`.
 *
 * The TCP tuning methods are optional: the WebSocket bridge leaves them as
 * no-ops because WS framing has no Nagle/keepalive/idle-timeout equivalent.
 */
export interface ServerTransportSocket extends Duplex {
  remoteAddress?: string
  remotePort?: number
  setNoDelay?(noDelay: boolean): unknown
  setKeepAlive?(enable: boolean, initialDelayMs: number): unknown
  setTimeout?(timeoutMs: number): unknown
}
