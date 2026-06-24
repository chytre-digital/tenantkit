/**
 * Realizes docs/02-reservation-core.md §9 and docs/04-roles-and-permissions.md §2 — the role hierarchy.
 *
 * Lives in `@reservation-core/domain/rbac`: pure, no I/O. `AppRole` is the `app_role` enum from doc 03,
 * totally ordered by rank (`owner > admin > coach > staff`). `roleAtLeast` is the coarse gate `withRoute`
 * ANDs with the fine-grained `can()` (permissions.ts). Generalizes both apps' `employee < admin < owner`
 * (employee → staff, plus `coach` for the course domain).
 */

export type AppRole = 'staff' | 'coach' | 'admin' | 'owner'

/** Rank 1..4. The same numbers back `core.role_rank()` in SQL (doc 02 §14) so app- and DB-gates agree. */
export const roleRank: Record<AppRole, number> = {
  staff: 1,
  coach: 2,
  admin: 3,
  owner: 4,
}

/** Coarse gate: is `role` at least `min`? `null` (no membership) is always below any minimum. */
export function roleAtLeast(role: AppRole | null, min: AppRole): boolean {
  if (role === null) return false
  return roleRank[role] >= roleRank[min]
}

/** All roles ordered low→high — handy for "promote/demote" UIs and rank-cap checks (doc 04 §5). */
export const ROLE_ORDER: readonly AppRole[] = ['staff', 'coach', 'admin', 'owner']
