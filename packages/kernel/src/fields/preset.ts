/**
 * Realizes ADR-0011 ("Per-tenant, seeded from an app preset") + migration 0004 (core.field_sets /
 * core.field_definitions) — preset APPLICATION.
 *
 * `applyPreset(preset, tenantId)` flattens a `FieldPreset` (an app's bundle of subject sets) into the two row
 * shapes ready to INSERT for a brand-new tenant: one `field_sets` row per subject, one `field_definitions`
 * row per field. From there the tenant edits them in Settings → Pole účastníka. The mapping is the camelCase
 * TS contract → the snake_case SQL columns (0004_fields.sql:19-54), with the migration's column defaults
 * applied here so callers can insert the rows as-is.
 *
 * Pure: it builds plain row objects and assigns deterministic ids via the injected `IdGen` (or a stub) — no
 * DB access. The actual INSERT is the app/adapter's job.
 */
import type { IdGen } from '../ports'
import type { FieldDefinition, FieldPreset, FieldSet } from './types'

export type { FieldPreset } from './types'

// ─────────────────────────────────────────────────────────────────────────────
// Row shapes — exactly the insertable columns of core.field_sets / core.field_definitions.
// (Server timestamps + the trigger-maintained `updated_at` are left to the DB defaults.)
// ─────────────────────────────────────────────────────────────────────────────

/** An insertable `core.field_sets` row (0004_fields.sql:19-27). */
export interface FieldSetRow {
  id: string
  tenant_id: string
  key: string
  /** localized name jsonb. */
  name: Record<string, string>
}

/** An insertable `core.field_definitions` row (0004_fields.sql:29-54). */
export interface FieldDefinitionRow {
  id: string
  tenant_id: string
  set_id: string
  /** null = whole tenant; a uuid = only that course (0004_fields.sql:33). Presets seed tenant-wide ⇒ null. */
  course_id: string | null
  key: string
  label: Record<string, string>
  help: Record<string, string>
  type: FieldDefinition['type']
  target: FieldDefinition['target']
  required: boolean
  options: { value: string; label: Record<string, string> }[]
  validation: NonNullable<FieldDefinition['validation']>
  display_order: number
  surfaces: FieldDefinition['surfaces']
  is_system: boolean
  storage: FieldDefinition['storage']
  column_name: string | null
  pii: boolean
  editable_by: NonNullable<FieldDefinition['editableBy']>
  source: string
  active: boolean
}

/** What `applyPreset` returns: the two row buckets, set rows first so `set_id` FKs resolve on insert. */
export interface AppliedPreset {
  sets: FieldSetRow[]
  definitions: FieldDefinitionRow[]
}

/**
 * Options for `applyPreset`. `ids` is injected for determinism in tests (docs/14: no `random()` in core
 * logic); when omitted a small counter stub is used so a missing runtime never breaks a pure call.
 */
export interface ApplyPresetOptions {
  ids?: Pick<IdGen, 'uuid'>
}

function fallbackIdGen(): Pick<IdGen, 'uuid'> {
  let n = 0
  // Not cryptographic — only a stable placeholder when no IdGen is wired (the DB default would otherwise win).
  return { uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}` }
}

function defToRow(
  def: FieldDefinition,
  ctx: { id: string; tenantId: string; setId: string },
): FieldDefinitionRow {
  return {
    id: ctx.id,
    tenant_id: ctx.tenantId,
    set_id: ctx.setId,
    course_id: null, // preset = tenant-wide; per-course overrides are added later in Settings
    key: def.key,
    label: def.label,
    help: def.help ?? {},
    type: def.type,
    target: def.target,
    required: def.required,
    options: def.options ?? [],
    validation: def.validation ?? {},
    display_order: def.displayOrder,
    surfaces: def.surfaces,
    is_system: def.isSystem,
    storage: def.storage,
    column_name: def.columnName ?? null,
    pii: def.pii ?? false,
    editable_by: def.editableBy ?? 'staff',
    source: def.source ?? 'preset',
    active: def.active ?? true,
  }
}

/**
 * Flatten a preset into insertable rows for one tenant.
 *
 * @returns `{ sets, definitions }` — arrays of plain objects whose keys are the SQL column names. Insert
 *          `sets` first (the definitions reference `set_id`). The return type is intentionally the precise
 *          row shapes (not `any`) so a typed adapter inserts them without coercion.
 */
export function applyPreset(
  preset: FieldPreset,
  tenantId: string,
  opts: ApplyPresetOptions = {},
): AppliedPreset {
  const ids = opts.ids ?? fallbackIdGen()
  const sets: FieldSetRow[] = []
  const definitions: FieldDefinitionRow[] = []

  for (const set of preset.sets as FieldSet[]) {
    const setId = ids.uuid()
    sets.push({ id: setId, tenant_id: tenantId, key: set.key, name: set.name })
    for (const def of set.fields) {
      definitions.push(defToRow(def, { id: ids.uuid(), tenantId, setId }))
    }
  }

  return { sets, definitions }
}
