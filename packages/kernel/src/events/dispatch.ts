/**
 * Realizes docs/09-plugins-and-subscriptions.md §5 — the pure fan-out primitive behind the bus.
 *
 * `dispatchEvent(event, targets)` runs every target handler and returns a `DispatchResult`. Two load-bearing
 * guarantees, both lifted from the email contract (doc 10 §1, "a failed email must not break enrollment"):
 *   • NEVER THROWS — a handler that rejects (or throws synchronously) is caught and recorded in `failures`; the
 *     other handlers still run. A side effect failing must not roll back the domain write that emitted the event.
 *   • ISOLATED + DETERMINISTIC — targets run concurrently (independent side effects), but `failures` is reported
 *     in target order, so the result is stable for tests regardless of which handler settled first.
 *
 * Pure: no ports, no I/O of its own — the handlers do the I/O. That keeps the dispatch logic unit-testable
 * without a runtime (the omluvenka lesson: keep the rules out of the side-effecting layer, doc 01 §3).
 */
import type { OutboxEvent, EventSubscriber, DispatchResult, SubscriberFailure } from './types'

/** A named handler to run for an event. The name is what shows up in `DispatchResult.failures[].subscriber`. */
export interface DispatchTarget {
  name: string
  handler: EventSubscriber
}

/**
 * Run all `targets` for `event`, collecting failures instead of throwing. `onError` (optional) is called once
 * per failure as it is recorded — the seam an app uses to log to Sentry / mark the outbox row for retry.
 */
export async function dispatchEvent(
  event: OutboxEvent,
  targets: DispatchTarget[],
  onError?: (failure: SubscriberFailure, event: OutboxEvent) => void,
): Promise<DispatchResult> {
  // `Promise.resolve().then(...)` normalizes a SYNC throw inside a handler into a rejected promise, so
  // allSettled captures both sync and async failures uniformly.
  const settled = await Promise.allSettled(
    targets.map((t) => Promise.resolve().then(() => t.handler(event))),
  )

  const failures: SubscriberFailure[] = []
  settled.forEach((outcome, i) => {
    if (outcome.status === 'rejected') {
      const failure: SubscriberFailure = { subscriber: targets[i]!.name, error: errorMessage(outcome.reason) }
      failures.push(failure)
      onError?.(failure, event)
    }
  })

  return { event, handled: targets.length - failures.length, failures }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
