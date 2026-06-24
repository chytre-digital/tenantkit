# @tenantkit/testing

The **in-memory runtime** + the **port conformance suite** — the "is it really decoupled?" check from
[docs/14 §6.4](../../docs/14-portability-and-providers.md).

## `createTestRuntime()`

A fully vendor-free `CoreRuntime` (the same bag of ports `createSupabaseRuntime()` returns) over a Map-backed
store + a frozen, advanceable clock. The kernel and the app test against this — fast, deterministic, no Supabase.

```ts
import { createTestRuntime } from '@tenantkit/testing'

const t = createTestRuntime({ tenants: [{ id: 't1', name: 'Delfínek', slug: 'delfinek', tier: 'studio' }] })
const res = await POST(t.requestAs('user-1'))        // act as a seeded user (RLS resolves to them)
expect(t.sentEmails).toHaveLength(1)                 // assert side-effects
t.advanceTime(31 * 864e5)                            // drive credit-expiry math
```

`store` (seed/inspect rows + `registerRpc`), `sentEmails`, `payments`, `advanceTime`, `requestAs/requestAsService/anonRequest`.

## The conformance suite

Vitest suites written against the **ports only**, so any adapter can run them:

```ts
import { runAllConformance, type ConformanceHarness } from '@tenantkit/testing'

describe('my-adapter', () => runAllConformance(() => makeMyHarness()))
```

A `ConformanceHarness` provides `runtime`, `seedUserWithMembership()`, `requestAs()`, `anonRequest()`. The
in-memory runtime runs the suite in `src/__tests__/inmemory.conformance.test.ts`; the Supabase adapter runs the
**same** call against a throwaway project in an integration lane. **A new community adapter is "done" when this
goes green** — that's the bar, instead of arguing about coupling. MIT.
