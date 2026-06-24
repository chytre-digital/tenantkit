# ADR-0005 — Per-course credit expiry

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Platform team
- **Context tags:** domain, omluvenky, data-model

## Context

The omluvenka system turns an excused absence into a **makeup credit** redeemable into another session. The
brief is explicit: *"každému kurzu jde nastavit expirace omluvenkového tokenu"* — **each course** can
configure how long its credits stay valid. This is a real product need: a seasonal swim block, an
evergreen membership, and a term/quarter music school all want *different* expiry rules, and they coexist
in one tenant. The legacy system had a good **named validity-window** model but applied it inconsistently;
a flat global TTL would be wrong for most of these cases.

We also learned from legacy that **all the omluvenka bugs lived in side-effecting handlers and background
jobs** (clock-skew, a job that hadn't run yet flipping state). Correctness must not depend on a job.

## Decision

Expiry is configured **per course** via `courses.excuse_policy.expiry`, a small tagged union with one of
four modes:

| `mode` | Meaning | Produces |
|---|---|---|
| `none` | Never expires | `expires_at = null` |
| `ttl` | N days from issue | `expires_at = issuedAt + ttlDays` |
| `course_end` | Until the source course's last session | `expires_at = lastSession.starts_at` |
| `windows` | The legacy named validity-window model, generalized (base window + `forwardWindows`) | `valid_window_ids[]` |

`computeExpiry` is a **pure domain function** that maps the policy to physical columns at issue time;
`isRedeemableNow(credit, today)` is evaluated **lazily at redemption** — never relying on a job for
correctness. A nightly job sets `status='expired'` *only* so the portal can show an accurate bucket and
retention can purge; correctness never depends on it having run. Tenant-level `excuseDefaults` seed each new
course, which may override — so a studio sets policy once.

## Consequences

**Positive:** Each course expresses exactly the rule its program needs; `ttl`/`course_end` collapse to a
human "platí do 14. 7." while `windows` supports disjoint term ranges; pure, exhaustively unit-testable
expiry math; no clock-skew or stale-job correctness bugs.
**Negative / costs:** Two physical representations (`expires_at` vs `valid_window_ids`) the UI must render
as one sentence; per-course config is a richer admin surface; the lazy + nightly split must be clearly
documented so no one treats the job as authoritative.
**Follow-ups:** The pure-domain test list (each mode, `isRedeemableNow` truth table) in
[08 §13](../08-attendance-and-omluvenky.md); staff Extend as the only post-issue mutation of expiry.

## Alternatives considered

- **Global TTL only.** Trivial, but cannot express seasonal blocks, evergreen, or term systems at once —
  fails the brief. Rejected.
- **Tenant-level expiry only.** Better, and we *do* keep it as the per-course default; but a tenant runs
  courses with genuinely different rules, so it cannot be the sole knob. Rejected as the only level.
- **A background expiry job as the source of truth.** Simple mental model, but reintroduces exactly the
  clock-skew/"job hasn't run" class of legacy bug. Rejected — the job is cosmetic, redemption is
  authoritative.
