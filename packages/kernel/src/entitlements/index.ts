/**
 * Realizes docs/02-reservation-core.md §10 and docs/09-plugins-and-subscriptions.md §3 — plan gating.
 *
 * A plan is a `Tier`: a map of feature keys → a boolean or a numeric limit. The strategic move (proven in
 * main-panel): a PLUGIN IS JUST A FEATURE KEY (`plugin:payments`, `plugin:sms`) — so a tier "owns" a plugin
 * and the plugin guard (plugins/guard.ts) checks BOTH "enabled" and this entitlement. `tenants.tier` is a
 * materialized column kept fresh by the payments plugin's Stripe webhooks; request-time checks read it and
 * tolerate staleness (doc 09 §3.3).
 */
import { DomainError } from '../domain/errors'

/** App-defined, e.g. 'free' | 'studio' | 'pro'. Kept open so the core doesn't hardcode a product's tiers. */
export type Tier = string
export type FeatureKey = string

/** Sentinel for an unbounded numeric limit (e.g. `maxCourses: 'unlimited'` on `pro`, doc 09 §3.2). */
export const UNLIMITED = 'unlimited' as const
export type Limit = number | typeof UNLIMITED

export interface TierEntitlements {
  /** Boolean feature flags OR numeric limits (`maxCourses`, `maxStaff`, …). */
  features: Record<FeatureKey, boolean | Limit>
}

/**
 * The tier → entitlements map. The APP supplies this (doc 02 §10: "app supplies this map"); the core ships an
 * empty default and `setTierEntitlements` wires the real one at boot (doc 02 §15).
 */
let TIER_ENTITLEMENTS: Record<Tier, TierEntitlements> = {}

export function setTierEntitlements(map: Record<Tier, TierEntitlements>): void {
  TIER_ENTITLEMENTS = map
}

/** Ordered tiers, low→high, for `minTier` comparisons. Derived from insertion order of the wired map. */
let TIER_ORDER: Tier[] = []
export function setTierOrder(order: Tier[]): void {
  TIER_ORDER = order
}

export function getEntitlements(tier: Tier): TierEntitlements {
  return TIER_ENTITLEMENTS[tier] ?? { features: {} }
}

function tierRank(tier: Tier): number {
  const i = TIER_ORDER.indexOf(tier)
  return i === -1 ? 0 : i
}

function featureEnabled(tier: Tier, key: FeatureKey): boolean {
  const v = getEntitlements(tier).features[key]
  if (typeof v === 'boolean') return v
  if (v === UNLIMITED) return true
  if (typeof v === 'number') return v > 0
  return false
}

export interface CheckEntitlementsInput {
  tier: Tier
  features?: FeatureKey[]
  minTier?: Tier
}

/**
 * Throws on failure (the route boundary catches it via `jsonError`/`mapDomainError`):
 *  - a missing feature → `FEATURE_NOT_AVAILABLE`
 *  - too low a tier   → `UPGRADE_REQUIRED`
 */
export function checkEntitlements({ tier, features = [], minTier }: CheckEntitlementsInput): void {
  if (minTier && tierRank(tier) < tierRank(minTier)) {
    throw new DomainError('UPGRADE_REQUIRED', `Requires the ${minTier} plan or higher.`, { minTier, tier })
  }
  for (const key of features) {
    if (!featureEnabled(tier, key)) {
      throw new DomainError('FEATURE_NOT_AVAILABLE', `Feature "${key}" is not available on your plan.`, { feature: key, tier })
    }
  }
}

/** Use-case-time numeric guard: `assertWithinLimit('maxCourses', count, tier)` → `LIMIT_REACHED` (doc 09 §3.2). */
export function assertWithinLimit(key: FeatureKey, current: number, tier: Tier): void {
  const limit = getEntitlements(tier).features[key]
  if (limit === UNLIMITED || limit === true) return
  if (typeof limit === 'number' && current >= limit) {
    throw new DomainError('LIMIT_REACHED', `Limit for "${key}" reached (${limit}).`, { feature: key, limit, current })
  }
}

/** The object injected into `RouteCtx.entitlements` (doc 02 §4) — a tier-bound view of the checks above. */
export interface EntitlementsService {
  readonly tier: Tier
  has(feature: FeatureKey): boolean
  limit(feature: FeatureKey): Limit | undefined
  require(input: Omit<CheckEntitlementsInput, 'tier'>): void
  assertWithinLimit(feature: FeatureKey, current: number): void
}

export function createEntitlementsService(tier: Tier): EntitlementsService {
  return {
    tier,
    has: (feature) => featureEnabled(tier, feature),
    limit: (feature) => {
      const v = getEntitlements(tier).features[feature]
      return typeof v === 'number' || v === UNLIMITED ? v : undefined
    },
    require: (input) => checkEntitlements({ tier, ...input }),
    assertWithinLimit: (feature, current) => assertWithinLimit(feature, current, tier),
  }
}

export { TIER_ENTITLEMENTS }
