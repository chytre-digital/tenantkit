/**
 * Realizes ADR-0011 ("Surface-aware: each field declares where it appears") + migration 0004
 * (`surfaces field_surface[]`, `active`, `display_order`) — field RESOLUTION for a given surface.
 *
 * `resolveFields(fields, { surface })` is the single gate every render path runs first: drop inactive rows,
 * keep only those tagged for the requested surface, and sort by `displayOrder`. The admin "Nový účastník"
 * modal, the public QR form, and the portal all call this with their own `surface` so one stored schema
 * yields three correctly-ordered, correctly-scoped field lists. Pure + side-effect free.
 */
import type { FieldDefinition, FieldSurface } from './types'

export interface ResolveFieldsOptions {
  /** Which surface is rendering: 'admin_form' | 'public_form' | 'portal'. */
  surface: FieldSurface
  /**
   * Optional active locale. Resolution does NOT translate (labels stay localized maps so a client can switch
   * language without a refetch) — `locale` is accepted for parity with the documented API and reserved for
   * future locale-scoped fields. `buildFormDescriptor` (schema.ts) is where a locale is actually applied.
   */
  locale?: string
}

/** `active` defaults to true when the row omits it (mirrors the column default, 0004_fields.sql:50). */
function isActive(f: FieldDefinition): boolean {
  return f.active !== false
}

/**
 * Filter to active + surface-tagged fields, sorted ascending by `displayOrder`.
 *
 * Stable for equal orders (preserves input order), so a deterministic preset ordering survives. Returns a new
 * array; the input is not mutated.
 */
export function resolveFields(
  fields: FieldDefinition[],
  opts: ResolveFieldsOptions,
): FieldDefinition[] {
  return fields
    .filter((f) => isActive(f) && f.surfaces.includes(opts.surface))
    .sort((a, b) => a.displayOrder - b.displayOrder)
}
