# 05 — Authentication

> How an actor **proves who it is**, before [04](04-roles-and-permissions.md) decides what it may do. Identity
> is **Supabase Auth (GoTrue)**; the brief mandates **username/password + OAuth + magic link** for sign-in,
> **OTP** as a family fallback, and **login-less safe-links** for one-shot actions (the omluvenka self-service
> needs links that work with no account). Table/column names (`core.memberships`, `core.participant_accounts`,
> `app_role`, `participant_relation`, `public.applications.safe_link_token`) are authoritative from
> [03](03-data-model.md).

## 1. Identity provider & method matrix

Supabase Auth (GoTrue) owns `auth.users`, password hashing (bcrypt), OAuth handshakes, magic-link/OTP
issuance, and the **access JWT + refresh** pair. `reservation-core` adds: the active-tenant cookie, the
two-context `requireClaims()` ([02 §7](02-reservation-core.md)), the **safe-link** scheme (which is *ours*,
not GoTrue's), rate-limiting, and the Resend-owned email templates ([10](10-notifications-and-email.md)).

Supported **method × audience** (a method is allowed for an audience only where ✔):

| Method | Staff (admin console) | Family (portal) | Applicant (public) | Notes |
|---|---|---|---|---|
| **Email + password** | ✔ primary | ✔ (opt-in) | — | bcrypt via GoTrue; policy in §6. |
| **OAuth** (Google / Apple / Microsoft) | ✔ | ✔ | — | Google+Microsoft for staff; +Apple for family (iOS). |
| **Magic link** (email) | — | ✔ **primary** | — | passwordless; the family default. |
| **OTP** (6-digit email code) | — | ✔ fallback | — | when a magic-link click is awkward (in-app webview, shared inbox). |
| **Email invite** | ✔ (creates membership) | — | — | staff onboarding; §2b. |
| **None (anonymous)** | — | — | ✔ | the QR form needs no session. |
| **Safe-link** (opaque token) | — | (one-shot) | ✔ **follow-up** | login-less, single-purpose; §2f. |
| **2FA / TOTP** | ✔ owners + operators | (offered) | — | required for `owner` & platform operator; §6. |

Surfaces are the four from [01 §7](01-architecture.md): admin console (`app.terminar.cz`), public/enrollment
(`‹slug›.terminar.cz/zapis`), portal (`‹slug›.terminar.cz/portal`), and ops back-office. **Audience is a property
of the route** ([02 §2](02-reservation-core.md)); the auth method must be one the matrix permits for that
audience, else the callback rejects with `403`.

## 2. Flows

State lives in exactly three places — make this explicit per flow:
(a) **GoTrue** (`auth.users`, identities, refresh tokens), (b) **cookies** via `@supabase/ssr`
(`sb-‹ref›-auth-token` access+refresh; `active_tenant_id`), (c) **app tables** (`core.memberships`,
`core.participant_accounts`, `public.applications`). The in-memory access token lives only for the lifetime of a
server request ([01 §4–5](01-architecture.md)).

### (a) Staff email/password login + active-tenant cookie

```
1. POST /api/auth/sign-in        { email, password }   (rateLimit: 'password', §6)
2. supabase.auth.signInWithPassword()                 → GoTrue verifies bcrypt
      ↳ on success @supabase/ssr writes sb-‹ref›-auth-token cookie (access JWT + refresh)
3. requireClaims() loads memberships[] (+ participantAccounts[])  [02 §7]
4. resolve active tenant:
      - if memberships.length === 0  → redirect to /onboarding (provisionTenant, [02 §8])
      - else set active_tenant_id = cookie∩memberships, default first  [02 §7]
5. POST /api/auth/switch-tenant  { tenantId }  validates ∈ memberships → re-sets cookie
```

- `active_tenant_id` is an **httpOnly, SameSite=Lax** cookie, validated against `core.memberships` on every
  read (never trusted blind) — generalized from `activeRestaurant.ts` / `resolveActiveRestaurant`. A cookie
  pointing at a tenant the user left silently falls back to the first membership.
- Wrong credentials → `401`; GoTrue's raw message is mapped to a localized, **non-enumerating** string
  ("Nesprávné přihlašovací údaje") so the response is identical whether or not the email exists (§6).
- No `restaurant_id`-on-profile legacy shortcut: the active tenant is **cookie-derived only**
  (the deprecated `serverSignIn` profile-column fallback in `main-panel` is dropped).

### (b) Staff invite → accept (invite creates the membership)

```
1. admin: POST /api/staff/invite  { email, role }     (needs staff:manage, rank-capped — [04 §2,§5])
2. core inserts core.staff_invites { tenant_id, email, role, token(uuid), expires_at=72h, invited_by }
3. Resend sends the localized invite (template owned by Resend, [10]) with a safe-link:
      ‹slug›.terminar.cz/auth/accept-invite?token=…
4. invitee follows link:
      - no auth.users row → GoTrue sign-up (password OR OAuth), then continue
      - has account       → just sign in
5. POST /api/auth/accept-invite { token }  (SECURITY DEFINER RPC accept_staff_invite):
      validates token (unexpired, unconsumed, email matches) →
      INSERT core.memberships (user_id, tenant_id, role)  → consume invite → audit_log [04 §8]
6. active_tenant_id set to the new tenant.
```

The invite **carries the role**; membership is created at accept time, not invite time (so an abandoned invite
leaves no orphan membership). The `accept_staff_invite` RPC is `SECURITY DEFINER` to break the RLS
chicken-and-egg of "insert a membership in a tenant you are not yet a member of" — same pattern as
`provisionTenant` ([02 §8](02-reservation-core.md)).

### (c) Family magic-link sign-in to the portal

```
1. portal /portal/login  → POST /api/portal/auth/magic-link  { email }
      (rateLimit: 'magic-link' 5/10m per IP+email; ALWAYS responds 202 — anti-enumeration, §6)
2. supabase.auth.signInWithOtp({ email, options:{ emailRedirectTo:
      'https://‹slug›.terminar.cz/auth/callback?next=/portal' }})
      ↳ GoTrue mints a single-use magic-link token (TTL 60m), Resend delivers it [10]
3. guardian clicks → GET /auth/callback?code=…  (route OUTSIDE the [locale] segment, §7)
      ↳ supabase.auth.exchangeCodeForSession(code) → @supabase/ssr writes the session cookie
4. requireClaims() → participantAccounts[]; if empty → "no participants yet" claim screen (§3)
5. redirect to next (/portal).
```

The link is **single-use** (GoTrue invalidates on first exchange) and short-lived; a second click shows
"link already used / expired" rather than a session.

### (d) Family OAuth

```
1. portal "Continue with Google/Apple" → supabase.auth.signInWithOAuth({ provider,
      options:{ redirectTo: '…/auth/callback?next=/portal' }})
2. provider consent → back to /auth/callback?code=… → exchangeCodeForSession → cookie
3. first-ever sign-in: requireClaims() bootstraps a core.profiles row (idempotent, [02 §7])
4. participant-account resolution as in (c) step 4.
```

OAuth identities are linked by verified email; a guardian who first used a magic link and later "Continue with
Google" on the **same verified email** lands on the same `auth.users` row (GoTrue identity linking) — so they
keep their participant accounts. Apple's private-relay email is stored as-is and still matches by the relayed address.

### (e) OTP fallback (6-digit code)

For shared inboxes or in-app webviews where redirect-back is unreliable:

```
1. POST /api/portal/auth/otp/request { email }   (rateLimit: 'otp' 5/10m per IP+email; 202 always)
      ↳ supabase.auth.signInWithOtp({ email, options:{ shouldCreateUser:true } }) — code, not link
2. user types 6 digits → POST /api/portal/auth/otp/verify { email, token }
      ↳ supabase.auth.verifyOtp({ email, token, type:'email' }) → session cookie
3. lockout: 5 wrong codes → 15-min lock on that email (§6); resend has its own bucket.
```

Same session outcome as a magic link; OTP and magic-link share GoTrue's email-OTP machinery (the link is just
an OTP embedded in a URL).

