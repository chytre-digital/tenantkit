# ADR-0011 — Configurable, surface-aware participant field schema

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Platform team
- **Context tags:** data-model, multi-tenancy, extensibility

## Context

Every app — and every tenant within one — collects **different** data about its participants. The Termínář
mockup's *"Nový účastník"* form is *Jméno dítěte · Datum narození · Zákonný zástupce · E-mail · Telefon · Kurz ·
Stav platby · Poznámka* — but an adult fitness studio has no "child" or "guardian", a language school wants a
"level", a camp wants "allergies" and an "emergency contact". The same is true of the public QR form and the
portal. Hard‑coding these fields makes the product single‑purpose. Legacy `terminar` had only
`custom_field_definitions` for *extra* questions — it could not relabel or remove the *core* fields. The brief:
**"každá aplikace bude mít jiné uživatele/účastníky, proto je třeba aby tyto pole člověk mohl nastavit v
settings."**

## Decision

A single **configurable, surface‑aware field schema** (`core.field_sets` + `core.field_definitions`,
[migration 0004](../../supabase/migrations/0004_fields.sql)) that the admin/public/portal forms render from,
with a small **typed spine** underneath:

- **System fields** map to real typed columns (`participants.full_name`, `date_of_birth`,
  `enrollments.payment_status`, the application's guardian columns…). They can be **relabeled, toggled,
  reordered, made required/optional** — but not deleted (the spine stays for indexing, RLS, age matching,
  dedupe). **Custom fields** are stored in the existing `participants.custom` / `enrollments.custom` JSONB. No
  EAV explosion.
- **Surface‑aware**: each field declares where it appears (`admin_form`, `public_form`, `portal`).
- **Per‑tenant, seeded from an app preset**: Termínář ships a `kids-course` preset (child + guardian) and an
  `adult` preset (participant only); a new tenant gets a preset it then edits in **Settings → Pole účastníka**.
- **Plugin‑contributable**: a plugin may register field definitions (the `payments` plugin contributes
  `payment_status`); `source = 'plugin:<id>'`.
- The capability is **generic → it lives in the kernel** (`@tenantkit/kernel` `fields` module: definitions,
  preset application, Zod + form‑descriptor generation, value read/write across spine + JSONB). The
  participant/guardian/enrollment **presets** live in the Termínář app. See
  [docs/15](../15-configurable-fields-and-settings.md).

## Consequences

**Positive:** one form engine serves every app/tenant; the same schema drives admin add, public QR, and portal,
plus validation (Zod) on client and server from one source; supersedes the legacy `custom_field_definitions` /
`course_field_assignments`; another reason the kernel is broadly useful (any multi‑tenant SaaS wants this).
**Negative / costs:** a form/validation generator to build and test; system‑field guardrails (no delete,
column mapping) add rules; migrating legacy custom fields. **Follow‑ups:** ship the `fields` module + presets;
build the Settings UI; wire the three surfaces; document in [15](../15-configurable-fields-and-settings.md).

## Alternatives considered

- **Keep hard‑coded core fields + only custom extras (legacy).** Can't relabel "Jméno dítěte" → "Jméno
  účastníka" or drop the guardian for an adult app. Rejected — it's exactly what the brief asks to fix.
- **Full EAV (everything in a key/value table).** Maximally flexible but loses typed columns, indexing, and the
  RLS/age/dedupe logic that depends on them; slow and error‑prone. Rejected in favor of the spine + JSONB hybrid.
- **Per‑app code forks of the forms.** Fast for two apps, unbounded cost across many tenants; no self‑service.
  Rejected.
