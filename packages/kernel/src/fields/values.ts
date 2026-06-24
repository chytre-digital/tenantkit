/**
 * Realizes ADR-0011 ("value read/write across spine + JSONB") + migration 0004 (storage='column' vs 'jsonb',
 * grouped by `target`) — the VALUE ROUTER between the typed spine and the per-target jsonb bags.
 *
 * The schema is a presentation+validation layer OVER a small typed spine (participants.full_name,
 * date_of_birth, note; the application's guardian_* columns; enrollments.payment_status) PLUS a jsonb bag per
 * subject (participants.custom / enrollments.custom). These two functions are the only place that knows the
 * routing rule, so persistence stays a dumb "write these columns / merge this jsonb" per target:
 *
 *   splitValues(fields, flat)  →  { columns: { participant:{…}, guardian:{…}, enrollment:{…} },
 *                                   custom:  { participant:{…}, guardian:{…}, enrollment:{…} } }
 *   mergeValues(fields, { columns, custom })  →  flat { key: value }   (the inverse, for edit/portal reads)
 *
 * Routing rule (per field):
 *   - storage='column'  → goes to `columns[target][columnName]`  (the typed spine; needs `columnName`)
 *   - storage='jsonb'   → goes to `custom[target][key]`          (the jsonb bag, keyed by the stable field key)
 *
 * Pure, lossless round-trip: `mergeValues(fields, splitValues(fields, v))` ⊇ the keys present in `v`.
 */
import type { FieldDefinition, FieldTarget } from './types'

/** Per-target buckets. Targets with no fields are present but empty, so callers can index without guards. */
export type ByTarget<V> = Record<FieldTarget, V>

export interface SplitValues {
  /** Typed spine: `columns[target][columnName] = value` (insert/update the target's real columns). */
  columns: ByTarget<Record<string, unknown>>
  /** JSONB bag: `custom[target][fieldKey] = value` (merge into the target's `custom` jsonb). */
  custom: ByTarget<Record<string, unknown>>
}

const TARGETS: readonly FieldTarget[] = ['participant', 'guardian', 'enrollment']

function emptyByTarget(): ByTarget<Record<string, unknown>> {
  return { participant: {}, guardian: {}, enrollment: {} }
}

/**
 * Split a flat `{ fieldKey: value }` (e.g. a validated form submission) into spine columns + custom jsonb,
 * grouped by target. Only keys PRESENT in `values` are routed (an absent optional field stays absent — it
 * won't clobber an existing column/jsonb entry on update). A `column` field missing its `columnName` is a
 * misconfiguration; it is skipped (the spine has nowhere to put it) rather than silently dumped into jsonb.
 */
export function splitValues(
  fields: FieldDefinition[],
  values: Record<string, unknown>,
): SplitValues {
  const columns = emptyByTarget()
  const custom = emptyByTarget()

  for (const field of fields) {
    if (!(field.key in values)) continue
    const value = values[field.key]
    if (field.storage === 'column') {
      if (!field.columnName) continue // guarded misconfig: column storage requires a target column
      columns[field.target][field.columnName] = value
    } else {
      custom[field.target][field.key] = value
    }
  }

  return { columns, custom }
}

/** The persisted record shape `mergeValues` reads — one target's columns + that target's jsonb bag. */
export interface TargetRecord {
  columns: Record<string, unknown>
  custom: Record<string, unknown>
}

/**
 * Read values back to a flat `{ fieldKey: value }` for an edit form / portal view — the inverse of
 * `splitValues`. For each field, pull from its column (`columnName`) or the jsonb bag (`key`) of the supplied
 * record. Keys absent from the record are omitted (not set to `undefined`), so the result reflects exactly
 * what was stored.
 *
 * `record` is a SINGLE target's data. Callers typically merge per-target reads — e.g. participant columns +
 * participant.custom for the participant fields, enrollment columns + enrollment.custom for enrollment fields
 * — by passing the relevant target's fields to each call, or by combining the flat results.
 */
export function mergeValues(
  fields: FieldDefinition[],
  record: TargetRecord,
): Record<string, unknown> {
  const flat: Record<string, unknown> = {}

  for (const field of fields) {
    if (field.storage === 'column') {
      if (field.columnName && field.columnName in record.columns) {
        flat[field.key] = record.columns[field.columnName]
      }
    } else if (field.key in record.custom) {
      flat[field.key] = record.custom[field.key]
    }
  }

  return flat
}

export { TARGETS }
