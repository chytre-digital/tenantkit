/**
 * Realizes docs/04-roles-and-permissions.md §2 (the TS↔SQL role bridge) — `rolesSeedSql` builds the deterministic
 * seed for `core.roles` from the app's `RoleDef[]`, and `diffRoleSeed` compares the DECLARED vocabulary
 * (`getRoles()`) against the rows a deployment actually seeded, so drift between TypeScript and SQL is caught
 * before it becomes a silent authorization bug. Both are pure — the drift-check never touches a real database.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { defineRoles, getRoles } from '../../rbac/roles'
import { rolesSeedSql, diffRoleSeed, type RoleRow } from '../index'

// The Výkazník field-ops vocabulary (spec §6.2) — deliberately NOT staff/coach/admin/owner, to prove the
// framework carries no roles of its own. `owner` is the single top principal; `admin`/`owner` may administer.
const VYKAZNIK = [
  { key: 'worker', rank: 10, label: 'Pracovník' },
  { key: 'reviewer', rank: 20, label: 'Kontrolor' },
  { key: 'admin', rank: 30, label: 'Správce', isAdmin: true },
  { key: 'owner', rank: 40, label: 'Vlastník', isAdmin: true, isOwner: true },
]

/** The rows `rolesSeedSql(VYKAZNIK)` would put in `core.roles` (what an in-sync `select … from core.roles` returns). */
const SEEDED: RoleRow[] = [
  { key: 'worker', rank: 10, label: 'Pracovník', is_owner: false, is_admin: false },
  { key: 'reviewer', rank: 20, label: 'Kontrolor', is_owner: false, is_admin: false },
  { key: 'admin', rank: 30, label: 'Správce', is_owner: false, is_admin: true },
  { key: 'owner', rank: 40, label: 'Vlastník', is_owner: true, is_admin: true },
]

describe('rolesSeedSql (doc 04 §2)', () => {
  it('emits one row per role with owner derived and flags defaulted', () => {
    const sql = rolesSeedSql(VYKAZNIK)
    expect(sql).toContain("('worker', 10, 'Pracovník', false, false)")
    expect(sql).toContain("('admin', 30, 'Správce', false, true)")
    expect(sql).toContain("('owner', 40, 'Vlastník', true, true)")
  })

  it('is idempotent — upserts on conflict, never deletes (memberships may reference a role)', () => {
    const sql = rolesSeedSql(VYKAZNIK)
    expect(sql).toContain('on conflict (key) do update set')
    expect(sql).toMatch(/is_owner = excluded\.is_owner/)
    expect(sql).not.toMatch(/\bdelete\b/i)
  })

  it('derives the owner from the top rank when none is flagged', () => {
    const sql = rolesSeedSql([
      { key: 'a', rank: 1 },
      { key: 'b', rank: 5 },
    ])
    expect(sql).toContain("('b', 5, null, true, false)") // top rank becomes the owner; null label
    expect(sql).toContain("('a', 1, null, false, false)")
  })

  it('escapes single quotes in labels (no SQL injection via a label)', () => {
    const sql = rolesSeedSql([{ key: 'x', rank: 1, label: "O'Brien", isOwner: true }])
    expect(sql).toContain("('x', 1, 'O''Brien', true, false)")
  })
})

describe('diffRoleSeed — getRoles() vs core.roles rows (doc 04 §2)', () => {
  beforeEach(() => defineRoles(VYKAZNIK))

  it('reports in-sync (empty report) when the seed mirrors the declared roles', () => {
    const diff = diffRoleSeed(getRoles(), SEEDED)
    expect(diff.inSync).toBe(true)
    expect(diff.missing).toEqual([])
    expect(diff.extra).toEqual([])
    expect(diff.mismatched).toEqual([])
    expect(diff.report).toBe('')
  })

  it('flags a role declared in code but never seeded (missing)', () => {
    const withoutReviewer = SEEDED.filter((r) => r.key !== 'reviewer')
    const diff = diffRoleSeed(getRoles(), withoutReviewer)
    expect(diff.inSync).toBe(false)
    expect(diff.missing).toEqual(['reviewer'])
    expect(diff.report).toContain('missing in core.roles')
    expect(diff.report).toContain('reviewer')
  })

  it('flags a stale role seeded in the DB but no longer declared (extra)', () => {
    const withLegacy: RoleRow[] = [...SEEDED, { key: 'legacy', rank: 99, is_owner: false, is_admin: false }]
    const diff = diffRoleSeed(getRoles(), withLegacy)
    expect(diff.inSync).toBe(false)
    expect(diff.extra).toEqual(['legacy'])
    expect(diff.report).toContain('extra in core.roles')
  })

  it('flags rank and capability-flag drift with a readable per-field report', () => {
    const drifted = SEEDED.map((r) =>
      r.key === 'admin' ? { ...r, rank: 3, is_admin: false } : r.key === 'owner' ? { ...r, is_owner: false } : r,
    )
    const diff = diffRoleSeed(getRoles(), drifted)
    expect(diff.inSync).toBe(false)
    expect(diff.mismatched).toEqual([
      { key: 'admin', field: 'rank', code: 30, db: 3 },
      { key: 'admin', field: 'is_admin', code: true, db: false },
      { key: 'owner', field: 'is_owner', code: true, db: false },
    ])
    expect(diff.report).toContain('admin.rank: code=30 db=3')
    expect(diff.report).toContain('owner.is_owner: code=true db=false')
  })

  it('ignores label differences — labels are an i18n concern, not part of the authz contract', () => {
    const relabelled = SEEDED.map((r) => ({ ...r, label: 'změněno' }))
    const diff = diffRoleSeed(getRoles(), relabelled)
    expect(diff.inSync).toBe(true)
    expect(diff.report).toBe('')
  })

  it('treats a NULL/absent db flag as false (matches the core.roles column defaults)', () => {
    const sparse: RoleRow[] = [
      { key: 'worker', rank: 10 },
      { key: 'reviewer', rank: 20 },
      { key: 'admin', rank: 30, is_admin: true },
      { key: 'owner', rank: 40, is_owner: true, is_admin: true },
    ]
    expect(diffRoleSeed(getRoles(), sparse).inSync).toBe(true)
  })
})
