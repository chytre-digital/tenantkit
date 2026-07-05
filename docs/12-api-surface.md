# 12 — API surface

> The complete REST surface of Termínář 2: conventions, envelopes, and the **endpoint catalogue** that the
> domain docs ([06](06-courses-and-terminar.md)–[10](10-notifications-and-email.md)) imply. **Every** route is a
> `withRoute(...)` ([02 §4](02-reservation-core.md)); the `audience`, `minRole`/`can`, `plugin`, and validation
> columns below are exactly its `RouteOptions`. Names (`audience`, `app_role`, the `Permission` strings, the
> `{error,code,details,issues}` envelope, the event types) are authoritative from
> [02](02-reservation-core.md)–[10](10-notifications-and-email.md). This document does not introduce new
> behaviour — it is the consolidated **contract**; the *why* of each flow lives in its domain doc.

## 1. REST conventions

| Aspect | Rule |
|---|---|
| **Base** | All app routes under `/api`. Plugin routes under `/api/plugins/‹id›/…` ([09 §1](09-plugins-and-subscriptions.md)); webhooks under `/api/webhooks/‹provider›`; cron under `/api/cron/‹job›`. |
| **Nesting** | Resources nest one level where ownership is intrinsic: `/api/courses/:id/sessions`, `/api/sessions/:id/attendance`, `/api/participants/:id/credits`, `/api/credits/:id`. Deeper relations are flat with filters (`/api/enrollments?courseId=…`) rather than 3‑level paths. |
| **Methods** | `GET` (read, no side effects), `POST` (create / action), `PATCH` (partial update), `DELETE` (soft‑delete / cancel). State transitions that are not a field write are `POST` sub‑resources (`/approve`, `/cancel`, `/enable`) — not a `PATCH status`. |
| **Surface = host** | Admin → `app.terminar.cz`; public + portal → `‹slug›.terminar.cz` ([01 §7](01-architecture.md)). The **route audience**, not the host, is the security boundary ([04 §1](04-roles-and-permissions.md)). |
| **Tenant resolution** | Never sent in the body. Staff: `tenantFrom: 'cookie'` (the `active_tenant_id` cookie) or `'param'`; public/portal: `tenantFrom: 'host'` (the `‹slug›` subdomain) ([02 §8](02-reservation-core.md)). |
| **IDs** | All `uuid` ([03 §1](03-data-model.md)). Path ids are the resource's own `id`. |
| **Time** | ISO‑8601 UTC (`timestamptz`) on the wire; the client renders in the tenant timezone. Dates‑only as `YYYY-MM-DD` (`dateOnlySchema`). |

### 1.1 JSON shapes & the two envelopes

Promoted from [02 §5](02-reservation-core.md); there is exactly one success shape and one error shape, so the
client toast/query layer is uniform.

```jsonc
// SUCCESS — jsonOk<T>(data): 2xx. The payload is the named resource, never a bare array at the root.
{ "course": { "id": "…", "title": "…", … } }
{ "courses": [ … ], "page": { "nextCursor": "eyJ…", "hasMore": true } }

// ERROR — jsonError(e): 4xx/5xx. Always { error, code, details?, issues? }.
{ "error": "Validation failed", "code": "VALIDATION_ERROR",
  "issues": [ { "path": ["body","email"], "message": "Invalid email" } ] }
{ "error": "Not a member of this tenant", "code": "NOT_A_MEMBER" }
```

`error` is a human (localized) message; **`code` is the stable machine token** the client switches on. `issues`
appears only for `VALIDATION_ERROR` (the flattened `ZodError`); `details` carries structured context for the
rest. Status→code mapping is the `jsonError` ladder in [02 §5](02-reservation-core.md).

### 1.2 Standard codes (recap)

The codes any route may return, beyond a resource‑specific one. Full mapping in [02 §5](02-reservation-core.md);
RLS denials (`42501`) surface as `403 FORBIDDEN` ([04 §4](04-roles-and-permissions.md)).

| HTTP | `code` | Raised by |
|---|---|---|
| 400 | `VALIDATION_ERROR` | `body`/`query` parse fail (Zod) — carries `issues`. |
| 401 | `UNAUTHORIZED` | no session on a non‑public route. |
| 403 | `NOT_A_MEMBER` · `NOT_A_PARTICIPANT` · `FORBIDDEN` · `UPGRADE_REQUIRED` | audience/tenant/role/entitlement gate; RLS `42501`. |
| 404 | `NOT_FOUND` | row absent **or** invisible under RLS (no existence oracle). |
| 409 | `CONFLICT` | unique violation (`23505`) — e.g. double active enrollment. |
| 422 | `PLUGIN_NOT_ENABLED` · `SESSION_FULL` · `CREDIT_EXPIRED` · `COURSE_LOCKED` · `EXCUSE_DEADLINE_PASSED` · `CAPACITY_BELOW_OCCUPANCY` · `LIMIT_REACHED` | domain‑rule / check‑constraint (`23514`/`P0001`) → `mapDomainError`. |
| 429 | `RATE_LIMITED` | per‑identity token bucket (§7). |
| 500 | `INTERNAL` | fallback. |

### 1.3 Pagination, filtering, sorting

