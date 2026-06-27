/**
 * Realizes docs/02-reservation-core.md §7 and docs/05-auth.md §4 — `resolveClaims()` + `AuthContext`.
 *
 * Resolves the authenticated subject into the two-context `AuthContext`: STAFF (`memberships`) AND the
 * PARTICIPANT side (`participantAccounts`) — one account can be both; the route's `audience` decides which is
 * required (doc 04 §1). A participant account links a user to a participant they may act for; its `relation` is a
 * value — `'self'` for an adult / own participant managing their own enrollment, or an app value (e.g. a kid's
 * `'guardian'`/`'parent'`). The framework stays participant-generic; "guardian" is only ever a relation VALUE.
 *
 * PORTS REFACTOR (docs/14 §7): this no longer imports Supabase. It reads identity through
 * `runtime.identity.getCurrentUser(req)` and the three cross-cutting reads through `runtime.authz`
 * (`ensureProfile` / `getMemberships` / `getParticipantAccounts`). The adapter decides HOW those rows are fetched.
 *
 * Behaviors lifted from main-panel's `requireClaims`, generalized:
 *   • MEMOIZED PER REQUEST — a `WeakMap<Request, Promise<AuthContext>>` gives one DB round-trip per request no
 *     matter how many callers, WITHOUT a hard dependency on React `cache()` (doc 02 §7). The kernel is now
 *     framework-agnostic; the `Request` object is the natural per-request key.
 *   • IDEMPOTENT profile bootstrap → `runtime.authz.ensureProfile` ensures a `core.profiles` row exists on first
 *     authenticated hit (the adapter guards the select → insert-if-missing, or uses a DB trigger).
 *   • Throws `unauthorized()` when there is no session.
 *
 * Table names are authoritative from doc 03 §3 (`core.profiles`, `core.memberships`, `core.participant_accounts`)
 * — but they now live INSIDE the adapter's `AuthzStore`, not here.
 */
import type { CoreRuntime } from '../ports'
import { unauthorized } from '../http/errors'
import type { AppRole } from '../rbac/roles'

export interface ProfileClaims {
  fullName: string | null
  locale: string | null
  avatarUrl: string | null
  phone: string | null
}

/** STAFF side — one row per tenant the user belongs to. */
export interface Membership {
  tenantId: string
  role: AppRole
}

/** A participant-account link's relation: 'self' (adult / own participant) or an app value (e.g. 'guardian', 'parent'). */
export type ParticipantRelation = 'parent' | 'guardian' | 'self'

/** PARTICIPANT side — one row per participant the account may act for. */
export interface ParticipantAccount {
  participantId: string
  tenantId: string
  relation: ParticipantRelation
}

export interface AuthContext {
  userId: string
  email: string | null
  profile: ProfileClaims
  memberships: Membership[] // STAFF
  participantAccounts: ParticipantAccount[] // PARTICIPANT (family) side
}

/**
 * Per-request memo. The first `resolveClaims(req, …)` in a request hits the ports; subsequent calls in the same
 * request (any component / the route pipeline) reuse the in-flight Promise. Keyed on the `Request` itself so the
 * entry is GC'd with the request — the framework-agnostic replacement for React `cache()` (doc 02 §7).
 */
const REQUEST_CLAIMS = new WeakMap<Request, Promise<AuthContext>>()

/**
 * Resolve the caller's `AuthContext` for this request via the runtime's ports. Memoized per `Request`.
 * Throws `401 UNAUTHORIZED` when there is no active session.
 */
export function resolveClaims(req: Request, runtime: CoreRuntime): Promise<AuthContext> {
  const cached = REQUEST_CLAIMS.get(req)
  if (cached) return cached
  const promise = loadClaims(req, runtime)
  REQUEST_CLAIMS.set(req, promise)
  return promise
}

async function loadClaims(req: Request, runtime: CoreRuntime): Promise<AuthContext> {
  const user = await runtime.identity.getCurrentUser(req)
  if (!user) throw unauthorized('UNAUTHORIZED', 'No active session')

  // Idempotent profile bootstrap (adapter guards the select → insert-if-missing or uses a DB trigger).
  const profile = await runtime.authz.ensureProfile(user.id, user.email ?? null)

  // Both context shapes are loaded in parallel; the route's audience picks which one it requires.
  const [memberships, participantAccounts] = await Promise.all([
    runtime.authz.getMemberships(user.id),
    runtime.authz.getParticipantAccounts(user.id),
  ])

  return {
    userId: user.id,
    email: user.email ?? null,
    profile: {
      fullName: profile.fullName,
      locale: profile.locale,
      avatarUrl: profile.avatarUrl,
      phone: profile.phone,
    },
    memberships: memberships.map((m) => ({ tenantId: m.tenantId, role: m.role as AppRole })),
    participantAccounts: participantAccounts.map((p) => ({
      participantId: p.participantId,
      tenantId: p.tenantId,
      relation: p.relation as ParticipantRelation,
    })),
  }
}
