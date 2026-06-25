/**
 * Realizes ADR-0011 / docs/15-configurable-fields-and-settings.md — the configurable field engine, proven pure:
 * surface resolution, the ONE Zod schema that validates client+server, the localized form descriptor, the
 * spine↔jsonb value router (lossless round-trip), and preset → insertable rows. This is the Phase 1/2 kernel
 * deliverable's DoD ("buildZodSchema validating identically client+server", doc 13 §3 exit criterion).
 */
import { describe, it, expect } from 'vitest'
import {
  resolveFields,
  buildZodSchema,
  buildFormDescriptor,
  splitValues,
  mergeValues,
  applyPreset,
} from '../index'
import type { FieldDefinition, FieldPreset } from '../index'

/** Build a FieldDefinition with sensible defaults; `over` overrides (and always supplies `key`). */
function f(over: Partial<FieldDefinition> & Pick<FieldDefinition, 'key'>): FieldDefinition {
  return {
    label: { cs: over.key },
    type: 'text',
    target: 'participant',
    required: false,
    displayOrder: 0,
    surfaces: ['admin_form'],
    isSystem: false,
    storage: 'jsonb',
    ...over,
  }
}

describe('resolveFields (surface + active + order)', () => {
  it('keeps active fields tagged for the surface, sorted by displayOrder', () => {
    const fields = [
      f({ key: 'a', displayOrder: 2, surfaces: ['admin_form', 'public_form'] }),
      f({ key: 'b', displayOrder: 1, surfaces: ['admin_form'] }),
      f({ key: 'c', displayOrder: 0, surfaces: ['public_form'] }), // wrong surface
      f({ key: 'd', displayOrder: 0, surfaces: ['admin_form'], active: false }), // inactive
    ]
    expect(resolveFields(fields, { surface: 'admin_form' }).map((x) => x.key)).toEqual(['b', 'a'])
    expect(resolveFields(fields, { surface: 'public_form' }).map((x) => x.key)).toEqual(['c', 'a'])
  })
})

describe('buildZodSchema (one schema, client+server)', () => {
  const schema = buildZodSchema([
    f({ key: 'name', type: 'text', required: true }),
    f({ key: 'email', type: 'email', required: true }),
    f({ key: 'age', type: 'number', required: false, validation: { min: 0, max: 120 } }),
    f({ key: 'level', type: 'select', required: true, options: [{ value: 'a', label: { cs: 'A' } }, { value: 'b', label: { cs: 'B' } }] }),
    f({ key: 'tags', type: 'multiselect', required: false, options: [{ value: 'x', label: { cs: 'X' } }] }),
  ])

  it('accepts a valid record', () => {
    expect(schema.safeParse({ name: 'Ada', email: 'a@x.cz', level: 'a', tags: ['x'] }).success).toBe(true)
  })
  it('rejects an empty required free-text', () => {
    expect(schema.safeParse({ name: '', email: 'a@x.cz', level: 'a' }).success).toBe(false)
  })
  it('rejects a malformed email', () => {
    expect(schema.safeParse({ name: 'Ada', email: 'nope', level: 'a' }).success).toBe(false)
  })
  it('rejects a value outside a select enum', () => {
    expect(schema.safeParse({ name: 'Ada', email: 'a@x.cz', level: 'z' }).success).toBe(false)
  })
  it('enforces number bounds', () => {
    expect(schema.safeParse({ name: 'Ada', email: 'a@x.cz', level: 'a', age: 200 }).success).toBe(false)
    expect(schema.safeParse({ name: 'Ada', email: 'a@x.cz', level: 'a', age: 5 }).success).toBe(true)
  })
})

describe('buildFormDescriptor (localized, render-ready)', () => {
  it('resolves labels/options to the locale and adds a type placeholder', () => {
    const desc = buildFormDescriptor(
      [
        f({ key: 'email', type: 'email', required: true, label: { cs: 'E-mail', en: 'Email' } }),
        f({ key: 'lvl', type: 'select', required: false, options: [{ value: 'a', label: { cs: 'Áčko', en: 'A' } }] }),
      ],
      'en',
    )
    expect(desc[0]).toMatchObject({ key: 'email', label: 'Email', type: 'email', required: true, placeholder: 'you@email.com' })
    expect(desc[1]!.options).toEqual([{ value: 'a', label: 'A' }])
  })
})

describe('splitValues / mergeValues (spine ↔ jsonb router)', () => {
  const fields = [
    f({ key: 'full_name', target: 'participant', storage: 'column', columnName: 'full_name' }),
    f({ key: 'allergy', target: 'participant', storage: 'jsonb' }),
    f({ key: 'payment_status', target: 'enrollment', storage: 'column', columnName: 'payment_status' }),
    f({ key: 'broken', target: 'participant', storage: 'column' }), // misconfig: no columnName → skipped
  ]

  it('routes column fields to the spine and jsonb fields to the bag, per target', () => {
    const split = splitValues(fields, { full_name: 'Ada', allergy: 'nuts', payment_status: 'paid', broken: 'x', absent: 'y' })
    expect(split.columns.participant).toEqual({ full_name: 'Ada' })
    expect(split.custom.participant).toEqual({ allergy: 'nuts' })
    expect(split.columns.enrollment).toEqual({ payment_status: 'paid' })
    expect(split.custom.enrollment).toEqual({}) // nothing custom on enrollment
  })

  it('round-trips back to a flat record (lossless for present keys)', () => {
    const split = splitValues(fields, { full_name: 'Ada', allergy: 'nuts' })
    const back = mergeValues(
      fields.filter((x) => x.target === 'participant'),
      { columns: split.columns.participant, custom: split.custom.participant },
    )
    expect(back).toEqual({ full_name: 'Ada', allergy: 'nuts' })
  })
})

describe('applyPreset (→ insertable rows)', () => {
  it('flattens a preset into snake_case field_sets + field_definitions rows with deterministic ids', () => {
    const preset: FieldPreset = {
      key: 'kids',
      sets: [
        {
          key: 'participant',
          name: { cs: 'Účastník' },
          fields: [
            f({ key: 'full_name', isSystem: true, storage: 'column', columnName: 'full_name', required: true }),
            f({ key: 'allergy', storage: 'jsonb' }),
          ],
        },
      ],
    }
    let n = 0
    const applied = applyPreset(preset, 'tenant-1', { ids: { uuid: () => `id-${++n}` } })

    expect(applied.sets).toEqual([{ id: 'id-1', tenant_id: 'tenant-1', key: 'participant', name: { cs: 'Účastník' } }])
    expect(applied.definitions).toHaveLength(2)
    expect(applied.definitions[0]).toMatchObject({
      id: 'id-2',
      tenant_id: 'tenant-1',
      set_id: 'id-1',
      key: 'full_name',
      is_system: true,
      storage: 'column',
      column_name: 'full_name',
      required: true,
      display_order: 0,
      source: 'preset',
      active: true,
    })
    expect(applied.definitions[1]).toMatchObject({ key: 'allergy', is_system: false, column_name: null })
  })
})