- **Pagination is cursor‑based** (stable under inserts; no `OFFSET` drift). List routes accept `?limit=` (default
  25, max 100) and `?cursor=` (opaque, base64url of the last row's sort key + id). The response carries
  `page.nextCursor` (null when exhausted) and `page.hasMore`. Keyset order is the route's documented sort.
- **Filtering**: typed `query` params validated by a per‑route Zod schema (`parseQuery`, [02 §6](02-reservation-core.md)).
  Common ones: `?status=`, `?courseId=`, `?participantId=`, `?from=&to=` (date range), `?q=` (search), `?bucket=`
  (the *Kurzy*/*Přihlášky* segments, [06 §6.1](06-courses-and-terminar.md), [07 §4](07-registration-and-enrollment.md)).
- **Sorting**: `?sort=field` with `-` prefix for descending (e.g. `?sort=-startsAt`). The allowed sort set is
  fixed per route (it must be index‑backed, [03 §8](03-data-model.md)); an unknown field → `400 VALIDATION_ERROR`.

### 1.4 Idempotency headers (money & email)

Mutations that **grant paid value, take money, or send mail** accept an `Idempotency-Key` request header. The
key is forwarded to the underlying provider where one exists (Resend `idempotencyKey`, [02 §11](02-reservation-core.md);
Stripe idempotency) and otherwise recorded so a retried `POST` is a no‑op returning the original result.
Required on: course‑payment checkout, subscription checkout, manual credit grant, any client‑initiated send.
**Inbound webhooks** are deduped server‑side by the provider event id (`payments.webhook_events`,
[09 §5.4](09-plugins-and-subscriptions.md); `core.email_events.resend_id`, [10 §5](10-notifications-and-email.md)) —
the caller need not supply a key.

### 1.5 Audience model per route

Every row in the catalogue declares an **audience** ([02 §2](02-reservation-core.md), [04 §1](04-roles-and-permissions.md)):

| `audience` | Who | Resolved by | Authorization |
|---|---|---|---|
| `public` | anon (no session) | — | RLS `anon` policies only ([03 §7](03-data-model.md)); rate‑limited where it writes. |
| `staff` | tenant member | `requireClaims()` + tenant ([02 §7](02-reservation-core.md)) | `minRole` (rank) **AND** `can` (`resource:action:scope`). |
| `family` | guardian / participant | `requireClaims()` + participant accounts | relational — `core.can_act_for_participant()` ([04 §7](04-roles-and-permissions.md)); never `minRole`/`can`. |
| `operator` | platform admin | `core.is_platform_admin()` ([04 §6](04-roles-and-permissions.md)) | cross‑tenant; outside tenant RLS. Ops back‑office only. |

> **Reading the catalogue.** "minRole/can" is the **staff** gate (`—` for non‑staff audiences); "Plugin?" is the
> `withRoute({ plugin })` gate ([02 §4](02-reservation-core.md) step 6); "Request→Response" abbreviates the body
> schema and the `jsonOk` payload. Safe‑link routes are `public` but additionally validate the opaque token
> ([05 §2f](05-auth.md)) before acting.

> **Slug‑scoped surfaces ([02 §4a](02-reservation-core.md)).** Routes mounted under a tenant slug
> (`/api/projects/[slug]/…`) use `withSlugRoute`: the "Resolved by" column's tenant step becomes
> `getTenantBySlug(slug)` for **every** audience — `public` slug routes included (`404 NOT_FOUND` on an
> unknown slug precedes everything except the staff/family `401`). The `active_tenant_id` cookie plays no
> part on these surfaces, and `plugin` gating works even on their `public` rows because the tenant is always
> resolved.

### 1.6 Versioning

v1 is **unversioned at the path** (`/api/...`): a single first‑party client (the Termínář app) ships with the
server, so contract changes are coordinated in one monorepo CI run ([01 §2](01-architecture.md)). Evolution is
**additive** — new fields are optional, new codes are namespaced, removals go through a deprecation window. The
**public/partner** surface (the `apiAccess` entitlement, `pro` only, [09 §3.2](09-plugins-and-subscriptions.md))
is the boundary that *does* get a frozen contract: when first‑party `pro` API access ships it mounts under
`/api/v1/public/*` with the OpenAPI document (§9) as its compatibility promise. Breaking changes there bump to
`/api/v2/...`; `/api/v1` is supported through a published sunset.

## 2. Endpoint catalogue

Grouped by surface. Method+Path is relative to the host of its audience (§1). `can` values are the permission
strings from [04 §3](04-roles-and-permissions.md); a `:own`/`:any` suffix is the scope the route requires
(`:own` admits `:any` holders). Body/query schemas are the Zod names ([02 §6](02-reservation-core.md)).

### 2.1 Auth

Flows in [05 §2](05-auth.md). The magic‑link / OTP / password‑reset / application‑submit endpoints always
answer `202` regardless of account existence (anti‑enumeration, [05 §6](05-auth.md)).

| Method + Path | Audience | minRole/can | Plugin? | Purpose | Request → Response |
|---|---|---|---|---|---|
| `POST /api/auth/sign-in` | public | — | — | Staff email+password login ([05 §2a](05-auth.md)). | `{email,password}` → `200 {user}` + `sb-…` cookie; `401 UNAUTHORIZED` on bad creds (non‑enumerating). |
| `POST /api/auth/sign-out` | staff/family | — | — | Revoke session, clear cookie; `{scope:'global'}` = everywhere ([05 §5](05-auth.md)). | `{scope?}` → `200 {}`. |
| `POST /api/auth/switch-tenant` | staff | any member | — | Set `active_tenant_id` ([02 §7](02-reservation-core.md)). | `{tenantId}` validated ∈ memberships → `200 {tenantId}`; else `403 NOT_A_MEMBER`. |
| `POST /api/staff/invite` | staff | `staff:manage` (rank‑capped) | — | Create `core.staff_invites`, email accept link ([05 §2b](05-auth.md)). | `{email,role}` → `202 {}`. |
| `POST /api/auth/accept-invite` | public | — | — | Consume invite → `core.memberships` (SECURITY DEFINER `accept_staff_invite`). | `{token}` (+ prior sign‑up/in) → `200 {tenantId,role}`; expired → `422`. |
| `POST /api/portal/auth/magic-link` | public | — | — | Family passwordless sign‑in link ([05 §2c](05-auth.md)). | `{email}`, `rateLimit:'magic-link'` → **always `202`**. |
| `POST /api/portal/auth/otp/request` | public | — | — | 6‑digit code fallback ([05 §2e](05-auth.md)). | `{email}`, `rateLimit:'otp'` → `202`. |
| `POST /api/portal/auth/otp/verify` | public | — | — | Verify code → session. | `{email,token}`, `rateLimit:'otp'` → `200 {}` + cookie; 5 wrong → 15‑min lock. |
| `GET /auth/callback` | public | — | — | OAuth / magic‑link return; `exchangeCodeForSession` (outside `[locale]`, [05 §7](05-auth.md)). | `?code&next` → `302 next`; binds pending participant accounts ([05 §3](05-auth.md)). |
| `POST /api/auth/password-reset` | public | — | — | Magic‑link‑style reset email ([05 §6](05-auth.md)). | `{email}` → `202`. |
| `GET /api/safe-link/resolve` | public | — | — | Resolve/validate an opaque token before its action ([05 §2f](05-auth.md)). | `?token` → `200 {purpose,object}`; invalid/expired/used → `410`/`422`. |

### 2.2 Admin · Tenants & settings

Tenant provisioning is `provisionTenant` ([02 §8](02-reservation-core.md)); ranks & the rank‑cap in
[04 §2,§5](04-roles-and-permissions.md). Branding/domain/limits are entitlement‑gated ([09 §3.2](09-plugins-and-subscriptions.md)).

| Method + Path | Audience | minRole/can | Plugin? | Purpose | Request → Response |
|---|---|---|---|---|---|
| `POST /api/tenants` | staff | (any auth user) | — | Provision a studio + owner membership (`create_tenant_with_owner`). | `{name,slug}` → `201 {tenantId}`; slug taken → `409`. |
| `GET /api/tenant` | staff | `settings:view` | — | Active tenant row (name, slug, tier, status). | → `200 {tenant}`. |
| `PATCH /api/tenant` | staff | `settings:manage` | — | Edit name/default locale/`settings` (incl. `excuseDefaults`, [08 §12](08-attendance-and-omluvenky.md)). | `UpdateTenantSchema` → `200 {tenant}`. |
| `PATCH /api/tenant/branding` | staff | `settings:manage` | — | White‑label `branding` jsonb ([10 §4](10-notifications-and-email.md)); fields gated by tier. | `BrandingSchema` → `200 {branding}`; ungranted field → `403 UPGRADE_REQUIRED`. |
| `GET /api/members` | staff | `staff:view` | — | List memberships (SECURITY DEFINER read, [04 §5](04-roles-and-permissions.md)). | `?role&cursor` → `200 {members,page}`. |
| `PATCH /api/members/:id` | staff | `staff:manage` (rank‑capped) | — | Change a member's role (below own rank; not `owner`). | `{role}` → `200 {member}`; escalation → `403`; audited ([04 §8](04-roles-and-permissions.md)). |
| `DELETE /api/members/:id` | staff | `staff:manage` (rank‑capped) | — | Revoke a membership. | → `204`; audited. |
| `POST /api/members/transfer-ownership` | staff | `minRole:'owner'` | — | Atomic owner transfer (`transfer_ownership` RPC, [04 §8](04-roles-and-permissions.md)). | `{newOwnerUserId}` → `200 {}`; demotes incumbent so `one_owner_per_tenant` holds. |
| `GET /api/plugins` | staff | `plugins:manage` | — | List registered plugins + per‑tenant activation/entitlement state ([09 §4](09-plugins-and-subscriptions.md)). | → `200 {plugins}`. |
| `POST /api/plugins/:id/enable` | staff | `minRole:'owner'`, `entitlements:{features:['plugin:<id>']}` | — | Activate a plugin ([09 §2.2](09-plugins-and-subscriptions.md)); runs `onEnable`. | → `200 {}`; un‑entitled → `403 UPGRADE_REQUIRED`. |
| `POST /api/plugins/:id/disable` | staff | `minRole:'owner'` | — | Suspend a plugin (data retained, [09 §2.5](09-plugins-and-subscriptions.md)). | → `200 {}`. |
| `GET /api/plugins/:id/settings` | staff | `plugins:manage` | yes `:id` | Read per‑tenant `plugin_settings` (auto‑form, [09 §1](09-plugins-and-subscriptions.md)). | → `200 {settings}`. |
| `PUT /api/plugins/:id/settings` | staff | `plugins:manage` | yes `:id` | Save settings (validated by the plugin's `settingsSchema`; secrets go to vault). | `‹plugin schema›` → `200 {settings}`. |
| `GET /api/custom-fields` | staff | `settings:view` | — | Tenant `custom_field_definitions` library ([06 §8](06-courses-and-terminar.md)). | → `200 {fields}`. |
| `POST /api/custom-fields` | staff | `settings:manage` | — | Define a field (`yes_no\|text\|options\|number\|date`). | `CustomFieldSchema` → `201 {field}`. |
| `PATCH /api/custom-fields/:id` | staff | `settings:manage` | — | Edit a definition. | `CustomFieldSchema` → `200 {field}`. |
| `DELETE /api/custom-fields/:id` | staff | `settings:manage` | — | Remove a definition. | → `204`. |
| `GET /api/validity-windows` | staff | `settings:view` | — | Named `validity_windows` for `windows` expiry ([08 §5](08-attendance-and-omluvenky.md)). | → `200 {windows}`. |
| `POST /api/validity-windows` | staff | `settings:manage`, `entitlements:{features:['omluvenkyAdvancedWindows']}` | — | Create a window (`name,starts_on,ends_on`). | `WindowSchema` → `201 {window}`; on `free` → `403 FEATURE_NOT_AVAILABLE`. |
| `PATCH`/`DELETE /api/validity-windows/:id` | staff | `settings:manage` + entitlement | — | Edit / soft‑delete a window. | → `200 {window}` / `204`. |
| `GET /api/tenant/domains` | staff | `settings:view` | — | Custom sending/app domains (`core.tenant_domains`, [01 §7](01-architecture.md)). | → `200 {domains}`. |
| `POST /api/tenant/domains` | staff | `settings:manage`, `entitlements:{features:['customDomain']}` | — | Add a domain (returns DNS records to set; Resend/DNS verify async, [10 §4](10-notifications-and-email.md)). | `{host}` → `201 {domain,dns}`; non‑`pro` → `403`. |
| `POST /api/tenant/domains/:id/verify` | staff | `settings:manage` + entitlement | — | Trigger re‑check; sets `verified_at`. | → `200 {verified}`. |

### 2.3 Admin · Courses & sessions

Model, states, the recurrence generator, and capacity in [06](06-courses-and-terminar.md). Coaches act on
**own** courses (`coach_assignments`), admins/owners on **any** ([04 §3](04-roles-and-permissions.md)).
`completed`/`cancelled` courses are read‑only → `422 COURSE_LOCKED` ([06 §3](06-courses-and-terminar.md)).

| Method + Path | Audience | minRole/can | Plugin? | Purpose | Request → Response |
|---|---|---|---|---|---|
| `GET /api/courses` | staff | `courses:view:own` | — | Termínář list ([06 §6.1](06-courses-and-terminar.md)); filter by bucket/status/kind, search title+tags. | `?bucket&status&kind&q&sort&cursor` → `200 {courses,page}`. |
| `POST /api/courses` | staff | `courses:create` | — | Author a course (draft). `kind` fixed at create ([06 §2](06-courses-and-terminar.md)). | `CreateCourseSchema` → `201 {course}`; over `maxCourses` → `422 LIMIT_REACHED`. |
| `GET /api/courses/:id` | staff | `courses:view:own` | — | Course detail (editor load). | → `200 {course}`. |
| `PATCH /api/courses/:id` | staff | `courses:edit:own` | — | Edit fields/policy; capacity floor = peak occupancy ([06 §3](06-courses-and-terminar.md)). | `UpdateCourseSchema` → `200 {course}`; below occupancy → `422 CAPACITY_BELOW_OCCUPANCY`. |
| `DELETE /api/courses/:id` | staff | `courses:delete:own` | — | Soft‑delete (`deleted_at`). | → `204`. |
| `POST /api/courses/:id/status` | staff | `courses:edit:own` | — | State transition *Aktivovat*/*Dokončit*/*Zrušit* ([06 §3](06-courses-and-terminar.md)); cancel triggers auto‑excuse ([08 §9](08-attendance-and-omluvenky.md)). | `{to:'active'\|'completed'\|'cancelled'}` → `200 {course}`; bad transition → `422`. |
| `GET /api/courses/:id/sessions` | staff | `courses:view:own` | — | Sessions of the course, ordered by `sequence`. | → `200 {sessions}`. |
| `POST /api/courses/:id/sessions` | staff | `sessions:manage:own` | — | **Bulk create** the explicit `Session[]` from the generator ([06 §5](06-courses-and-terminar.md)) (or one manual). | `{sessions:[…]}` (`BulkSessionsSchema`) → `201 {sessions}`; overlap/invariant → `422`. |
| `PATCH /api/sessions/:id` | staff | `sessions:manage:own` | — | Edit one session (time/duration/location). Re‑numbers `sequence`. | `UpdateSessionSchema` → `200 {session}`. |
| `DELETE /api/sessions/:id` | staff | `sessions:manage:own` | — | Remove a session. | → `204`. |
| `POST /api/sessions/:id/cancel` | staff | `sessions:manage:own` | — | Cancel a session → auto‑excuse + credits ([08 §9](08-attendance-and-omluvenky.md)); emits `session.cancelled`. | `{reason?}` → `200 {session}`. |
| `GET /api/courses/:id/coaches` | staff | `courses:view:own` | — | `coach_assignments` + `primary_coach_id` ([06 §9](06-courses-and-terminar.md)). | → `200 {coaches}`. |
| `POST /api/courses/:id/coaches` | staff | `courses:assign-coach` | — | Assign a coach (own‑scope RLS reach). | `{userId,isPrimary?}` → `201 {coach}`. |
| `DELETE /api/courses/:id/coaches/:userId` | staff | `courses:assign-coach` | — | Unassign a coach. | → `204`. |
| `GET`/`PUT /api/courses/:id/tags` | staff | `courses:view`/`courses:edit:own` | — | `course_tags` (chips; snapshotted onto credits, [06 §7](06-courses-and-terminar.md)). | `{tags:[…]}` → `200 {tags}`. |
| `GET`/`PUT /api/courses/:id/fields` | staff | `courses:view`/`settings:manage` | — | `course_field_assignments` (pick fields + `required`, [06 §8](06-courses-and-terminar.md)). | `{assignments:[…]}` → `200 {assignments}`. |
| `PATCH /api/courses/:id/visibility` | staff | `courses:edit:own` | — | `show_on_public`, `registration_mode` ([06 §9](06-courses-and-terminar.md)). | `{showOnPublic,registrationMode}` → `200 {course}`. |
| `GET /api/courses/:id/calendar.ics` | staff | `courses:view:own` | — | iCalendar feed, one `VEVENT`/session ([06 §6.4](06-courses-and-terminar.md)). | → `200 text/calendar`. |

### 2.4 Admin · Applications (*Přihlášky*)

The approval queue and the *Zapsat*/*Zamítnout*/*Vrátit* actions are [07 §4](07-registration-and-enrollment.md).
Approve runs the atomic SECURITY DEFINER transaction (guardian/participant dedupe + capacity + enrollment).

| Method + Path | Audience | minRole/can | Plugin? | Purpose | Request → Response |
|---|---|---|---|---|---|
| `GET /api/applications` | staff | `applications:view:own` | — | Review queue; stats + filter tabs (`Vše/Nové/Zapsané/Zamítnuté`, [07 §4](07-registration-and-enrollment.md)). | `?status&q&cursor` → `200 {applications,stats,page}`. |
| `GET /api/applications/:id` | staff | `applications:view:own` | — | One application's captured contact + custom answers. | → `200 {application}`. |
| `POST /api/applications/:id/approve` | staff | `applications:decide:own` | — | **Zapsat** — the approval transaction ([07 §4.1](07-registration-and-enrollment.md)); may re‑assign course/slot. | `{courseId?,sessionId?}` → `200 {enrollment}`; full → `422 SESSION_FULL`; dup → `409 CONFLICT`. |
| `POST /api/applications/:id/reject` | staff | `applications:decide:own` | — | **Zamítnout** — `rejected`, stamp decider; emits `application.rejected` (polite email). | `{reason?}` → `200 {application}`. |
| `POST /api/applications/:id/reset` | staff | `applications:decide:own` | — | **Vrátit** — back to `pending`; reverses a just‑made enrollment iff no attendance/payment ([07 §9](07-registration-and-enrollment.md)). | → `200 {application}`. |

### 2.5 Admin · Participants & enrollments

Identity model and dedupe in [07 §5–§6](07-registration-and-enrollment.md). The participant‑profile modal
surfaces credits ([08 §8](08-attendance-and-omluvenky.md)).

| Method + Path | Audience | minRole/can | Plugin? | Purpose | Request → Response |
|---|---|---|---|---|---|
| `GET /api/participants` | staff | `participants:view:own` | — | Roster; filter by course/age, search name. | `?courseId&q&cursor` → `200 {participants,page}`. |
| `GET /api/participants/:id` | staff | `participants:view:own` | — | Participant profile (enrollments, attendance, credits, `custom`). | → `200 {participant}`. |
| `PATCH /api/participants/:id` | staff | `participants:manage:own` | — | Edit record, `note`, custom field values ([06 §8](06-courses-and-terminar.md)). | `UpdateParticipantSchema` → `200 {participant}`. |
| `POST /api/enrollments` | staff | `enrollments:manage` | — | Manual *Nový účastník*: upsert guardian+participant, atomic capacity, `source='staff'` ([07 §5](07-registration-and-enrollment.md)). | `StaffEnrollSchema` → `201 {enrollment}`; full → `422 SESSION_FULL`; dup → `409`. |
| `GET /api/enrollments` | staff | `enrollments:manage` | — | Enrollments, filterable by course/participant/status. | `?courseId&participantId&status&cursor` → `200 {enrollments,page}`. |
| `POST /api/enrollments/:id/cancel` | staff | `enrollments:manage` | — | Cancel an enrollment (`cancelled`, reason); emits `enrollment.cancelled` (refund eval, [09 §5.5](09-plugins-and-subscriptions.md)). | `{reason?}` → `200 {enrollment}`. |
| `PATCH /api/enrollments/:id` | staff | `enrollments:manage` | — | Move/edit (re‑assign course, `payment_status` informational unless `payments` owns it). | `UpdateEnrollmentSchema` → `200 {enrollment}`. |

### 2.6 Admin · Attendance & credits

The omluvenka economy in [08](08-attendance-and-omluvenky.md). Recording attendance is `attendance:record`
(coach own‑scope); all credit *management* is `minRole:'admin'` + `credits:manage`, append‑audited in
`public.credit_audit` ([08 §8](08-attendance-and-omluvenky.md)).

| Method + Path | Audience | minRole/can | Plugin? | Purpose | Request → Response |
|---|---|---|---|---|---|
| `GET /api/sessions/:id/attendance` | staff | `attendance:record:own` | — | Roster + current marks for the *Docházka* screen ([08 §2](08-attendance-and-omluvenky.md)). | → `200 {roster}`. |
| `POST /api/sessions/:id/attendance` | staff | `attendance:record:own` | — | Save marks; `excused` mints a credit per policy ([08 §2,§4](08-attendance-and-omluvenky.md)); idempotent. | `{marks:[{participantId,state}]}` (`RecordAttendanceSchema`) → `200 {attendance}`. |
| `GET /api/courses/:id/overview` | staff | `reports:view:own` | — | *Přehled* — per‑participant present/excused/absent + course stats ([08 §10](08-attendance-and-omluvenky.md)). | → `200 {overview}`. |
| `GET /api/reports/credits` | staff | `reports:view` | — | Outstanding credit liability ("147 active, 12 expiring", [08 §10](08-attendance-and-omluvenky.md)). | `?status&from&to` → `200 {report}`. |
| `GET /api/participants/:id/credits` | staff | `credits:manage:own` | — | A participant's credits (the profile modal). | → `200 {credits}`. |
| `PATCH /api/credits/:id` | staff | `minRole:'admin'`, `credits:manage` | — | **Extend** (`{extend:{windowIds?,expiresAt?}}`, forward‑only) or **Re‑tag** (`{tags}`) ([08 §8](08-attendance-and-omluvenky.md)). | → `200 {credit}`; audited `extend`/`retag`. |
| `DELETE /api/credits/:id` | staff | `minRole:'admin'`, `credits:manage` | — | **Cancel** — soft‑delete, `status='cancelled'`, no restore. | → `204`; audited `cancel`. |
| `POST /api/participants/:id/credits` | staff | `minRole:'admin'`, `credits:grant` | — | **Grant** a goodwill credit (no source excuse). | `GrantCreditSchema` → `201 {credit}`; audited `grant`. |

### 2.7 Public (anon)

The QR funnel and catalogue, [07 §2](07-registration-and-enrollment.md). All `audience:'public'`,
`tenantFrom:'host'`; RLS anon policies gate reads (`show_on_public and status='active'`, [03 §7](03-data-model.md)).
`staff_only` courses are absent ([07 §8](07-registration-and-enrollment.md)).

| Method + Path | Audience | minRole/can | Plugin? | Purpose | Request → Response |
|---|---|---|---|---|---|
| `GET /api/public/tenant` | public | — | — | Public studio profile (name, branding, locale) for the landing/funnel header. | `host` → `200 {tenant}`. |
| `GET /api/public/courses` | public | — | — | Anon catalogue (Step 2 cards) — only public+active. | `?q` → `200 {courses}`. |
| `GET /api/public/courses/:id` | public | — | — | Course detail (age band, description, fields). | → `200 {course}`. |
| `GET /api/public/courses/:id/availability` | public | — | — | Slot chips with `taken/cap` per session ([06 §4](06-courses-and-terminar.md), [07 Step 3](07-registration-and-enrollment.md)). | `?from&to` → `200 {sessions}`. |
| `POST /api/zapis/applications` | public | — | — | Submit the QR form → one `applications` row (`pending`) + `application.received` email ([07 §2](07-registration-and-enrollment.md)). | `CreateApplicationSchema`, `rateLimit:'application'` → **`202`** (anti‑enumeration). |
| `GET /api/public/applications/resolve` | public | — | — | Safe‑link **track/confirm** of an application ([05 §2f](05-auth.md)); validates `safe_link_token`. | `?token` → `200 {application}`. |
| `POST /api/public/applications/confirm` | public | — | — | Confirm contact via the tracking safe‑link (status unchanged, contact verified). | `{token}` → `200 {}`; used/expired → `410`. |

### 2.8 Portal (family)

The participant portal, `audience:'family'` — scope **is** the participant account ([04 §7](04-roles-and-permissions.md));
no `minRole`/`can`. The omluvenka self‑service and makeup finder are [08 §3,§6](08-attendance-and-omluvenky.md);
payments are the `payments` plugin's family routes (§2.9). GDPR export/erase per [03 §10](03-data-model.md).

| Method + Path | Audience | minRole/can | Plugin? | Purpose | Request → Response |
|---|---|---|---|---|---|
| `GET /api/portal/me` | family | — | — | The signed‑in guardian's profile + tenants. | → `200 {me}`. |
| `GET /api/portal/dashboard` | family | — | — | Home: children, upcoming sessions, balance summary. | → `200 {dashboard}`. |
| `GET /api/portal/participants` | family | — | — | "My children" (actable participants, [05 §3](05-auth.md)). | → `200 {participants}`. |
| `POST /api/portal/participants` | family | — | — | *Přidat dítě* — new participant + `participant_accounts(relation='parent')` ([07 §6](07-registration-and-enrollment.md)). | `AddChildSchema` → `201 {participant}`. |
| `GET /api/portal/sessions` | family | — | — | A participant's scheduled sessions / calendar. | `?participantId&from&to` → `200 {sessions}`. |
| `POST /api/portal/sessions/:id/excuse` | family | — | — | **Self‑excuse** before `selfExcuseDeadlineHours`; writes `excuses(source='self')`, mints credit ([08 §3](08-attendance-and-omluvenky.md)). | `{participantId}`, rate‑limited → `200 {excuse,credit?}`; late → `422 EXCUSE_DEADLINE_PASSED`. |
| `GET /api/portal/credits` | family | — | — | Credit balance / omluvenka list ([08 §6](08-attendance-and-omluvenky.md)). | `?participantId` → `200 {credits,balance}`. |
| `GET /api/portal/makeup/availability` | family | — | — | Week grid classifying sessions free/full/off‑age/booked‑by‑you ([08 §6](08-attendance-and-omluvenky.md)). | `?participantId&from&to` → `200 {sessions}`. |
| `POST /api/portal/credits/:id/redeem` | family | — | — | **Book a makeup** — `redeem_credit_into_session` RPC (match + atomic capacity, [08 §6](08-attendance-and-omluvenky.md)). | `{sessionId}` → `200 {makeup}`; full → `422 SESSION_FULL`; expired → `422 CREDIT_EXPIRED`. |
| `POST /api/portal/makeups/:id/cancel` | family | — | — | Cancel a makeup before `minCancellationNoticeHours`; restores credit to `active` ([08 §6](08-attendance-and-omluvenky.md)). | → `200 {makeup}`; past notice → `422` (staff only). |
| `GET /api/portal/payments` | family | — | — | The family's orders/receipts (reads `payments.orders`, [09 §5.2.2](09-plugins-and-subscriptions.md)). | `?cursor` → `200 {orders,page}`. |
| `GET /api/portal/account/export` | family | — | — | GDPR data export (guardian + participants JSON, [03 §10](03-data-model.md)). | → `200 {export}` (or async job link). |
| `DELETE /api/portal/account` | family | — | — | Account deletion: cascade participant accounts, anonymize history ([03 §10](03-data-model.md)). | `{confirm}` → `202 {}`. |
| `GET`/`PUT /api/portal/notifications/preferences` | family | — | — | Per‑event/channel `notification_preferences` ([10 §6](10-notifications-and-email.md)). | `{prefs:[…]}` → `200 {prefs}`. |
| `GET /api/portal/notifications` | family | — | — | In‑app bell list ([10 §8](10-notifications-and-email.md)); realtime channel (§6). | `?unread&cursor` → `200 {notifications,page}`. |
| `POST /api/portal/notifications/:id/read` | family | — | — | Mark an in‑app notification read (`read_at`). | → `200 {}`. |

> A small number of these are also reachable login‑less by **safe‑link** ([05 §2f](05-auth.md)): the
> self‑excuse and the makeup‑cancel actions accept an emailed action token (`/omluvenka/omluvit?token=…`,
> makeup cancel from `makeup.booked` mail, [10 §2](10-notifications-and-email.md) rows 5/9) and run under the
> anon client through the token‑scoped SECURITY DEFINER RPC — never a full session.

### 2.9 Plugins

Mounted under `/api/plugins/‹id›/*`; each handler is auto‑wrapped with `assertPluginEnabled` (activation **AND**
entitlement, [09 §4](09-plugins-and-subscriptions.md)). Payments split into tenant **billing** and course
**payments** ([09 §5.2](09-plugins-and-subscriptions.md)); the webhook is `public` (the provider is
unauthenticated) but signature‑verified.

| Method + Path | Audience | minRole/can | Plugin? | Purpose | Request → Response |
|---|---|---|---|---|---|
| `GET /api/plugins/payments/billing/checkout` | staff | `billing:manage` | payments | Stripe Checkout (`mode:'subscription'`) for `studio`/`pro` ([09 §5.2.1](09-plugins-and-subscriptions.md)). | `?plan` → `302` hosted checkout. |
| `GET /api/plugins/payments/billing/portal` | staff | `billing:manage` | payments | Stripe Billing Portal (upgrade/downgrade/cancel/card). | → `302` portal. |
| `GET /api/plugins/payments/orders` | staff | `billing:manage` | payments | Course‑payment orders for the tenant. | `?status&cursor` → `200 {orders,page}`. |
| `POST /api/plugins/payments/orders/:enrollmentId/checkout` | family | — | payments | Course‑fee Checkout (`mode:'payment'`, Connect) → `orders(pending)` ([09 §5.2.2](09-plugins-and-subscriptions.md)). | `Idempotency-Key` → `200 {checkoutUrl}`. |
| `POST /api/plugins/payments/connect/onboard` | staff | `billing:manage` | payments | Begin Stripe Connect onboarding for the studio ([09 §5.3](09-plugins-and-subscriptions.md)). | → `200 {onboardingUrl}`. |
| `GET /api/plugins/sms/settings` | staff | `plugins:manage` | sms | Read `SmsSettings` ([09 §6.5](09-plugins-and-subscriptions.md)) (provider, sender, events, quiet hours). | → `200 {settings}`. |
| `PUT /api/plugins/sms/settings` | staff | `plugins:manage` | sms | Save `SmsSettings` (credentials go to vault). | `SmsSettings` → `200 {settings}`. |
| `POST /api/plugins/sms/send-test` | staff | `plugins:manage` | sms | Send a test SMS to verify provider/sender ([09 §6](09-plugins-and-subscriptions.md)). | `{to}` → `200 {ref}`. |

### 2.10 Webhooks & cron

Inbound provider callbacks and scheduled jobs. **Webhooks** are `audience:'public'` + signature‑verified +
idempotent ([09 §5.4](09-plugins-and-subscriptions.md), [10 §5](10-notifications-and-email.md)); **cron** routes
run service‑role (RLS‑bypassing, fenced to `app/api/cron/**`, [01 §4](01-architecture.md)) and are idempotent
([10 §9](10-notifications-and-email.md)). Neither is called by the app client.

| Method + Path | Audience | Auth | Purpose | Notes |
|---|---|---|---|---|
| `POST /api/webhooks/stripe` | public | Stripe signature | Subscription + course‑payment events → `tenants.tier` / `payment_status` ([09 §5.4](09-plugins-and-subscriptions.md)). | Dedupe `payments.webhook_events`; `400` bad sig; `200` no‑op on replay. (Alias of `/api/plugins/payments/webhook`.) |
| `POST /api/webhooks/resend` | public | Resend signing secret | Delivery status → `core.email_events` ([10 §5](10-notifications-and-email.md)). | `delivered\|bounced\|complained\|opened`; high bounce → alert. |
| `POST /api/webhooks/sms` | public | provider signature | SMS delivery receipts → `sms.messages.status` ([09 §6.4](09-plugins-and-subscriptions.md)). | `sent\|delivered\|failed`; provider‑specific verification. |
| `POST /api/cron/reminders` | operator¹ | Vercel Cron / service role | **Reminder sweep** (every 15 min): emit `session.reminder_due` ([10 §9](10-notifications-and-email.md)). | Stamps `reminded_at`; idempotent per tick. |
| `POST /api/cron/expire-credits` | operator¹ | service role | **Credit‑expiry sweep** (daily): emit `credit.expiring_soon`; flip due `credits` → `expired` ([08 §5](08-attendance-and-omluvenky.md), [10 §9](10-notifications-and-email.md)). | Correctness never depends on this job; expiry is evaluated live at redeem. |
| `POST /api/cron/retention` | operator¹ | service role | **Reconcile & cleanup** (nightly): tier drift ([09 §3.4](09-plugins-and-subscriptions.md)); purge read notifications, expired credits, old rejected applications ([03 §10](03-data-model.md)). | Direct maintenance; emits nothing. |

¹ Cron routes are not user‑facing; they authenticate by the Vercel Cron secret / service role, conceptually the
`operator` plane ([04 §6](04-roles-and-permissions.md)) — never `requireClaims`.

## 3. Realtime channels

Two Supabase Realtime channels ([01 §6](01-architecture.md)), authorized by the same RLS predicates as the REST
reads — a client can subscribe only to rows it may read.

| Channel | Backed by | Audience | Purpose |
|---|---|---|---|
| `attendance:‹sessionId›` | `public.attendance` | staff (`attendance:record:own`) | Live co‑marking on the *Docházka* screen ("coach B is also marking", [01 §6](01-architecture.md)). |
| `notifications:‹userId›:‹tenantId›` | `core.notifications` | staff & family | The bell badge updates live without polling ([10 §8](10-notifications-and-email.md)); filtered to the user. |

Realtime is **polish, not a source of truth** — every mutation still flows through the REST/`withRoute` path; the
channel only pushes the already‑committed row.

## 4. Rate‑limited endpoints

The token bucket (per IP **and** email/identity) declared via `withRoute({ rateLimit })`
([02 §4](02-reservation-core.md), [05 §6](05-auth.md)); exceed → `429 RATE_LIMITED`. Counter store is
`core.rate_limits` (or Upstash). Lockouts (5 failed password / 5 wrong OTP → 15 min) are separate from the
request bucket.

| Endpoint | `rateLimit.key` | Limit / window | Rationale |
|---|---|---|---|
| `POST /api/portal/auth/magic-link` | `magic-link` | 5 / 10m | passwordless spray ([05 §2c](05-auth.md)). |
| `POST /api/portal/auth/otp/request` | `otp` | 5 / 10m | code request flood. |
| `POST /api/portal/auth/otp/verify` | `otp` | 5 / 10m | code guessing (+ 15‑min lock on 5 wrong). |
| `POST /api/auth/sign-in` | `password` | per identity | brute‑force (+ 15‑min lock on 5 fails). |
| `POST /api/auth/password-reset` | `password-reset` | 5 / 10m | reset spam. |
| `POST /api/zapis/applications` | `application` | 5 / 10m | public‑form abuse ([07 §9](07-registration-and-enrollment.md)). |
| `POST /api/portal/sessions/:id/excuse` | `self-excuse` | per account | self‑excuse spam ([08 §11](08-attendance-and-omluvenky.md)). |
| `POST /api/plugins/sms/send-test` | `sms-test` | low / hour | paid‑channel cost guard. |

## 5. OpenAPI

The contract is **generated from the Zod schemas**, never hand‑maintained — the same schemas that
`withRoute({ body, query })` validates ([02 §6](02-reservation-core.md)) are the single source of truth, so the
document can never drift from enforcement. Build step: `zod-to-openapi` walks the route registry (each route's
`RouteOptions` already carries `body`/`query`, the response `jsonOk` shape, the audience, and the error codes
§1.2) and emits an OpenAPI 3.1 document at build time; CI fails if the committed spec is stale. The shared
envelopes (§1.1), the standard error responses (§1.2), the cursor‑pagination params (§1.3), and the
`Idempotency-Key` header (§1.4) are reusable components referenced by every operation. This document is what the
`apiAccess` (`pro`) public surface (§1.6) publishes and what generates the typed client; the `tags` group
operations by the same surfaces as §2.

Continue to **[13 — Roadmap & milestones](13-roadmap-and-milestones.md)** for how this surface is built, phase
by phase.
