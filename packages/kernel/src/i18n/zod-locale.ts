/**
 * Localized Zod error maps — the per-request seam for translating Zod's BUILT-IN validation messages
 * (e.g. "Required", "Invalid datetime") into the caller's language WITHOUT touching global state.
 *
 * Zod 4 accepts a per-parse error map: `schema.parse(data, { error: zodErrorMap(locale) })`. Each
 * `z.locales.<code>()` factory returns a fully-translated `{ localeError }`. We wire the SUPPORTED_LOCALES
 * EXPLICITLY (not `z.locales[locale]`) so adding a locale is a deliberate one-line change and the compiler
 * proves every supported locale has a factory. Vendor-free: depends only on `zod`, like the kernel core.
 * Realizes docs/02-reservation-core.md §13.
 */
import { z } from 'zod'
import { type Locale, DEFAULT_LOCALE, isSupportedLocale } from './locale'

/** Zod's per-parse error-map type, surfaced without a deep import into `zod/v4/core`. */
export type ZodErrorMap = ReturnType<typeof z.locales.cs>['localeError']

// Explicit wiring (NOT `z.locales[locale]`) so a new SUPPORTED_LOCALE is a deliberate one-liner here.
const FACTORIES: Record<Locale, () => { localeError: ZodErrorMap }> = {
  cs: z.locales.cs,
  en: z.locales.en,
}

const cache = new Map<Locale, ZodErrorMap>()

/**
 * The localized Zod error map for `locale` (falls back to {@link DEFAULT_LOCALE}). Built once per locale, then
 * memoized — pass the result to `schema.parse(data, { error })` / `schema.safeParse(data, { error })`.
 */
export function zodErrorMap(locale: Locale): ZodErrorMap {
  const key = isSupportedLocale(locale) && FACTORIES[locale] ? locale : DEFAULT_LOCALE
  let map = cache.get(key)
  if (!map) {
    map = FACTORIES[key]!().localeError
    cache.set(key, map)
  }
  return map
}

/**
 * Layer a `custom` error map over a `fallback`. `custom` WINS when it returns a string or `{ message }`;
 * returning `null`/`undefined` DEFERS to `fallback` (typically {@link zodErrorMap}). Lets an app localize its
 * OWN field messages while inheriting Zod's translated built-ins for every other issue.
 */
export function composeErrorMap(custom: ZodErrorMap, fallback: ZodErrorMap): ZodErrorMap {
  return (issue) => {
    const r = custom(issue)
    return r != null ? r : fallback(issue)
  }
}
