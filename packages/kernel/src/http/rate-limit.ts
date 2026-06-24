/**
 * Realizes docs/02-reservation-core.md §4 (rateLimit) and docs/05-auth.md §6 — per-identity token bucket.
 *
 * Closes the legacy gap: auth-adjacent public endpoints were unthrottled. Buckets are keyed on BOTH client IP
 * AND identity (email/userId) so neither one IP spraying addresses nor one address from many IPs gets through.
 * The counter store is a `core.rate_limits(bucket_key, window_start, count)` row (or Upstash if present);
 * exceeding the limit → `429 RATE_LIMITED`.
 *
 * PORTS REFACTOR (docs/14): the atomic counter RPC runs through `runtime.db.service()` (the service-scoped
 * `ScopedDb`) instead of a direct Supabase admin client — so any `Database` adapter backs it.
 */
import { tooManyRequests } from './errors'
import type { CoreRuntime } from '../ports'

export interface RateLimitSpec {
  /** Bucket name, e.g. 'magic-link' | 'otp' | 'password' | 'application-submit'. */
  key: string
  limit: number
  /** Window like '10m' | '1h' | '15m'. */
  window: `${number}${'s' | 'm' | 'h'}`
}

function windowMs(w: RateLimitSpec['window']): number {
  const n = parseInt(w, 10)
  const unit = w.slice(-1)
  return unit === 's' ? n * 1000 : unit === 'm' ? n * 60_000 : n * 3_600_000
}

/**
 * Increment the (key + identity) bucket for the current window; throw `429` when it exceeds `limit`.
 * `identity` should already fold in IP + email/userId (the caller composes it from the request). The counter
 * lives behind the runtime's service-scoped DB handle, so the RPC bypasses RLS as it must.
 */
export async function enforceRateLimit(
  runtime: CoreRuntime,
  spec: RateLimitSpec,
  identity: string,
): Promise<void> {
  const windowStart = new Date(Math.floor(Date.now() / windowMs(spec.window)) * windowMs(spec.window))
  const bucketKey = `${spec.key}:${identity}`

  // Atomic upsert-and-increment via a SECURITY DEFINER RPC keeps the read-modify-write race-free under load.
  // `rpc()` throws on a DB error, so the count is the resolved value (mapped to HTTP by jsonError if it throws).
  const count = await runtime.db.service().rpc<number>('bump_rate_limit', {
    p_bucket_key: bucketKey,
    p_window_start: windowStart.toISOString(),
  })

  if (typeof count === 'number' && count > spec.limit) {
    throw tooManyRequests('RATE_LIMITED', 'Too many requests, please try again later', {
      key: spec.key,
      limit: spec.limit,
      window: spec.window,
    })
  }
}
