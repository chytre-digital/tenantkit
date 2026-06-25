/**
 * `PaymentProvider` port → Stripe. Used by the `payments` plugin (docs/09 §5). Two checkout flows — tenant
 * billing (subscription → drives `core.tenants.tier`) and course payment (one-off → `payments.orders`) — plus
 * refunds and webhook verification that maps Stripe events to the kernel's VENDOR-NEUTRAL `PaymentEvent` union,
 * so the plugin never sees a Stripe type. Swap this package for `@tenantkit/payments-gopay` and nothing else changes.
 */
import Stripe from 'stripe'
import type { PaymentEvent, PaymentProvider } from '@deverjak/tenantkit-kernel'

export interface StripePaymentsOptions {
  secretKey: string
  webhookSecret: string
}

export function createStripePayments(opts: StripePaymentsOptions): PaymentProvider {
  const stripe = new Stripe(opts.secretKey)

  return {
    async createSubscriptionCheckout({ tenantId, plan, returnUrl }) {
      const s = await stripe.checkout.sessions.create({
        mode: 'subscription',
        line_items: [{ price: plan, quantity: 1 }],
        success_url: returnUrl,
        cancel_url: returnUrl,
        metadata: { tenantId, kind: 'tenant_subscription' },
      })
      return { url: s.url ?? returnUrl }
    },

    async createPaymentCheckout({ tenantId, enrollmentId, amountMinor, currency, returnUrl }) {
      const s = await stripe.checkout.sessions.create({
        mode: 'payment',
        line_items: [
          { price_data: { currency, unit_amount: amountMinor, product_data: { name: 'Course fee' } }, quantity: 1 },
        ],
        success_url: returnUrl,
        cancel_url: returnUrl,
        metadata: { tenantId, enrollmentId, kind: 'course_payment' },
      })
      return { url: s.url ?? returnUrl }
    },

    async refund({ paymentRef, amountMinor }) {
      const r = await stripe.refunds.create({ payment_intent: paymentRef, amount: amountMinor })
      return { refundRef: r.id }
    },

    async verifyWebhook(req, secret) {
      const sig = req.headers.get('stripe-signature') ?? ''
      const body = await req.text()
      const evt = stripe.webhooks.constructEvent(body, sig, secret || opts.webhookSecret)
      return mapEvent(evt)
    },
  }
}

/** Stripe event → the kernel's neutral PaymentEvent (ports/index.ts §4). Unknown events collapse to `ignored`. */
function mapEvent(evt: Stripe.Event): PaymentEvent {
  switch (evt.type) {
    case 'customer.subscription.updated':
    case 'customer.subscription.created': {
      const sub = evt.data.object as Stripe.Subscription
      return {
        type: 'subscription.updated',
        tenantId: String(sub.metadata['tenantId'] ?? ''),
        tier: String(sub.metadata['tier'] ?? 'free'),
        status: sub.status,
        // Stripe API 2025-03-31+ (SDK v18+) moved `current_period_end` off the Subscription onto each
        // SubscriptionItem; the subscription's period end is the first item's. (Was `sub.current_period_end`.)
        currentPeriodEnd: (sub.items.data[0]?.current_period_end ?? 0) * 1000,
      }
    }
    case 'checkout.session.completed': {
      const s = evt.data.object as Stripe.Checkout.Session
      return {
        type: 'payment.succeeded',
        enrollmentId: String(s.metadata?.['enrollmentId'] ?? ''),
        paymentRef: String(s.payment_intent ?? ''),
        amountMinor: s.amount_total ?? 0,
      }
    }
    case 'charge.refunded': {
      const c = evt.data.object as Stripe.Charge
      return { type: 'refund.succeeded', paymentRef: String(c.payment_intent ?? ''), refundRef: c.id }
    }
    default:
      return { type: 'ignored' }
  }
}
