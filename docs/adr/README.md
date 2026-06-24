# Architecture Decision Records

This directory records the load-bearing decisions behind **`reservation-core`** and **Termínář 2**. Each
ADR captures *one* decision with its context, the choice made, the consequences we accept, and the
alternatives we rejected — so a future reader (or a future product onto the core, like NaLekci or
Restaurio) understands *why* the system looks the way it does, not just *what* it is. ADRs are immutable
once **Accepted**; we supersede rather than edit. They are referenced by exact filename from the design
docs ([00](../00-overview.md), [01](../01-architecture.md), [02](../02-reservation-core.md),
[08](../08-attendance-and-omluvenky.md)).

| # | Title | Status | Summary |
|---|---|---|---|
| [0001](0001-stack-nextjs-supabase-resend.md) | Stack: Next.js 16 + Supabase + Resend | Accepted | Adopt the team's existing stack over legacy .NET, so the core can absorb `main-panel`/`admin-console` and RLS is the security boundary. |
| [0002](0002-extract-reservation-core.md) | Extract `reservation-core` | Accepted | Promote the plumbing both reference apps duplicate into one shared framework, generalizing only the tenant noun. |
| [0003](0003-monorepo-and-packaging.md) | Monorepo & packaging | Accepted | pnpm + Turborepo with scoped `@reservation-core/*` packages, `plugins/*`, and `apps/*`; headless core, optional `ui-mantine`. |
| [0004](0004-multimodal-core.md) | Multimodal core | Accepted | One `withRoute` serves four modalities (tenant-type, identity-type, auth-method, surface) via an `audience` option. |
| [0005](0005-per-course-credit-expiry.md) | Per-course credit expiry | Accepted | Omluvenka expiry is configured per course (`none\|ttl\|course_end\|windows`) and evaluated lazily at redemption. |
| [0006](0006-plugins-as-entitlements.md) | Plugins as entitlements | Accepted | Plugins are per-tenant activations gated by subscription tier; each owns its schema and extends only via 5 seams. |
| [0007](0007-guardian-participant-identity.md) | Guardian ↔ Participant identity | Accepted | Model Guardian (account) ↔ Participant (attendee) first-class, with `relation='self'` for adults; RLS via `guardian_can_act()`. |
| [0008](0008-rls-is-member-of.md) | RLS via `is_member_of()` | Accepted | DRY tenant isolation with one `SECURITY DEFINER` membership helper, replacing the inline subqueries that caused a recursion incident. |
| [0009](0009-portability-ports-and-adapters.md) | Portability: ports & adapters | Accepted | Postgres+RLS is the only hard dependency; Supabase/Resend/Stripe become swappable adapters behind ports, enabling an MIT open-source release. |
| [0010](0010-two-layer-packaging-and-oss-repos.md) | Two-layer packaging & OSS repos | Accepted | Generic `@tenantkit/*` kernel + `@reservation-core/*` domain, in **one public monorepo** with granular npm packages; product stays private. |
| [0011](0011-configurable-field-schema.md) | Configurable field schema | Accepted | Per-tenant, surface-aware participant/guardian/enrollment fields (system spine + custom JSONB + plugin-contributed), editable in Settings; generated forms + Zod. |
