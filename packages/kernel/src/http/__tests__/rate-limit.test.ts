/**
 * Realizes docs/05-auth.md §6 + docs/13 §7 Phase 5 — the rate-limit POLICY proven pure, plus a thin integration
 * check of `enforceRateLimit` over a fake runtime (no DB). Covers window math, the limit/lockout decision, the
 * preset bucket set, and the 429 envelope (scope + retryAfterSeconds).
 */
import { describe, it, expect } from 'vitest'
import type { CoreRuntime } from '../../ports'
import {
  rateLimitWindowMs,
  windowStartFor,
  evaluateLimit,
  enforceRateLimit,
  RATE_LIMIT_PRESETS,
  type RateLimitSpec,
} from '../rate-limit'

describe('window math (pure)', () => {
  it('parses window strings to ms', () => {
    expect(rateLimitWindowMs('30s')).toBe(30_000)
    expect(rateLimitWindowMs('10m')).toBe(600_000)
    expect(rateLimitWindowMs('1h')).toBe(3_600_000)
  })

  it('floors now to the fixed-window boundary', () => {
    const now = new Date('2026-06-25T08:07:30.000Z')
    expect(windowStartFor(now, '5m').toISOString()).toBe('2026-06-25T08:05:00.000Z')
    expect(windowStartFor(now, '1h').toISOString()).toBe('2026-06-25T08:00:00.000Z')
  })
})

describe('evaluateLimit (pure decision)', () => {
  const spec: RateLimitSpec = { key: 'k', limit: 5, window: '10m' }

  it('allows while count <= limit and reports remaining', () => {
    expect(evaluateLimit(1, spec)).toEqual({ ok: true, remaining: 4 })
    expect(evaluateLimit(5, spec)).toEqual({ ok: true, remaining: 0 })
  })

  it('blocks with window scope once count exceeds limit (Retry-After = window)', () => {
    expect(evaluateLimit(6, spec)).toEqual({ ok: false, scope: 'window', retryAfterSeconds: 600 })
  })

  it('escalates to lockout scope past the threshold (longer Retry-After)', () => {
    const withLockout: RateLimitSpec = { key: 'password', limit: 5, window: '15m', lockout: { threshold: 10, window: '1h' } }
    // between limit and threshold → window scope
    expect(evaluateLimit(8, withLockout)).toMatchObject({ ok: false, scope: 'window' })
    // past threshold → lockout scope, 1h Retry-After
    expect(evaluateLimit(11, withLockout)).toEqual({ ok: false, scope: 'lockout', retryAfterSeconds: 3600 })
  })
})

describe('RATE_LIMIT_PRESETS (the bucket set)', () => {
  it('ships the documented auth-adjacent buckets', () => {
    expect(Object.keys(RATE_LIMIT_PRESETS).sort()).toEqual(
      ['application-submit', 'magic-link', 'otp', 'password', 'self-excuse'].sort(),
    )
    expect(RATE_LIMIT_PRESETS.password.lockout).toEqual({ threshold: 20, window: '1h' })
  })
})

describe('enforceRateLimit (integration over a fake runtime)', () => {
  /** A minimal runtime whose service RPC returns a fixed count and records the args it was called with. */
  function runtimeReturning(count: number, capture?: (fn: string, args: Record<string, unknown>) => void): CoreRuntime {
    const scoped = {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        capture?.(fn, args)
        return count as unknown
      },
      tx: async <T>(fn: (db: unknown) => Promise<T>) => fn(scoped),
    }
    return { db: { service: () => scoped } } as unknown as CoreRuntime
  }

  const spec: RateLimitSpec = { key: 'magic-link', limit: 5, window: '10m' }

  it('passes (no throw) while under the limit, hitting bump_rate_limit with the composed bucket key', async () => {
    let seen: { fn: string; args: Record<string, unknown> } | undefined
    const rt = runtimeReturning(3, (fn, args) => (seen = { fn, args }))
    await expect(enforceRateLimit(rt, spec, 'ip|user-1')).resolves.toBeUndefined()
    expect(seen?.fn).toBe('bump_rate_limit')
    expect(seen?.args['p_bucket_key']).toBe('magic-link:ip|user-1')
    expect(typeof seen?.args['p_window_start']).toBe('string')
  })

  it('throws 429 with scope + retryAfterSeconds once over the limit', async () => {
    const rt = runtimeReturning(6)
    await expect(enforceRateLimit(rt, spec, 'ip|user-1')).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      details: { scope: 'window', retryAfterSeconds: 600, key: 'magic-link' },
    })
  })

  it('throws with lockout scope past the threshold', async () => {
    const rt = runtimeReturning(25)
    await expect(enforceRateLimit(rt, RATE_LIMIT_PRESETS.password, 'ip|user-1')).rejects.toMatchObject({
      status: 429,
      details: { scope: 'lockout', retryAfterSeconds: 3600 },
    })
  })
})
