/**
 * `EmailComposer` — the vendor-free port for one-off transactional email COMPOSITION (docs/10 §3 sibling).
 *
 * `defineEmail`/`sendEmail` cover the template-per-locale pipeline; apps still need a cheaper shape for
 * ad-hoc notifier emails (greeting + one paragraph + optional CTA button + optional fine-print), where every
 * app hand-rolled its own HTML builder and escaping. This port names that shape once; the concrete branded
 * renderer lives behind it (`createTransactionalComposer` in @deverjak/tenantkit-email-resend). Composition is
 * pure — no transport — so the result plugs into `runtime.email.send` / the kernel's `sendEmail` unchanged.
 */

export interface TransactionalEmailInput {
  /** Opening line, e.g. "Dobrý den, Jano," — rendered as its own paragraph. */
  greeting: string
  /** The main paragraph. */
  body: string
  /** Optional call-to-action button; plaintext gets `label: href` on its own line. */
  cta?: { href: string; label: string }
  /** Optional small secondary paragraph after the CTA (fine print, permanent URLs, cancel links). */
  extra?: string
}

/** Pure composition: input → branded `{ html, text }` pair, ready for an `EmailProvider` send. */
export interface EmailComposer {
  compose(input: TransactionalEmailInput): { html: string; text: string }
}
