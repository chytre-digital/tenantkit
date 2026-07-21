/**
 * Realizes docs/04-roles-and-permissions.md §2–§3 — the role hierarchy + the scoped permission evaluator, proven
 * pure. The vocabulary is app-defined via `defineRoles()` (data, not a hardcoded enum), so these suites declare
 * their own roles first — including a "custom project" suite that never mentions staff/coach/admin/owner, proving
 * the framework carries no role vocabulary of its own.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { defineRoles, roleAtLeast, roleRank, getRoleOrder, getOwnerRole } from '../roles'
import { can, mayEver, setPermissionGrants } from '../permissions'

describe('roles registry (doc 04 §2)', () => {
  beforeEach(() => {
    defineRoles([
      { key: 'staff', rank: 1 },
      { key: 'coach', rank: 2 },
      { key: 'admin', rank: 3, isAdmin: true },
      { key: 'owner', rank: 4, isOwner: true, isAdmin: true },
    ])
  })

  it('totally orders staff < coach < admin < owner', () => {
    expect(roleAtLeast('owner', 'admin')).toBe(true)
    expect(roleAtLeast('admin', 'admin')).toBe(true)
    expect(roleAtLeast('coach', 'admin')).toBe(false)
    expect(roleAtLeast('staff', 'coach')).toBe(false)
  })
  it('null role (no membership) is below every minimum', () => {
    expect(roleAtLeast(null, 'staff')).toBe(false)
  })
  it('roleRank looks up the declared rank (0 for unknown); order is low→high', () => {
    expect(roleRank('staff')).toBe(1)
    expect(roleRank('owner')).toBe(4)
    expect(roleRank('nope')).toBe(0)
    expect(getRoleOrder()).toEqual(['staff', 'coach', 'admin', 'owner'])
  })
  it('exposes the declared owner role', () => {
    expect(getOwnerRole()).toBe('owner')
  })
})

describe('roles registry — a project with its OWN vocabulary (no framework leak)', () => {
  beforeEach(() => {
    // A different app: crew/dispatch. The framework must work with these keys exactly as it did with the others.
    defineRoles([
      { key: 'pracovnik', rank: 1 },
      { key: 'vedouci-posadky', rank: 2 },
      { key: 'dispecer', rank: 3, isAdmin: true },
      { key: 'vlastnik', rank: 4, isOwner: true, isAdmin: true },
    ])
  })

  it('ranks + gates work on custom keys', () => {
    expect(roleAtLeast('dispecer', 'vedouci-posadky')).toBe(true)
    expect(roleAtLeast('pracovnik', 'dispecer')).toBe(false)
    expect(roleRank('vlastnik')).toBe(4)
    expect(getRoleOrder()).toEqual(['pracovnik', 'vedouci-posadky', 'dispecer', 'vlastnik'])
    expect(getOwnerRole()).toBe('vlastnik')
  })

  it('derives the owner as the top rank when none is flagged', () => {
    defineRoles([
      { key: 'a', rank: 1 },
      { key: 'b', rank: 5 },
    ])
    expect(getOwnerRole()).toBe('b')
  })

  it('rejects a malformed vocabulary (duplicate keys, two owners, empty)', () => {
    expect(() => defineRoles([])).toThrow()
    expect(() => defineRoles([{ key: 'x', rank: 1 }, { key: 'x', rank: 2 }])).toThrow()
    expect(() =>
      defineRoles([
        { key: 'x', rank: 1, isOwner: true },
        { key: 'y', rank: 2, isOwner: true },
      ]),
    ).toThrow()
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
