/**
 * Realizes docs/02-reservation-core.md §11 and docs/10-notifications-and-email.md §1 — `sendEmail`.
 *
 * PORTS REFACTOR (docs/14 §3): the kernel no longer imports Resend. It RENDERS the localized template and hands
 * a vendor-neutral `EmailMessage` to `runtime.email.send` — the `EmailProvider` adapter (Resend lives in
 * `@tenantkit/email-resend`, but it could be SES/SMTP/Postmark/console). The four load-bearing behaviors survive
 * the move, now split correctly across the boundary:
 *   • LOCALIZED — the template renders per `locale` HERE (defineEmail), before it crosses the port.
 *   • IDEMPOTENT — `idempotencyKey` rides on the `EmailMessage`; the adapter forwards it so a retried
 *     webhook/scheduler tick can't double-send (doc 10 §2).
 *   • GRACEFUL — the `EmailProvider` contract never throws: a missing key → `skipped`, a provider error →
 *     `error` RECORDED. A failed email must not break enrollment (doc 01 §9). The kernel just relays the result.
 *   • BRANDED — a per-tenant `TenantBranding` (from-name, reply-to, logo) resolved at send time (doc 10 §4) and
 *     baked into the rendered message's `from`/`replyTo` before it leaves the kernel.
 */
import type { CoreRuntime } from '../ports'
import type { Locale } from '../i18n/create-i18n'
import type { EmailTemplate, TenantBranding } from './define-email'

export interface SendEmailInput<TData = Record<string, unknown>> {
  to: string | string[]
  template: EmailTemplate<TData>
  locale: Locale
  data: TData
  idempotencyKey?: string
  tags?: Record<string, string>
  /** Resolved per-tenant branding; the app's `brandResolver` supplies it (doc 02 §15, doc 10 §4). */
  branding?: TenantBranding
  /** Overrides the default from address ("Name <addr>" form) the adapter would otherwise use. */
  from?: string
}

export type EmailResult =
  | { status: 'ok'; id: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; error: string }

const DEFAULT_BRANDING: TenantBranding = { fromName: 'Reservation', poweredBy: true }
const DEFAULT_FROM_ADDRESS = 'no-reply@example.com'

/**
 * Never throws into the request path — the `EmailProvider` contract guarantees a resolved `EmailSendResult`
 * (doc 10 §1), which we surface unchanged as an `EmailResult`. Rendering happens kernel-side; transport is the
 * adapter's job (`runtime.email.send`).
 */
export async function sendEmail<TData>(
  runtime: CoreRuntime,
  input: SendEmailInput<TData>,
): Promise<EmailResult> {
  const branding = input.branding ?? DEFAULT_BRANDING
  const rendered = input.template.render({ data: input.data, locale: input.locale, branding })

  return runtime.email.send({
    to: input.to,
    from: input.from ?? `${branding.fromName} <${fromAddress(input.from)}>`,
    replyTo: branding.replyTo,
    subject: rendered.subject,
    html: rendered.html,
    text: rendered.text,
    // Idempotency key forwarded so a retried outbox row is a no-op at the provider (doc 10 §2).
    idempotencyKey: input.idempotencyKey,
    tags: input.tags,
  })
}

function fromAddress(from?: string): string {
  // `from` may be "Name <addr>"; extract the address, falling back to a sane default.
  const match = from?.match(/<([^>]+)>/)
  return match?.[1] ?? DEFAULT_FROM_ADDRESS
}