### (f) Login-less safe-link tokens (one-shot actions)

The legacy participant flows and the **omluvenka self-service** require acting from an email **without
logging in**. A safe-link is **our** opaque token (not a GoTrue session): single-purpose, signed, expiring,
single-use where the action is irreversible. Contrast with a full session below.

```
Application confirm:
  app stores public.applications.safe_link_token (uuid, [03 §5]); email links
    ‹slug›.terminar.cz/zapis/potvrzeni?token=…   → GET validates token (unexpired, status='pending')
    → shows the application → POST confirm  → status unchanged but contact verified; single-use.

Self-excuse from an email reminder ("omluvit se"):
  session reminder email carries a per-(enrollment,session) action token:
    /omluvenka/omluvit?token=…  → server validates: token valid, BEFORE excuse_policy.deadlineHours,
    enrollment active → write public.excuses(source='self') → mint credit [03 §6, doc 08]
    → token consumed (single-use); link now shows "už omluveno".
```

| Safe-link vs full session | Safe-link | Full session |
|---|---|---|
| Grants | one action on one object | broad access per RLS |
| Auth artifact | opaque signed token in URL | access JWT + refresh cookie |
| Lifetime | minutes–days, action-scoped | rotating, long-lived |
| Reuse | single-use (irreversible acts) | many requests |
| Backed by | app token table / signature | GoTrue |

