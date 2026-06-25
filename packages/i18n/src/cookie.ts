/**
 * Cookie-based i18n wiring (next-intl WITHOUT routing) — the seam for apps that key locale by a `NEXT_LOCALE`
 * cookie + the user's profile, NOT by a `[locale]` URL segment. Sits ALONGSIDE the URL-routing `createI18n`.
 *
 * The locale resolution order MATCHES the kernel's `resolveLocale` (cookie → Accept-Language → default), so the
 * UI language and the server-side validation/error language always agree for the same request. Realizes
 * docs/02-reservation-core.md §13 (the cookie/profile branch of locale resolution).
 */
import { getRequestConfig } from 'next-intl/server'
import { cookies, headers } from 'next/headers'

/** A supported locale string, e.g. 'cs' | 'en'. Apps narrow this via their `createI18nCookie` call. */
export type Locale = string

export interface CreateI18nCookieOptions<L extends readonly Locale[]> {
  locales: L
  defaultLocale: L[number]
  /** Cookie carrying the chosen locale. MUST match the kernel's `resolveLocale` cookie (default 'NEXT_LOCALE'). */
  cookieName?: string
  /** How a locale's messages are loaded; defaults to dynamic-importing `messages/‹locale›.json`. */
  loadMessages?: (locale: L[number]) => Promise<Record<string, unknown>>
}

export function createI18nCookie<const L extends readonly Locale[]>(opts: CreateI18nCookieOptions<L>) {
  const { locales, defaultLocale } = opts
  const cookieName = opts.cookieName ?? 'NEXT_LOCALE'
  const load = opts.loadMessages ?? defaultLoader
  const supported = locales as readonly string[] // widen so `.includes(string)` typechecks for a const tuple

  /** cookie → Accept-Language (first supported, 2-char) → defaultLocale. Mirrors the kernel's resolveLocale. */
  async function resolveLocale(): Promise<L[number]> {
    const fromCookie = (await cookies()).get(cookieName)?.value
    if (fromCookie && supported.includes(fromCookie)) return fromCookie as L[number]

    const accept = (await headers()).get('accept-language') ?? ''
    const fromHeader = accept
      .split(',')
      .map((part) => part.split(';')[0]?.trim().slice(0, 2))
      .find((code): code is L[number] => !!code && supported.includes(code))
    if (fromHeader) return fromHeader

    return defaultLocale
  }

  // next-intl WITHOUT routing: we supply the locale ourselves (no `[locale]` segment / middleware). An explicit
  // locale passed to `getTranslations({ locale })` still wins; otherwise resolve from the cookie/header.
  const request = getRequestConfig(async ({ locale: explicit }) => {
    const locale = explicit && supported.includes(explicit) ? (explicit as L[number]) : await resolveLocale()
    return { locale, messages: await load(locale) }
  })

  return { request, resolveLocale, locales, defaultLocale, cookieName }
}

/** The bundle returned by `createI18nCookie` — `request` (default export for `i18n/request.ts`) + `resolveLocale`. */
export type I18nCookie = ReturnType<typeof createI18nCookie>

// No `@/messages` default: an alias-based dynamic import inside this PACKAGE can't be resolved by the app's
// bundler (the alias is app-scoped, this file lives in node_modules). Apps MUST pass `loadMessages` with a path
// the bundler can see, e.g. `(l) => import(`../messages/${l}.json`).then((m) => m.default)`.
function defaultLoader(_locale: Locale): Promise<Record<string, unknown>> {
  throw new Error(
    '[tenantkit-i18n] createI18nCookie: pass `loadMessages` — e.g. (l) => import(`../messages/${l}.json`).then((m) => m.default)',
  )
}
