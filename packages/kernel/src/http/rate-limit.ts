/**
 * Realizes docs/02-reservation-core.md §4 (rateLimit) and docs/05-auth.md §6 + docs/13 §7 Phase 5 ("the full
 * bucket set live + lockouts") — per-identity token bucket with escalating lockout.
 *
 * Closes the legacy gap: auth-adjacent public endpoints were unthrottled. Buckets are keyed on BOTH client IP
 * AND identity (email/userId) so neither one IP spraying addresses nor one address from many IPs gets through.
 * The counter store is a `core.rate_limits(bucket_key, window_start, count)` row (or Upstash if present);
 * exceeding the limit → `429 RATE_LIMITED`, with a `retryAfterSeconds` hint and a `scope` ('window' | 'lockout').
 *
 * The window math (`windowStartFor`/`rateLimitWindowMs`) and the limit decision (`evaluateLimit`) are PURE and
 * exported, so the policy is unit-tested without a DB (the omluvenka lesson — keep rules out of the I/O layer,
 * doc 01 §3). `enforceRateLimit` is the thin I/O wrapper: bump the counter via the service-scoped RPC, then
 * apply the pure decision.
 *
 * PORTS REFACTOR (docs/14): the atomic counter RPC runs through `runtime.db.service()` (the service-scoped
 * `ScopedDb`) instead of a direct Supabase admin client — so any `Database` adapter backs it.
 */
import { tooManyRequests } from './errors'
import type { CoreRuntime } from '../ports'

/** A window like '10m' | '1h' | '15m' | '30s'. */
export type RateLimitWindow = `${number}${'s' | 'm' | 'h'}`

/** Escalating lockout: once the windowed count exceeds `threshold`, block for the longer `window` (doc 05 §6). */
export interface RateLimitLockout {
  threshold: number
  window: RateLimitWindow
}

export interface RateLimitSpec {
  /** Bucket name, e.g. 'magic-link' | 'otp' | 'password' | 'application-submit'. */
  key: string
  limit: number
  window: RateLimitWindow
  /** Optional escalating lockout after repeated abuse within the window. */
  lockout?: RateLimitLockout
}

/** Window string → milliseconds. Pure. */
export function rateLimitWindowMs(w: RateLimitWindow): number {
  const n = parseInt(w, 10)
  const unit = w.slice(-1)
  return unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000
}

/** The start of the fixed window containing `now` — the boundary on which the counter resets. Pure. */
export function windowStartFor(now: Date, w: RateLimitWindow): Date {
  const ms = rateLimitWindowMs(w)
  return new Date(Math.floor(now.getTime() / ms) * ms)
}

export type LimitDecision =
  | { ok: true; remaining: number }
  | { ok: false; scope: 'window' | 'lockout'; retryAfterSeconds: number }

/**
 * Pure policy: given the post-increment `count` for a (key+identity) bucket in the current window, decide
 * whether the request is allowed. A configured lockout takes precedence and yields the longer Retry-After.
 */
export function evaluateLimit(count: number, spec: RateLimitSpec): LimitDecision {
  if (spec.lockout && count > spec.lockout.threshold) {
    return { ok: false, scope: 'lockout', retryAfterSeconds: Math.ceil(rateLimitWindowMs(spec.lockout.window) / 1000) }
  }
  if (count > spec.limit) {
    return { ok: false, scope: 'window', retryAfterSeconds: Math.ceil(rateLimitWindowMs(spec.window) / 1000) }
  }
  return { ok: true, remaining: Math.max(0, spec.limit - count) }
}

/**
 * The standard auth-adjacent bucket set (doc 05 §6, doc 12 §4) — apps reference these instead of re-deriving the
 * limits, so "the full bucket set" is consistent across surfaces. Tune per product as needed.
 */
export const RATE_LIMIT_PRESETS = {
  'magic-link': { key: 'magic-link', limit: 5, window: '10m' },
  otp: { key: 'otp', limit: 5, window: '10m' },
  password: { key: 'password', limit: 10, window: '15m', lockout: { threshold: 20, window: '1h' } },
  'application-submit': { key: 'application-submit', limit: 10, window: '1h' },
  'self-excuse': { key: 'self-excuse', limit: 20, window: '1h' },
} as const satisfies Record<string, RateLimitSpec>

/**
 * Increment the (key + identity) bucket for the current window; throw `429` when the pure decision says so.
 * `identity` should already fold in IP + email/userId (the caller composes it from the request). The counter
 * lives behind the runtime's service-scoped DB handle, so the RPC bypasses RLS as it must.
 */
export async function enforceRateLimit(
  runtime: CoreRuntime,
  spec: RateLimitSpec,
  identity: string,
): Promise<void> {
  const windowStart = windowStartFor(new Date(), spec.window)
  const bucketKey = `${spec.key}:${identity}`

  // Atomic upsert-and-increment via a SECURITY DEFINER RPC keeps the read-modify-write race-free under load.
  const count = await runtime.db.service().rpc<number>('bump_rate_limit', {
    p_bucket_key: bucketKey,
    p_window_start: windowStart.toISOString(),
  })
  if (typeof count !== 'number') return

  const decision = evaluateLimit(count, spec)
  if (!decision.ok) {
    throw tooManyRequests('RATE_LIMITED', 'Too many requests, please try again later', {
      key: spec.key,
      limit: spec.limit,
      window: spec.window,
      scope: decision.scope,
      retryAfterSeconds: decision.retryAfterSeconds,
    })
  }
}