Safe-link requests run under the **anon** client through a `SECURITY DEFINER` RPC scoped to exactly the token's
object — never a service-role free-for-all. A self-excuse safe-link can mint a credit but cannot read the rest
of the family's data. Token construction & entropy in §5.

## 3. Guardian ↔ Participant linking

A magic-link/OAuth/registered guardian is **associated with participants** through `core.participant_accounts`
([03 §3](03-data-model.md)); how that row is born:

1. **On application approval** ([03 §5](03-data-model.md) → enrollment): staff approve a `public.applications`
   row carrying `guardian_email`. The approval use-case:
   - matches `guardian_email` to an existing `auth.users` (verified email) → if found, create
     `core.participant_accounts(user_id, participant_id, relation='parent', is_primary=true)`;
   - else send a **claim** invite (magic link to the portal). The participant account is created **pending** against
     the email and resolved to the `user_id` when they first authenticate.
2. **Claiming flow**: an unauthenticated guardian who follows the post-approval email signs in (magic link /
   OAuth / password). On first `requireClaims()`, any pending participant account matching their verified email is
   bound to their `user_id` (idempotent, like the profile bootstrap in [02 §7](02-reservation-core.md)).
3. **Adult self-managing participant**: at enrollment the applicant marks "I am the participant" → the
   participant row is created and a `core.participant_accounts(relation='self', is_primary=true)` link binds the adult
   to themselves. `relation='self'` is a `participant_relation` value ([03 §3](03-data-model.md)); it confers no
   extra power ([04 §7](04-roles-and-permissions.md)).
4. **Adding another child**: an authenticated guardian uses *Přidat dítě* in the portal → creates a new
   `public.participants` row in the tenant and a second `core.participant_accounts(user_id, participant_id,
   relation='parent')`. The `unique (user_id, participant_id)` constraint ([03 §3](03-data-model.md)) prevents
   duplicate links; two guardians over one child are two rows (one `is_primary`).

> Participant-account binding always keys on a **verified** email. An unverified address never auto-links — it stays
> pending until the address is proven by a magic-link/OTP click, closing the obvious account-takeover hole.

## 4. Account model — one user, two contexts

One `auth.users` row can be **both** staff and family (a coach whose child swims at the studio). There is no
separate "family users" table; the distinction is which app rows reference the user.

```ts
// requireClaims() returns BOTH shapes (02 §7); the route's audience picks the required one.
interface AuthContext {
  userId: string; email: string | null; profile: ProfileClaims
  memberships:   Membership[]     // { tenantId, role }       — STAFF context
  participantAccounts: ParticipantAccount[] // { participantId, relation } — FAMILY context
}
```

