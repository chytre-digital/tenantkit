# 06 — Courses & the termínář

> The course is the spine of Termínář 2: a long‑term offering (**Kurz**) is an ordered set of sessions
> (**Lekce**) with capacity, an age band, tags, custom fields, and an omluvenka policy. This document is the
> authority on the **course model & lifecycle**, the **capacity/occupancy** math, the **recurrence generator**
> (the legacy carry‑over that emits an explicit, editable session list — no rule persisted), the **termínář**
> (the admin *Kurzy* list + calendar), and the **course editor** surface. Schema names are authoritative in
> [03](03-data-model.md); the omluvenka policy itself lives in [08](08-attendance-and-omluvenky.md); roles &
> permissions in [04](04-roles-and-permissions.md). UX is the [Admin] mockup (*Kurzy* list + *Kalendář*).

## 1. The course model

A **course** (`public.courses`) is the unit of offering. The columns that this document governs (full DDL in
[03](03-data-model.md)):

| Column | CZ (UI) | Notes |
|---|---|---|
| `title`, `description` | Název, Popis | The list's primary label + the editor's *Detail* tab. |
| `kind` | Typ | `one_time` (**Jednorázový**) \| `multi_session` (**Vícelekční**). Drives session invariants (§2). |
| `status` | Stav | `draft` \| `active` \| `completed` \| `cancelled`. State machine in §3. |
| `capacity` | Kapacita | Default seats per session; ≥ 1. Per‑session override via `sessions.capacity_override` (§4). |
| `age_min_months`, `age_max_months` | Věkové rozmezí | Nullable age band **in months**; drives QR recommendation + makeup matching (§7). |
| `registration_mode` | Zápis | `open` (public form on) \| `staff_only` (no public form; see [07](07-registration-and-enrollment.md)). |
| `show_on_public` | Viditelnost | Listed on the anon catalogue when `true` **and** `status='active'` (RLS `public_catalogue`). |
| `excuse_policy` (jsonb) | Omluvenky | The per‑course expiry/redeem policy; **specced in [08](08-attendance-and-omluvenky.md)**, surfaced here only as an editor tab (§8). |
| `primary_coach_id` | Hlavní lektor | The owning coach; plus `public.coach_assignments` for co‑coaches (own‑scope RLS). |
| `created_by`, `deleted_at` | — | Soft‑deleted (history matters); a deleted course never appears in the termínář. |

A course is **always** read through `withRoute` ([02](02-reservation-core.md) §4): staff read requires
membership; create/edit requires `minRole: 'coach'` + `can: 'courses:edit:own'` (a coach edits **own**
courses; admin/owner edit **any** via `courses:edit:any`). The anon catalogue read is a separate public route.

## 2. `kind` & the session invariants

`kind` is fixed at creation and constrains the session set:

| `kind` | CZ | Session rule | Capacity semantics |
|---|---|---|---|
| `one_time` | Jednorázový | **Exactly 1** session (an open day, a workshop, a camp kickoff). | `capacity` = seats for the single occurrence. |
| `multi_session` | Vícelekční | **≥ 2** sessions, ordered by `sequence` (a seasonal block — "blok 7 lekcí"). | `capacity` = seats per session; one enrollment holds a seat across the whole block. |

Cross‑cutting invariants enforced in the domain layer **and** by DB checks / the create RPC:

1. `one_time ⇒ count(sessions) === 1`; `multi_session ⇒ count(sessions) ≥ 2`.
2. **Sessions are non‑overlapping** within a course: for any two sessions `[startsᵢ, startsᵢ + durationᵢ)` do
   not intersect. (Overlap is a generator/edit‑time validation, not a hard DB constraint — see §5.)
3. **Future‑dated at creation**: every session's `starts_at > now()` when a `draft` course is first submitted.
   (Back‑dating to record a historical course is an explicit `import` path, not the normal create flow.)
4. `sequence` is 1‑based, contiguous, and ordered by `starts_at` (the generator assigns it; manual edits
   re‑number).

## 3. Status state machine

```
                 ┌──────────── activate ───────────┐
   (create) ──▶ draft ───────────────────────────▶ active ───── complete ─────▶ completed   (terminal)
                  │                                   │
                  └────── cancel ──┐        ┌── cancel ┘
                                   ▼        ▼
                                   cancelled                                     (terminal)
```

