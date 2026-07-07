/**
 * `EmailProvider` port → Resend. The transactional transport the kernel's `sendEmail(runtime, …)` delegates to
 * (docs/14 §4; the Resend `import` used to live in the kernel — it now lives here, behind the port).
 *
 * Four load-bearing behaviors, each a legacy lesson made structural (docs/10 §1):
 *   • IDEMPOTENT — `idempotencyKey` forwarded so a retried outbox tick can't double-send.
 *   • GRACEFUL  — no API key → `skipped`; a provider error → `error` RETURNED, never thrown (must not break enrollment).
 */
import { Resend } from 'resend'
import type { EmailMessage, EmailProvider, EmailSendResult } from '@deverjak/tenantkit-kernel'

export { createTransactionalComposer, type TransactionalComposerOptions } from './transactional'

export interface ResendEmailOptions {
  /** Default From, e.g. "Termínář <no-reply@terminar.cz>". A message's own `from` overrides it. */
  from: string
  /** Defaults to `process.env.RESEND_API_KEY`. Missing key → every send is cleanly `skipped`. */
  apiKey?: string
}

export function createResendEmail(opts: ResendEmailOptions): EmailProvider {
  const key = opts.apiKey ?? process.env.RESEND_API_KEY
  const client = key ? new Resend(key) : null

  return {
    async send(msg: EmailMessage): Promise<EmailSendResult> {
      if (!client) return { status: 'skipped', reason: 'no_api_key' }
      try {
        const { data, error } = await client.emails.send(
          {
            from: msg.from || opts.from,
            to: msg.to,
            replyTo: msg.replyTo,
            subject: msg.subject,
            html: msg.html,
            text: msg.text,
            tags: toResendTags(msg.tags),
          },
          msg.idempotencyKey ? { idempotencyKey: msg.idempotencyKey } : undefined,
        )
        if (error) return { status: 'error', error: error.message }
        return { status: 'ok', id: data?.id ?? 'unknown' }
      } catch (e) {
        return { status: 'error', error: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}

function toResendTags(tags?: Record<string, string>): Array<{ name: string; value: string }> | undefined {
  return tags ? Object.entries(tags).map(([name, value]) => ({ name, value })) : undefined
}
