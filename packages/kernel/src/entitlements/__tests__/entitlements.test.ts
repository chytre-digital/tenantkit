/**
 * Realizes docs/09-plugins-and-subscriptions.md §3 — the tier/entitlement engine (the gate `withRoute` and the
 * plugin guard both reuse). Proven pure against a wired tier map.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  setTierEntitlements,
  setTierOrder,
  getEntitlements,
  checkEntitlements,
  assertWithinLimit,
  createEntitlementsService,
  UNLIMITED,
} from '../index'

/** Run `fn`, returning the thrown DomainError's `code` (or a sentinel), for terse assertions. */
function thrownCode(fn: () => void): string {
  try {
    fn()
    return 'NO_THROW'
  } catch (e) {
    return (e as { code?: string }).code ?? 'NO_CODE'
  }
}

describe('entitlements (doc 09 §3)', () => {
  beforeEach(() => {
    setTierOrder(['free', 'studio', 'pro'])
    setTierEntitlements({
      free: { features: { maxCourses: 1 } },
      studio: { features: { 'plugin:payments': true, maxCourses: 10 } },
      pro: { features: { 'plugin:payments': true, 'plugin:sms': true, maxCourses: UNLIMITED } },
    })
  })

  it('getEntitlements falls back to empty features for an unknown tier', () => {
    expect(getEntitlements('does-not-exist')).toEqual({ features: {} })
  })

  it('minTier gate → UPGRADE_REQUIRED below, passes at/above', () => {
    expect(thrownCode(() => checkEntitlements({ tier: 'free', minTier: 'studio' }))).toBe('UPGRADE_REQUIRED')
    expect(thrownCode(() => checkEntitlements({ tier: 'studio', minTier: 'studio' }))).toBe('NO_THROW')
    expect(thrownCode(() => checkEntitlements({ tier: 'pro', minTier: 'studio' }))).toBe('NO_THROW')
  })

  it('feature gate → FEATURE_NOT_AVAILABLE when the tier lacks it', () => {
    expect(thrownCode(() => checkEntitlements({ tier: 'free', features: ['plugin:payments'] }))).toBe('FEATURE_NOT_AVAILABLE')
    expect(thrownCode(() => checkEntitlements({ tier: 'studio', features: ['plugin:payments'] }))).toBe('NO_THROW')
  })

  it('assertWithinLimit → LIMIT_REACHED at the cap; ok under; UNLIMITED never trips', () => {
    expect(thrownCode(() => assertWithinLimit('maxCourses', 1, 'free'))).toBe('LIMIT_REACHED')
    expect(thrownCode(() => assertWithinLimit('maxCourses', 0, 'free'))).toBe('NO_THROW')
    expect(thrownCode(() => assertWithinLimit('maxCourses', 9999, 'pro'))).toBe('NO_THROW')
  })

  it('createEntitlementsService exposes has/limit/require bound to a tier', () => {
    const svc = createEntitlementsService('studio')
    expect(svc.tier).toBe('studio')
    expect(svc.has('plugin:payments')).toBe(true)
    expect(svc.has('plugin:sms')).toBe(false)
    expect(svc.limit('maxCourses')).toBe(10)
    expect(thrownCode(() => svc.require({ features: ['plugin:sms'] }))).toBe('FEATURE_NOT_AVAILABLE')
  })
})
