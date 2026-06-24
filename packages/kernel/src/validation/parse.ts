/**
 * Realizes docs/02-reservation-core.md §6 (Validation).
 *
 * The Zod request-parsing kit. Each parser returns a `ParseResult<T>` discriminated union — never throws — so a
 * standalone call site uses the `if (isParseError(r)) return r.response` pattern. `withRoute({ body, query })`
 * calls these for you and lifts the parsed value into `ctx.input` (doc 02 §4).
 */
import { ZodError, type ZodSchema } from 'zod'
import { jsonError } from '../http/respond'
import { badRequest } from '../http/errors'

export type ParseResult<T> =
  | { success: true; data: T }
  | { success: false; response: Response }

export function isParseError<T>(r: ParseResult<T>): r is { success: false; response: Response } {
  return r.success === false
}

function fail(error: ZodError): { success: false; response: Response } {
  // 400 VALIDATION_ERROR with `issues` so the form layer can map field errors (doc 02 §5).
  return { success: false, response: jsonError(error) }
}

/** Parse + validate a JSON request body. A malformed JSON payload becomes a 400 BAD_REQUEST. */
export async function parseJson<T>(req: Request, schema: ZodSchema<T>): Promise<ParseResult<T>> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return { success: false, response: jsonError(badRequest('INVALID_JSON', 'Request body is not valid JSON')) }
  }
  const result = schema.safeParse(raw)
  return result.success ? { success: true, data: result.data } : fail(result.error)
}

/** Parse + validate the URL query string (coerced to a plain object of string|string[]). */
export function parseQuery<T>(req: Request, schema: ZodSchema<T>): ParseResult<T> {
  const params = new URL(req.url).searchParams
  const obj: Record<string, string | string[]> = {}
  for (const key of params.keys()) {
    const all = params.getAll(key)
    obj[key] = all.length > 1 ? all : all[0]!
  }
  const result = schema.safeParse(obj)
  return result.success ? { success: true, data: result.data } : fail(result.error)
}

/** Parse + validate selected request headers (e.g. an idempotency key, a tenant host). */
export function parseHeaders<T>(req: Request, schema: ZodSchema<T>): ParseResult<T> {
  const obj: Record<string, string> = {}
  req.headers.forEach((value, key) => {
    obj[key] = value
  })
  const result = schema.safeParse(obj)
  return result.success ? { success: true, data: result.data } : fail(result.error)
}
