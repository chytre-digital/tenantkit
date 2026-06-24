/**
 * Realizes docs/02-reservation-core.md §5 (HTTP & error model).
 *
 * `HttpError` carries an HTTP status + a STABLE machine code (+ optional details). The factories below are the
 * canonical way route/use-case code signals a failure; `jsonError` (respond.ts) turns any throw into the
 * uniform body `{ error, code, details?, issues? }`. Promoted from both apps' duplicated error stacks into one.
 */

export class HttpError extends Error {
  readonly status: number
  readonly code: string
  readonly details?: unknown

  constructor(status: number, code: string, message?: string, details?: unknown) {
    super(message ?? code)
    this.name = 'HttpError'
    this.status = status
    this.code = code
    this.details = details
    Object.setPrototypeOf(this, HttpError.prototype)
  }
}

export function isHttpError(e: unknown): e is HttpError {
  return e instanceof HttpError
}

/**
 * Factory shape: each takes a `code` (defaulting to a sensible one) so call sites read like
 * `forbidden('NOT_A_MEMBER')` / `unprocessable('PLUGIN_NOT_ENABLED')`.
 */
type Factory = (code?: string, message?: string, details?: unknown) => HttpError

const make = (status: number, defaultCode: string): Factory =>
  (code = defaultCode, message, details) => new HttpError(status, code, message, details)

export const badRequest: Factory = make(400, 'BAD_REQUEST')
export const unauthorized: Factory = make(401, 'UNAUTHORIZED')
export const forbidden: Factory = make(403, 'FORBIDDEN')
export const notFound: Factory = make(404, 'NOT_FOUND')
export const conflict: Factory = make(409, 'CONFLICT')
export const unprocessable: Factory = make(422, 'UNPROCESSABLE')
export const tooManyRequests: Factory = make(429, 'RATE_LIMITED')
export const internal: Factory = make(500, 'INTERNAL')
