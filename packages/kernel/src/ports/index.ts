/**
 * Realizes docs/14-portability-and-providers.md — the PORTS that decouple `reservation-core` from Supabase,
 * Resend, and Stripe so it runs on ANY Postgres with bring-your-own auth / email / payments.
 *
 * The rule: core depends ONLY on these interfaces. Concrete providers ship as separate adapter packages
 * (`@reservation-core/adapter-supabase`, `@reservation-core/adapter-postgres`, `@reservation-core/email-resend`,
 * `@reservation-core/payments-stripe`, …) selected in the app's `core.config.ts`. The one HARD dependency is
 * Postgres + RLS (a Postgres feature, not a Supabase one — see ADR-0009); identity reaches RLS through the
 * `core.current_user_id()` GUC indirection (see src/db/index.ts), which every Database adapter sets.
 *
 * These are interfaces only — no implementation, no vendor imports. That is the whole point.
 */

// ─────────────────────────────────────────────────────────────────────────────
// 1) IdentityProvider — WHO is the caller, and the auth flows (replaces Supabase Auth / GoTrue)
// ─────────────────────────────────────────────────────────────────────────────

export interface AuthUser {
  id: string
  email: string | null
  emailVerified: boolean
}

/** Adapters: Supabase Auth (native), Auth.js/NextAuth, Lucia, or a custom GoTrue-compatible IdP. */
export interface IdentityProvider {
  /** Resolve the authenticated user from the incoming request (cookies/headers). Null = anonymous. */
  getCurrentUser(req: Request): Promise<AuthUser | null>

  /** Password sign-in → a session the SessionStore can persist. */
  signInWithPassword(input: { email: string; password: string }): Promise<AuthSession>

  /** Passwordless: issue a single-use magic link (the adapter sends nothing — EmailProvider does). */
  createMagicLink(input: { email: string; redirectTo: string }): Promise<{ token: string; url: string }>
  verifyMagicLink(token: string): Promise<AuthSession>

  /** 6-digit OTP fallback. */
  requestOtp(email: string): Promise<void>
  verifyOtp(input: { email: string; code: string }): Promise<AuthSession>

  /** OAuth (Google/Apple/Microsoft…). Async: most IdPs (incl. Supabase) compute the authorize URL server-side. */
  oauthAuthorizeUrl(input: { provider: string; redirectTo: string }): Promise<string>
  oauthExchange(input: { provider: string; code: string }): Promise<AuthSession>

  signOut(req: Request): Promise<void>

  /** Admin-side user provisioning (staff invite accept, participant-account claim) — service-level, re-checks authz in code. */
  createUser(input: { email: string; password?: string }): Promise<AuthUser>
}

export interface AuthSession {
  user: AuthUser
  /** Opaque tokens the SessionStore writes into cookies; shape is the adapter's business. */
  accessToken: string
  refreshToken?: string
  expiresAt: number
}

/** Persists/refreshes the session across requests (the `updateSession`/cookie concern, framework-bound). */
export interface SessionStore {
  read(req: Request): Promise<AuthSession | null>
  write(res: Response, session: AuthSession): Promise<void>
  refresh(req: Request, res: Response): Promise<AuthSession | null>
  clear(res: Response): Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) Database — tenant-scoped Postgres access. Core owns the SCHEMA + RLS; the app owns its query layer.
//    This port is deliberately NARROW: it does not try to be an ORM. It exposes (a) identity-scoped vs
//    service-role execution and (b) the handful of cross-cutting reads core itself performs.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A handle whose statements run under a given role with `core.current_user_id()` resolved (RLS-enforced).
 * Refined while building the Supabase reference adapter (docs/14 §7): identity is REQUEST-scoped, not an
 * explicit actorId — Supabase derives it from the session cookie's JWT; a direct-driver adapter does
 * `SET LOCAL app.user_id` from the verified session. Hence `Database.forRequest(req)` below.
 */
export interface ScopedDb {
  /** Call a SECURITY DEFINER / RPC function (e.g. redeem_credit_into_session, create_tenant_with_owner). */
  rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T>
  /**
   * Raw tagged-template SQL → rows. OPTIONAL: driver adapters (pg/postgres.js/Drizzle) and the `service`
   * scope implement it; PostgREST-only adapters (Supabase user/anon scope) omit it — use the adapter's
   * native client (`.from()`) or an `rpc()` there instead.
   */
  query?<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>
  /** Atomic unit of work; the actor identity holds for its lifetime. */
  tx<T>(fn: (db: ScopedDb) => Promise<T>): Promise<T>
}

