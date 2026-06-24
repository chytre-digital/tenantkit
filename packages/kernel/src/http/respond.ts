/**
 * Realizes docs/02-reservation-core.md §5 — `jsonOk` / `jsonError`.
 *
 * The universal response pair (the legacy duplicate `jsonOk`/`jsonError` resolved into one). `jsonError` maps,
 * IN ORDER: HttpError → DomainError (mapDomainError) → raw PostgrestError by PG code → ZodError →
 * fallback 500. The body shape is ALWAYS `{ error, code, details?, issues? }` so the client toast layer is
 * uniform (doc 02 §5).
 */
import { ZodError } from 'zod'
import { HttpError, isHttpError } from './errors'
import { DomainError, isDomainError, mapDomainError } from '../domain/errors'

/** 200 with the data spread at the top level: `jsonOk({ session })` → `{ session: … }`. */
export function jsonOk<T>(data: T, init?: ResponseInit): Response {
  return Response.json(data, { status: 200, ...init })
}

interface ErrorBody {
  error: string
  code: string
  details?: unknown
  issues?: unknown
}

function body(status: number, b: ErrorBody): Response {
  return Response.json(b, { status })
}

/**
 * The shape Supabase/PostgREST throws on a failed query. We duck-type it (no import of the SDK error class) so
 * a raw query rejection maps to the right HTTP status by its Postgres `code` (doc 02 §5).
 */
interface PostgrestErrorLike {
  code: string
  message: string
  details?: string | null
  hint?: string | null
}

function isPostgrestError(e: unknown): e is PostgrestErrorLike {
  return (
    typeof e === 'object' &&
    e !== null &&
    'code' in e &&
    'message' in e &&
    typeof (e as { code: unknown }).code === 'string'
  )
}

/** Postgres SQLSTATE → { HTTP status, stable code }. The common ones the apps hit (doc 02 §5, doc 04 §4). */
function mapPgError(e: PostgrestErrorLike): { status: number; code: string } {
  switch (e.code) {
    case '42501': // insufficient_privilege — an RLS denial
      return { status: 403, code: 'FORBIDDEN' }
    case '23505': // unique_violation
      return { status: 409, code: 'CONFLICT' }
    case '23503': // foreign_key_violation
      return { status: 422, code: 'FK_VIOLATION' }
    case '23514': // check_violation
    case 'P0001': // raise_exception — our SECURITY DEFINER RPCs raise these for business-rule failures
      return { status: 422, code: 'CONSTRAINT_VIOLATION' }
    case 'PGRST116': // PostgREST: no rows where exactly one expected
      return { status: 404, code: 'NOT_FOUND' }
    default:
      return { status: 500, code: 'DB_ERROR' }
  }
}

/** Universal catch — turn ANY thrown value into the uniform error response. */
export function jsonError(err: unknown): Response {
  // 1) HttpError — already carries status + code.
  if (isHttpError(err)) {
    return body(err.status, { error: err.message, code: err.code, details: err.details })
  }

  // 2) DomainError — bridge to HTTP via the single mapper.
  if (isDomainError(err)) {
    const http = mapDomainError(err)
    return body(http.status, { error: http.message, code: http.code, details: http.details })
  }

  // 3) Raw PostgrestError — map by PG code (belt-and-suspenders for RLS denials, conflicts, …).
  if (isPostgrestError(err)) {
    const { status, code } = mapPgError(err)
    return body(status, { error: err.message, code, details: err.details ?? undefined })
  }

  // 4) ZodError — a validation failure that escaped `parseJson` (e.g. validated mid-handler).
  if (err instanceof ZodError) {
    return body(400, { error: 'Validation failed', code: 'VALIDATION_ERROR', issues: err.issues })
  }

  // 5) Fallback — unknown throw. Log server-side; never leak internals to the client.
  // logger.error('Unhandled route error', { err }) — wired in the app (doc 01 §9)
  return body(500, { error: 'Internal server error', code: 'INTERNAL' })
}

export { HttpError, DomainError }
