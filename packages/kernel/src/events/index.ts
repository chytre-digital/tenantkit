/**
 * Barrel for the kernel `events` module — the in-process `core.outbox` dispatcher (docs/09 §5, docs/13 §4/§6).
 * Re-exported from the package root (packages/kernel/src/index.ts) so apps `import { createEventBus } from
 * '@tenantkit/kernel'` and wire the plugin registry into it once.
 */
export type { OutboxEvent, EventSubscriber, SubscriberFailure, DispatchResult } from './types'
export { dispatchEvent, type DispatchTarget } from './dispatch'
export { createEventBus, type EventBus, type EventBusOptions, type PublishInput } from './bus'
