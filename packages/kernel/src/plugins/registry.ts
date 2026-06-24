/**
 * Realizes docs/09-plugins-and-subscriptions.md §2.1 (register) — the plugin registry.
 *
 * Registration is GLOBAL and TENANT-LESS (app boot, doc 09 §2.1): the app lists its plugins in `core.config.ts`
 * and the registry validates each spec, indexes its event handlers by `CoreEvent`, records its route module
 * under `/api/plugins/‹id›`, and folds `requiresTier` into the entitlement map (`plugin:<id>` becomes a feature
 * key). A duplicate `id` is a boot-time error.
 */
import type { Tier } from '../entitlements'
import type {
  Plugin,
  PluginId,
  CoreEvent,
  EventHandler,
  PluginRouteModule,
} from './define-plugin'

export interface PluginRegistry {
  get(id: PluginId): Plugin | undefined
  all(): Plugin[]
  handlersFor(event: CoreEvent): Array<{ pluginId: PluginId; handler: EventHandler }>
  routeFor(id: PluginId): PluginRouteModule | undefined
}

const plugins = new Map<PluginId, Plugin>()
const handlerIndex = new Map<CoreEvent, Array<{ pluginId: PluginId; handler: EventHandler }>>()
/** `plugin:<id>` feature key → the minimum tier that owns it (from `requiresTier`). Consumed by the app's
 *  tier-map merge so a plugin's gate is auto-wired into entitlements (doc 09 §3.1). */
const pluginTierRequirements = new Map<`plugin:${PluginId}`, Tier | undefined>()

/**
 * Register the app's plugins at boot. Order is the build order (doc 09 §9: payments first). Idempotent across a
 * hot reload for the same set; a genuinely duplicate id throws.
 */
export function registerPlugins(list: Plugin[]): PluginRegistry {
  for (const plugin of list) {
    if (plugins.has(plugin.id) && plugins.get(plugin.id) !== plugin) {
      throw new Error(`[plugins] duplicate plugin id "${plugin.id}"`)
    }
    plugins.set(plugin.id, plugin)

    // Index event handlers by event type for O(1) fan-out from the outbox dispatcher (doc 09 §5).
    for (const [event, handler] of Object.entries(plugin.events ?? {})) {
      if (!handler) continue
      const bucket = handlerIndex.get(event as CoreEvent) ?? []
      bucket.push({ pluginId: plugin.id, handler: handler as EventHandler })
      handlerIndex.set(event as CoreEvent, bucket)
    }

    // Record `plugin:<id>` → requiresTier so the entitlement map can be auto-extended (doc 09 §3.1:
    // plugins-are-entitlements). The app's tier map declares which tiers OWN the key; this is the bridge a
    // `defineApp` merge reads to fold plugin gates into TIER_ENTITLEMENTS.
    pluginTierRequirements.set(plugin.featureKey, plugin.requiresTier)
  }
  return registry
}

/** `plugin:<id>` → minimum owning tier, for the app's entitlement-map merge at boot. */
export function pluginTierMap(): ReadonlyMap<`plugin:${PluginId}`, Tier | undefined> {
  return pluginTierRequirements
}

export const registry: PluginRegistry = {
  get: (id) => plugins.get(id),
  all: () => [...plugins.values()],
  handlersFor: (event) => handlerIndex.get(event) ?? [],
  routeFor: (id) => plugins.get(id)?.routes,
}

/**
 * "Mount routes" notion: the app's catch-all `app/api/plugins/[id]/[...path]/route.ts` looks the handler up by
 * `(id, path, method)` and dispatches to it. Each plugin route is already wrapped with `assertPluginEnabled`
 * (guard.ts), so an un-entitled tenant never reaches plugin code (doc 09 §8).
 */
export function resolvePluginRoute(
  id: PluginId,
  path: string,
  method: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): ((...args: any[]) => Promise<Response>) | undefined {
  const mod = registry.routeFor(id)
  return mod?.[path]?.[method.toUpperCase()]
}
