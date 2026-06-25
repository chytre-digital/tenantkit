/**
 * Realizes docs/01-architecture.md §9 (structured logs, "no PII") + docs/03-data-model.md §10 (GDPR) — value
 * REDACTION, driven by the same `pii` flag the field schema already carries (fields/types.ts: pii "drives
 * export/erase + log redaction").
 *
 * Two jobs:
 *   • `redact(value, { keys })` — deep-mask the named keys anywhere in a structure (the logging seam: a request
 *     logger redacts before it serializes, so an email/phone never lands in a log line).
 *   • `piiKeysOf(fields)` — derive the redaction key-set from a tenant's `FieldDefinition[]` (every field flagged
 *     `pii`, by both its `key` and its spine `columnName`), so redaction tracks the configurable schema instead
 *     of a hardcoded list. This is the kernel half of GDPR export/erase + observability.
 *
 * Pure + structure-preserving: returns a deep COPY (never mutates the input), leaves non-PII values untouched,
 * and does not traverse `Date` instances.
 */
import type { FieldDefinition } from '../fields/types'

/** The mask substituted for a redacted value. */
export const REDACTED = '[redacted]'

/** Secret-ish keys that should never appear in a log line, regardless of the field schema (doc 01 §9). */
export const DEFAULT_SECRET_KEYS: readonly string[] = [
  'password',
  'token',
  'secret',
  'accessToken',
  'refreshToken',
  'authorization',
  'apiKey',
  'vaultKey',
]

export interface RedactOptions {
  /** Key names to mask wherever they occur (exact, case-sensitive match). */
  keys: Iterable<string>
  /** The replacement string (default `[redacted]`). */
  mask?: string
}

/** Deep-copy `value`, masking any property whose key is in `options.keys`. Arrays + nested objects are walked. */
export function redact<T>(value: T, options: RedactOptions): T {
  const keys = new Set(options.keys)
  const mask = options.mask ?? REDACTED
  return walk(value, keys, mask) as T
}

function walk(v: unknown, keys: Set<string>, mask: string): unknown {
  if (Array.isArray(v)) return v.map((item) => walk(item, keys, mask))
  if (v !== null && typeof v === 'object') {
    if (v instanceof Date) return v // leave special objects intact (don't shatter them into key/value)
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = keys.has(k) ? mask : walk(val, keys, mask)
    }
    return out
  }
  return v
}

/** Convenience: mask the always-secret keys (+ any `extra`) — the "no secrets in logs" default. */
export function redactSecrets<T>(value: T, extra: Iterable<string> = []): T {
  return redact(value, { keys: [...DEFAULT_SECRET_KEYS, ...extra] })
}

/**
 * The PII key-set of a field schema: every field flagged `pii`, contributed by both its stable `key` and (when
 * it maps to a typed spine column) its `columnName` — so the same set redacts a flat form submission AND a row
 * read back from the spine. De-duplicated.
 */
export function piiKeysOf(fields: FieldDefinition[]): string[] {
  const keys = new Set<string>()
  for (const f of fields) {
    if (!f.pii) continue
    keys.add(f.key)
    if (f.columnName) keys.add(f.columnName)
  }
  return [...keys]
}

/** Redact a values record using a field schema's `pii` flags (GDPR-safe logging of participant data). */
export function redactPii<T>(value: T, fields: FieldDefinition[], opts?: { mask?: string }): T {
  return redact(value, { keys: piiKeysOf(fields), ...(opts?.mask !== undefined ? { mask: opts.mask } : {}) })
}
