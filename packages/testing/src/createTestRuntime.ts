/**
 * Realizes docs/14-portability-and-providers.md §6.4 (in-memory adapter = the honesty check) + §7 (rollout #2).
 *
 * `createTestRuntime()` — the one call that assembles a fully vendor-free `CoreRuntime` (the same bag of ports
 * `createSupabaseRuntime()` returns, ports/index.ts) over a single shared `MemoryStore` + a frozen `Clock`.
 * This is what makes the kernel's own tests fast and Supabase-free, and what the conformance suites run against.
 *
 * It returns more than the runtime: the `store` (to seed/inspect rows), `sentEmails` (the captured outbox),
 * `payments` (recorded checkouts/events), and `advanceTime` (move the frozen clock to drive expiry math). It
 * also hands back small request helpers so a test can act AS a seeded user — wiring identity → RLS end-to-end:
 * the `MemoryDatabase` reads the actor from a header these helpers set.
 */
import type { CoreRuntime } from '@tenantkit/kernel'
import { type AdvanceableClock, createCounterIdGen, createFixedClock } from './memory/clock'
import { createMemoryDatabase, MEMORY_ACTOR_HEADER, MEMORY_SERVICE_ACTOR } from './memory/database'
import { createMemoryEmail, type MemoryEmailProvider, type SentEmail } from './memory/email'
import { createMemoryIdentity, createMemorySessionStore } from './memory/identity'
import { createMemoryAuthzStore } from './memory/authz'
import { createMemoryPayments, type MemoryPaymentProvider } from './memory/payments'
import { type MemorySeed, MemoryStore } from './memory/store'

export interface TestRuntime {
  /** The vendor-free runtime — pass straight to `withRoute({ runtime, … })`. */
  runtime: CoreRuntime
  /** The shared Map store: seed more rows, register RPCs, or assert on resulting state. */
  store: MemoryStore
  /** The captured outbox — every `EmailMessage` the kernel sent, in order. */
  sentEmails: SentEmail[]
  /** The email port itself (to arm `failNext()` / `skipNext()` and `clear()`). */
  email: MemoryEmailProvider
  /** The payments mock (recorded checkouts/refunds; `enqueueEvent()` for webhook tests). */
  payments: MemoryPaymentProvider
  /** Move the frozen clock forward by `ms` — drives credit expiry / session-expiry assertions. */
  advanceTime(ms: number): void
  /** The advanceable clock (also `set(date)`), in case a test wants finer control. */
  clock: AdvanceableClock
  /** Build a `Request` whose `Database.forRequest` resolves to the given seeded user id (RLS as that user). */
  requestAs(userId: string, init?: RequestInit): Request
  /** Build a `Request` that runs as the service role (RLS bypass) — for webhook/cron-style tests. */
  requestAsService(init?: RequestInit): Request
  /** Build an anonymous `Request` (no identity; public-catalogue reads). */
  anonRequest(init?: RequestInit): Request
}

const DEFAULT_URL = 'http://test.local/'

/**
 * Assemble the in-memory runtime. Pass a `seed` to pre-load users / tenants / memberships / domain rows.
 * Everything shares ONE store and ONE clock so identity, RLS, authz, and time all stay consistent.
 */
export function createTestRuntime(seed: MemorySeed = {}): TestRuntime {
  const store = new MemoryStore(seed)
  const clock = createFixedClock()
  const ids = createCounterIdGen()

  const identityDeps = {
    store,
    now: () => clock.now(),
    mintToken: () => ids.token(),
  }

  const email = createMemoryEmail()
  const payments = createMemoryPayments()

  const runtime: CoreRuntime = {
    identity: createMemoryIdentity(identityDeps),
    sessions: createMemorySessionStore(identityDeps),
    db: createMemoryDatabase(store),
    authz: createMemoryAuthzStore(store),
    email,
    payments,
    // storage intentionally omitted — optional in the kernel (ports/index.ts §5); add a memory one if needed.
    clock,
    ids,
  }

  const withActor = (actor: string, init?: RequestInit): Request => {
    const headers = new Headers(init?.headers)
    headers.set(MEMORY_ACTOR_HEADER, actor)
    return new Request(DEFAULT_URL, { ...init, headers })
  }

  return {
    runtime,
    store,
    sentEmails: email.sentEmails,
    email,
    payments,
    advanceTime: (ms) => clock.advance(ms),
    clock,
    requestAs: (userId, init) => withActor(userId, init),
    requestAsService: (init) => withActor(MEMORY_SERVICE_ACTOR, init),
    anonRequest: (init) => new Request(DEFAULT_URL, init),
  }
}
