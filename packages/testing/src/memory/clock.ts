/**
 * Realizes docs/14-portability-and-providers.md §4 (`Clock` / `IdGen` ports) + §7 (in-memory adapter).
 *
 * The deterministic time + id seam. The whole reason `Clock`/`IdGen` are ports (ports/index.ts §6) is so the
 * domain never reaches for `Date.now()` / `crypto.randomUUID()` directly — meaning a test can FREEZE time, then
 * ADVANCE it on demand to drive expiry math (the omluvenka credit engine, doc 08), and assert on STABLE ids.
 *
 *   • `createFixedClock(start)` — `now()` returns the same instant until you `advance(ms)` it.
 *   • `createCounterIdGen(seed?)` — monotonic, prefix-tagged ids (`uuid` → `0000…0001`, `token` → `tok_1`),
 *     so snapshots/assertions read the same on every run. No randomness ⇒ no flake.
 */
import type { Clock, IdGen } from '@deverjak/tenantkit-kernel'

/** A `Clock` you can move forward by hand — the test's grip on "now". */
export interface AdvanceableClock extends Clock {
  /** Jump the clock forward by `ms` milliseconds (negative is allowed but discouraged). */
  advance(ms: number): void
  /** Hard-set the clock to a specific instant. */
  set(date: Date): void
}

/**
 * A frozen clock. `now()` is stable across calls — nothing ticks until you `advance()` / `set()`.
 * Default epoch is a fixed, readable instant so unrelated suites share the same baseline.
 */
export function createFixedClock(start: Date = new Date('2026-01-01T00:00:00.000Z')): AdvanceableClock {
  let current = start.getTime()
  return {
    now: () => new Date(current),
    advance: (ms) => {
      current += ms
    },
    set: (date) => {
      current = date.getTime()
    },
  }
}

/**
 * A deterministic `IdGen`. `uuid()` emits sequential UUID-shaped strings; `token()` emits `tok_<n>`. Both share
 * one counter so ordering is observable in assertions. NOT cryptographically random — that's the point in tests.
 */
export function createCounterIdGen(seed = 0): IdGen {
  let n = seed
  return {
    uuid: () => {
      n += 1
      // UUID-shaped (8-4-4-4-12) but fully deterministic: the counter is zero-padded into the last group.
      const hex = n.toString(16).padStart(12, '0')
      return `00000000-0000-4000-8000-${hex}`
    },
    token: (_bytes?: number) => {
      n += 1
      return `tok_${n}`
    },
  }
}
