/**
 * `SessionStore` port → Supabase SSR cookies. `refresh()` is the `updateSession` pattern from the reference
 * apps: build a client whose cookie writes land on the outgoing Response, call `getUser()` to rotate the token,
 * and the SSR client propagates the refreshed `Set-Cookie` headers. The @deverjak/tenantkit-next middleware calls this
 * on every request.
 */
import type { AuthSession, SessionStore } from '@deverjak/tenantkit-kernel'
import { type CookieAdapter, readOnlyCookies, userClient } from './clients'
import { type SupabaseRequestAuthOptions, normalizeRequestAuth, resolveRequestCredential } from './request-auth'

export class SupabaseSessionStore implements SessionStore {
  private readonly requestAuth: SupabaseRequestAuthOptions
  constructor(requestAuth?: SupabaseRequestAuthOptions) {
    this.requestAuth = normalizeRequestAuth(requestAuth)
  }

  async read(req: Request): Promise<AuthSession | null> {
    const client = userClient(readOnlyCookies(cookiesFromRequest(req)))
    const { data } = await client.auth.getSession()
    return data.session ? toSession(data.session) : null
  }

  async write(_res: Response, _session: AuthSession): Promise<void> {
    // No-op on Supabase: cookies are written by the SSR client during the auth call that produced the session.
    // Kept for ports that persist out-of-band (e.g. iron-session adapters).
  }

  async refresh(req: Request, res: Response): Promise<AuthSession | null> {
    // A Bearer access token is a short-lived request credential owned by the mobile client — NOT a server-managed
    // cookie session. For a Bearer request (or a malformed Authorization header on a bearer-enabled runtime) skip
    // the refresh entirely: build no client, rotate nothing, and emit NO `Set-Cookie`. Mobile refresh is Expo's job.
    const credential = resolveRequestCredential(req, this.requestAuth)
    if (credential.kind === 'bearer' || credential.kind === 'invalid') return null

    const cookies = responseCookieAdapter(req, res)
    const client = userClient(cookies)
    const { data } = await client.auth.getUser() // rotates + sets refreshed cookies onto `res`
    if (!data.user) return null
    const { data: s } = await client.auth.getSession()
    return s.session ? toSession(s.session) : null
  }

  async clear(res: Response): Promise<void> {
    const cookies = responseCookieAdapter(new Request('http://x'), res)
    await userClient(cookies).auth.signOut()
  }
}

export const createSupabaseSessionStore = (requestAuth?: SupabaseRequestAuthOptions): SupabaseSessionStore =>
  new SupabaseSessionStore(requestAuth)

function cookiesFromRequest(req: Request): { name: string; value: string }[] {
  const header = req.headers.get('cookie')
  if (!header) return []
  return header.split(';').map((p) => {
    const i = p.indexOf('=')
    return { name: p.slice(0, i).trim(), value: decodeURIComponent(p.slice(i + 1).trim()) }
  })
}

/** A cookie adapter that reads from the Request and APPENDS Set-Cookie onto the Response. */
function responseCookieAdapter(req: Request, res: Response): CookieAdapter {
  return {
    getAll: () => cookiesFromRequest(req),
    setAll: (toSet) => {
      for (const c of toSet) {
        res.headers.append('set-cookie', serializeCookie(c.name, c.value, c.options))
      }
    },
  }
}

function serializeCookie(name: string, value: string, options?: Record<string, unknown>): string {
  // Minimal serializer; the @deverjak/tenantkit-next binding uses Next's cookie API in production.
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax']
  if (process.env.NODE_ENV === 'production') parts.push('Secure')
  if (options?.['maxAge']) parts.push(`Max-Age=${String(options['maxAge'])}`)
  return parts.join('; ')
}

function toSession(s: {
  access_token: string
  refresh_token: string
  expires_at?: number
  user: { id: string; email?: string | null; email_confirmed_at?: string | null }
}): AuthSession {
  return {
    user: { id: s.user.id, email: s.user.email ?? null, emailVerified: Boolean(s.user.email_confirmed_at) },
    accessToken: s.access_token,
    refreshToken: s.refresh_token,
    expiresAt: (s.expires_at ?? 0) * 1000,
  }
}
