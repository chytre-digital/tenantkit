/**
 * Realizes docs/02-reservation-core.md §13 — the i18n factory (`@reservation-core/i18n`).
 *
 * A thin factory over next-intl that returns `routing` (defineRouting), `request` (getRequestConfig loading
 * `messages/‹locale›.json`), and locale-aware `navigation` (Link/redirect/usePathname/useRouter). This deletes
 * the config DRIFT found in Restaurio (two configs, `cs` vs `en` default). Message catalogues are per-app and
 * namespaced (`admin.*`, `portal.*`, `enroll.*`, `email.*`); plugins ship their own (`plugins.payments.*`).
 * Locale resolution: URL `[locale]` → user profile → tenant default → system default.
 */
import { defineRouting } from 'next-intl/routing'
import { createNavigation } from 'next-intl/navigation'
import { getRequestConfig } from 'next-intl/server'

/** A supported locale string, e.g. 'cs' | 'en'. Apps narrow this via their `createI18n` call. */
export type Locale = string

export interface CreateI18nOptions<L extends readonly Locale[]> {
  locales: L
  defaultLocale: L[number]
  /** How a locale's messages are loaded; defaults to dynamic-importing `messages/‹locale›.json`. */
  loadMessages?: (locale: L[number]) => Promise<Record<string, unknown>>
}

// `L` is inferred as a const tuple (`['cs','en']`), which is what next-intl's tuple-generic API expects — a
// bare `string[]` would widen and demand a `pathnames` map. This mirrors how an app calls createI18n. The
// return type is inferred (the three next-intl handles) rather than annotated, so the precise tuple-narrowed
// routing type is preserved instead of widened to the broad `Pathnames<Locales>` branch.
export function createI18n<const L extends readonly Locale[]>(opts: CreateI18nOptions<L>) {
  const { locales, defaultLocale } = opts
  const load = opts.loadMessages ?? defaultLoader

  // 1) routing — the `[locale]` segment config (prefix strategy etc.).
  const routing = defineRouting({
    locales,
    defaultLocale,
    localePrefix: 'as-needed', // default locale unprefixed; others get `/‹locale›`
  })

  // 2) request — server-side per-request config: validate the requested locale, then load its catalogue.
  const request = getRequestConfig(async ({ requestLocale }) => {
    const requested = await requestLocale
    const locale = requested && locales.includes(requested) ? requested : defaultLocale
    return { locale, messages: await load(locale) }
  })

  // 3) navigation — locale-aware Link / redirect / usePathname / useRouter bound to the routing above.
  const navigation = createNavigation(routing)

  return { routing, request, navigation }
}

/** The `{ routing, request, navigation }` bundle returned by `createI18n`. */
export type I18n = ReturnType<typeof createI18n>

function defaultLoader(locale: Locale): Promise<Record<string, unknown>> {
  // Apps keep catalogues at `messages/‹locale›.json` (doc 02 §13). The `@/` alias resolves into the app.
  return import(`@/messages/${locale}.json`).then((m) => m.default as Record<string, unknown>)
}
