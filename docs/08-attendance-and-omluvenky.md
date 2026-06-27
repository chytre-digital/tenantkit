# 08 — Attendance & the omluvenka system

> The signature subsystem. An absence becomes a **makeup credit** ("omluvenka") whose **expiration is set
> per course**, redeemable into another suitable session that has free capacity. This document is the
> authority on the lifecycle, the state machines, the per‑course expiry policy, and the edge cases.
> Schema in [03](03-data-model.md); UX references the [Admin] and [Parent‑Náhrady] mockups.

## 1. The economy in one picture

```
   Coach marks a participant EXCUSED on a session
                 │
                 ▼
        public.excuses (recorded) ──── policy says creditsEnabled? ──no──▶ (no credit; absence just excused)
                 │ yes
                 ▼
        public.credits (active)  ← expiry stamped from the COURSE's excuse_policy
                 │
   Guardian opens portal, sees balance, picks a free + suitable session
                 │  (atomic capacity check)
                 ▼
        public.makeups (booked) + credit → redeemed   ── consumes 1 credit
```

The brief's phrase *"každému kurzu jde nastavit expirace omluvenkového tokenu"* maps exactly to a course's
`excuse_policy.expiry`. **The credit is the token**; its validity is what a course configures.

## 2. Recording attendance (admin)

Per the [Admin] mockup's *Docházka* screen: pick a session, see the roster, mark each participant
**present / excused / absent**, "Všichni přítomni" (bulk present), then **Uložit docházku**. A summary panel
shows marked progress and counts, and the banner *"Omluvení účastníci automaticky získají náhradovou jednotku
(omluvenku)."*

```
POST /api/sessions/:id/attendance        (withRoute: staff, minRole 'coach', can 'attendance:record')
body: { marks: [{ participantId, state: 'present'|'excused'|'absent' }] }
```

`recordAttendance` (application use‑case) for each mark:
1. Upsert `public.attendance(session_id, participant_id, state, marked_by, marked_at)`.
2. **If `state` transitions to `excused`** and no excuse exists for `(session, participant)` → create
   `public.excuses(source='staff', status='recorded')`, then run **credit issuance** (§4).
3. If a mark transitions **away** from `excused` (correction) and a credit was auto‑issued **and not yet
   redeemed** → cancel that credit (soft‑delete, audit reason `attendance_corrected`). A *redeemed* credit is
   never auto‑revoked (the makeup already happened); staff are warned instead.

Attendance is idempotent: re‑saving the same marks is a no‑op; only state *changes* drive side‑effects.

## 3. Self‑excuse (portal, before the deadline)

A guardian may excuse a participant **themselves**, but only up to
`excuse_policy.selfExcuseDeadlineHours` before the session starts (default 24 h; legacy default).

```
POST /api/portal/sessions/:id/excuse      (withRoute: family)
```
`createSelfExcuse` validates: the participant is the caller's (participant account); the session is in the future and
`now < starts_at − deadlineHours`; not already excused. On success it writes the same `excuses` row
(`source='self'`) and runs issuance (§4). Past the deadline → `422 EXCUSE_DEADLINE_PASSED`. This endpoint is
rate‑limited per account.

## 4. Credit issuance (the rules)

Issuance is decoupled from the excuse record (a domain event `attendance.excused` on `core.outbox`, consumed
by the issuance handler) so email and money plugins can also react without coupling. The pure decision lives
in `domain/credits/issue.ts`:

```ts
function decideIssue(course: Course, excuse: Excuse, now: Date): IssueDecision {
  const p = course.excusePolicy
  if (!p.creditsEnabled) return { issue: false }
  if (p.maxCreditsPerEnrollment != null && excuse.enrollmentCreditCount >= p.maxCreditsPerEnrollment)
    return { issue: false, reason: 'cap_reached' }
  return { issue: true, tags: course.tags, expiry: computeExpiry(p.expiry, course, now) }
}
```

If `issue`, write `public.credits(status='active', tags, …)` with expiry (next section), set
`excuses.status='credit_issued'` and link `credit_id`. The credit's `tags` are **snapshotted from the source
course** at issue time (so later course edits don't change an issued credit's redeem‑matching).

## 5. Per‑course expiration — the heart of the feature

`courses.excuse_policy.expiry` is a small tagged union. A course picks **one** mode. `computeExpiry` turns it
into the two physical columns (`credits.expires_at` and/or `credits.valid_window_ids`):

