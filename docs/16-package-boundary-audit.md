# 16 — Package boundary & concept-leakage audit

> **What this is.** A static audit of whether the package boundaries that
> [ADR-0002](adr/0002-extract-reservation-core.md), [ADR-0009](adr/0009-portability-ports-and-adapters.md)
> and [ADR-0010](adr/0010-two-layer-packaging-and-oss-repos.md) set up actually hold in the code, or whether
> concepts have **leaked across layers**. Evidence is cited as `path:line`. **No code was changed** — this
> document only records what is there today and where the seams have slipped.
>
> **Date:** 2026-06-28 · **Scope:** `packages/*`, `plugins/*`, `db/migrations/*` (the published surface). The
> private product app (Termínář) is out of scope — it is *allowed* to know everything.

---

## 1. The rules being audited

The intended layering (from the ADRs):

| Layer | Packages | May know about | Must **not** know about |
|---|---|---|---|
| **L1 — generic backbone** (`@tenantkit/*`) | `kernel`, `next`, `i18n`, `adapter-supabase`, `email-resend`, `payments-stripe`, `testing` | tenants, members, roles, plans, plugins, routes, email, ports | courses, sessions, omluvenky, credits, capacity — *or any single app's tenant noun* ("studio") |
| **L2 — reservation domain** (`@reservation-core/*`) | `reservation-core`, first-party `plugins/*` | courses, sessions, capacity, the omluvenka credit engine | a **specific app preset** (kids-course "guardian/child" vs adult "participant") |
| **App** (private) | Termínář, NaLekci, Restaurio | everything | — |

Two load-bearing principles the ADRs call out explicitly:

- **ADR-0002:** the core *"knows about tenants, members, roles, plans, plugins, routes, and email — **never** about courses, sessions, or omluvenky"*, and *"the core must stay genuinely product-agnostic or it leaks one app's assumptions into all of them."* The **one** real coupling — the tenant noun — is generalized via `defineTenancy({ tenantTerm })`.
- **ADR-0011 / [doc 15](15-configurable-fields-and-settings.md):** "guardian" + "child" are the Termínář **`kids-course` preset**, not inherent to reservation — *"an adult fitness studio needs just «Jméno účastníka», no guardian."*

---

## 2. Verdict at a glance

**The structural boundaries are sound; the leaks are vocabulary, not architecture.** The dependency graph is
acyclic and correctly directed, and every vendor SDK is quarantined in its adapter. What has leaked is
**domain and app vocabulary into the generic kernel**, plus one half-finished rename in the domain layer.
Several of the leaks are *self-admitted in their own docstrings*, which suggests they are known staging
shortcuts rather than oversights — but they are real, and they are shipped on the L1 surface.

| # | Leak | From → Into | Severity | Self-admitted? |
|---|---|---|---|---|
| L1 | `CREDIT_*` / `SESSION_FULL` domain codes in the kernel error bridge | L2 domain → `kernel` | **High** | ✔ ("Lives conceptually in `@reservation-core/domain`") |
| L2 | Same codes localized in the kernel error catalog | L2 domain → `kernel` | **High** | ✔ (catalog says it holds "codes the KERNEL itself produces") |
| L3 | `"studio"` (Termínář tenant noun) hardcoded in kernel error messages | App → `kernel` | **High** | ✗ (kernel *has* `tenantTerm` and bypasses it) |
| L4 | `course_id` in the generic field-schema system + core SQL | L2 domain → `kernel` / `core` SQL | **Medium** | ✗ |
| L5 | `guardian*` / `child*` preset shape in the reservation dedupe | App preset → `reservation-core` | **Medium** | ✗ (half-renamed) |
| L6 | `fromName: 'Reservation'` default branding | L2 wording → `kernel` | **Low** | ✗ |
| L7 | Stale `// == packages/reservation-core/src/ports` comment | drift | **Low** | ✗ |
| L8 | Provisional `@tenantkit/kernel` name in comments vs real `@deverjak/…` | drift | **Low** | ✗ |
| L9 | Kernel unit/conformance tests reason only in reservation nouns | coupling smell | **Low** | ✗ |

---

## 3. What is correctly bounded (the parts that hold)

Stated first so the leaks below are read in proportion.

- **Dependency direction is clean and acyclic.** Every cross-package import is an *adapter/binding → kernel*
  edge, almost all `import type` (compile-time only): `adapter-supabase`, `testing`, `next`, `email-resend`,
  `payments-stripe`, `plugins/sms` all point at `@deverjak/tenantkit-kernel`; nothing points back. No package
  imports a *sibling* adapter.
