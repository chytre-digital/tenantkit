/**
 * Realizes docs/02-reservation-core.md §13 (locale resolution) for the API edge.
 *
 * `withRoute` resolves the request locale from the cookie/header (there is no `[locale]` URL segment on an API
 * route). The full app chain is URL `[locale]` → user profile → tenant default → system default (doc 02 §13);
 * at the API edge only the latter parts apply. Defaults are safe.
 */
import { cookies, headers } from 'next/headers'
import type { Locale } from '../i18n/create-i18n'

const LOCALE_COOKIE = 'NEXT_LOCALE'
const DEFAULT_LOCALE: Locale = 'cs'
const SUPPORTED: Locale[] = ['cs', 'en']

export async function resolveLocale(): Promise<Locale> {
  // 1) explicit cookie set by next-intl's middleware / a user toggle.
  const store = await cookies()
  const cookieLocale = store.get(LOCALE_COOKIE)?.value
  if (cookieLocale && SUPPORTED.includes(cookieLocale)) return cookieLocale

  // 2) Accept-Language header — first supported match.
  const h = await headers()
  const accept = h.get('accept-language') ?? ''
  const fromHeader = accept
    .split(',')
    .map((part) => part.split(';')[0]?.trim().slice(0, 2))
    .find((code): code is Locale => !!code && SUPPORTED.includes(code))
  if (fromHeader) return fromHeader

  // 3) system default. (The per-user profile / tenant-default steps are applied by the page layer.)
  return DEFAULT_LOCALE
}
