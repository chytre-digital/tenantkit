import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { jsonError } from '../respond'
import { forbidden, unauthorized } from '../errors'
import { zodErrorMap } from '../../i18n/zod-locale'

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

describe('jsonError — localization by code', () => {
  it('localizes an HttpError by its stable code (cs), keeping the code stable', async () => {
    const res = jsonError(forbidden('NOT_A_MEMBER'), 'cs')
    expect(res.status).toBe(403)
    const json = (await res.json()) as { error: string; code: string }
    expect(json.code).toBe('NOT_A_MEMBER') // machine code unchanged
    expect(json.error).toBe('Nejste členem tohoto studia.') // Czech message, not the bare code
  })

  it('localizes the same kind of error to English when locale=en', async () => {
    const json = (await jsonError(unauthorized(), 'en').json()) as { error: string; code: string }
    expect(json.code).toBe('UNAUTHORIZED')
    expect(json.error).toBe('Please sign in first.')
  })

  it('defaults to cs when no locale is passed (back-compat)', async () => {
    const json = (await jsonError(forbidden('FORBIDDEN')).json()) as { error: string }
    expect(json.error).toBe('K této akci nemáte oprávnění.')
  })

  it('localizes the INTERNAL fallback for an unknown throw', async () => {
    const json = (await jsonError(new Error('boom'), 'cs').json()) as { error: string; code: string }
    expect(json.code).toBe('INTERNAL')
    expect(json.error).toBe('Vnitřní chyba serveru.')
  })

  it('still formats ZodError as "path: message" (field messages localized upstream at parse time)', async () => {
    const schema = z.object({ title: z.string().min(3) })
    let caught: unknown
    try {
      schema.parse({ title: 'x' }, { error: zodErrorMap('cs') })
    } catch (e) {
      caught = e
    }
    const json = (await jsonError(caught, 'cs').json()) as { error: string; code: string; details: { path: string }[] }
    expect(json.code).toBe('VALIDATION_ERROR')
    expect(json.details[0]?.path).toBe('title')
    expect(json.error.startsWith('title: ')).toBe(true)
  })
})
