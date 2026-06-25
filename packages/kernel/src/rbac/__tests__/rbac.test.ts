/**
 * Realizes docs/04-roles-and-permissions.md §2–§3 — the role order + the scoped permission evaluator, proven
 * pure (these back BOTH the app gate and, via the same ranks, the RLS `role_rank()` in db/index.ts).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { roleAtLeast, roleRank, ROLE_ORDER } from '../roles'
import { can, mayEver, setPermissionGrants } from '../permissions'

describe('roles (doc 04 §2)', () => {
  it('totally orders staff < coach < admin < owner', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true)
    expect(roleAtLeast('admin', 'admin')).toBe(true)
    expect(roleAtLeast('coach', 'admin')).toBe(false)
    expect(roleAtLeast('staff', 'coach')).toBe(false)
  })
  it('null role (no membership) is below every minimum', () => {
    expect(roleAtLeast(null, 'staff')).toBe(false)
  })
  it('ranks match the SQL role_rank + ROLE_ORDER is low→high', () => {
    expect(roleRank).toEqual({ staff: 1, coach: 2, admin: 3, owner: 4 })
    expect(ROLE_ORDER).toEqual(['staff', 'coach', 'admin', 'owner'])
  })
})

describe('permissions can/mayEver (doc 04 §3)', () => {
  beforeEach(() => {
    setPermissionGrants({
      staff: {},
      coach: { 'courses:edit': 'own' },
      admin: { 'courses:edit': 'any' },
      owner: { 'courses:edit': 'any', 'billing:manage': true },
    })
  })

  it("'any' grant satisfies both own and any requirements", () => {
    expect(can('admin', 'courses:edit:any')).toBe(true)
    expect(can('admin', 'courses:edit:own')).toBe(true)
  })

  it("'own' grant satisfies an own requirement only when the caller owns the row", () => {
    expect(can('coach', 'courses:edit:own')).toBe(false)
    expect(can('coach', 'courses:edit:own', { ownerOf: true })).toBe(true)
    expect(can('coach', 'courses:edit:any')).toBe(false) // own never satisfies an 'any' requirement
  })

  it('scope-less grant (true) always passes; ungranted is always false', () => {
    expect(can('owner', 'billing:manage')).toBe(true)
    expect(can('staff', 'courses:edit:any')).toBe(false)
  })

  it('mayEver ignores per-row ownership (for menu visibility)', () => {
    expect(mayEver('coach', 'courses:edit:any')).toBe(true) // could, for some row
    expect(mayEver('staff', 'courses:edit')).toBe(false)
  })
})