/** The three role-scoped handles available within one HTTP request. */
export interface RequestDb {
  /** RLS-enforced AS the authenticated caller (Supabase: cookie JWT; pg: `SET LOCAL app.user_id`). */
  user(): ScopedDb
  /** `anon` role for public catalogue reads — RLS still applies, no identity. */
  anon(): ScopedDb
  /** Service role — BYPASSES RLS (webhooks/cron/provisioning); the caller MUST re-check authz in code. */
  service(): ScopedDb
}

export interface Database {
  /** Request-scoped handles; identity comes from the request's session/cookie. */
  forRequest(req: Request): RequestDb
  /** Out-of-band service handle (cron jobs, scripts, tests) — no request; bypasses RLS. */
  service(): ScopedDb
}

/** The focused reads `requireClaims`/guards/entitlements need — implementable over any `Database`. */
export interface AuthzStore {
  ensureProfile(userId: string, email: string | null): Promise<ProfileRow>
  getMemberships(userId: string): Promise<Array<{ tenantId: string; role: string }>>
  getParticipantAccounts(userId: string): Promise<Array<{ participantId: string; tenantId: string; relation: string }>>
  getPluginActivation(tenantId: string, pluginId: string): Promise<{ enabled: boolean } | null>
  getTenantTier(tenantId: string): Promise<string>
  provisionTenant(input: { name: string; slug: string; ownerId: string }): Promise<{ tenantId: string }>
}
export interface ProfileRow { fullName: string | null; locale: string | null; avatarUrl: string | null; phone: string | null }

// ─────────────────────────────────────────────────────────────────────────────
// 3) EmailProvider — transactional send (replaces the direct Resend import)
// ─────────────────────────────────────────────────────────────────────────────

export interface EmailMessage {
  to: string | string[]
  from: string
  replyTo?: string
  subject: string
  html: string
  text?: string
  idempotencyKey?: string
  tags?: Record<string, string>
}
export type EmailSendResult =
  | { status: 'ok'; id: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string }

/** Adapters: Resend, SMTP/Nodemailer, AWS SES, Postmark, or a console adapter for local dev. Never throws. */
export interface EmailProvider {
  send(message: EmailMessage): Promise<EmailSendResult>
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) PaymentProvider — used by the `payments` plugin (replaces the direct Stripe import)
// ─────────────────────────────────────────────────────────────────────────────

export interface PaymentProvider {
  /** Tenant billing: a subscription Checkout that ultimately drives `core.tenants.tier`. */
  createSubscriptionCheckout(input: { tenantId: string; plan: string; returnUrl: string }): Promise<{ url: string }>
  /** Course payment: a one-off Checkout for an enrollment fee (optionally split via Connect-style payouts). */
  createPaymentCheckout(input: { tenantId: string; enrollmentId: string; amountMinor: number; currency: string; returnUrl: string }): Promise<{ url: string }>
  refund(input: { paymentRef: string; amountMinor?: number }): Promise<{ refundRef: string }>
  /** Verify + normalize a provider webhook into a vendor-neutral event the plugin maps. */
  verifyWebhook(req: Request, secret: string): Promise<PaymentEvent>
}
export type PaymentEvent =
  | { type: 'subscription.updated'; tenantId: string; tier: string; status: string; currentPeriodEnd: number }
  | { type: 'payment.succeeded'; enrollmentId: string; paymentRef: string; amountMinor: number }
  | { type: 'payment.failed'; enrollmentId: string; reason: string }
  | { type: 'refund.succeeded'; paymentRef: string; refundRef: string }
  | { type: 'ignored' }

/** Adapters: Stripe (reference), GoPay / Comgate (CZ), Adyen, or a mock for tests. */

// ─────────────────────────────────────────────────────────────────────────────
// 5) StorageProvider — files (logos, exports). Optional; replaces Supabase Storage.
// ─────────────────────────────────────────────────────────────────────────────

export interface StorageProvider {
  put(input: { bucket: string; key: string; body: ArrayBuffer | Uint8Array; contentType: string }): Promise<{ key: string }>
  signedUrl(input: { bucket: string; key: string; expiresInSec: number }): Promise<string>
  remove(input: { bucket: string; key: string }): Promise<void>
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) Clock + IdGen — injected so the domain is deterministic in tests (no Date.now()/random in core logic)
// ─────────────────────────────────────────────────────────────────────────────

export interface Clock { now(): Date }
export interface IdGen { uuid(): string; token(bytes?: number): string }

// ─────────────────────────────────────────────────────────────────────────────
// The runtime: the bag of ports an app wires once and `withRoute` reads from. No vendor types anywhere above.
// ─────────────────────────────────────────────────────────────────────────────

export interface CoreRuntime {
  identity: IdentityProvider
  sessions: SessionStore
  db: Database
  authz: AuthzStore
  email: EmailProvider
  payments?: PaymentProvider
  storage?: StorageProvider
  clock: Clock
  ids: IdGen
}
