/**
 * Realizes docs/14-portability-and-providers.md §4 (`PaymentProvider` port, "mock for tests" adapter) + §7.
 *
 * A fake `PaymentProvider` (ports/index.ts §4) for the `payments` plugin's tests. It does NO network and holds
 * NO Stripe types — instead:
 *   • checkout calls return a deterministic fake hosted-checkout URL AND record the intent, so a test can assert
 *     "a subscription checkout for tenant t1 / plan pro was opened".
 *   • `refund()` returns a deterministic `refundRef`.
 *   • `verifyWebhook(req, secret)` does NOT verify a signature — it reads a JSON body shaped like a neutral
 *     `PaymentEvent` and returns it (or `{ type: 'ignored' }`). This lets the plugin's webhook handler be tested
 *     by POSTing a plain JSON event, with zero Stripe signing. You can also queue events with `enqueueEvent()`.
 *
 * The real `@tenantkit/payments-stripe` maps Stripe's signed events to this SAME `PaymentEvent` union — so the
 * plugin code under test is byte-identical whether it runs on the mock or on Stripe.
 */
import type { PaymentEvent, PaymentProvider } from '@tenantkit/kernel'

/** A recorded checkout intent (subscription or one-off course payment) for assertions. */
export type CheckoutIntent =
  | { kind: 'subscription'; tenantId: string; plan: string; returnUrl: string; url: string }
  | {
      kind: 'payment'
      tenantId: string
      enrollmentId: string
      amountMinor: number
      currency: string
      returnUrl: string
      url: string
    }

/** A recorded refund for assertions. */
export interface RefundIntent {
  paymentRef: string
  amountMinor?: number
  refundRef: string
}

export interface MemoryPaymentProvider extends PaymentProvider {
  /** Every checkout opened, in order. */
  readonly checkouts: CheckoutIntent[]
  /** Every refund issued, in order. */
  readonly refunds: RefundIntent[]
  /** Queue an event that the NEXT `verifyWebhook()` returns (overrides the request body parse). */
  enqueueEvent(event: PaymentEvent): void
  clear(): void
}

export function createMemoryPayments(): MemoryPaymentProvider {
  const checkouts: CheckoutIntent[] = []
  const refunds: RefundIntent[] = []
  const eventQueue: PaymentEvent[] = []
  let counter = 0

  const nextId = (prefix: string): string => {
    counter += 1
    return `${prefix}_${counter}`
  }

  return {
    checkouts,
    refunds,

    async createSubscriptionCheckout(input) {
      const url = `https://checkout.test/${nextId('sub')}?tenant=${input.tenantId}&plan=${input.plan}`
      checkouts.push({ kind: 'subscription', ...input, url })
      return { url }
    },

    async createPaymentCheckout(input) {
      const url = `https://checkout.test/${nextId('pay')}?enrollment=${input.enrollmentId}`
      checkouts.push({ kind: 'payment', ...input, url })
      return { url }
    },

    async refund(input) {
      const refundRef = nextId('re')
      refunds.push({ ...input, refundRef })
      return { refundRef }
    },

    /**
     * No signature verification (there is no Stripe here). A queued event wins; otherwise the request body is
     * parsed as a `PaymentEvent`. Anything unparseable becomes `{ type: 'ignored' }`, matching how the real
     * adapter treats events it doesn't care about.
     */
    async verifyWebhook(req: Request, _secret: string): Promise<PaymentEvent> {
      const queued = eventQueue.shift()
      if (queued) return queued
      try {
        const body = (await req.json()) as Partial<PaymentEvent>
        if (body && typeof body === 'object' && typeof body.type === 'string') {
          return body as PaymentEvent
        }
      } catch {
        /* fall through to ignored */
      }
      return { type: 'ignored' }
    },

    enqueueEvent(event) {
      eventQueue.push(event)
    },
    clear() {
      checkouts.length = 0
      refunds.length = 0
      eventQueue.length = 0
    },
  }
}
