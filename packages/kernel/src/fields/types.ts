/**
 * Realizes ADR-0011 (docs/adr/0011-configurable-field-schema.md) and migration 0004
 * (db/migrations/0004_fields.sql) — the configurable, surface-aware FIELD SCHEMA types.
 *
 * WHY this lives in the kernel: "každá aplikace bude mít jiné účastníky, proto je třeba aby tyto pole člověk
 * mohl nastavit v settings." Every app/tenant collects different data about its participants (a swim school
 * needs "Jméno dítěte + Zákonný zástupce"; an adult studio needs only "Jméno účastníka"). So the admin
 * "Nový účastník" modal, the public QR form and the portal are DATA-DRIVEN from a per-tenant field schema.
 * The capability is generic → it ships as kernel (ADR-0011 "Decision"); the participant/guardian/enrollment
 * PRESETS live in the Termínář app (apps/terminar/src/fields/presets.ts).
 *
 * These are the pure type contracts. They mirror the SQL enums + columns ONE-TO-ONE:
 *   - `FieldType`    ↔ enum `field_type`    (0004_fields.sql:13)
 *   - `FieldTarget`  ↔ enum `field_target`  (0004_fields.sql:14)   — which subject the field describes
 *   - `FieldStorage` ↔ enum `field_storage` (0004_fields.sql:15)   — typed column vs jsonb bag
 *   - `FieldSurface` ↔ enum `field_surface` (0004_fields.sql:16)   — where the field is shown
 *   - `FieldDefinition` ↔ row of `core.field_definitions` (0004_fields.sql:29-54)
 *   - `FieldSet`        ↔ row of `core.field_sets`        (0004_fields.sql:19-27) + its definitions
 *
 * No I/O, no vendor imports — pure types so both client form code and server validation share one source.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Scalar enums — verbatim from the migration's Postgres enums.
// ─────────────────────────────────────────────────────────────────────────────

/** Widget + value kind. `segmented` is the pill toggle (e.g. Stav platby: Zaplaceno/Nezaplaceno). */
export type FieldType =
  | 'text'
  | 'textarea'
  | 'email'
  | 'phone'
  | 'date'
  | 'number'
  | 'select'
  | 'multiselect'
  | 'boolean'
  | 'segmented'

/** The subject a field describes. One `FieldSet` per target per tenant (0004_fields.sql:18). */
export type FieldTarget = 'participant' | 'guardian' | 'enrollment'

/** Where a field is rendered. A field may appear on several surfaces at once (it's an array on the row). */
export type FieldSurface = 'admin_form' | 'public_form' | 'portal'

/** How a field's value is persisted: a typed spine column, or the per-target jsonb bag. */
export type FieldStorage = 'column' | 'jsonb'

/** Who may edit the value — drives portal vs admin write gates (mirrors `editable_by`, 0004_fields.sql:48). */
export type FieldEditableBy = 'staff' | 'guardian' | 'both'

// ─────────────────────────────────────────────────────────────────────────────
// Option + validation shapes (the `options` / `validation` jsonb columns).
// ─────────────────────────────────────────────────────────────────────────────

/** A localized label, e.g. `{ cs: "Účastník", en: "Participant" }`. Mirrors every `jsonb` label column. */
export type LocalizedText = Record<string, string>

/** One choice for `select` | `multiselect` | `segmented`; the label is localized like every other label. */
export interface FieldOption {
  value: string
  label: LocalizedText
}

/** The `validation` jsonb bag → maps onto Zod refinements in schema.ts. All keys optional. */
export interface FieldValidation {
  /** text/textarea/email/phone min length. */
  minLength?: number
  /** text/textarea/email/phone max length. */
  maxLength?: number
  /** number min (inclusive). */
  min?: number
  /** number max (inclusive). */
  max?: number
  /** a JS-flavoured regex source applied to string values (e.g. a phone pattern). */
  regex?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// FieldDefinition — one row of `core.field_definitions`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single configurable field. The SHAPE is the contract the Settings UI edits, presets seed, plugins
 * contribute, and the form/validation generators consume.
 *
 * System vs custom (ADR-0011): `isSystem` rows map to the typed spine via `storage:'column'` + `columnName`
 * (e.g. participant `full_name`, enrollment `payment_status`). They can be relabeled / toggled / reordered /
 * made required — but NOT deleted. Custom rows use `storage:'jsonb'` and land in the per-target jsonb bag
 * (`participants.custom` / `enrollments.custom`). No EAV explosion.
 */
export interface FieldDefinition {
  /** Stable machine key — unique within its set, e.g. 'child_name','dob','guardian_email','payment_status'. */
  key: string
  /** Localized field label (the `<label>` text). */
  label: LocalizedText
  /** Optional localized helper text shown under the field. */
  help?: LocalizedText
  type: FieldType
  target: FieldTarget
  required: boolean
  /** Choices for select/multiselect/segmented; ignored for other types. */
  options?: FieldOption[]
  validation?: FieldValidation
  /** Ascending sort key within a surface (mirrors `display_order`). */
  displayOrder: number
  /** Surfaces this field renders on. Empty ⇒ shown nowhere (effectively hidden). */
  surfaces: FieldSurface[]
  /** System spine field (relabel/toggle yes, delete no) vs tenant/plugin custom field. */
  isSystem: boolean
  storage: FieldStorage
  /** Target table column when `storage==='column'` (e.g. 'full_name','date_of_birth','payment_status'). */
  columnName?: string
  /** Personally-identifiable — drives export/erase + log redaction (mirrors `pii`, 0004_fields.sql:47). */
  pii?: boolean
  /** Write gate; defaults to 'staff' if omitted (mirrors `editable_by` default, 0004_fields.sql:48). */
  editableBy?: FieldEditableBy
  /** Provenance: 'preset' | 'tenant' | 'plugin:<id>' (mirrors `source`, 0004_fields.sql:49). */
  source?: string
  /** Soft on/off without deleting; defaults to true if omitted (mirrors `active`, 0004_fields.sql:50). */
  active?: boolean
}

/**
 * One subject's fields — a row of `core.field_sets` plus its `core.field_definitions`. `key` is the subject:
 * `'participant' | 'guardian' | 'enrollment'` (it equals the contained fields' `target`).
 */
export interface FieldSet {
  key: string
  name: LocalizedText
  fields: FieldDefinition[]
}

/**
 * A named bundle of sets an app ships to seed a new tenant (e.g. Termínář's `kids-course` and `adult`).
 * `applyPreset(preset, tenantId)` (preset.ts) turns this into insertable `core.field_sets` /
 * `core.field_definitions` rows. The Settings UI then edits those rows per tenant.
 */
export interface FieldPreset {
  key: string
  sets: FieldSet[]
}
