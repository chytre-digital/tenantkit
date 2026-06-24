/**
 * Realizes docs/14-portability-and-providers.md §7 (in-memory adapter) — the `IdentityProvider` and
 * `SessionStore` ports (ports/index.ts §1) over the shared `MemoryStore`'s `authUsers` table.
 *
 * Deterministic GoTrue stand-in. Every flow the kernel needs is modeled with plain maps, no crypto, no network:
 *   • password    — `signInWithPassword` checks the seeded cleartext password (TESTS ONLY).
 *   • magic link  — `createMagicLink` mints a single-use token into a map and returns a URL embedding it; the
 *                   adapter sends NOTHING (the EmailProvider does — same contract as Supabase generateLink).
 *   • OTP         — `requestOtp` stashes a fixed 6-digit code per email; `verifyOtp` checks it.
 *   • OAuth       — `oauthAuthorizeUrl` returns a fake authorize URL; `oauthExchange` accepts a fake `code`
 *                   shaped `oauth:<email>` and signs that user in (auto-provisioning).
 *   • provisioning — `createUser` inserts an authUsers row (staff-invite / guardian-claim path).
 *
 * Sessions are opaque tokens `sess:<userId>` (the port says the shape is the adapter's business). The
 * `SessionStore` reads/writes them as a cookie; the test runtime turns the cookie back into the actor header
 * the `MemoryDatabase` reads — closing the identity → RLS loop end-to-end (doc 14 §3.1).
 */
import type { AuthSession, AuthUser, IdentityProvider, SessionStore } from '@tenantkit/kernel'
import type { AuthUserRow, MemoryStore } from './store'

/** Cookie name the session token is stored under (the in-memory analogue of `sb-…-auth-token`). */
export const MEMORY_SESSION_COOKIE = 'memory-session'
/** Fixed OTP a test can rely on when it didn't capture the one `requestOtp` generated. */
export const MEMORY_DEFAULT_OTP = '000000'

/** Encode/decode the opaque session token ⇄ user id. The format is private to this adapter. */
export const encodeSessionToken = (userId: string): string => `sess:${userId}`
export const decodeSessionToken = (token: string | null | undefined): string | null =>
  token && token.startsWith('sess:') ? token.slice('sess:'.length) : null

interface IdentityDeps {
  store: MemoryStore
  /** Injected clock so issued sessions expire deterministically (default: +1h from `clock.now()`). */
  now: () => Date
  /** Injected token minter (the runtime passes the deterministic IdGen) for magic-link tokens. */
  mintToken: () => string
}

export class MemoryIdentity implements IdentityProvider {
  /** token → email, single-use; popped on verify. */
  private magicLinks = new Map<string, string>()
  /** email → otp code. */
  private otps = new Map<string, string>()

  constructor(private readonly deps: IdentityDeps) {}

  async getCurrentUser(req: Request): Promise<AuthUser | null> {
    const userId = decodeSessionToken(readSessionCookie(req.headers.get('cookie')))
    if (!userId) return null
    const row = this.findById(userId)
    return row ? toAuthUser(row) : null
  }

  async signInWithPassword(input: { email: string; password: string }): Promise<AuthSession> {
    const row = this.findByEmail(input.email)
    if (!row || row.password !== input.password) {
      throw new Error('[memory-identity] invalid credentials')
    }
    return this.session(row)
  }

  async createMagicLink(input: { email: string; redirectTo: string }): Promise<{ token: string; url: string }> {
    // Auto-provision on magic link (Supabase's shouldCreateUser default), so passwordless onboarding works.
    const row = this.findByEmail(input.email) ?? this.insertUser(input.email)
    const token = this.deps.mintToken()
    this.magicLinks.set(token, row.email)
    const url = `${input.redirectTo}${input.redirectTo.includes('?') ? '&' : '?'}token=${token}`
    return { token, url }
  }

  async verifyMagicLink(token: string): Promise<AuthSession> {
    const email = this.magicLinks.get(token)
    if (!email) throw new Error('[memory-identity] invalid or used magic-link token')
    this.magicLinks.delete(token) // single-use
    const row = this.findByEmail(email)
    if (!row) throw new Error('[memory-identity] magic-link user vanished')
    row.emailVerified = true // verifying a link proves the address
    return this.session(row)
  }

  async requestOtp(email: string): Promise<void> {
    // Anti-enumeration: behave the same whether or not the user exists (auto-provision like Supabase OTP).
    if (!this.findByEmail(email)) this.insertUser(email)
    this.otps.set(email, MEMORY_DEFAULT_OTP)
  }

  async verifyOtp(input: { email: string; code: string }): Promise<AuthSession> {
    const expected = this.otps.get(input.email)
    if (!expected || expected !== input.code) throw new Error('[memory-identity] invalid OTP')
    this.otps.delete(input.email)
    const row = this.findByEmail(input.email)
    if (!row) throw new Error('[memory-identity] otp user vanished')
    row.emailVerified = true
    return this.session(row)
  }

