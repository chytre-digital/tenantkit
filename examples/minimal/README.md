# example: minimal

The smallest end‑to‑end wiring of `tenantkit` — a Supabase runtime + one endpoint per tenancy model. Read it
to see how the pieces snap together; copy it to start a new product.

- [`src/runtime.ts`](src/runtime.ts) — assemble the `CoreRuntime` once (Supabase + Resend).
- [`src/app/api/t/[slug]/ping/route.ts`](src/app/api/t/%5Bslug%5D/ping/route.ts) — **`withSlugRoute`
  (recommended)**: the tenant is the `[slug]` in the URL, resolved for public and staff alike (doc 02 §4a).
- [`src/app/api/ping/route.ts`](src/app/api/ping/route.ts) — legacy `withRoute` (cookie‑selected tenant), kept
  for cookie/host‑tenancy apps.

```bash
cp .env.example .env   # SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY
pnpm --filter @tenantkit/example-minimal dev
```

Apply the kernel + reference migrations from [`../../db/migrations`](../../db/migrations) first
(they create `core.*` + the RLS predicates). That's the whole setup.
