/**
 * The `Locale` type + helpers — deliberately vendor-free (no next-intl) so the kernel core compiles and tests
 * with only `zod`. The next-intl wiring (routing/request/navigation) lives in the separate `@tenantkit/i18n`
 * package (it needs Next). Realizes docs/02-reservation-core.md §13.
 */
export type Locale = string

export const DEFAULT_LOCALE: Locale = 'cs'
export const SUPPORTED_LOCALES: readonly Locale[] = ['cs', 'en']

export function isSupportedLocale(code: string | undefined | null): code is Locale {
  return !!code && SUPPORTED_LOCALES.includes(code)
}

/** Read a single cookie value out of a raw `Cookie` header — used by the framework-agnostic edge helpers. */
export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=')
    if (idx === -1) continue
    if (pair.slice(0, idx).trim() === name) return decodeURIComponent(pair.slice(idx + 1).trim())
  }
  return null
}
