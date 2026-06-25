/**
 * Realizes docs/01 §9 (no-PII logs) + docs/03 §10 (GDPR) — redaction proven pure + schema-driven.
 */
import { describe, it, expect } from 'vitest'
import { redact, redactSecrets, redactPii, piiKeysOf } from '../redact'
import type { FieldDefinition } from '../../fields/types'

describe('redact', () => {
  it('deep-masks the named keys, preserves the rest, and does not mutate the input', () => {
    const input = {
      id: 'p1',
      email: 'a@x.cz',
      guardian: { name: 'Eva', phone: '+420777111222' },
      siblings: [{ name: 'Tom', email: 'tom@x.cz' }],
    }
    const out = redact(input, { keys: ['email', 'phone'] })

    expect(out).toEqual({
      id: 'p1',
      email: '[redacted]',
      guardian: { name: 'Eva', phone: '[redacted]' },
      siblings: [{ name: 'Tom', email: '[redacted]' }],
    })
    // input untouched
    expect(input.email).toBe('a@x.cz')
    expect(input.guardian.phone).toBe('+420777111222')
  })

  it('honours a custom mask and leaves Date instances intact', () => {
    const d = new Date('2026-06-25T00:00:00.000Z')
    const out = redact({ secret: 'x', when: d }, { keys: ['secret'], mask: '***' })
    expect(out).toEqual({ secret: '***', when: d })
    expect(out.when).toBeInstanceOf(Date)
  })

  it('redactSecrets masks the default secret keys', () => {
    const out = redactSecrets({ accessToken: 'abc', refreshToken: 'def', userId: 'u1' })
    expect(out).toEqual({ accessToken: '[redacted]', refreshToken: '[redacted]', userId: 'u1' })
  })
})

describe('piiKeysOf + redactPii (schema-driven, doc 03 §10)', () => {
  const field = (over: Partial<FieldDefinition> & Pick<FieldDefinition, 'key'>): FieldDefinition => ({
    label: { cs: over.key },
    type: 'text',
    target: 'participant',
    required: false,
    displayOrder: 0,
    surfaces: ['admin_form'],
    isSystem: false,
    storage: 'jsonb',
    ...over,
  })

  const fields: FieldDefinition[] = [
    field({ key: 'full_name', pii: true, storage: 'column', columnName: 'full_name' }),
    field({ key: 'date_of_birth', pii: true, storage: 'column', columnName: 'date_of_birth' }),
    field({ key: 'note', pii: false }),
    field({ key: 'allergy', pii: true }), // jsonb custom field, no columnName
  ]

  it('collects keys AND spine column names of pii fields only', () => {
    expect(piiKeysOf(fields).sort()).toEqual(['allergy', 'date_of_birth', 'full_name'].sort())
    expect(piiKeysOf(fields)).not.toContain('note')
  })

  it('redactPii masks exactly the schema-flagged PII', () => {
    const row = { full_name: 'Ada Lovelace', date_of_birth: '2019-05-01', note: 'wants lane 3', allergy: 'nuts' }
    expect(redactPii(row, fields)).toEqual({
      full_name: '[redacted]',
      date_of_birth: '[redacted]',
      note: 'wants lane 3',
      allergy: '[redacted]',
    })
  })
})
