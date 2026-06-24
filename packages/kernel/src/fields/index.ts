/**
 * Barrel for the kernel `fields` module — the configurable, surface-aware field-schema engine (ADR-0011,
 * docs/15-configurable-fields-and-settings.md). Re-exported from the package root via `export * from './fields'`
 * (packages/kernel/src/index.ts), so apps `import { … } from '@tenantkit/kernel'`.
 *
 * The whole engine in one place:
 *   - types        the contracts (FieldDefinition/FieldSet/FieldPreset + the enums)
 *   - applyPreset  seed a tenant's core.field_sets/field_definitions from an app preset
 *   - resolveFields filter active + surface, sort by displayOrder
 *   - buildZodSchema / buildFormDescriptor   one schema → server+client validation and a render-ready descriptor
 *   - splitValues / mergeValues              route values across the typed spine and the per-target jsonb bags
 *
 * Pure + vendor-free (the only dependency is `zod`, which the ADR names as part of the capability).
 */

// --- types & enums ---
export type {
  FieldType,
  FieldTarget,
  FieldSurface,
  FieldStorage,
  FieldEditableBy,
  LocalizedText,
  FieldOption,
  FieldValidation,
  FieldDefinition,
  FieldSet,
  FieldPreset,
} from './types'

// --- preset application (→ insertable core.field_sets / core.field_definitions rows) ---
export {
  applyPreset,
  type AppliedPreset,
  type FieldSetRow,
  type FieldDefinitionRow,
  type ApplyPresetOptions,
} from './preset'

// --- resolution (surface + active + order) ---
export { resolveFields, type ResolveFieldsOptions } from './resolve'

// --- schema + form descriptor generation ---
export {
  buildZodSchema,
  buildFormDescriptor,
  type FormField,
  type FormFieldOption,
} from './schema'

// --- value routing (spine columns ↔ jsonb bags) ---
export {
  splitValues,
  mergeValues,
  TARGETS,
  type SplitValues,
  type TargetRecord,
  type ByTarget,
} from './values'
