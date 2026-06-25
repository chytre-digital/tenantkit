/**
 * Realizes docs/09-plugins-and-subscriptions.md §5 (subscribe + fan-out) + docs/13 §4/§6 ("core.outbox event
 * bus") — the in-process EVENT BUS.
 *
 * `createEventBus({ registry })` is what the app wires once. It joins the two subscriber sources behind one
 * `emit`:
 *   1. CORE LISTENERS registered with `on(type, handler)` — the app's own decoupled reactions (e.g. "send the
 *      enrollment.confirmed email"). `on` returns an unsubscribe fn.
 *   2. PLUGIN HANDLERS from the registry's `handlersFor(type)` (define-plugin.ts `events`), auto-included so a
 *      plugin reacts to a core event WITHOUT the core knowing the plugin exists — exactly the SDK seam (doc 09 §5).
 *
 * `emit(event)` fans out via `dispatchEvent` (never throws; failures captured). `publish({type,tenantId,payload})`
 * is the convenience that STAMPS the `id`/`occurredAt` and emits — using the injected `ids`/`clock` (for
 * deterministic tests), falling back to Web Crypto + the wall clock exactly as the rate-limiter does
 * (http/rate-limit.ts), since this is infrastructure, not the deterministic domain layer.
 *
 * Vendor-free: depends only on the plugin registry shape and the `IdGen`/`Clock` ports — no DB, no transport.
 */
import type { Clock, IdGen } from '../ports'
import type { CoreEvent, EventHandler } from '../plugins/define-plugin'
import type { PluginRegistry } from '../plugins/registry'
import { dispatchEvent, type DispatchTarget } from './dispatch'
import type { OutboxEvent, EventSubscriber, DispatchResult, SubscriberFailure } from './types'

export interface EventBusOptions {
  /** The plugin registry; its `handlersFor(event)` are folded into every `emit`. Omit for a core-only bus. */
  registry?: Pick<PluginRegistry, 'handlersFor'>
  /** Called once per subscriber failure — the seam to log / mark the outbox row for retry. */
  onError?: (failure: SubscriberFailure, event: OutboxEvent) => void
  /** Injected for deterministic `publish` ids in tests; falls back to `crypto.randomUUID()`. */
  ids?: Pick<IdGen, 'uuid'>
  /** Injected for a deterministic `publish` timestamp in tests; falls back to the wall clock. */
  clock?: Clock
}

/** Args to `publish` — everything but the stamped `id`/`occurredAt`, which it fills in (overridable). */
export interface PublishInput<P = unknown> {
  type: CoreEvent
  tenantId: string
  payload: P
  idempotencyKey?: string
  /** Override the generated id (e.g. reuse the persisted `core.outbox.id` when draining). */
  id?: string
  /** Override the timestamp (e.g. the persisted `occurred_at`). */
  occurredAt?: string
}

export interface EventBus {
  /** Subscribe a core listener to a `CoreEvent`. Returns an unsubscribe fn. `opts.name` labels it in failures. */
  on<P = unknown>(type: CoreEvent, handler: EventSubscriber<P>, opts?: { name?: string }): () => void
  /** Fan a fully-formed event out to every core listener + plugin handler. Never throws. */
  emit(event: OutboxEvent): Promise<DispatchResult>
  /** Build an `OutboxEvent` (stamping id/occurredAt) and `emit` it. */
  publish<P = unknown>(input: PublishInput<P>): Promise<DispatchResult>
}

export function createEventBus(opts: EventBusOptions = {}): EventBus {
  const listeners = new Map<CoreEvent, Array<{ name: string; handler: EventSubscriber }>>()
  let seq = 0

  const on: EventBus['on'] = (type, handler, o) => {
    const entry = { name: o?.name ?? `${type}#${++seq}`, handler: handler as EventSubscriber }
    const bucket = listeners.get(type) ?? []
    bucket.push(entry)
    listeners.set(type, bucket)
    return () => {
      const b = listeners.get(type)
      if (!b) return
      const i = b.indexOf(entry)
      if (i !== -1) b.splice(i, 1)
    }
  }

  function targetsFor(event: OutboxEvent): DispatchTarget[] {
    const core: DispatchTarget[] = (listeners.get(event.type) ?? []).map((l) => ({ name: l.name, handler: l.handler }))
    const plugins: DispatchTarget[] = (opts.registry?.handlersFor(event.type) ?? []).map(({ pluginId, handler }) => ({
      name: `plugin:${pluginId}`,
      handler: adaptPluginHandler(handler),
    }))
    // Core listeners first, then plugins — a stable, documented order (DispatchResult.failures follows it).
    return [...core, ...plugins]
  }

  const emit: EventBus['emit'] = (event) => dispatchEvent(event, targetsFor(event), opts.onError)

  const publish: EventBus['publish'] = (input) =>
    emit({
      id: input.id ?? opts.ids?.uuid() ?? crypto.randomUUID(),
      type: input.type,
      tenantId: input.tenantId,
      payload: input.payload,
      occurredAt: input.occurredAt ?? (opts.clock?.now() ?? new Date()).toISOString(),
      idempotencyKey: input.idempotencyKey,
    })

  return { on, emit, publish }
}

/** Bridge the plugin handler's `{type,tenantId,payload}` shape (define-plugin.ts) to an `EventSubscriber`. */
function adaptPluginHandler(handler: EventHandler): EventSubscriber {
  return (event) => handler({ type: event.type, tenantId: event.tenantId, payload: event.payload })
}
