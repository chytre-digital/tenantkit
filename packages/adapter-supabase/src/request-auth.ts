/**
 * Request-auth resolver — the ONE internal place that decides how the current `Request` authenticates: a
 * Supabase session cookie (web) or an `Authorization: Bearer <access-token>` (mobile/Expo). Identity, Database
 * and SessionStore all funnel through `resolveRequestCredential()` so the credential is chosen ONCE per request
 * and can never diverge between the app guard (`ctx.claims`) and the RLS DB scope (`ctx.db.user()`).
 *
 * This module is intentionally vendor-free (no `@supabase/*` import) so the precedence rules are unit-testable
 * offline. Mapping a credential to a concrete Supabase client lives in `identity.ts` / `database.ts`.
 */

export type SupabaseRequestAuthMode = 'cookie' | 'bearer' | 'cookie-or-bearer'

export interface SupabaseRequestAuthOptions {
  /** Which request transports authenticate. Defaults to `cookie` for backward compatibility. */
  mode?: SupabaseRequestAuthMode
}

/**
 * The resolved credential for a request:
 *  • `bearer`    — a validated-shape `Authorization: Bearer <token>` (the token is still server-verified by identity).
 *  • `cookie`    — use the Supabase session cookie (today's behavior).
 *  • `invalid`   — bearer transport is enabled but the `Authorization` header is present-and-malformed; the
 *                  request is UNAUTHENTICATED (→ 401) and must NEVER silently fall back to the cookie.
 *  • `anonymous` — no credential at all.
 */
export type RequestCredential =
  | { kind: 'bearer'; accessToken: string }
  | { kind: 'cookie' }
  | { kind: 'invalid' }
  | { kind: 'anonymous' }

const DEFAULT_MODE: SupabaseRequestAuthMode = 'cookie'

/** Normalize the opt-in options to a concrete config (default `mode: 'cookie'`). */
export function normalizeRequestAuth(options?: SupabaseRequestAuthOptions): { mode: SupabaseRequestAuthMode } {
  return { mode: options?.mode ?? DEFAULT_MODE }
}

/**
 * Parse the `Authorization` header. Returns the token for a well-formed `Bearer <non-empty>` (scheme compared
 * case-insensitive, token trimmed at the edges only), `'malformed'` for a present-but-unusable header (empty,
 * whitespace-only, non-bearer scheme like `Basic`, or `Bearer` with no token), or `null` when absent.
 * The token is never logged nor embedded in any thrown message.
 */
function parseAuthorization(req: Request): { token: string } | 'malformed' | null {
  const header = req.headers.get('authorization')
  if (header === null) return null
  const trimmed = header.trim()
  if (trimmed === '') return 'malformed'
  const spaceIdx = trimmed.indexOf(' ')
  const scheme = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase()
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()
  if (scheme !== 'bearer') return 'malformed'
  if (rest === '') return 'malformed'
  return { token: rest }
}

/**
 * Decide the credential for this request under the configured mode.
 * Precedence (spec §4.2): Bearer wins when present in a bearer-enabled mode; a malformed Authorization header
 * becomes `invalid` (→ 401) and never falls back to cookie; pure `cookie` mode ignores Authorization entirely.
 */
export function resolveRequestCredential(req: Request, options: SupabaseRequestAuthOptions): RequestCredential {
  const { mode } = normalizeRequestAuth(options)

  // Pure cookie mode: ignore `Authorization` completely — byte-for-byte the pre-Bearer behavior.
  if (mode === 'cookie') return { kind: 'cookie' }

  const parsed = parseAuthorization(req)

  if (parsed === 'malformed') return { kind: 'invalid' }
  if (parsed !== null) return { kind: 'bearer', accessToken: parsed.token }

  // No Authorization header present.
  if (mode === 'cookie-or-bearer') return { kind: 'cookie' }
  return { kind: 'anonymous' } // pure `bearer` mode with no header
}
