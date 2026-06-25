import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { jsonError } from '../respond'

describe('jsonError — ZodError', () => {
  it('returns a field-specific message + structured details (not a generic "Validation failed")', async () => {
    const schema = z.object({ title: z.string().min(1, 'Enter a title.'), capacity: z.number().int() })
    let caught: unknown
    try {
      schema.parse({ title: '', capacity: 1.5 })
    } catch (e) {
      caught = e
    }

    const res = jsonError(caught)
    expect(res.status).toBe(400)
    const json = (await res.json()) as {
      error: string
      code: string
      details: { path: string; message: string; code: string }[]
    }
    expect(json.code).toBe('VALIDATION_ERROR')
    expect(json.error).not.toBe('Validation failed')
    expect(json.error).toContain('title')
    expect(json.error).toContain('Enter a title.')
    expect(Array.isArray(json.details)).toBe(true)
    expect(json.details.some((d) => d.path === 'title' && d.message === 'Enter a title.')).toBe(true)
  })

  it('joins nested array/object paths with dots', async () => {
    const schema = z.object({ sessions: z.array(z.object({ startsAt: z.string().min(5) })) })
    let caught: unknown
    try {
      schema.parse({ sessions: [{ startsAt: 'x' }] })
    } catch (e) {
      caught = e
    }

    const json = (await jsonError(caught).json()) as { error: string; details: { path: string }[] }
    expect(json.error).toContain('sessions.0.startsAt')
    expect(json.details[0]?.path).toBe('sessions.0.startsAt')
  })
})
