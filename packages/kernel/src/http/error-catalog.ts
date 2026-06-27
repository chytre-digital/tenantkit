/**
 * Localized messages for the kernel's STABLE error codes — the per-locale counterpart to the machine `code`
 * every error response carries. `jsonError` (respond.ts) looks a code up here so the human-readable `error`
 * string is in the caller's language, while `code` + `details` stay stable for the client. A missing locale
 * falls back to `cs` (mirrors `defineEmail`'s catalogue + fallback, doc 02 §11).
 *
 * Scope: codes the KERNEL itself produces — HttpError factories + throw-site codes (errors.ts, with-route.ts,
 * plugins/guard.ts), DomainError statuses (domain/errors.ts), the SQLSTATE map (respond.ts `mapPgError`), plus
 * the VALIDATION_ERROR umbrella and INTERNAL. Apps localize their OWN domain codes in their own catalogues; an
 * uncatalogued code falls through to the thrown message (see respond.ts).
 */
import { type Locale, DEFAULT_LOCALE } from '../i18n/locale'

type Catalog = Partial<Record<Locale, Record<string, string>>>

const FALLBACK_LOCALES: Locale[] = [DEFAULT_LOCALE] // ['cs']

const CATALOG: Catalog = {
  cs: {
    // HttpError statuses (errors.ts)
    BAD_REQUEST: 'Neplatný požadavek.',
    UNAUTHORIZED: 'Nejprve se přihlaste.',
    FORBIDDEN: 'K této akci nemáte oprávnění.',
    NOT_FOUND: 'Nenalezeno.',
    CONFLICT: 'Tento záznam již existuje.',
    UNPROCESSABLE: 'Požadavek nelze zpracovat.',
    RATE_LIMITED: 'Příliš mnoho požadavků. Zkuste to prosím později.',
    INTERNAL: 'Vnitřní chyba serveru.',
    // specialized HttpError codes raised at throw sites
    INVALID_JSON: 'Tělo požadavku není platný JSON.',
    NOT_A_MEMBER: 'Nejste členem tohoto studia.',
    NOT_A_PARTICIPANT: 'Tento účet nemá žádné účastníky.',
    PLUGIN_NOT_ENABLED: 'Tato funkce není pro vaše studio zapnutá.',
    // DomainError codes (domain/errors.ts)
    UPGRADE_REQUIRED: 'Tato funkce vyžaduje vyšší tarif.',
    FEATURE_NOT_AVAILABLE: 'Tato funkce není ve vašem tarifu dostupná.',
    LIMIT_REACHED: 'Byl dosažen limit.',
    CREDIT_EXPIRED: 'Platnost kreditu vypršela.',
    CREDIT_ALREADY_REDEEMED: 'Kredit již byl uplatněn.',
    SESSION_FULL: 'Kapacita lekce je naplněná.',
    // SQLSTATE-derived (respond.ts mapPgError)
    FK_VIOLATION: 'Odkazovaný záznam neexistuje.',
    CONSTRAINT_VIOLATION: 'Operaci nelze provést — porušuje pravidlo.',
    DB_ERROR: 'Chyba databáze.',
    // validation umbrella — the per-field messages are localized at parse time (zod-locale.ts)
    VALIDATION_ERROR: 'Zkontrolujte prosím zadané údaje.',
  },
  en: {
    BAD_REQUEST: 'Bad request.',
    UNAUTHORIZED: 'Please sign in first.',
    FORBIDDEN: "You don't have permission for this action.",
    NOT_FOUND: 'Not found.',
    CONFLICT: 'This record already exists.',
    UNPROCESSABLE: 'The request could not be processed.',
    RATE_LIMITED: 'Too many requests. Please try again later.',
    INTERNAL: 'Internal server error.',
    INVALID_JSON: 'Request body is not valid JSON.',
    NOT_A_MEMBER: 'You are not a member of this studio.',
    NOT_A_PARTICIPANT: 'This account has no participants.',
    PLUGIN_NOT_ENABLED: 'This feature is not enabled for your studio.',
    UPGRADE_REQUIRED: 'This feature requires a higher plan.',
    FEATURE_NOT_AVAILABLE: 'This feature is not available on your plan.',
    LIMIT_REACHED: 'A limit has been reached.',
    CREDIT_EXPIRED: 'The credit has expired.',
    CREDIT_ALREADY_REDEEMED: 'The credit has already been redeemed.',
    SESSION_FULL: 'This session is full.',
    FK_VIOLATION: 'A referenced record does not exist.',
    CONSTRAINT_VIOLATION: "This operation isn't allowed — it violates a rule.",
    DB_ERROR: 'Database error.',
    VALIDATION_ERROR: 'Please check the values you entered.',
  },
}

/** The localized message for a stable `code` (falls back to `cs`), or `undefined` if not catalogued. */
export function errorMessageFor(code: string, locale: Locale): string | undefined {
  const direct = CATALOG[locale]?.[code]
  if (direct) return direct
  for (const l of FALLBACK_LOCALES) {
    const m = CATALOG[l]?.[code]
    if (m) return m
  }
  return undefined
}