| From → To | CZ trigger | Guard / invariant |
|---|---|---|
| `draft → active` | *Aktivovat* / *Publikovat* | Must satisfy all §2 invariants (right session count, non‑overlapping, future‑dated). Only `active` courses are visible to the public catalogue and accept applications. |
| `draft → cancelled` | *Zrušit* | Abandon before it ran. No enrollments expected. |
| `active → completed` | *Dokončit* (or auto) | All sessions are in the past, **or** staff close it manually. Completing freezes the roster & attendance; credits already issued keep their own expiry. |
| `active → cancelled` | *Zrušit kurz* | Notifies active enrollments; outstanding credits sourced from the course remain valid by their own expiry (redeemable into other courses if `crossCourse`). Triggers the auto‑excuse path in [08](08-attendance-and-omluvenky.md) §9. |

**Invariants on edit:**

- A `cancelled` or `completed` course is **read‑only**: no field edits, no session add/edit/delete, no new
  enrollments. The editor renders disabled with a banner; mutations return `422 COURSE_LOCKED`.
- `kind` is **immutable** after creation (it would invalidate the session set).
- `capacity` may be lowered only to ≥ current peak occupancy of any session (else `422 CAPACITY_BELOW_OCCUPANCY`);
  raising is always allowed.
- Editing `age_min_months`/`age_max_months` or `tags` does **not** retroactively change already‑issued credits
  — those snapshot the band/tags at issue time ([08](08-attendance-and-omluvenky.md) §4).

