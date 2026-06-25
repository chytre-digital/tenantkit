/**
 * Realizes docs/09-plugins-and-subscriptions.md §5 + docs/13 §4/§6 — the event-bus contract, proven pure +
 * vendor-free. Covers: isolated fan-out (one bad handler can't sink the others), deterministic failure order,
 * plugin-registry folding (a plugin reacts without the core knowing it), unsubscribe, and deterministic
 * `publish` stamping via injected ids/clock.
 */
import { describe, it, expect, vi } from 'vitest'
import { dispatchEvent } from '../dispatch'
import { createEventBus } from '../bus'
import type { OutboxEvent } from '../types'

const evt = (over: Partial<OutboxEvent> = {}): OutboxEvent => ({
  id: 'e1',
  type: 'enrollment.created',
  tenantId: 't1',
  payload: { enrollmentId: 'en1' },
  occurredAt: '2026-06-25T08:00:00.000Z',
  ...over,
})

describe('dispatchEvent (doc 09 §5 — isolated fan-out)', () => {
  it('runs every target and reports handled count when all succeed', async () => {
    const seen: string[] = []
    const r = await dispatchEvent(evt(), [
      { name: 'a', handler: () => void seen.push('a') },
      { name: 'b', handler: async () => void seen.push('b') },
    ])
    expect(seen.sort()).toEqual(['a', 'b'])
    expect(r.handled).toBe(2)
    expect(r.failures).toEqual([])
  })

  it('captures a failing handler without throwing, and still runs the others', async () => {
    const ran: string[] = []
    const r = await dispatchEvent(evt(), [
      { name: 'ok-1', handler: () => void ran.push('ok-1') },
      { name: 'boom', handler: () => { throw new Error('kaboom') } },
      { name: 'ok-2', handler: async () => void ran.push('ok-2') },
    ])
    expect(ran.sort()).toEqual(['ok-1', 'ok-2']) // the others still ran
    expect(r.handled).toBe(2)
    expect(r.failures).toEqual([{ subscriber: 'boom', error: 'kaboom' }])
  })

  it('reports failures in TARGET order, not settle order (deterministic)', async () => {
    const r = await dispatchEvent(evt(), [
      { name: 'slow-fail', handler: async () => { await Promise.resolve(); throw new Error('slow') } },
      { name: 'fast-fail', handler: () => { throw new Error('fast') } },
    ])
    expect(r.failures.map((f) => f.subscriber)).toEqual(['slow-fail', 'fast-fail'])
  })

  it('calls onError once per failure', async () => {
    const onError = vi.fn()
    await dispatchEvent(evt(), [{ name: 'x', handler: () => { throw new Error('e') } }], onError)
    expect(onError).toHaveBeenCalledTimes(1)
    expect(onError.mock.calls[0]![0]).toEqual({ subscriber: 'x', error: 'e' })
  })
})

describe('createEventBus — core listeners', () => {
  it('delivers an emitted event to every on() listener', async () => {
    const bus = createEventBus()
    const a = vi.fn()
    const b = vi.fn()
    bus.on('enrollment.created', a)
    bus.on('enrollment.created', b)
    bus.on('payment.succeeded', vi.fn()) // different type — must not fire

    const r = await bus.emit(evt())
    expect(a).toHaveBeenCalledOnce()
    expect(b).toHaveBeenCalledOnce()
    expect(a.mock.calls[0]![0]).toMatchObject({ type: 'enrollment.created', tenantId: 't1' })
    expect(r.handled).toBe(2)
  })

  it('unsubscribe stops further delivery', async () => {
    const bus = createEventBus()
    const h = vi.fn()
    const off = bus.on('enrollment.created', h)
    await bus.emit(evt())
    off()
    await bus.emit(evt())
    expect(h).toHaveBeenCalledOnce() // only the first emit reached it
  })
})

describe('createEventBus — plugin registry folding (doc 09 §5)', () => {
  it('includes registry.handlersFor() and adapts the {type,tenantId,payload} shape', async () => {
    const pluginHandler = vi.fn((_e: unknown) => Promise.resolve())
    const registry = {
      handlersFor: (type: string) =>
        type === 'enrollment.created' ? [{ pluginId: 'sms', handler: pluginHandler }] : [],
    }
    const bus = createEventBus({ registry })
    const core = vi.fn()
    bus.on('enrollment.created', core)

    const r = await bus.emit(evt())

    expect(core).toHaveBeenCalledOnce()
    expect(pluginHandler).toHaveBeenCalledOnce()
    // the plugin handler receives the adapted {type,tenantId,payload} shape (not the full OutboxEvent)
    expect(pluginHandler).toHaveBeenCalledWith({
      type: 'enrollment.created',
      tenantId: 't1',
      payload: { enrollmentId: 'en1' },
    })
    expect(r.handled).toBe(2)
  })

  it('labels a plugin failure as plugin:<id>', async () => {
    const registry = {
      handlersFor: () => [{ pluginId: 'payments', handler: async () => { throw new Error('stripe down') } }],
    }
    const bus = createEventBus({ registry })
    const r = await bus.emit(evt())
    expect(r.failures).toEqual([{ subscriber: 'plugin:payments', error: 'stripe down' }])
  })
})

describe('createEventBus — publish stamping', () => {
  it('stamps id + occurredAt from the injected ids/clock and carries the idempotency key', async () => {
    const bus = createEventBus({
      ids: { uuid: () => 'evt-fixed' },
      clock: { now: () => new Date('2026-06-25T08:00:00.000Z') },
    })
    const seen: OutboxEvent[] = []
    bus.on('credit.issued', (e) => void seen.push(e))

    await bus.publish({ type: 'credit.issued', tenantId: 't9', payload: { creditId: 'c1' }, idempotencyKey: 'k-1' })

    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual({
      id: 'evt-fixed',
      type: 'credit.issued',
      tenantId: 't9',
      payload: { creditId: 'c1' },
      occurredAt: '2026-06-25T08:00:00.000Z',
      idempotencyKey: 'k-1',
    })
  })

  it('honours explicit id/occurredAt overrides (e.g. draining a persisted outbox row)', async () => {
    const bus = createEventBus({ ids: { uuid: () => 'generated' } })
    const seen: OutboxEvent[] = []
    bus.on('payment.succeeded', (e) => void seen.push(e))
    await bus.publish({
      type: 'payment.succeeded',
      tenantId: 't1',
      payload: {},
      id: 'row-42',
      occurredAt: '2020-01-01T00:00:00.000Z',
    })
    expect(seen[0]!.id).toBe('row-42')
    expect(seen[0]!.occurredAt).toBe('2020-01-01T00:00:00.000Z')
  })
})
