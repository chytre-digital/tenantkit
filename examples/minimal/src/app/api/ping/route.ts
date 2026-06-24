/**
 * Two endpoints showing the two ends of `withRoute`:
 *   GET  /api/ping        — public, no auth.
 *   POST /api/ping        — staff, tenant-scoped; the INSERT runs under the caller's RLS identity.
 */
import { withRoute, jsonOk } from '@tenantkit/kernel'
import { z } from 'zod'
import { runtime } from '../../../runtime'

export const GET = withRoute({ runtime, audience: 'public' }, async () => {
  return jsonOk({ ok: true, ts: runtime.clock.now().toISOString() })
})

export const POST = withRoute(
  { runtime, audience: 'staff', minRole: 'admin', tenantFrom: 'cookie', body: z.object({ note: z.string().min(1) }) },
  async (ctx) => {
    // ctx.db.user() is the caller's RLS-scoped handle — the write cannot escape their tenant.
    await ctx.db.user().rpc('record_note', { tenant_id: ctx.tenantId, note: ctx.input.body!.note })
    return jsonOk({ recorded: true, tenantId: ctx.tenantId, by: ctx.claims?.userId })
  },
)