| `mode` | Meaning | Produces | Best for |
|---|---|---|---|
| `none` | Credits never expire. | `expires_at = null`, `valid_window_ids = {}` | Evergreen memberships. |
| `ttl` | Valid **N days from issue**. | `expires_at = issuedAt + ttlDays` | "Use your makeup within 30 days." |
| `course_end` | Valid until the **source course's last session**. | `expires_at = lastSession.starts_at` | Seasonal blocks. |
| `windows` | Valid within named **validity windows** (source window + `forwardWindows` next). | `valid_window_ids = [w0, w1, …]` | Term/quarter systems (legacy model). |

```ts
type ExpiryPolicy =
  | { mode: 'none' }
  | { mode: 'ttl'; ttlDays: number }
  | { mode: 'course_end' }
  | { mode: 'windows'; windowIds: string[]; forwardWindows: number }
```

`windows` mode (carried from legacy, generalized): load the tenant's `validity_windows` ordered by
`starts_on`; find the index of the policy's base window; take that window **plus the next `forwardWindows`**;
their ids become `valid_window_ids`. Example: base = "Jaro 2026", `forwardWindows = 2` → credit redeemable
across Jaro/Léto/Podzim 2026.

**Why two physical representations?** `ttl`/`course_end` collapse to a single timestamp (cheap, obvious to
users — "platí do 14. 7."). `windows` needs the array (a credit can be valid across disjoint ranges). The
portal shows whichever is set as a human sentence.

### Expiry evaluation (redemption time)

`isRedeemableNow(credit, today)`:
- `status === 'active'` and `deleted_at is null`, **and**
- (`expires_at is null` **or** `today ≤ expires_at`) **and**
- (`valid_window_ids` empty **or** some window covers `today` with `starts_on ≤ today ≤ ends_on`).

There is **no background job flipping credits to `expired`** for correctness — expiry is evaluated live at
redemption (matches legacy and avoids clock‑skew bugs). A nightly job *does* set `status='expired'` purely so
the portal can show an accurate "expired" bucket and so retention can purge them; correctness never depends on
that job having run.

## 6. Redemption (book a makeup)

The [Parent‑Náhrady] mockup is the spec for the UX: an **age slider** + **weekly calendar** that classifies
each session as **free / full / off‑age / booked‑by‑you**, a **balance badge** ("3 omluvenky"), and a confirm
modal that ends in *"Rezervovat náhradu"* and decrements the balance.

```
GET  /api/portal/makeup/availability?participantId&from&to     → week grid of sessions w/ free counts
POST /api/portal/credits/:id/redeem                            (withRoute: family)
body: { sessionId }
```

`redeemCredit` runs in a **single `SECURITY DEFINER` RPC** (`redeem_credit_into_session`) for atomicity:

1. The credit belongs to a participant the caller may act for (`can_act_for_participant`) and `isRedeemableNow`.
2. **Match rules** from the *target* session's course vs the credit (driven by the **source** course's
   `redeemMatch`):
   - `ageMatchRequired` → participant's age (from `date_of_birth`) ∈ target course `[age_min_months,
     age_max_months]`.
   - `sameTagsRequired` → target course `tags ∩ credit.tags ≠ ∅`.
   - `crossCourse === false` → target must be the **same course** as the source.
3. **Capacity** (atomic): `select count(*) … for update` on active `makeups` + `enrollments` for that session
   vs `effectiveCapacity(session)`; reject `422 SESSION_FULL` if full. (This row‑lock is what prevents two
   guardians grabbing the last seat — the generalized `main-panel` overbooking guard.)
4. Insert `public.makeups(status='booked')`; set `credit.status='redeemed'`, `redeemed_makeup_id`,
   `redeemed_at`. One credit → one makeup.

Cancellation: a guardian may cancel a makeup up to `minCancellationNoticeHours` before it starts → makeup
`cancelled`, and the **credit is restored to `active`** (its original expiry still applies; if already past,
it goes `expired`). Past the notice window, only staff can cancel.

## 7. State machines

```
excuse:   recorded ──issue──▶ credit_issued
          (recorded is terminal if creditsEnabled=false)

credit:   active ──redeem──▶ redeemed
          active ──expiry reached (lazy/nightly)──▶ expired
          active ──staff soft-delete / attendance corrected──▶ cancelled
          redeemed ──makeup cancelled in window──▶ active (then maybe ▶ expired)

makeup:   booked ──attended (coach marks present on target)──▶ attended
          booked ──cancelled (guardian in-window | staff)──▶ cancelled  (credit → active)
