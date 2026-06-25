/**
 * Realizes docs/09-plugins-and-subscriptions.md §1–§4 — the Plugin SDK: `definePlugin` validation, the registry
 * (event indexing / route resolution / tier map / dedup), and the `assertPluginEnabled` guard (activation AND
 * entitlement). The guard is exercised over a fake runtime (no DB).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { definePlugin } from '../define-plugin'
import { registerPlugins, registry, resolvePluginRoute, pluginTierMap } from '../registry'
import { assertPluginEnabled } from '../guard'
import { setTierEntitlements, setTierOrder } from '../../entitlements'
import type { CoreRuntime } from '../../ports'

describe('definePlugin (doc 09 §1)', () => {
  it('freezes a valid spec and derives the plugin:<id> feature key', () => {
    const p = definePlugin({ id: 'payments', name: { cs: 'Platby' }, requiresTier: 'studio' })
    expect(p.featureKey).toBe('plugin:payments')
    expect(Object.isFrozen(p)).toBe(true)
  })
  it('rejects a non-kebab id', () => {
    expect(() => definePlugin({ id: 'Payments', name: { cs: 'x' } })).toThrow(/kebab/)
  })
  it('rejects a reserved dbSchema (a plugin owns its OWN schema)', () => {
    expect(() => definePlugin({ id: 'x', name: { cs: 'x' }, dbSchema: 'public' })).toThrow(/reserved/)
  })
})

describe('registry (doc 09 §2.1)', () => {
  const handler = async () => {}
  const sms = definePlugin({
    id: 'sms',
    name: { cs: 'SMS' },
    requiresTier: 'pro',
    events: { 'enrollment.created': handler },
    routes: { '/send': { POST: async () => new Response('ok') } },
  })

  it('indexes event handlers + routes and folds requiresTier into the tier map', () => {
    registerPlugins([sms])
    expect(registry.get('sms')).toBe(sms)
    expect(registry.handlersFor('enrollment.created').map((h) => h.pluginId)).toContain('sms')
    expect(typeof resolvePluginRoute('sms', '/send', 'POST')).toBe('function')
    expect(resolvePluginRoute('sms', '/send', 'GET')).toBeUndefined()
    expect(pluginTierMap().get('plugin:sms')).toBe('pro')
  })

  it('throws on a duplicate id registered as a different object', () => {
    registerPlugins([definePlugin({ id: 'dup', name: { cs: 'a' } })])
    expect(() => registerPlugins([definePlugin({ id: 'dup', name: { cs: 'b' } })])).toThrow(/duplicate/)
  })
})

describe('assertPluginEnabled (doc 09 §4 — activation AND entitlement)', () => {
  beforeEach(() => {
    setTierOrder(['free', 'pro'])
    setTierEntitlements({ free: { features: {} }, pro: { features: { 'plugin:sms': true } } })
  })

  /** A runtime exposing only the two authz reads the guard needs. */
  function runtime(activation: { enabled: boolean } | null, tier: string): CoreRuntime {
    return {
      authz: {
        getPluginActivation: async () => activation,
        getTenantTier: async () => tier,
      },
    } as unknown as CoreRuntime
  }

  it('passes when the plugin is enabled AND the tier is entitled', async () => {
    await expect(assertPluginEnabled(runtime({ enabled: true }, 'pro'), 't1', 'sms')).resolves.toBeUndefined()
  })

  it('422 PLUGIN_NOT_ENABLED (reason activation) when not enabled', async () => {
    await expect(assertPluginEnabled(runtime(null, 'pro'), 't1', 'sms')).rejects.toMatchObject({
      status: 422,
      code: 'PLUGIN_NOT_ENABLED',
      details: { reason: 'activation' },
    })
  })

  it('422 PLUGIN_NOT_ENABLED (reason entitlement) when enabled but the tier lacks it', async () => {
    await expect(assertPluginEnabled(runtime({ enabled: true }, 'free'), 't1', 'sms')).rejects.toMatchObject({
      status: 422,
      code: 'PLUGIN_NOT_ENABLED',
      details: { reason: 'entitlement' },
    })
  })
})
