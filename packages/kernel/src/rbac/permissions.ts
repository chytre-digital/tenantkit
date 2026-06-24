/**
 * Realizes docs/02-reservation-core.md §9 and docs/04-roles-and-permissions.md §3 — the permission layer.
 *
 * Pure `@reservation-core/domain/rbac`. A `Permission` is `resource:action[:scope]` with `scope ∈ {own, any}`;
 * the same scope distinction becomes an RLS `USING` clause in SQL (doc 04 §4). The core only knows how to
 * EVALUATE `can(role, perm)`; the GRANT MAP is data the app owns (`TERMINAR_PERMISSIONS`, doc 04 §3) and can
 * override per tenant on a future "custom roles" entitlement. A generic default map ships here so the core is
 * usable standalone; apps replace it via `setPermissionGrants`.
 */
import type { AppRole } from './roles'
import { roleRank } from './roles'

export type Scope = 'own' | 'any'

export type Permission =
  | `${string}:${string}` // scope-less, e.g. 'billing:manage'
  | `${string}:${string}:${Scope}` // scoped, e.g. 'courses:edit:any'

/** A role's grants: permission → the broadest scope granted (`any` implies `own`), or `true` for scope-less. */
export type GrantMap = Record<AppRole, Partial<Record<string, Scope | true>>>

/**
 * Generic default grants (resource-agnostic): higher rank ⇒ broader. Apps supply a real catalogue; this keeps
 * `can()` meaningful before that wiring exists. Keyed by the scope-less `resource:action` stem.
 */
let GRANTS: GrantMap = {
  staff: {},
  coach: {},
  admin: {},
  owner: {},
}

/** App wiring: replace the default grant map with the app's catalogue (doc 02 §15, doc 04 §3). */
export function setPermissionGrants(grants: GrantMap): void {
  GRANTS = grants
}

function splitPerm(perm: Permission): { stem: string; scope: Scope | null } {
  const parts = perm.split(':')
  if (parts.length >= 3 && (parts[2] === 'own' || parts[2] === 'any')) {
    return { stem: `${parts[0]}:${parts[1]}`, scope: parts[2] }
  }
  return { stem: perm, scope: null }
}

/**
 * Does `role` hold `perm`? `ctx.ownerOf` is the runtime fact "the caller is assigned to THIS row" (e.g. a
 * `coach_assignments` hit, doc 04 §3) which lets an `own` requirement pass for a coach. A grant of `any`
 * satisfies any requirement; an `own` grant satisfies an `own`/scope-less requirement only when `ownerOf`.
 */
export function can(role: AppRole, perm: Permission, ctx?: { ownerOf?: boolean }): boolean {
  const { stem, scope } = splitPerm(perm)
  const granted = GRANTS[role]?.[stem]
  if (granted === undefined) return false
  if (granted === true) return true // scope-less grant
  if (granted === 'any') return true // 'any' covers 'own' and scope-less requirements
  // granted === 'own': only when the required scope is 'own'/none AND the caller owns this row.
  if (scope === 'any') return false
  return ctx?.ownerOf === true
}

/** True when `role` could ever hold `perm` for SOME row (ignores per-row `ownerOf`) — for menu visibility. */
export function mayEver(role: AppRole, perm: Permission): boolean {
  const { stem } = splitPerm(perm)
  return GRANTS[role]?.[stem] !== undefined
}

export { roleRank }