- `audience: 'staff'` requires `memberships` (in the resolved tenant) and ignores participant accounts; `audience:
  'family'` requires `participantAccounts` and ignores roles. A user with only one of the two is simply denied the
  other surface (`403 NOT_A_MEMBER` / `403 NOT_A_PARTICIPANT`, [04 §8](04-roles-and-permissions.md)).
- The **same login** serves both surfaces; the *surface URL* (admin host vs `/portal`) and the route audience
  decide context — the user does not pick "log in as staff vs parent". This is exactly the `AuthContext`
  contract in [02 §4,§7](02-reservation-core.md).
- `core.profiles` (1:1 with `auth.users`, [03 §3](03-data-model.md)) holds display name, locale, avatar shared
  across both contexts; it is bootstrapped idempotently on first authenticated hit.

## 5. Session handling

Cookie-based, via `@supabase/ssr`, identical mechanics across surfaces ([01 §4–5](01-architecture.md)):

- **Storage**: the session (access JWT + refresh) is an **httpOnly** cookie `sb-‹ref›-auth-token` written by
  `@supabase/ssr`. The browser never sees the JWT in JS; client components call API routes, not Supabase with a
  bearer token.
- **Rotation**: `proxy.ts` middleware calls `updateSession(req, res)` on **every** request — it constructs a
  `createServerClient` and `await supabase.auth.getUser()`, which refreshes the access token from the refresh
  token and re-writes the cookie when near expiry (the `updateSession` promoted from both reference apps'
  `supabase/proxy.ts`). Locale negotiation runs in the same middleware but is skipped for `/api`
  ([01 §5](01-architecture.md)).
- **In-memory access token**: within a single server request, `createServerClient()` reads the cookie once;
  the decoded JWT lives only for that request's lifetime — never persisted app-side, never logged
  ([01 §9](01-architecture.md), no PII in logs).
- **Refresh-token reuse detection**: GoTrue rotates refresh tokens and revokes the family on reuse (stolen
  refresh token → both sessions die). Sign-out (`POST /api/auth/sign-out`) revokes server-side and clears the
  cookie; "sign out everywhere" calls `signOut({ scope: 'global' })`.
- **Portal session** is the same `@supabase/ssr` cookie session on the portal host — *not* a separate scheme
  (the legacy "three token schemes + two portals" is collapsed to one, [00 §7](00-overview.md)).

## 6. Security

The legacy gap we explicitly close: **auth-adjacent public endpoints were unthrottled**. Closed precisely:

- **Rate-limiting (token bucket per IP + email)** on `magic-link request`, `otp request`, `otp verify`, and
  `application submit`, declared on the route ([02 §4](02-reservation-core.md), `rateLimit`):
  `{ key:'magic-link', limit:5, window:'10m' }`. Buckets are keyed on **both** client IP and email so neither a
  single IP spraying addresses nor one address from many IPs gets through. Counter store: a Postgres
  `core.rate_limits(bucket_key, window_start, count)` row (or Upstash if present); `429 RATE_LIMITED` on
  exceed.
