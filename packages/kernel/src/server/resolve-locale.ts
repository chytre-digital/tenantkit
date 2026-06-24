/**
 * Realizes docs/02-reservation-core.md §13 (locale resolution) for the API edge — now framework-agnostic.
 *
 * `withRoute` resolves the request locale from the cookie/header on the Web `Request` (no `next/headers`, so the
 * kernel needs no Next). The full app chain is URL `[locale]` → user profile → tenant default → system default;
 * at the API edge only the latter parts apply. Defaults are safe.
 */
import { type Locale, DEFAULT_LOCALE, isSupportedLocale, readCookie } from '../i18n/locale'

const LOCALE_COOKIE = 'NEXT_LOCALE'

export function resolveLocale(req: Request): Locale {
  // 1) explicit cookie (set by the i18n middleware or a user toggle).
  const cookieLocale = readCookie(req.headers.get('cookie'), LOCALE_COOKIE)
  if (isSupportedLocale(cookieLocale)) return cookieLocale

  // 2) Accept-Language — first supported match.
  const accept = req.headers.get('accept-language') ?? ''
  const fromHeader = accept
    .split(',')
    .map((part) => part.split(';')[0]?.trim().slice(0, 2))
    .find((code): code is Locale => isSupportedLocale(code))
  if (fromHeader) return fromHeader

  // 3) system default.
  return DEFAULT_LOCALE
}
