/**
 * Realizes docs/02-reservation-core.md §12 and docs/09-plugins-and-subscriptions.md §1 — the Plugin SDK.
 *
 * A plugin is an optional, per-tenant feature module that touches the system through FIVE documented seams
 * only — DB schema, routes, events, UI slots, settings — and nothing else. That constraint is the point: the
 * core stays decoupled and a plugin can never destabilize it. `definePlugin` validates a `PluginSpec` and
 * returns a frozen `Plugin`.
 */
import type { ZodSchema } from 'zod'
import type { Tier } from '../entitlements'
import type { ScopedDb } from '../ports'

export type PluginId = string // 'payments' | 'sms' | 'booking-calendar' | 'ratings' | …

export interface LocalizedString {
  cs: string
  en?: string
  [locale: string]: string | undefined
}

/** Core domain events plugins may subscribe to (catalogue in doc 09 §5.1). Kept open for app-defined events. */
export type CoreEvent =
  | 'enrollment.created'
  | 'enrollment.cancelled'
  | 'attendance.recorded'
  | 'attendance.excused'
  | 'credit.issued'
  | 'credit.redeemed'
  | 'credit.expiring_soon'
  | 'session.reminder_due'
  | 'session.cancelled'
  | 'application.submitted'
  | 'application.approved'
  | 'application.rejected'
  | 'payment.succeeded'
  | 'payment.refunded'
  | (string & {})

/** Named UI injection points rendered by `<PluginSlot name=…>` (doc 02 §12, doc 09 §1). */
export type UiSlot =
  | 'admin.course.tabs'
  | 'portal.participant.actions'
  | 'enrollment.form.extra'
  | (string & {})

// Isomorphic SDK: we type React components structurally to avoid dragging React into the headless core.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReactComponent = (props: any) => unknown

export type EventHandler = (event: { type: CoreEvent; tenantId: string; payload: unknown }) => Promise<void>

/** A plugin's route module — mounted under `/api/plugins/‹id›/*`, each handler pre-wrapped with the guard. */
export interface PluginRouteModule {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [path: string]: Record<string, (...args: any[]) => Promise<Response>>
}

/**
 * Context handed to lifecycle hooks. `db` is a SCHEMA-SCOPED service-role handle (a port `ScopedDb`) that can
 * write only the plugin's own schema — never the global service handle (doc 09 §7). PORTS REFACTOR (docs/14):
 * this is a vendor-neutral `ScopedDb`, so a plugin's `onEnable`/`onDisable` runs on any `Database` adapter
 * (`rpc()`/`query()`/`tx()`); Supabase apps reach `.from()` via the adapter's `.client` escape hatch. `vault`
 * holds secrets (API keys), which must NEVER live in `plugin_settings` (doc 09 §1).
 */
export interface PluginLifecycleCtx {
  tenantId: string
  db: ScopedDb // service-scoped, fenced to the plugin's dbSchema
  settings: Record<string, unknown>
  vault: { get(key: string): Promise<string | undefined> }
}

export interface PluginSpec {
  id: PluginId
  name: LocalizedString
  requiresTier?: Tier // entitlement gate, e.g. payments → 'studio'
  dbSchema?: string // owns a Postgres schema; NEVER core/public tables
  routes?: PluginRouteModule // mounted under /api/plugins/<id>/*
  events?: Partial<Record<CoreEvent, EventHandler>> // subscribe to core.outbox events
  uiSlots?: Partial<Record<UiSlot, ReactComponent>> // inject into named slots
  settingsSchema?: ZodSchema // per-tenant config → auto-rendered settings form
  onEnable?(ctx: PluginLifecycleCtx): Promise<void> // provision per-tenant resources (idempotent)
  onDisable?(ctx: PluginLifecycleCtx): Promise<void> // tear down / suspend (data retained)
}

/** The validated, frozen plugin. `featureKey` is the entitlement key a tier owns: `plugin:<id>` (doc 09 §3.1). */
export interface Plugin extends Readonly<PluginSpec> {
  readonly featureKey: `plugin:${PluginId}`
}

export function definePlugin(spec: PluginSpec): Plugin {
  if (!spec.id || !/^[a-z][a-z0-9-]*$/.test(spec.id)) {
    throw new Error(`[plugin] invalid id "${spec.id}" — must be kebab-case`)
  }
  if (spec.dbSchema && /^(core|public|auth|storage)$/.test(spec.dbSchema)) {
    // Hard rule: a plugin owns its OWN schema and may never target a core/app schema (doc 09 §1, §8).
    throw new Error(`[plugin ${spec.id}] dbSchema "${spec.dbSchema}" is reserved — plugins own their own schema`)
  }
  return Object.freeze({ ...spec, featureKey: `plugin:${spec.id}` as const })
}