- **Lockout**: 5 failed password attempts or 5 wrong OTP codes → 15-minute lock on that identity (separate from
  the request bucket so a locked account can't be probed by spamming requests).
- **Anti-enumeration "always 202"**: magic-link / OTP / password-reset / application-submit endpoints return an
  identical `202 Accepted` ("Pokud účet existuje, poslali jsme e-mail.") **regardless** of whether the email
  exists. No timing oracle (constant-time-ish path), no distinct error. This is why those flows never surface
  "no such user".
- **Safe-link entropy/expiry**: tokens are 256-bit random (`gen_random_bytes(32)`, base64url) — the
  `applications.safe_link_token` is a v4 uuid (122 bits) for *tracking* links; **action** safe-links that
  mutate (self-excuse, confirm) use the 256-bit signed form, are **single-use**, and expire (action-scoped TTL,
  §7 table). Signed = HMAC over `{purpose, objectId, exp}` with a server secret so a forged/edited token fails
  validation before any DB hit.
- **2FA**: TOTP enrollment is **required** for `owner` memberships and **platform operators**
  ([00 §4](00-overview.md), [04 §6](04-roles-and-permissions.md)), offered to all family/staff. Enforced at
  `withRoute` for owner/operator audiences (no valid AAL2 → step-up challenge).
- **Password policy**: min 10 chars, checked against a breached-password list (HaveIBeenPwned k-anonymity
  range), no max < 72 (bcrypt), no forced rotation (NIST 800-63B). Reset is a magic-link-style email, same
  anti-enumeration.
- **GDPR consent at signup**: family signup and the public application both capture explicit consent
  (`public.applications.gdpr_consent_at`, [03 §5,§10](03-data-model.md)); the consent text + version is stored
  so a later policy change is auditable. Export/erase paths per [03 §10](03-data-model.md). EU residency
  (Supabase EU, Resend EU, [01 §10](01-architecture.md)).

## 7. Token types & provider configuration

### All token types

| Token | Issued by | Entropy | TTL | Single-use | Storage |
|---|---|---|---|---|---|
| **Access JWT** | GoTrue | RS256-signed claims | ~1h (rotated) | no (reused until exp) | httpOnly cookie (`sb-…`) |
| **Refresh token** | GoTrue | 256-bit opaque | ~30d sliding | yes (rotates; reuse → revoke family) | httpOnly cookie |
| **Magic-link token** | GoTrue | ≥128-bit opaque (email OTP) | 60 min | **yes** | emailed URL only |
| **OTP (6-digit)** | GoTrue | 10⁶ space + lockout | 60 min | **yes** | emailed code; user-typed |
| **Safe-link (action)** | core | 256-bit + HMAC sig | action-scoped (e.g. self-excuse = until `deadlineHours`; confirm = 7d) | **yes** | emailed URL; token table |
| **Safe-link (tracking)** | core | 122-bit uuid (`safe_link_token`) | application lifetime | no (idempotent read) | `public.applications` row |
| **Staff invite** | core | 128-bit uuid | 72 h | **yes** | `core.staff_invites` row |
| **Portal session** | GoTrue (`@supabase/ssr`) | = access+refresh above | as session | n/a | httpOnly cookie |
| **TOTP secret (2FA)** | GoTrue | 160-bit shared secret | until removed | n/a | GoTrue (encrypted) |

### Provider configuration notes

- **Redirect / callback**: every OAuth & magic-link flow returns to `‹host›/auth/callback?code=…&next=…`. The
  `auth/callback` route lives **outside the `[locale]` segment** (so `exchangeCodeForSession` runs before
  locale routing and is not rewritten by next-intl) — a deliberate fix for the i18n-callback collision; the
  allow-listed redirect URLs in the Supabase dashboard cover `app.terminar.cz`, `‹slug›.terminar.cz`, and any
  verified custom domain (`core.tenant_domains`, [01 §7](01-architecture.md)). `next` is validated against an
  allow-list (no open-redirect).
- **OAuth providers**: Google, Apple, Microsoft client IDs/secrets configured per environment
  ([01 §8](01-architecture.md)); scopes minimal (email + profile). Apple requires the private-relay-capable
  service ID.
- **Email templates owned by Resend, not Supabase**: GoTrue's built-in email sending is **disabled**; we use
  the **"auth hook" / generate-link** path so the localized magic-link, OTP, invite, and recovery emails are
  rendered and delivered by our Resend transactional layer ([02 §11](02-reservation-core.md)) — localized,
  branded per tenant, idempotency-keyed. This guarantees the legacy "hardcoded English" mistake cannot recur
  and keeps all transactional mail in one pipeline. Full template contract and the auth-hook wiring in
  **[10 — Email & notifications](10-notifications-and-email.md)**.
- **Confirm-email**: staff sign-up requires email verification before the membership/invite completes; OAuth
  emails arrive pre-verified from the provider.

The stack rationale (why GoTrue over the legacy three-scheme participant auth) is in
[`adr/0001-stack-nextjs-supabase-resend.md`](adr/0001-stack-nextjs-supabase-resend.md). Continue to
**[06 — Courses & the termínář](06-courses-and-terminar.md)**.
