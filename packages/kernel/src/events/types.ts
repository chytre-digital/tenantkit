/**
 * Realizes docs/09-plugins-and-subscriptions.md §5 (the event bus) + the roadmap's "core.outbox event bus"
 * (docs/13 §4 Phase 2 "lands here in skeleton form", §6 Phase 4 "fully exploited") — the EVENT CONTRACTS.
 *
 * A core domain action (an enrollment confirmed, an attendance marked excused, a payment succeeded) emits an
 * `OutboxEvent`; zero or more SUBSCRIBERS — plugin event handlers (define-plugin.ts `events`) and app/core
 * listeners — react to it. Decoupling is the whole point (doc 01 §3): the use-case that confirms an enrollment
 * does not know an email or an SMS will go out; it just emits `enrollment.created`. This file is the pure shape
 * both sides agree on; bus.ts/dispatch.ts carry the (still vendor-free) fan-out logic.
 *
 * The name `outbox` is deliberate: in production these rows are PERSISTED to `core.outbox` inside the same
 * transaction as the domain write (the transactional-outbox pattern), then a drain worker hands each row to
 * `EventBus.emit`. Persistence is the adapter's seam; the kernel ships the in-process dispatcher the worker runs.
 */
import type { CoreEvent } from '../plugins/define-plugin'

/**
 * One emitted event. `id` + `occurredAt` identify it for idempotent processing; `tenantId` scopes every handler
 * (a plugin only ever acts within the tenant that produced the event). `payload` is the event-specific data
 * (kept `unknown` here — each `CoreEvent` documents its own payload in doc 09 §5.1).
 */
export interface OutboxEvent<P = unknown> {
  id: string
  type: CoreEvent
  tenantId: string
  payload: P
  /** ISO-8601 instant the event occurred (the `core.outbox.occurred_at` column). */
  occurredAt: string
  /** Optional dedupe key so a redelivered row is a no-op downstream (mirrors the email idempotency key). */
  idempotencyKey?: string
}

/** A reaction to an event. May be async; SHOULD be idempotent (it can be redelivered). */
export type EventSubscriber<P = unknown> = (event: OutboxEvent<P>) => void | Promise<void>

/** A single subscriber's failure, captured (not thrown) so one bad handler can't sink the others. */
export interface SubscriberFailure {
  /** Stable name of the failing subscriber — a core listener's registered name, or `plugin:<id>`. */
  subscriber: string
  error: string
}

/** The outcome of fanning one event out to all its subscribers. `failures` is empty ⇒ everyone succeeded. */
export interface DispatchResult {
  event: OutboxEvent
  /** How many subscribers ran without throwing. */
  handled: number
  /** Per-subscriber failures, in target order (core subscribers first, then plugins). */
  failures: SubscriberFailure[]
}
