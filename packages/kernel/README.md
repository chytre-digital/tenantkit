# `@tenantkit/kernel` (mockup)

> Illustrative reference source for the framework specified in
> [`docs/02-reservation-core.md`](../../docs/02-reservation-core.md). **Not production code** — bodies are
> representative (real logic where short, `// …` where a full implementation would be long). Read it to see the
> *shape* of the framework.

## What this is

`reservation-core` is the reusable foundation extracted from two real apps (`main-panel`, `admin-console`) that
had independently re-implemented the same building blocks: the four Supabase client factories, a
`withAuthRoute` wrapper, `requireClaims()`, an active-tenant cookie, the HTTP/error stack, the Zod validation
kit, an entitlements engine, the Resend layer, and the next-intl wiring. The only real difference between the
apps was the **tenant noun** — that single coupling is what the core generalizes.

It knows about **tenants, members, roles, plans, plugins, routes, and email** — never about courses, sessions,
or omluvenky. Termínář 2 (and later NaLekci, Restaurio) are thin domains on top.

## The headless principle

The core is **server-first and UI-agnostic**: the heart of it (`withRoute`, http, validation, supabase, auth,
tenancy, rbac, entitlements, email, plugin runtime) drags in **no React**. Pure types and policy math
(roles, entitlement checks, token utils) have **no dependencies at all** and are unit-testable without
Supabase. React only enters through the optional `ui-mantine` package. This is why the legacy bugs (EF
change-tracking, JWT claim mismatches) cannot recur: the rules do not depend on the persistence mechanism or
the rendering layer.

## The package split (real shape)

In the real monorepo this is published as scoped packages so apps import only what they need (doc 02 §3):

| Package | Contains |
|---|---|
| `@tenantkit/kernel` | `withRoute`, http, validation, supabase clients, auth, tenancy, rbac, entitlements, email, plugin runtime |
| `@reservation-core/domain` | pure types & policy helpers (roles, entitlement math, token utils) — zero deps |
| `@reservation-core/i18n` | next-intl routing/request/navigation factory |
| `@reservation-core/db` | SQL: `is_member_of()`, `set_updated_at()`, RLS macros |
| `@reservation-core/plugins` | Plugin SDK types & registry (isomorphic) |
| `@reservation-core/ui-mantine` | Mantine theme, tokens, primitives, `<PluginSlot>` |
| `@reservation-core/testing` | tenant/user factories, RLS test harness, fake Resend |

This mockup keeps them in one tree (`src/{server,http,validation,supabase,auth,tenancy,rbac,entitlements,email,plugins,i18n,domain}`)
so the whole framework reads top-to-bottom.

## Write your first route

Every API route is a `withRoute(opts, handler)`. The wrapper resolves identity, tenant, role, plugin-gating,
and validation, then hands a typed `RouteCtx` to your handler:

```ts
// apps/terminar/app/api/sessions/[id]/attendance/route.ts
import { withRoute, jsonOk } from '@tenantkit/kernel'
import { RecordAttendanceSchema } from '@/domain/attendance'

export const POST = withRoute(
  { audience: 'staff', minRole: 'coach', tenantFrom: 'cookie',
    can: 'attendance:record', body: RecordAttendanceSchema },
  async (ctx, _req, { params }: { params: { id: string } }) => {
    const result = await recordAttendance(ctx, {                  // an application use-case
      sessionId: params.id, marks: ctx.input.body!.marks,
    })
    return jsonOk({ attendance: result })
  },
)
```

That single declaration enforces: caller has a session, is a member of the resolved tenant, is at least
`coach`, holds `attendance:record`, and sent a body matching the schema — each a clean early-return error.
RLS is the second gate underneath (doc 04).

See doc 02 for the full pipeline and every subsystem.
