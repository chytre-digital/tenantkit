/**
 * Realizes docs/02-reservation-core.md §5 — `DomainError` + `mapDomainError`.
 *
 * Lives conceptually in `@reservation-core/domain`: it carries a STABLE code but **no HTTP status** — the
 * domain layer (entitlement math, omluvenka rules, capacity checks, doc 01 §3) must not know about HTTP.
 * `mapDomainError` is the single bridge from a domain code to an `HttpError`, consumed only by `jsonError`.
 */
import { HttpError } from '../http/errors'

export class DomainError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message?: string, details?: unknown) {
    super(message ?? code)
    this.name = 'DomainError'
    this.code = code
    this.details = details
    Object.setPrototypeOf(this, DomainError.prototype)
  }
}

export function isDomainError(e: unknown): e is DomainError {
  return e instanceof DomainError
}

/** Default domain-code → HTTP-status mapping. Codes not listed fall through to 422 (a domain rule violation). */
const DOMAIN_STATUS: Record<string, number> = {
  // entitlements (doc 02 §10)
  UPGRADE_REQUIRED: 403,
  FEATURE_NOT_AVAILABLE: 403,
  LIMIT_REACHED: 422,
  // omluvenka / credits (doc 08)
  CREDIT_EXPIRED: 422,
  CREDIT_ALREADY_REDEEMED: 409,
  // capacity (doc 03 §7, doc 08)
  SESSION_FULL: 409,
  // generic
  NOT_FOUND: 404,
}

/** The single bridge: e.g. `CreditExpired → 422 CREDIT_EXPIRED`. */
export function mapDomainError(e: DomainError): HttpError {
  const status = DOMAIN_STATUS[e.code] ?? 422
  return new HttpError(status, e.code, e.message, e.details)
}