  async oauthAuthorizeUrl(input: { provider: string; redirectTo: string }): Promise<string> {
    // The URL is computed server-side (the async-ification recorded in doc 14 §7). Encode a fake exchange code.
    return `https://oauth.test/${input.provider}/authorize?redirect=${encodeURIComponent(input.redirectTo)}`
  }

  async oauthExchange(input: { provider: string; code: string }): Promise<AuthSession> {
    // A test supplies `code = "oauth:<email>"`; we sign that identity in, provisioning it if new.
    const email = input.code.startsWith('oauth:') ? input.code.slice('oauth:'.length) : null
    if (!email) throw new Error('[memory-identity] oauth code must look like "oauth:<email>"')
    const row = this.findByEmail(email) ?? this.insertUser(email, { emailVerified: true })
    return this.session(row)
  }

  async signOut(_req: Request): Promise<void> {
    // Stateless tokens: the SessionStore clears the cookie. Nothing server-side to revoke in the memory model.
  }

  async createUser(input: { email: string; password?: string }): Promise<AuthUser> {
    if (this.findByEmail(input.email)) throw new Error('[memory-identity] user already exists')
    const row = this.insertUser(input.email, { password: input.password, emailVerified: true })
    return toAuthUser(row)
  }

  // ── helpers ──

  private session(row: AuthUserRow): AuthSession {
    const expiresAt = this.deps.now().getTime() + 60 * 60 * 1000 // +1h, deterministic via injected clock
    return {
      user: toAuthUser(row),
      accessToken: encodeSessionToken(row.id),
      refreshToken: `refresh:${row.id}`,
      expiresAt,
    }
  }

  private findByEmail(email: string): AuthUserRow | undefined {
    return this.deps.store.authUsers.find((u) => u.email.toLowerCase() === email.toLowerCase())
  }
  private findById(id: string): AuthUserRow | undefined {
    return this.deps.store.authUsers.find((u) => u.id === id)
  }
  private insertUser(email: string, extra: Partial<AuthUserRow> = {}): AuthUserRow {
    const row: AuthUserRow = {
      id: `user-${this.deps.store.authUsers.length + 1}`,
      email,
      emailVerified: extra.emailVerified ?? false,
      password: extra.password,
    }
    this.deps.store.authUsers.push(row)
    return row
  }
}

/**
 * `SessionStore` over the opaque token cookie. `read` decodes the cookie; `write` sets it on the Response;
 * `refresh` re-issues a session if the cookie is valid (the `updateSession` analogue); `clear` deletes it.
 */
export class MemorySessionStore implements SessionStore {
  constructor(private readonly deps: IdentityDeps) {}

  async read(req: Request): Promise<AuthSession | null> {
    const userId = decodeSessionToken(readSessionCookie(req.headers.get('cookie')))
    return userId ? this.sessionFor(userId) : null
  }

  async write(res: Response, session: AuthSession): Promise<void> {
    res.headers.append('set-cookie', serializeSessionCookie(session.accessToken))
  }

  async refresh(req: Request, res: Response): Promise<AuthSession | null> {
    const userId = decodeSessionToken(readSessionCookie(req.headers.get('cookie')))
    if (!userId) return null
    const session = this.sessionFor(userId)
    if (!session) return null
    // Rotate: re-stamp the cookie on the outgoing response (token is stable, expiry refreshed).
    res.headers.append('set-cookie', serializeSessionCookie(session.accessToken))
    return session
  }

  async clear(res: Response): Promise<void> {
    res.headers.append('set-cookie', `${MEMORY_SESSION_COOKIE}=; Path=/; Max-Age=0`)
  }

  private sessionFor(userId: string): AuthSession | null {
    const row = this.deps.store.authUsers.find((u) => u.id === userId)
    if (!row) return null
    return {
      user: toAuthUser(row),
      accessToken: encodeSessionToken(row.id),
      refreshToken: `refresh:${row.id}`,
      expiresAt: this.deps.now().getTime() + 60 * 60 * 1000,
    }
  }
}

export function createMemoryIdentity(deps: IdentityDeps): MemoryIdentity {
  return new MemoryIdentity(deps)
}
export function createMemorySessionStore(deps: IdentityDeps): MemorySessionStore {
  return new MemorySessionStore(deps)
}

function toAuthUser(row: AuthUserRow): AuthUser {
  return { id: row.id, email: row.email, emailVerified: row.emailVerified }
}

function readSessionCookie(header: string | null): string | undefined {
  if (!header) return undefined
  for (const pair of header.split(';')) {
    const i = pair.indexOf('=')
    if (i === -1) continue
    if (pair.slice(0, i).trim() === MEMORY_SESSION_COOKIE) {
      return decodeURIComponent(pair.slice(i + 1).trim())
    }
  }
  return undefined
}

function serializeSessionCookie(token: string): string {
  return `${MEMORY_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`
}
