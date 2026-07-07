/**
 * `EmailComposer` port → the branded transactional layout every tenantkit app was hand-rolling (extracted
 * verbatim from Termínář's notifications renderer). Pure composition — no Resend, no transport — packaged here
 * so the email module owns both halves of "send a notifier email": compose (this) + deliver (createResendEmail).
 *
 * Layout: greeting ¶ → body ¶ → optional CTA button (plus a plain-URL fallback line for clients that strip
 * styles) → optional fine-print ¶ → footer. Every interpolated value is HTML-escaped; the plaintext part mirrors
 * the same content with `label: href` standing in for the button.
 */
import type { EmailComposer, TransactionalEmailInput } from '@deverjak/tenantkit-kernel'

export interface TransactionalComposerOptions {
  /** Closing paragraph, e.g. "S pozdravem,\ntým Termínář". Newlines become <br/> in the HTML part. */
  footer: string
  /** CTA button background color. Defaults to #2563eb. */
  ctaColor?: string
  /** Line above the plain-URL fallback under the CTA button. Defaults to the Czech "Pokud tlačítko nefunguje…". */
  ctaFallbackLine?: string
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function createTransactionalComposer(opts: TransactionalComposerOptions): EmailComposer {
  const ctaColor = opts.ctaColor ?? '#2563eb'
  const ctaFallbackLine = opts.ctaFallbackLine ?? 'Pokud tlačítko nefunguje, otevřete tento odkaz:'
  const footerHtml = escapeHtml(opts.footer).replace(/\n/g, '<br/>')

  return {
    compose(input: TransactionalEmailInput): { html: string; text: string } {
      const { greeting, body, cta, extra } = input
      const ctaHtml = cta
        ? `<p style="margin:20px 0"><a href="${escapeHtml(cta.href)}" style="display:inline-block;background:${ctaColor};color:#fff;text-decoration:none;padding:10px 18px;border-radius:6px;font-weight:600">${escapeHtml(cta.label)}</a></p>` +
          `<p style="color:#777;font-size:13px">${escapeHtml(ctaFallbackLine)}<br/>${escapeHtml(cta.href)}</p>`
        : ''
      const extraHtml = extra ? `<p style="color:#555;font-size:13px">${escapeHtml(extra)}</p>` : ''
      const html =
        `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#1a1a1a;line-height:1.5">` +
        `<p>${escapeHtml(greeting)}</p>` +
        `<p>${escapeHtml(body)}</p>` +
        ctaHtml +
        extraHtml +
        `<p style="color:#777;font-size:13px">${footerHtml}</p>` +
        `</div>`
      const text = [greeting, body, cta ? `${cta.label}: ${cta.href}` : null, extra ?? null, opts.footer]
        .filter(Boolean)
        .join('\n\n')
      return { html, text }
    },
  }
}
