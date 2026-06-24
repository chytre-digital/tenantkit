/**
 * Realizes ADR-0011 ("Zod + form-descriptor generation … from one source") — the FORM + VALIDATION generators.
 *
 * Two pure functions turn a resolved list of `FieldDefinition`s into the two artefacts the UI + the request
 * boundary need, from ONE schema (ADR-0011 "Consequences": same schema drives admin add, public QR and portal
 * plus client+server validation):
 *   - `buildZodSchema(fields)`   → a `ZodObject` keyed by `field.key`, encoding type + required + validation.
 *                                  Used by `withRoute({ body })` on the server AND the form resolver on the client.
 *   - `buildFormDescriptor(fields, locale)` → a flat, localized `FormField[]` a renderer maps to inputs.
 *
 * Vendor-light by design: the ONE dependency is `zod`, which the kernel already ships (the ADR names "Zod"
 * explicitly, so it is part of the capability — not a leaked vendor). No DB, no React, no i18n library.
 */
import { z } from 'zod'
import type { FieldDefinition, FieldType, LocalizedText } from './types'

/** Compile-time exhaustiveness: reachable only if a new `FieldType` is left unhandled (then `x` isn't `never`). */
function assertNever(x: never): never {
  throw new Error(`Unhandled field type: ${String(x)}`)
}

// ─────────────────────────────────────────────────────────────────────────────
// buildZodSchema — FieldDefinition[] → ZodObject
// ─────────────────────────────────────────────────────────────────────────────

/** Pick the best label for a locale: exact → 'cs' (product default) → 'en' → first → the key. */
function pickText(text: LocalizedText | undefined, locale: string, fallbackKey: string): string {
  if (!text) return fallbackKey
  return text[locale] ?? text.cs ?? text.en ?? Object.values(text)[0] ?? fallbackKey
}

/** A field's base Zod type BEFORE required/optional is applied. */
function baseSchema(field: FieldDefinition): z.ZodTypeAny {
  const v = field.validation ?? {}
  const optionValues = (field.options ?? []).map((o) => o.value)

  switch (field.type) {
    case 'email': {
      let s = z.string().email('Neplatný e-mail')
      if (v.maxLength != null) s = s.max(v.maxLength)
      return s
    }
    case 'phone':
    case 'text':
    case 'textarea': {
      let s = z.string()
      if (v.minLength != null) s = s.min(v.minLength)
      if (v.maxLength != null) s = s.max(v.maxLength)
      if (v.regex) s = s.regex(new RegExp(v.regex))
      return s
    }
    case 'date': {
      // Stored/transported as ISO 'YYYY-MM-DD' (doc 03 §4 `date_of_birth`, mirrors the QR form's value shape).
      return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Očekáváno YYYY-MM-DD')
    }
    case 'number': {
      let s = z.number()
      if (v.min != null) s = s.min(v.min)
      if (v.max != null) s = s.max(v.max)
      return s
    }
    case 'boolean':
      return z.boolean()
    case 'select':
    case 'segmented': {
      // A closed choice → an enum of the option values (segmented is a single-choice pill group).
      return optionValues.length ? z.enum(optionValues as [string, ...string[]]) : z.string()
    }
    case 'multiselect': {
      const item = optionValues.length ? z.enum(optionValues as [string, ...string[]]) : z.string()
      return z.array(item)
    }
    default: {
      // Exhaustiveness guard: if a new FieldType is added, `field.type` is no longer `never` and this errors.
      return assertNever(field.type)
    }
  }
}

/**
 * Apply required/optional semantics. Required free-text additionally rejects the empty string (so a blank text
 * input fails like the QR form's `.trim()` checks). Enums (select/segmented) already reject "" by construction,
 * so they only need the non-optional base. Optional fields accept `undefined`.
 */
function withRequired(schema: z.ZodTypeAny, field: FieldDefinition): z.ZodTypeAny {
  if (!field.required) return schema.optional()
  if (isFreeText(field.type)) {
    // Tighten the lower bound to ≥1 for required free-text unless a larger minLength already set it.
    const min = Math.max(1, field.validation?.minLength ?? 0)
    return (schema as z.ZodString).min(min, 'Povinné pole')
  }
  return schema
}

/** Types whose base schema is a `ZodString` we can `.min()` (excludes enums/array/number/boolean). */
function isFreeText(t: FieldType): boolean {
  return t === 'text' || t === 'textarea' || t === 'email' || t === 'phone' || t === 'date'
}

/**
 * Build a `ZodObject` from field definitions. Each entry is keyed by `field.key`; the value schema encodes the
 * field's `type`, `required` flag and `validation` bag. The result validates a flat
 * `Record<fieldKey, value>` — the same flat shape `mergeValues` reads back and a form submits.
 *
 * NOTE: pass an already-RESOLVED list (see resolveFields) so the schema matches exactly what a given surface
 * renders — e.g. the public QR form's Zod won't demand the admin-only `payment_status`.
 */
export function buildZodSchema(fields: FieldDefinition[]): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {}
  for (const field of fields) {
    shape[field.key] = withRequired(baseSchema(field), field)
  }
  return z.object(shape)
}

// ─────────────────────────────────────────────────────────────────────────────
// buildFormDescriptor — FieldDefinition[] → FormField[] (localized, render-ready)
// ─────────────────────────────────────────────────────────────────────────────

/** A localized option for a rendered select/segmented control. */
export interface FormFieldOption {
  value: string
  label: string
}

/**
 * One render-ready field: labels/help resolved to the active `locale`, options flattened. A UI layer (Mantine,
 * plain HTML, the mockup's `<input>`s) maps this directly — it never touches `FieldDefinition` or its jsonb maps.
 */
export interface FormField {
  key: string
  label: string
  type: FieldType
  required: boolean
  options?: FormFieldOption[]
  help?: string
  placeholder?: string
  order: number
}

/** A light, locale-aware placeholder hint per type (kept generic — apps can override in their renderer). */
function defaultPlaceholder(field: FieldDefinition, locale: string): string | undefined {
  if (field.type === 'email') return locale === 'en' ? 'you@email.com' : 'vas@email.cz'
  if (field.type === 'phone') return '+420 777 123 456'
  return undefined
}

/**
 * Build the flat, localized form descriptor. `fields` should be RESOLVED first (resolveFields) so order +
 * surface are already applied; `order` is carried through from `displayOrder` for renderers that re-sort.
 */
export function buildFormDescriptor(fields: FieldDefinition[], locale: string): FormField[] {
  return fields.map((field) => {
    const out: FormField = {
      key: field.key,
      label: pickText(field.label, locale, field.key),
      type: field.type,
      required: field.required,
      order: field.displayOrder,
    }
    if (field.help) out.help = pickText(field.help, locale, '')
    if (field.options?.length) {
      out.options = field.options.map((o) => ({ value: o.value, label: pickText(o.label, locale, o.value) }))
    }
    const ph = defaultPlaceholder(field, locale)
    if (ph) out.placeholder = ph
    return out
  })
}