The list's *Stav* badge maps these states (the mockup also surfaces a derived *Proběhlý* bucket for past `active`
courses — see §6). Badge tokens (from the mockup's `STATUS` map):

| `status` | CZ label | bg / fg |
|---|---|---|
| `active` | **Aktivní** | `#dde7d4` / `#3a5a40` |
| `draft` | **Koncept** | `#efeee7` / `#5c5b4f` |
| `completed` | **Dokončeno** | `#d9e7e3` / `#2f544e` |
| `cancelled` | **Zrušeno** | `#f4e0db` / `#803129` |
| *(derived)* past | **Proběhlý** | `#f6ead0` / `#8a611a` |

## 4. Capacity & occupancy ("obsazenost")

Two inputs, one derived number.

**Effective capacity** — a session may override the course default:

```ts
function effectiveCapacity(session: Session, course: Course): number {
  return session.capacity_override ?? course.capacity   // null override → inherit
}
```

**Occupancy** ("obsazenost") of a session = the seats it currently holds. A seat is taken by **(a)** an active
enrollment in the parent course (each enrollment occupies a seat in *every* session of the block) **plus**
**(b)** any **booked makeup** redeemed *into that specific session* by a participant from another course:

```ts
function occupancy(session: Session): number {
  return countActiveEnrollments(session.course_id)      // (a) block members
       + countBookedMakeups(session.id)                 // (b) makeup guests (doc 08)
}
function isFull(session: Session, course: Course): boolean {
  return occupancy(session) >= effectiveCapacity(session, course)
}
```

This count is the authority for **both** the QR form's slot chips ([07](07-registration-and-enrollment.md)) and
the portal's makeup grid ([08](08-attendance-and-omluvenky.md) §6). It is never trusted from a stale read at
write time: enrolling and booking a makeup both go through the **atomic capacity RPC** (`select … for update` on
the counted rows before insert) described in [02](02-reservation-core.md) §14 and [03](03-data-model.md) §7 —
that row‑lock is what prevents two people grabbing the last seat.

**List‑level occupancy** (the *Obsazenost* column on the *Kurzy* list) is the course's headline ratio. The
mockup shows `enrolled / capacity` (active enrollments vs course capacity, e.g. `10/12`); for `multi_session`
courses that is the per‑session seat usage shared across the block.

**Occupancy badges** (thresholds carried from the QR mockup's `viewSchedule`, reused on the list & calendar):

| State | Condition | Colour (fg) | UI |
|---|---|---|---|
| **Volno** (free) | `free > 2` | `#5e7d59` (sage) | `taken/cap`, clickable |
| **Skoro plno** (near‑full) | `1 ≤ free ≤ 2` | `#b9842b` (ochre) | `taken/cap`, clickable |
| **Obsazeno** (full) | `free ≤ 0` | `#ab453a` (clay) | label *Obsazeno*, **disabled** |

where `free = effectiveCapacity − occupancy`. On the *Kurzy* list the *Obsazenost* cell turns clay (`#803129`,
bold) when `enrolled >= capacity` (the mockup's `full` style), otherwise neutral ink.

## 5. The recurrence generator (frontend‑only, no rule persisted)

This is the signature **legacy carry‑over**. Long‑term courses are weekly ("po 16:00, 7×"), so typing 7
sessions by hand is painful — but **storing a recurrence rule is wrong** for this domain because real schedules
have holidays, single‑week time shifts, room swaps, and a make‑up week tacked on the end. So the generator is a
**pure client‑side wizard** that *expands* a rule into a concrete, fully editable `Session[]`, and the form
submits that **explicit list**. Nothing about the rule survives; `public.sessions` is the source of truth
(noted in [03](03-data-model.md): *"No recurrence rule is stored"*).

### 5.1 The UX (course editor → *Termíny* tab)

```
┌─ Vygenerovat termíny ────────────────────────────────────────────────┐
│ Dny v týdnu:  [Po]✔ [Út] [St] [Čt] [Pá] [So] [Ne]   + přidat pravidlo │   ← one or more weekly rules
│ Čas:   16:00      Délka: 45 min      Místo: Malý bazén                 │
│ Začátek: 2026‑09‑07     Konec:  ( ) počtem lekcí [7]  (•) datem […]   │   ← count OR end-date
│ Výjimky (svátky):  28. 9.,  28. 10.   [+ přidat]                       │
│                                            [ Náhled termínů → ]        │
├─ Náhled (editovatelný) ──────────────────────────────────────────────┤
│ 1.  po 7. 9.  16:00  45 min  Malý bazén        ✎  🗑                   │
│ 2.  po 14. 9. 16:00  45 min  Malý bazén        ✎  🗑                   │
│ …                                              + přidat lekci ručně    │
└──────────────────────────────────────────────────────────────────────┘
```

Flow: pick **weekday(s) + time + duration + location**, a **start date**, and a stop condition that is *either*
an **occurrence count** *or* an **end date**; optionally list **holiday exception** dates → **Náhled** renders
the expanded list. From there every row is **editable**: change a single session's date/time/duration/location,
**delete** one, or **add** an ad‑hoc session by hand (the make‑up week, a relocated lesson). **Submit** sends
the resulting `Session[]`; the generator parameters are discarded.

### 5.2 Algorithm (pseudocode)

```ts
type WeeklyRule = { weekdays: number[]; time: string; durationMin: number; location?: string }
type GenInput = {
  rules: WeeklyRule[]                 // ≥1 weekly rule (multiple weekday/time combos)
  startDate: DateOnly
  stop: { kind: 'count'; count: number } | { kind: 'until'; endDate: DateOnly }
  holidays: DateOnly[]                // exception dates to skip
}

function generateSessions(input: GenInput): DraftSession[] {
  const skip = new Set(input.holidays.map(toISO))
  const out: DraftSession[] = []
  const horizon = input.stop.kind === 'until'
    ? input.stop.endDate
    : addWeeks(input.startDate, input.stop.count + input.holidays.length + 8)  // generous upper bound

  for (let day = input.startDate; day <= horizon; day = addDays(day, 1)) {
    for (const rule of input.rules) {
      if (!rule.weekdays.includes(weekday(day))) continue
      if (skip.has(toISO(day))) continue                         // holiday exception
      const startsAt = atTime(day, rule.time)
      if (startsAt <= now()) continue                            // invariant §2.3: future-dated
      out.push({ startsAt, durationMin: rule.durationMin, location: rule.location })
      if (input.stop.kind === 'count' && out.length >= input.stop.count) { sortAndNumber(out); return finish(out) }
    }
  }
  sortAndNumber(out)                                             // order by startsAt, assign 1-based sequence
  return finish(out)
}

function finish(out: DraftSession[]) {
  flagDuplicates(out)          // same calendar day+time twice → warn (two rules collided)
  flagOverlaps(out)            // [start, start+dur) intersections → warn (invariant §2.2)
  if (out.length > 100) warn('softLimit')   // soft warning, not a block
  return out
}
```

Notes baked into the algorithm:

- **Multiple weekly rules** are first‑class: `rules: [{Mon 16:00}, {Wed 16:00}]` yields a 2×/week block; rules
  may differ in time/duration/location (a Monday small‑pool slot + a Thursday big‑pool slot).
- **`count` vs `until`** are mutually exclusive; `count` stops as soon as N **non‑holiday** sessions exist
  (holidays don't consume the count — skipping 28. 9. still yields 7 lessons), `until` walks to the end date.
- **Holiday exceptions** are simply skipped dates; because they're applied during expansion, the persisted list
  already has the gap — there is no rule to "re‑evaluate" later, which is the whole point.
- **Duplicate warning**: two rules landing on the same day+time are flagged (non‑blocking) so the user can drop
  one.
- **Overlap warning**: surfaces invariant §2.2 at generate time as a soft warning the user resolves by editing.
- **Soft cap > 100**: a non‑blocking *"Opravdu chcete vytvořit {{n}} lekcí?"* guard (legacy generated runaway
  lists from a bad end‑date); the user can proceed.

### 5.3 Why no rule is stored (the rationale)

Persisting an RRULE would force the system to *re‑derive* occurrences forever and re‑apply holiday/exception
logic on every read — and the moment a coach moves one lesson or inserts a make‑up week, the rule no longer
describes reality. Legacy learned this and chose **explicit sessions**; we keep it. Benefits: (1) holidays and
one‑off shifts are just normal rows; (2) attendance, capacity, and the calendar read a flat `sessions` table
with **no expansion at query time**; (3) editing one session can never accidentally rewrite the others. The
generator is therefore **authoring sugar**, not a stored entity — see [03](03-data-model.md) `public.sessions`.

## 6. The termínář — admin *Kurzy* screen (LIST + CALENDAR)

The *Kurzy* nav item ([Admin] mockup) is the termínář. A segmented toggle switches **Seznam** (list) and
**Kalendář** (calendar); the *Nový kurz* primary action (and a secondary *Export*) sit in the header.

### 6.1 LIST view (*Seznam*)

A **bucket filter** + **search** + two dropdown filters above a table.

- **Buckets** (segmented, derived from session dates): `Vše` · `Nadcházející` (upcoming) · `Probíhající`
  (ongoing) · `Minulé` (past).
- **Search** (`Hledat kurzy…`) matches title **and** tags (the mockup's `c.title` + `c.tags` filter).
- **Filters**: *Všechny stavy* (by `status`) and *Všechny typy* (by `kind`) dropdowns.

**Columns** (exactly the mockup's `<thead>`):

| Column | CZ | Source | Render |
|---|---|---|---|
| Course | **Kurz** | `title` + `sub` (age/location line) + tag chips | bold green title, muted subline, `course_tags` as sage chips. |
| Type | **Typ** | `kind` | *Jednorázový* / *Vícelekční*. |
| Status | **Stav** | `status` | pill badge (§3 table). |
| Occupancy | **Obsazenost** | `enrolled/capacity` | right‑aligned, tabular; clay+bold when full (§4). |
| Sessions | **Lekce** | `count(sessions)` | right‑aligned count. |
| First | **První lekce** | `min(sessions.starts_at)` | localized `d. mmm yyyy HH:MM`. |

Rows are clickable → open the course (editor / attendance). The whole table is one card with the studio's
elevation tokens.

### 6.2 CALENDAR view (*Kalendář*)

A **month grid** (Monday‑first, `po út st čt pá so ne`) with a header showing the month name + prev/next
chevrons. Each day cell renders that day's **sessions** as compact coloured event chips (`HH:MM` + short course
title), the chip colour keyed per course (the mockup's `TONE` palette: green / sage / teal / ochre / clay).
**Today** is highlighted (filled pill on the date number, tinted cell). Because sessions are explicit rows, the
calendar is a straight `sessions(tenant_id, starts_at)` range query (no recurrence expansion) — holidays simply
appear as empty days. Clicking an event opens that session (attendance / edit); the chips are the visual proof
that the generator's output, not a rule, is what's drawn.

### 6.3 Coach session calendar

The same month/week grid, **scoped to the signed‑in coach** via `coach_assignments` / `primary_coach_id`
(own‑scope RLS): a *Trenér* sees only their own sessions and rosters. It is the coach's day‑to‑day view —
"what am I teaching this week" → tap a session → take attendance ([08](08-attendance-and-omluvenky.md) §2).

### 6.4 ICS export / feed (a nicety)

`GET /api/courses/:id/calendar.ics` (and a per‑coach `…/portal/me/calendar.ics?token=…`) emit a standard
**iCalendar** feed — one `VEVENT` per session (`DTSTART`/`DURATION`/`SUMMARY`/`LOCATION`) — so a studio can
subscribe in Google/Apple Calendar. The header *Export* button offers the same as a one‑shot download. This is a
read‑only convenience layered on the explicit `sessions` rows; it carries no write semantics.

## 7. Tags & age band — what they drive

Two lightweight classifiers on the course feed both automation surfaces:

- **`course_tags`** (`public.course_tags`, freeform "zaměření" like *začátečníci*, *kojenci*, *závodní*):
  shown as chips on the list, and — crucially — **snapshotted onto a credit** at issue time so makeup
  **redemption matching** can require tag overlap (`sameTagsRequired`, [08](08-attendance-and-omluvenky.md)
  §6). Editing a course's tags never mutates already‑issued credits.
- **Age band** (`age_min_months` / `age_max_months`, **in months**): the single source for two behaviours:
  1. **QR auto‑recommendation** — the public form computes the child's age in months from DOB and picks the
     course whose `[min, max]` contains it (the mockup's `matched()` over `minM/maxM`; e.g. `12–23 měs.` →
     *Žabičky*). See [07](07-registration-and-enrollment.md) §Step0/Step2.
  2. **Makeup age‑gating** — `ageMatchRequired` checks the participant's current age ∈ the *target* course's
     band before allowing a redemption ([08](08-attendance-and-omluvenky.md) §6).

Age is **always computed from `date_of_birth`** (months for babies, years for older kids), **never stored** —
matching the QR form and the participant model in [03](03-data-model.md). The band is displayed in the UI as
`min–max měs.` (or rendered as years where natural).

## 8. Custom fields (vlastní pole)

Tenant‑defined extra questions, modelled by `public.custom_field_definitions` (tenant‑scoped library) +
`public.course_field_assignments` (which fields a given course asks, with a `required` flag). The field type
enum (`custom_field_definitions.field_type`):

| `field_type` | CZ | Input | `allowed_values` |
|---|---|---|---|
| `yes_no` | Ano/Ne | checkbox / toggle | — |
| `text` | Text | single line | — |
| `options` | Výběr | select / radio | uses `allowed_values text[]` |
| `number` | Číslo | numeric | — |
| `date` | Datum | date picker | — |

**Where collected:** the assigned fields render on the **public enrollment form** (and on the staff *Nový
účastník* modal), validated client‑ and server‑side; a `required` field blocks submission when empty
([07](07-registration-and-enrollment.md) §Custom fields).

**Where stored:** answers are persisted per enrollment in `public.participant_field_values(enrollment_id,
field_id, value)`, and a **denormalized snapshot** is kept on `participants.custom` (jsonb) for fast display in
the roster/profile (the participant‑profile modal reads it). Applications carry the raw answers in
`applications.custom` until approval copies them into the enrollment's field values.

Editing the **definition library** and a course's **assignments** is `minRole: 'admin'` work, surfaced in the
course editor's *Vlastní pole* tab (§9).

## 9. Course editor surface (tabs)

Opening a course (or *Nový kurz*) shows a tabbed editor. Each tab maps to columns/relations above:

| Tab | CZ | Edits | Notes |
|---|---|---|---|
| **Detail** | Detail | `title`, `description`, `kind`, `capacity`, `age_min_months`/`age_max_months`, `course_tags` | `kind` locked after create; capacity floor = peak occupancy (§3). |
| **Termíny** | Termíny | `public.sessions` via the **recurrence generator** (§5) + manual add/edit/delete | The explicit, editable `Session[]`; honours §2 invariants. |
| **Omluvenky** | Omluvenky | `excuse_policy` (creditsEnabled, expiry mode, deadlines, redeem rules) | **Specced in [08](08-attendance-and-omluvenky.md) §12** — this tab just renders it; inherits tenant defaults. |
| **Vlastní pole** | Vlastní pole | `course_field_assignments` (pick fields + `required`) | Draws from the tenant `custom_field_definitions` library (§8). |
| **Lektoři** | Lektoři | `primary_coach_id` + `coach_assignments` | The owning coach + co‑coaches; sets own‑scope RLS reach. |
| **Viditelnost** | Viditelnost / Veřejné | `show_on_public`, `registration_mode`, public slug/landing | Gates the anon catalogue + the QR form ([07](07-registration-and-enrollment.md)); `staff_only` hides the public form. |

A status action bar (top‑right of the editor) exposes the §3 transitions (*Aktivovat* / *Dokončit* / *Zrušit*),
disabled with a *COURSE_LOCKED* banner once the course is `completed`/`cancelled`. Plugins may inject extra tabs
via the `admin.course.tabs` UI slot ([02](02-reservation-core.md) §12, [09](09-plugins-and-subscriptions.md)) —
e.g. the `payments` plugin adds a *Cena* tab — without the core knowing about money.
