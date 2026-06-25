import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { zodErrorMap, composeErrorMap, type ZodErrorMap } from '../zod-locale'

describe('zodErrorMap', () => {
  it('localizes Zod built-in messages per parse call (cs ≠ en)', () => {
    const schema = z.string().min(3)
    const cs = schema.safeParse('x', { error: zodErrorMap('cs') })
    const en = schema.safeParse('x', { error: zodErrorMap('en') })
    expect(cs.success).toBe(false)
    expect(en.success).toBe(false)
    const csMsg = cs.success ? '' : cs.error.issues[0]!.message
    const enMsg = en.success ? '' : en.error.issues[0]!.message
    expect(csMsg.length).toBeGreaterThan(0)
    expect(enMsg.length).toBeGreaterThan(0)
    expect(csMsg).not.toBe(enMsg) // genuinely different languages, not the same default
  })

  it('falls back to the default locale (cs) for an unsupported locale', () => {
    const schema = z.string().min(3)
    const cs = schema.safeParse('x', { error: zodErrorMap('cs') })
    const xx = schema.safeParse('x', { error: zodErrorMap('xx') }) // unknown → cs
    const csMsg = cs.success ? '' : cs.error.issues[0]!.message
    const xxMsg = xx.success ? '' : xx.error.issues[0]!.message
    expect(xxMsg).toBe(csMsg)
  })
})

describe('composeErrorMap', () => {
  it('lets the custom map win on a string, else defers to the fallback', () => {
    const custom: ZodErrorMap = (issue) => ((issue.path ?? []).join('.') === 'title' ? 'Vlastní hláška' : undefined)
    const map = composeErrorMap(custom, zodErrorMap('en'))

    const schema = z.object({ title: z.string().min(3), note: z.string().min(3) })
    const res = schema.safeParse({ title: 'x', note: 'y' }, { error: map })
    expect(res.success).toBe(false)
    if (res.success) return
    const byPath = Object.fromEntries(res.error.issues.map((i) => [i.path.join('.'), i.message]))
    expect(byPath.title).toBe('Vlastní hláška') // custom won
    expect(byPath.note).not.toBe('Vlastní hláška') // deferred to the English fallback
    expect((byPath.note ?? '').length).toBeGreaterThan(0)
  })
})
