/**
 * Realizes docs/02-reservation-core.md §11 and docs/10-notifications-and-email.md §3 — `defineEmail`.
 *
 * A template renders subject AND body PER LOCALE — the legacy "hardcoded English" mistake is impossible by
 * construction (doc 10 §1). A missing locale falls back to the tenant default, then `cs`. Bodies are authored
 * with React Email (or MJML) and rendered to HTML with a plain-text part alongside.
 */
import type { Locale } from '../i18n/create-i18n'

export interface EmailRenderInput<TData> {
  data: TData
  locale: Locale
  branding: TenantBranding
}

export interface RenderedEmail {
  subject: string
  html: string
  text: string
}

/** Per-tenant branding resolved at send time from `core.tenants.branding` (doc 10 §4). */
export interface TenantBranding {
  logoUrl?: string
  fromName: string
  replyTo?: string
  colors?: { brand: string; [k: string]: string }
  poweredBy: boolean // "Powered by …" footer — dropped on pro (white-label, doc 09 §3.2)
}

export interface EmailSpec<TData> {
  /** Stable template key, namespaced (`email.*`); plugins use `plugins.<id>.email.*` (doc 10 §3). */
  key: string
  /** Per-locale subject line. */
  subject: Partial<Record<Locale, (data: TData) => string>>
  /** Per-locale body renderer → HTML. The plain-text part is derived if `text` is omitted. */
  body: Partial<Record<Locale, (input: EmailRenderInput<TData>) => string>>
  text?: Partial<Record<Locale, (input: EmailRenderInput<TData>) => string>>
}

/** The opaque template handle `sendEmail` consumes. Carries its key + a locale-resolving `render`. */
export interface EmailTemplate<TData = Record<string, unknown>> {
  key: string
  render(input: EmailRenderInput<TData>): RenderedEmail
}

const FALLBACK_LOCALES: Locale[] = ['cs']

function pick<T>(map: Partial<Record<Locale, T>>, locale: Locale): T | undefined {
  return map[locale] ?? FALLBACK_LOCALES.map((l) => map[l]).find(Boolean)
}

export function defineEmail<TData>(spec: EmailSpec<TData>): EmailTemplate<TData> {
  return {
    key: spec.key,
    render(input) {
      const subjectFn = pick(spec.subject, input.locale)
      const bodyFn = pick(spec.body, input.locale)
      if (!subjectFn || !bodyFn) {
        throw new Error(`[email ${spec.key}] no renderer for locale "${input.locale}" (and no fallback)`)
      }
      const html = bodyFn(input)
      const textFn = spec.text ? pick(spec.text, input.locale) : undefined
      return {
        subject: subjectFn(input.data),
        html,
        text: textFn ? textFn(input) : htmlToText(html),
      }
    },
  }
}

/** Cheap HTML→text fallback for the plain-text part (deliverability + a11y, doc 10 §3). */
function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+\n/g, '\n')
    .trim()
}