```

Invariants (enforced in domain + DB checks): a `redeemed` credit has exactly one non‑cancelled makeup; a
`cancelled` credit has no active makeup; you cannot redeem a non‑`active` credit; `valid_window_ids` and
`expires_at` are immutable after issue **except** via staff Extend (§8).

## 8. Staff credit management (+ audit)

From the [Admin] participant‑profile modal: a studio can see a participant's credits and adjust them. All
mutations are **append‑only audited** in `public.credit_audit`.

| Action | Endpoint | Effect | Audited as |
|---|---|---|---|
| **Extend** | `PATCH /api/credits/:id` `{ extend: { windowIds?, expiresAt? } }` | append windows / push `expires_at` later (only forward) | `extend` |
| **Re‑tag** | `PATCH /api/credits/:id` `{ tags }` | full replacement of `tags` (empty rejected) | `retag` |
| **Cancel** | `DELETE /api/credits/:id` | soft‑delete, `status='cancelled'`; no restore | `cancel` |
| **Grant** | `POST /api/participants/:id/credits` | manually mint a goodwill credit (no source excuse) | `grant` |

All require `minRole: 'admin'` and `can: 'credits:manage'`. The guardian sees a cancelled credit as
*"Zrušeno organizátorem."*

## 9. Auto‑excuse on cancellation

When **staff cancel a session** (`sessions.status='cancelled'`): every active enrollment with no attendance
mark is auto‑excused (`excuse.source='staff'`, reason `session_cancelled`) and credits issue **regardless of
`creditsEnabled`** when the cancellation is the studio's fault (configurable `creditOnCancellation`, default
true). When **staff cancel a whole course**: active enrollments are notified; outstanding credits sourced from
that course remain valid by their own expiry (redeemable into other courses if `crossCourse`).

## 10. Reporting (admin overview)

The [Admin] *Přehled* tab: per‑participant present / excused / absent counts and an attendance‑rate bar across
the course's elapsed sessions, plus course‑level stats (held sessions, avg attendance, credits issued vs
redeemed). All derived by aggregating `attendance` + `credits` — no extra storage. A studio‑level dashboard
shows outstanding credit liability ("147 active omluvenky, 12 expiring this month").

## 11. Edge cases & decisions

| Case | Decision |
|---|---|
| Excused then corrected to present | Auto‑issued, **unredeemed** credit is cancelled; redeemed credit stays (warn staff). |
| Two guardians book the last makeup seat | `select … for update` serializes; loser gets `SESSION_FULL`. |
| Credit expires while a makeup is booked | Irrelevant — expiry is checked at *redeem*, not after; a booked makeup stands. |
| Redeem into the *same* session that was excused | Allowed only if it's a different occurrence; the source session is in the past by definition. |
| Participant has multiple active credits | Portal spends the **soonest‑expiring** redeemable credit first (FIFO by expiry). |
| Tenant disables the `omluvenky` feature mid‑season | Existing credits remain redeemable; new excuses stop minting. (Feature flag, not data deletion.) |
| Self‑excuse spam | Rate‑limited; and self‑excuse only mints a credit if policy allows, same as staff. |

## 12. Configuration surface (admin UI)

Per course, in the course editor (doc 06), a *Omluvenky* section renders `excuse_policy`:

- **Toggle**: *Generovat omluvenky za omluvené absence* (`creditsEnabled`).
- **Platnost omluvenky** (the expiry mode): radio `Neomezeně | Počet dní | Do konce kurzu | Platnostní okna`,
  with the dependent inputs (`ttlDays`, window picker + `forwardWindows`).
- **Termín pro vlastní omluvení** (`selfExcuseDeadlineHours`).
- **Pravidla náhrady**: checkboxes `Stejné zaměření (tagy)`, `Odpovídající věk`, `Pouze stejný kurz`.
- **Strop omluvenek na účastníka** (`maxCreditsPerEnrollment`, optional).

Tenant‑level defaults for all of the above live in `core.tenants.settings.excuseDefaults`; a new course
inherits them and may override — so a studio sets policy once and rarely touches it per course.

## 13. Pure‑domain test list (must pass before any UI)

- `computeExpiry` for each mode (incl. `windows` forward math, `course_end` with 0/1/N sessions).
- `isRedeemableNow` truth table (active/expired/cancelled × ttl/window/none × inside/outside).
- `decideIssue` (disabled, cap reached, happy path, tag snapshot).
- redemption match (age in/out, tag overlap/none, same/cross course).
- FIFO credit selection by expiry.
- atomic capacity under simulated concurrency (integration test against a real Postgres).

These are pure functions in `domain/` precisely so they're trivially testable — the legacy system's omluvenka
bugs were all in side‑effecting handlers; ours can't be, because the rules don't do I/O.