- **Vendor SDKs are quarantined in their adapters.** `@supabase/*` appears only in `adapter-supabase`,
  `resend` only in `email-resend`, `stripe` only in `payments-stripe`, `next`/`next-intl` only in
  `next`/`i18n`. `kernel`'s only runtime dependency is `zod`; `reservation-core` has **zero** dependencies.
- **`reservation-core` is genuinely pure.** No external imports at all — every export is an I/O-free function
  over plain arguments (`packages/reservation-core/src/**`). A domain layer with no port or vendor coupling is
  exactly the ADR-0002 target.
- **The tenant noun *is* parameterized** where the abstraction was built for it: `defineTenancy({ tenantTerm })`
  (`kernel/src/tenancy/index.ts:29`), open `Tier` (`kernel/src/entitlements/index.ts:12`), and an
  app-owned permission grant map (`kernel/src/rbac/permissions.ts:6`) all keep the product's specifics out of
  the core. The leaks in §4 are places that *bypass* this machinery, not places where it is missing.
- **The earlier `guardian → participant_accounts` framework rename is complete in the kernel** — `guardian`
  survives there only as a documented *relation value example* (`kernel/src/db/index.ts:200`), which is
  intended.

---

## 4. Detailed findings

### L1 — Reservation-domain error codes live in the generic kernel  ·  **High**

`packages/kernel/src/domain/errors.ts:31-39` — the `DOMAIN_STATUS` map (consumed by `mapDomainError`, the
single domain→HTTP bridge) hardcodes reservation-domain codes next to generic ones:

```
CREDIT_EXPIRED: 422,
CREDIT_ALREADY_REDEEMED: 409,
SESSION_FULL: 409,
```

The file's **own docstring** says it *"Lives conceptually in `@reservation-core/domain`"* (`:4`). The codes
are *thrown* from the domain layer (the credit/capacity engine), not from the kernel — so the generic backbone
ships a status table for codes it never raises. This is the cleanest example of L2 vocabulary embedded in L1.

> Boundary intent: the kernel should own the *mechanism* (`DomainError`, the 422 fall-through), and let each
> domain/app register its own code→status entries. Today the reservation entries are baked in.

### L2 — …and they are localized in the kernel error catalog too  ·  **High**

`packages/kernel/src/http/error-catalog.ts:38-40,64-66` localizes the same codes in `cs`/`en`
(*"Platnost kreditu vypršela."*, *"Kapacita lekce je naplněná."*, *"This session is full."*). This directly
contradicts the catalog's own scope note (`:7-10`):

> *"Scope: codes the KERNEL itself produces … Apps localize their OWN domain codes in their own catalogues."*

`CREDIT_*` and `SESSION_FULL` are domain codes, yet they sit in the kernel catalog. Same leak as L1, one layer
up (presentation).

### L3 — The Termínář tenant noun "studio" is hardcoded in kernel messages  ·  **High**

`packages/kernel/src/http/error-catalog.ts` bakes the app's tenant noun into generic error strings:

- `:32` `PLUGIN_NOT_ENABLED: 'Tato funkce není pro vaše studio zapnutá.'`
- `:31` `NOT_A_MEMBER: 'Nejste členem tohoto studia.'`
- `:58,60` the `en` equivalents — *"You are not a member of this studio."*

ADR-0002 names the tenant noun as **the single coupling that must be generalized**, and the kernel already
carries the tool for it — `tenantTerm` (`kernel/src/tenancy/index.ts:29`, *"e.g. { one: 'studio' }"*). These
strings bypass it and re-pin the core to "studio". NaLekci ("instructor") and Restaurio ("restaurant") consume
the same catalog and would render the wrong noun. This is app vocabulary in L1, and the fix surface
(`tenantTerm`) already exists.

### L4 — `course_id` in the generic field-schema system and core SQL  ·  **Medium**

The configurable-field capability is generic by design (ADR-0011 → ships as kernel), but it references the
reservation domain's table directly:

- `packages/kernel/src/fields/preset.ts:39` — `course_id: string | null` on the generic `FieldDefinitionRow`.
- `db/migrations/0004_fields.sql:33` — `course_id uuid references public.courses(id)` **inside the `core`
  field-definitions table**, i.e. the generic core schema has a foreign key into the reservation domain's
  `public.courses`.

A truly generic per-tenant field system would scope a definition to an opaque container id, not to "course".
The leak is mild (it is nullable and ignored by non-course apps) but it is a hard `core → public.courses`
reference in the layer that is supposed to be domain-free.

### L5 — The kids-course preset shape leaked into the reservation dedupe  ·  **Medium**

