/**
 * Realizes docs/02-reservation-core.md §9 and docs/04-roles-and-permissions.md §2 — the role hierarchy.
 *
 * Lives in `@reservation-core/domain/rbac`: pure, no I/O. The role vocabulary is NOT hardcoded — the framework
 * only knows how to compare roles by RANK and which one is the "owner". Each app declares its own set at boot via
 * `defineRoles()` (mirroring `setTierEntitlements`/`setPermissionGrants`), so a project's roles never leak into
 * the framework. `roleAtLeast` is the coarse gate `withRoute` ANDs with the fine-grained `can()` (permissions.ts).
 * The same ranks back `core.role_rank()` in SQL (data-driven `core.roles` table, doc 02 §14) so app- and
 * DB-gates agree.
 */

/** A role identifier. Open string — the concrete vocabulary is app-defined via `defineRoles()`. */
export type AppRole = string

/**
 * One role in an app's hierarchy. `rank` totally orders roles (higher = more powerful). `isOwner` marks the
 * single top principal every tenant has exactly one of (provisioning, one-owner invariant, invite rank-cap);
 * `isAdmin` marks "may administer the tenant" — declarative metadata that mirrors the `core.roles` columns an
 * app seeds in SQL. `label` is an optional human name (apps usually localize labels in their own i18n instead).
 */
export interface RoleDef {
  key: string
  rank: number
  label?: string
  isOwner?: boolean
  isAdmin?: boolean
}

/**
 * The app's role hierarchy. Empty until `defineRoles()` runs at boot — the framework ships NO default vocabulary
 * (deliberately: an app's roles must not become the framework's default). Mirrors `TIER_ENTITLEMENTS`.
 */
let ROLE_REGISTRY: RoleDef[] = []
let RANK_BY_KEY = new Map<string, number>()
let OWNER_ROLE: string | null = null

/** App wiring: declare the role hierarchy. Validates uniqueness + a single owner; derives owner = top rank if unflagged. */
export function defineRoles(roles: RoleDef[]): void {
  if (roles.length === 0) throw new Error('defineRoles: at least one role is required')
  const keys = new Set<string>()
  for (const r of roles) {
    if (keys.has(r.key)) throw new Error(`defineRoles: duplicate role key "${r.key}"`)
    keys.add(r.key)
  }
  const owners = roles.filter((r) => r.isOwner)
  if (owners.length > 1) throw new Error('defineRoles: at most one role may be marked isOwner')
  const owner = owners[0] ?? [...roles].sort((a, b) => b.rank - a.rank)[0]
  if (!owner) throw new Error('defineRoles: at least one role is required')

  ROLE_REGISTRY = roles
  RANK_BY_KEY = new Map(roles.map((r) => [r.key, r.rank]))
  OWNER_ROLE = owner.key
}

/** Rank of `role`, or 0 for an unknown/undeclared role. Same numbers as SQL `core.role_rank()`. */
export function roleRank(role: AppRole): number {
  return RANK_BY_KEY.get(role) ?? 0
}

/** Coarse gate: is `role` at least `min`? `null` (no membership) is always below any minimum. */
export function roleAtLeast(role: AppRole | null, min: AppRole): boolean {
  if (role === null) return false
  return roleRank(role) >= roleRank(min)
}

/** All roles ordered low→high — handy for "promote/demote" UIs and rank-cap checks (doc 04 §5). */
export function getRoleOrder(): AppRole[] {
  return [...ROLE_REGISTRY].sort((a, b) => a.rank - b.rank).map((r) => r.key)
}

/** The declared role definitions (a copy), for label/flag lookups. */
export function getRoles(): RoleDef[] {
  return [...ROLE_REGISTRY]
}

/** The key of the owner role — the single top principal (provisioning, rank-cap). Throws if roles aren't declared. */
export function getOwnerRole(): AppRole {
  if (OWNER_ROLE === null) throw new Error('getOwnerRole: no roles declared — call defineRoles() at boot')
  return OWNER_ROLE
}
