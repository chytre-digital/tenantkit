/**
 * The slug-addressed twins of ../../ping (docs/02 §4a) — the RECOMMENDED tenancy model for new apps:
 *   GET  /api/t/[slug]/ping — public, but tenant-resolved (a public surface is still a tenant's surface).
 *   POST /api/t/[slug]/ping — staff; the tenant comes from the URL, never from a cookie.
 */
import { withSlugRoute, jsonOk } from '@tenantkit/kernel'
import { z } from 'zod'
import { runtime } from '../../../../../runtime'

export const GET = withSlugRoute({ runtime, audience: 'public' }, async (ctx) => {
  // Unknown slug already 404'd; ctx.tenant is the resolved { id, slug, name, tier } row.
  return jsonOk({ ok: true, studio: ctx.tenant.name, ts: runtime.clock.now().toISOString() })
})

export const POST = withSlugRoute(
  { runtime, audience: 'staff', minRole: 'admin', body: z.object({ note: z.string().min(1) }) },
  async (ctx) => {
    // Same RLS-scoped write as the legacy example — only the tenant selector changed (path, not cookie).
    await ctx.db.user().rpc('record_note', { tenant_id: ctx.tenant.id, note: ctx.input.body!.note })
    return jsonOk({ recorded: true, tenantId: ctx.tenant.id, by: ctx.claims?.userId })
  },
)
