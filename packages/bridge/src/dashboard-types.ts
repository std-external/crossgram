/** Browser-safe dashboard wire contracts; this module has no server imports. */
export type PlatformAccountStatus = 'ready' | 'loading' | 'error' | 'unsupported'

export interface PlatformAccountView {
  platformId: string
  platformKind: string
  status: PlatformAccountStatus
  displayName?: string
  firstName?: string
  lastName?: string
  username?: string
  userId?: string
  avatarUrl?: string
  virtualPhone?: string
  loginCode?: string
  validUntil?: number
  remainingSeconds?: number
  /** Whether an optional two-step verification password is configured. */
  hasPassword?: boolean
  error?: string
}

export interface CrossGramServerConfigDc {
  id: number
  ip: string
  port: number
}

export interface CrossGramServerConfig {
  name: 'CrossGram'
  enable_special_config: false
  host: string
  port: number
  rsa_key: string
  dcs: CrossGramServerConfigDc[]
}

export interface PlatformAccountDashboardData {
  accounts: PlatformAccountView[]
  serverConfig: CrossGramServerConfig
  loginTokenApprovalUrl: string
  updatedAt: number
  refresh(): Promise<void>
  /** Set, replace, or clear (null/empty) the two-step verification password. */
  setLoginPassword(platformId: string, password: string | null): Promise<void>
}

export interface StickerDashboardAccount {
  platformId: string
  platformSessionId: string
  platformKind: string
  displayName: string
  username?: string
  userId: string
}

export interface StickerDashboardAssignment {
  platformSessionId: string
  assigned: boolean
  automatic: boolean
  /**
   * Whether this account can send the pack's stickers at all. Assigning a pack
   * a platform will refuse to send only produces a visible-but-dead catalog in
   * the target client, so the dashboard surfaces the reason instead.
   */
  sendable: boolean
  /**
   * Whether this account can mirror the pack into the collection it owns, which
   * is what makes a pack it cannot send sendable after all.
   */
  saveable: boolean
}

/** Outcome of mirroring one pack into an account's own sticker collection. */
export interface StickerPackSaveResult {
  /** Stickers the platform accepted into the account's own collection. */
  saved: number
  /** Stickers whose reference belongs to another account and cannot be moved. */
  skipped: number
  /** Stickers the platform rejected. */
  failed: number
  /** Stickers left for a later call because the request hit its limit. */
  remaining: number
}

export interface StickerDashboardPack {
  providerId: string
  packId: string
  title: string
  count?: number
  version?: number
  sourcePlatformId?: string
  sourcePlatformSessionId?: string
  assignments: StickerDashboardAssignment[]
}

export interface StickerPackDashboardData {
  stickerAccounts: StickerDashboardAccount[]
  stickerPacks: StickerDashboardPack[]
  stickerUpdatedAt: number
  refreshStickerPacks(): Promise<void>
  setStickerPackAssigned(
    platformSessionId: string,
    providerId: string,
    packId: string,
    assigned: boolean,
  ): Promise<void>
  /** Mirror a pack into the collection the account owns (QQ: 收藏表情). */
  saveStickerPackToAccount(
    platformSessionId: string,
    providerId: string,
    packId: string,
  ): Promise<StickerPackSaveResult>
}

/** A bridge-owned bot that can be opened through a Telegram `t.me` link. */
export interface SystemBot {
  /** The conversation ID that the provider resolves for this bot. */
  conversationId: string
  /** Display name exposed to the WebUI and Telegram clients. */
  title: string
  /** Globally unique Telegram-style username, without `@`. */
  username: string
  /** Cordis package which registered the bot. */
  sourcePlugin: string
}

export interface BotDashboardData {
  bots: SystemBot[]
  botUpdatedAt: number
  refreshBots(): Promise<void>
}

export type BridgeDashboardData = PlatformAccountDashboardData & StickerPackDashboardData & BotDashboardData
