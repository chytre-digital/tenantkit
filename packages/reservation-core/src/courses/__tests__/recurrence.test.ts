/**
 * Realizes docs/06-courses-and-terminar.md §5 — the recurrence generator, proven pure + deterministic.
 * Covers the headline exit criterion (doc 06 exit): a 7-session weekly block with a holiday exception, plus
 * count-vs-until, multi-rule, future-dated filtering, and the soft warnings (duplicate/overlap/soft-cap).
 * (2026-09-07 is a Monday — the doc's worked example.)
 */
import { describe, it, expect } from 'vitest'
import { generateSessions, type WeeklyRule } from '../recurrence'

const mon = (time = '16:00', durationMin = 45, location?: string): WeeklyRule => ({
  weekdays: [1],
  time,
  durationMin,
  ...(location !== undefined ? { location } : {}),
})

describe('generateSessions — count + holidays (doc 06 §5 exit criterion)', () => {
  it('emits 7 Mondays with a holiday skipped (the holiday does NOT consume the count)', () => {
    const { sessions } = generateSessions({
      rules: [mon('16:00', 45, 'Malý bazén')],
      startDate: '2026-09-07',
      stop: { kind: 'count', count: 7 },
      holidays: ['2026-09-28'], // skipped — generation walks past it to keep 7 lessons
    })
    expect(sessions).toHaveLength(7)
    expect(sessions.map((s) => s.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(sessions[0]!.startsAt.toISOString()).toBe('2026-09-07T16:00:00.000Z')
    expect(sessions.map((s) => s.startsAt.toISOString())).not.toContain('2026-09-28T16:00:00.000Z')
    expect(sessions.at(-1)!.startsAt.toISOString()).toBe('2026-10-26T16:00:00.000Z')
    expect(sessions[0]!.location).toBe('Malý bazén')
  })
})

describe('generateSessions — stop conditions + multiple rules', () => {
  it('until walks to the (inclusive) end date', () => {
    const { sessions } = generateSessions({
      rules: [mon()],
      startDate: '2026-09-07',
      stop: { kind: 'until', endDate: '2026-09-21' },
    })
    expect(sessions.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-09-07T16:00:00.000Z',
      '2026-09-14T16:00:00.000Z',
      '2026-09-21T16:00:00.000Z',
    ])
  })

  it('supports multiple weekly rules (Mon 16:00 + Thu 17:00) interleaved and sorted', () => {
    const { sessions } = generateSessions({
      rules: [mon('16:00'), { weekdays: [4], time: '17:00', durationMin: 45 }],
      startDate: '2026-09-07',
      stop: { kind: 'count', count: 4 },
    })
    expect(sessions.map((s) => s.startsAt.toISOString())).toEqual([
      '2026-09-07T16:00:00.000Z', // Mon
      '2026-09-10T17:00:00.000Z', // Thu
      '2026-09-14T16:00:00.000Z', // Mon
      '2026-09-17T17:00:00.000Z', // Thu
    ])
  })

  it('drops sessions at/<= now when `now` is provided (future-dated invariant §2.3)', () => {
    const { sessions } = generateSessions({
      rules: [mon()],
      startDate: '2026-09-07',
      stop: { kind: 'count', count: 3 },
      now: new Date('2026-09-10T00:00:00Z'), // 2026-09-07 is in the past → skipped
    })
    expect(sessions[0]!.startsAt.toISOString()).toBe('2026-09-14T16:00:00.000Z')
    expect(sessions).toHaveLength(3)
  })
})

describe('generateSessions — soft warnings (doc 06 §5.2 finish)', () => {
  it('flags a duplicate day+time (two rules collide)', () => {
    const { warnings } = generateSessions({
      rules: [mon('16:00', 45), mon('16:00', 60)],
      startDate: '2026-09-07',
      stop: { kind: 'count', count: 2 },
    })
    expect(warnings.some((w) => w.kind === 'duplicate')).toBe(true)
  })

  it('flags an overlap without a duplicate when times differ but intervals intersect', () => {
    const { warnings } = generateSessions({
      rules: [mon('16:00', 120), mon('17:00', 30)], // 16:00–18:00 overlaps 17:00–17:30
      startDate: '2026-09-07',
      stop: { kind: 'count', count: 2 },
    })
    expect(warnings.some((w) => w.kind === 'overlap')).toBe(true)
    expect(warnings.some((w) => w.kind === 'duplicate')).toBe(false)
  })

  it('flags the > 100 soft cap (non-blocking)', () => {
    const { sessions, warnings } = generateSessions({
      rules: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], time: '16:00', durationMin: 30 }],
      startDate: '2026-01-01',
      stop: { kind: 'count', count: 101 },
    })
    expect(sessions).toHaveLength(101)
    expect(warnings).toContainEqual({ kind: 'soft_cap', count: 101 })
  })
})