`packages/reservation-core/src/enrollment/dedupe.ts` encodes the Termínář **`kids-course` preset**
(guardian-manages-child) as the reservation domain's only enrollment shape:

- `normalizeGuardianEmail`, `guardianMatchKey` (`:12,17`)
- `ApplicationIdentity { guardianEmail, childName, childDob, … }` (`:32-38`)
- `ChildIdentity` (`:24`)

Per ADR-0011 an adult studio — also a `reservation-core` consumer — has *no* guardian and no child; it enrolls
a participant directly. The rename to participant vocabulary was **started but not finished**: the function
`participantMatchKey` (`:28`) was renamed, yet it still takes a `ChildIdentity`, and the guardian/child
identifiers around it were left in place. The result is a domain layer that half-speaks two vocabularies and
hardcodes one app's family structure.

> This is the most *debatable* finding: one could argue "guardian/child" is the reservation domain's default
> and adult studios override it. But the field-schema ADR explicitly frames guardian/child as a **preset**, not
> a domain primitive — so the generic dedupe assuming it is a preset leak.

### L6 — `fromName: 'Reservation'` default branding  ·  **Low**

`packages/kernel/src/email/send.ts:38` defaults a tenant's email `fromName` to the literal `'Reservation'` —
an L2 domain word as the generic email default. Harmless in practice (tenants override branding) but it is
domain wording in the backbone's default path.

### L7 — Stale cross-package path comment  ·  **Low**

`packages/adapter-supabase/src/database.ts:13` annotates its kernel import with
`// == packages/reservation-core/src/ports`. That path does not exist — the port types (`Database`,
`RequestDb`, `ScopedDb`) live in the kernel now; `reservation-core` has no `ports/` directory. A leftover from
before the port types were consolidated; it points a reader at a boundary that has since moved.

### L8 — Provisional package name in comments vs the published name  ·  **Low**

Kernel doc comments tell apps to `import { … } from '@tenantkit/kernel'`
(`kernel/src/index.ts:2`, `openapi/index.ts:3`, `events/index.ts:4`, `fields/index.ts:4`,
`security/index.ts:4`), but the package actually publishes as `@deverjak/tenantkit-kernel`. ADR-0010 flagged
`@tenantkit/*` as a *provisional* scope; the rename landed in `package.json` but not in the comments. Purely
cosmetic, but every example import in the kernel is currently un-runnable as written.

### L9 — Kernel tests reason only in reservation nouns  ·  **Low (smell)**

The generic kernel proves itself almost entirely against one domain's vocabulary: `/api/courses`
(`openapi/__tests__/build.test.ts`), `enrollment.created` / `credit.issued`
(`events/__tests__/bus.test.ts`), `maxCourses` (`entitlements/__tests__/entitlements.test.ts`),
`courses:edit` (`rbac/__tests__/rbac.test.ts`), and `count_courses` in the **conformance suite**
(`testing/src/conformance.ts:72`). This is acceptable (tests are not shipped API), but a backbone whose only
worked example is the reservation domain is one rename away from quietly absorbing its assumptions. A second,
deliberately different fixture domain would harden the L1/L2 seam.

---

## 5. Note on intentionality

`packages/kernel/src/index.ts:2` labels the barrel a *"mockup"*, and findings L1–L2 are flagged in their own
docstrings as conceptually belonging to `@reservation-core`. So the high-severity leaks read as **deliberate
staging shortcuts** taken while the two-layer split (ADR-0010) is still being realized — the domain-error and
catalog machinery was built in the kernel first and not yet pushed down to the domain layer. That makes them
*tracked debt* rather than accidents, but the codes and the "studio" strings are nonetheless on the L1
published surface today, where a third consumer app would inherit them.

## 6. Summary

- **Architecture: clean.** Acyclic, correctly-directed dependencies; vendors quarantined; `reservation-core`
  pure; the tenant noun parameterized where the machinery was built for it.
- **Vocabulary: leaking, downward-acknowledged.** The generic kernel ships reservation-domain error codes
  (L1, L2) and the Termínář tenant noun "studio" (L3); the generic field system references `public.courses`
  (L4). Inside L2, the reservation dedupe hardcodes the kids-course guardian/child preset via an unfinished
  rename (L5).
- **Highest-value tightening** (for whoever picks this up — *not* done here): move the `CREDIT_*` / `SESSION_FULL`
  code→status + catalog entries out of `kernel` into the reservation layer, and route the "studio" strings
  through the existing `tenantTerm`. Both have a fix surface that already exists in the kernel; they are the
  two leaks most likely to mislead a second consumer app.
