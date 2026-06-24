# example: minimal

The smallest end‑to‑end wiring of `tenantkit` — a Supabase runtime + one `withRoute` endpoint. Read it to see
how the pieces snap together; copy it to start a new product.

- [`src/runtime.ts`](src/runtime.ts) — assemble the `CoreRuntime` once (Supabase + Resend).
- [`src/app/api/ping/route.ts`](src/app/api/ping/route.ts) — a public route and a tenant‑scoped staff route.

```bash
cp .env.example .env   # SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY
pnpm --filter @tenantkit/example-minimal dev
```

Apply the kernel + reference migrations from [`../../db/migrations`](../../db/migrations) first
(they create `core.*` + the RLS predicates). That's the whole setup.
