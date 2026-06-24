/**
 * Realizes docs/02-reservation-core.md §12 and docs/09-plugins-and-subscriptions.md §4 — the plugin guard.
 *
 * The single chokepoint used by `withRoute({ plugin })` (pipeline step 6) AND inside every plugin route. It
 * enforces BOTH halves and passes only if both hold:
 *   (a) ACTIVATION  — a `core.plugin_activations` row with `is_enabled = true`
 *   (b) ENTITLEMENT — `tenants.tier` grants the feature key `plugin:<id>` (checkEntitlements)
 * Either failing → `422 PLUGIN_NOT_ENABLED`. The legacy guard checked activation only; folding the entitlement
 * check in is what makes "plugins are entitlements" real at the request boundary (doc 09 §4).
 *
 * PORTS REFACTOR (docs/14 §4): the two cross-cutting reads — the activation row and the tenant tier — go through
 * `runtime.authz.getPluginActivation` / `getTenantTier` (both service-backed in the adapter so they see the row
 * regardless of the caller's RLS). No Supabase import; the entitlement half reuses the same engine as `withRoute`.
 */
import type { CoreRuntime } from '../ports'
import { unprocessable } from '../http/errors'
import { checkEntitlements, type Tier } from '../entitlements'
import type { PluginId } from './define-plugin'

/** Why the guard failed — surfaced so the admin grid shows "Zapnout" (enable) vs "Upgradovat plán" (upgrade). */
export type PluginGateReason = 'activation' | 'entitlement'

/**
 * Throws `422 PLUGIN_NOT_ENABLED` unless the tenant has the plugin enabled AND is entitled to it.
 * Reads the activation row and the tenant's tier via the runtime's `AuthzStore` (a cross-cutting check that must
 * see the row regardless of the caller's RLS); the entitlement half reuses the same engine as `withRoute`.
 */
export async function assertPluginEnabled(
  runtime: CoreRuntime,
  tenantId: string,
  pluginId: PluginId,
): Promise<void> {
  const [activation, tier] = await Promise.all([
    runtime.authz.getPluginActivation(tenantId, pluginId),
    runtime.authz.getTenantTier(tenantId),
  ])

  // (a) activation
  if (!activation?.enabled) {
    throw unprocessable('PLUGIN_NOT_ENABLED', `Plugin "${pluginId}" is not enabled for this tenant`, {
      reason: 'activation' satisfies PluginGateReason,
      pluginId,
    })
  }

  // (b) entitlement — reuse the tier engine; a downgrade fails here even though activation still says enabled.
  try {
    checkEntitlements({ tier: (tier ?? 'free') as Tier, features: [`plugin:${pluginId}`] })
  } catch {
    throw unprocessable('PLUGIN_NOT_ENABLED', `Plan does not include plugin "${pluginId}"`, {
      reason: 'entitlement' satisfies PluginGateReason,
      pluginId,
    })
  }
}
