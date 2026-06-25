/**
 * Realizes docs/06-courses-and-terminar.md §5 — the recurrence generator, PURE (the signature legacy carry-over).
 *
 * Long-term courses are weekly ("po 16:00, 7×"), but STORING a recurrence rule is wrong for this domain (real
 * schedules have holidays, single-week shifts, a make-up week tacked on the end). So this expands a rule into a
 * concrete, fully-editable `DraftSession[]` that the form then submits as an EXPLICIT list — nothing about the
 * rule survives (doc 06 §5.3). `public.sessions` is the source of truth; no expansion ever happens at read time.
 *
 * Pure + deterministic: all dates are computed in UTC and `now` is injected (omit it for pure expansion). Dates
 * are 'YYYY-MM-DD'; times are 'HH:MM' wall-clock materialized as a UTC instant (the app maps to the studio tz).
 */

/** One weekly rule (doc 06 §5.2): place a session on these weekdays at this time/duration/location. */
export interface WeeklyRule {
  /** ISO weekdays: 1 = Monday … 7 = Sunday (Po..Ne, matching the editor's day toggles). */
  weekdays: number[]
  /** 'HH:MM' 24h. */
  time: string
  durationMin: number
  location?: string
}

/** Stop condition — count OR end-date, mutually exclusive (doc 06 §5.2). */
export type StopCondition =
  | { kind: 'count'; count: number }
  | { kind: 'until'; endDate: string } // 'YYYY-MM-DD', inclusive

export interface GenerateInput {
  /** ≥ 1 weekly rule; multiple rules (e.g. Mon + Thu) are first-class (doc 06 §5.2 notes). */
  rules: WeeklyRule[]
  startDate: string // 'YYYY-MM-DD'
  stop: StopCondition
  /** Holiday/exception dates to skip ('YYYY-MM-DD'); they don't consume the `count` (doc 06 §5.2). */
  holidays?: string[]
  /** When provided, sessions at/<= now are dropped (invariant §2.3, future-dated). Omit for pure expansion. */
  now?: Date
}

/** One generated, editable session (doc 06 §5.1). `sequence` is 1-based, assigned after sorting by `startsAt`. */
export interface DraftSession {
  startsAt: Date
  durationMin: number
  location?: string
  sequence: number
}

/** Non-blocking warnings surfaced for the user to resolve by editing (doc 06 §5.2 `finish`). */
export type GenerateWarning =
  | { kind: 'duplicate'; isoDate: string; time: string }
  | { kind: 'overlap'; sequence: number }
  | { kind: 'soft_cap'; count: number }

export interface GenerateResult {
  sessions: DraftSession[]
  warnings: GenerateWarning[]
}

/** Defensive bound so a bad `until`/empty-weekday input can't loop forever (legacy generated runaway lists). */
const MAX_HORIZON_DAYS = 366 * 5
/** doc 06 §5.2: > 100 sessions is a soft warning, not a block. */
const SOFT_CAP = 100

/**
 * Expand the rule into an explicit, sorted, 1-based-sequenced `DraftSession[]` (doc 06 §5.2). Holidays are
 * skipped during expansion (so the persisted list already has the gap); `count` counts only emitted sessions;
 * `until` walks to the end date. Returns soft warnings (duplicate day+time, overlap, > 100) for the editor.
 */
export function generateSessions(input: GenerateInput): GenerateResult {
  const skip = new Set(input.holidays ?? [])
  const collected: Array<{ startsAt: Date; durationMin: number; location?: string }> = []
  const start = parseDateOnly(input.startDate)
  const horizonTime =
    input.stop.kind === 'until' ? parseDateOnly(input.stop.endDate).getTime() : Number.POSITIVE_INFINITY

  let day = start
  for (let guard = 0; day.getTime() <= horizonTime && guard <= MAX_HORIZON_DAYS; guard++, day = addDaysUTC(day, 1)) {
    if (skip.has(toISODate(day))) continue // holiday exception — whole day skipped
    const wd = isoWeekday(day)
    let stop = false
    for (const rule of input.rules) {
      if (!rule.weekdays.includes(wd)) continue
      const startsAt = atTimeUTC(day, rule.time)
      if (input.now !== undefined && startsAt.getTime() <= input.now.getTime()) continue // future-dated §2.3
      const session: { startsAt: Date; durationMin: number; location?: string } = {
        startsAt,
        durationMin: rule.durationMin,
      }
      if (rule.location !== undefined) session.location = rule.location
      collected.push(session)
      if (input.stop.kind === 'count' && collected.length >= input.stop.count) {
        stop = true
        break
      }
    }
    if (stop) break
  }

  collected.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
  const sessions: DraftSession[] = collected.map((s, i) => ({ ...s, sequence: i + 1 }))
  return { sessions, warnings: computeWarnings(sessions) }
}

function computeWarnings(sessions: DraftSession[]): GenerateWarning[] {
  const warnings: GenerateWarning[] = []

  // duplicate: the same calendar day + time emitted more than once (two rules collided).
  const counts = new Map<string, number>()
  for (const s of sessions) {
    const key = `${toISODate(s.startsAt)} ${hhmm(s.startsAt)}`
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const [key, n] of counts) {
    if (n > 1) {
      const [isoDate, time] = key.split(' ')
      warnings.push({ kind: 'duplicate', isoDate: isoDate!, time: time! })
    }
  }

  // overlap: a session starts before the previous one ends (sorted order).
  for (let i = 1; i < sessions.length; i++) {
    const prev = sessions[i - 1]!
    const cur = sessions[i]!
    if (cur.startsAt.getTime() < prev.startsAt.getTime() + prev.durationMin * 60_000) {
      warnings.push({ kind: 'overlap', sequence: cur.sequence })
    }
  }

  if (sessions.length > SOFT_CAP) warnings.push({ kind: 'soft_cap', count: sessions.length })
  return warnings
}

// ── UTC date helpers (no DST, fully deterministic) ──────────────────────────────────────────────────────────

function parseDateOnly(s: string): Date {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!))
}
function toISODate(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
function atTimeUTC(day: Date, time: string): Date {
  const [hh, mm] = time.split(':').map(Number)
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh!, mm!))
}
function addDaysUTC(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000)
}
/** ISO weekday: Monday = 1 … Sunday = 7. */
function isoWeekday(d: Date): number {
  const wd = d.getUTCDay()
  return wd === 0 ? 7 : wd
}
function pad(n: number): string {
  return String(n).padStart(2, '0')
}
function hhmm(d: Date): string {
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}
