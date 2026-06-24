/**
 * `IdentityProvider` port → Supabase Auth (GoTrue). This is WHY Supabase is the reference adapter: it
 * implements every flow the kernel needs natively (password, magic link, OTP, OAuth, admin user creation),
 * so the mapping is thin and complete.
 *
 * Magic links: we use `auth.admin.generateLink()` to MINT the link and hand it back, then the app sends it via
 * the EmailProvider (Resend) — so Resend owns the template (doc 10), not Supabase SMTP. Set Supabase Auth to
 * "no email" for magiclink if you go this route, or point Supabase SMTP at Resend and skip generateLink.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AuthSession, AuthUser, IdentityProvider } from '@tenantkit/kernel'
import { type CookieAdapter, adminClient, userClient } from './clients'

export interface SupabaseIdentityDeps {
  /** A writable cookie adapter for the current request (the @tenantkit/next binding backs this with next/headers). */
  cookies: () => Promise<CookieAdapter>
}

export class SupabaseIdentity implements IdentityProvider {
  constructor(private readonly deps: SupabaseIdentityDeps) {}

  private async client(): Promise<SupabaseClient> {
    return userClient(await this.deps.cookies())
  }

  async getCurrentUser(_req: Request): Promise<AuthUser | null> {
    const { data } = await (await this.client()).auth.getUser()
    return data.user ? toAuthUser(data.user) : null
  }

  async signInWithPassword(input: { email: string; password: string }): Promise<AuthSession> {
    const { data, error } = await (await this.client()).auth.signInWithPassword(input)
    if (error || !data.session) throw error ?? new Error('sign-in failed')
    return toAuthSession(data.session)
  }

  async createMagicLink(input: { email: string; redirectTo: string }): Promise<{ token: string; url: string }> {
    const { data, error } = await adminClient().auth.admin.generateLink({
      type: 'magiclink',
      email: input.email,
      options: { redirectTo: input.redirectTo },
    })
    if (error || !data.properties) throw error ?? new Error('generateLink failed')
    return { token: data.properties.hashed_token, url: data.properties.action_link }
  }

  async verifyMagicLink(token: string): Promise<AuthSession> {
    const { data, error } = await (await this.client()).auth.verifyOtp({ token_hash: token, type: 'magiclink' })
    if (error || !data.session) throw error ?? new Error('magic-link verify failed')
    return toAuthSession(data.session)
  }

  async requestOtp(email: string): Promise<void> {
    // Sends a 6-digit code (configure the Supabase email OTP template). Anti-enumeration: never reveals existence.
    await (await this.client()).auth.signInWithOtp({ email, options: { shouldCreateUser: true } })
  }

  async verifyOtp(input: { email: string; code: string }): Promise<AuthSession> {
    const { data, error } = await (await this.client()).auth.verifyOtp({ email: input.email, token: input.code, type: 'email' })
    if (error || !data.session) throw error ?? new Error('otp verify failed')
    return toAuthSession(data.session)
  }

  async oauthAuthorizeUrl(input: { provider: string; redirectTo: string }): Promise<string> {
    const { data, error } = await (await this.client()).auth.signInWithOAuth({
      provider: input.provider as never,
      options: { redirectTo: input.redirectTo, skipBrowserRedirect: true },
    })
    if (error || !data.url) throw error ?? new Error('oauth start failed')
    return data.url
  }

  async oauthExchange(input: { provider: string; code: string }): Promise<AuthSession> {
    const { data, error } = await (await this.client()).auth.exchangeCodeForSession(input.code)
    if (error || !data.session) throw error ?? new Error('oauth exchange failed')
    return toAuthSession(data.session)
  }

  async signOut(_req: Request): Promise<void> {
    await (await this.client()).auth.signOut()
  }

  async createUser(input: { email: string; password?: string }): Promise<AuthUser> {
    const { data, error } = await adminClient().auth.admin.createUser({
      email: input.email,
      password: input.password,
      email_confirm: true,
    })
    if (error || !data.user) throw error ?? new Error('createUser failed')
    return toAuthUser(data.user)
  }
}

export const createSupabaseIdentity = (deps: SupabaseIdentityDeps): SupabaseIdentity => new SupabaseIdentity(deps)

function toAuthUser(u: { id: string; email?: string | null; email_confirmed_at?: string | null }): AuthUser {
  return { id: u.id, email: u.email ?? null, emailVerified: Boolean(u.email_confirmed_at) }
}

function toAuthSession(s: {
  access_token: string
  refresh_token: string
  expires_at?: number
  user: { id: string; email?: string | null; email_confirmed_at?: string | null }
}): AuthSession {
  return {
    user: toAuthUser(s.user),
    accessToken: s.access_token,
    refreshToken: s.refresh_token,
    expiresAt: (s.expires_at ?? 0) * 1000,
  }
}
