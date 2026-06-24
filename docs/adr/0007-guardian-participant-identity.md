# ADR-0007 — Guardian ↔ Participant identity

- **Status:** Accepted
- **Date:** 2026-06-24
- **Deciders:** Platform team
- **Context tags:** domain, identity, data-model, security

## Context

Termínář 2 is a course platform for, often, **children**: a parent manages one or more kids, excuses their
absences, books their makeups, and pays. The legacy system modeled a participant as just **`name +
email`**. That made the real jobs impossible: a parent with **two children** could not have one account
over both, there was no meaningful **"my children"** view in a portal, and adults attending for themselves
were a special case bolted on. The reference apps (`main-panel`, `admin-console`) have **no** family
identity at all — they only know staff `memberships`. So this is genuinely **new** ground the core must
break, not promote.

Whatever we model has to fit the multimodal core ([ADR-0004](0004-multimodal-core.md)) as the **family**
audience and be enforceable by **RLS**, not just app code.

## Decision

Model **Guardian (an account) ↔ Participant (a child/attendee)** as a first-class relationship via
**`core.guardianships`** — `{ account, participantId, relation }`. A participant is the person who attends; a
guardian is the family account that may act for them. Adults attending for themselves are represented with
**`relation='self'`** (one account, a participant record it owns) rather than a separate code path.
`requireClaims()` returns `guardianships[]` alongside staff `memberships[]`; the family audience resolves a
`GuardianContext` of the participants the caller may act for. RLS is enforced by a SECURITY DEFINER
predicate **`guardian_can_act(participant)`**, used by every family-facing policy (portal reads, self-excuse,
redemption), mirroring how `is_member_of()` ([ADR-0008](0008-rls-is-member-of.md)) DRYs the staff side.

## Consequences

**Positive:** A real "my children" portal; one account spans multiple kids; adults are not a special case
(`relation='self'`); the family side gets the same DB-enforced isolation as staff; enrollment, excuses,
credits, and makeups all hang off a stable participant identity.
**Negative / costs:** A richer identity model and migration than `name+email`; the family-RLS path must be
tested as carefully as the staff path; relationship edge cases (shared custody, transferring a participant
between guardians, an adult who is also a guardian) need explicit handling.
**Follow-ups:** Schema and constraints in [03](../03-data-model.md); enrollment must create/link
participants under the right guardianship; portal "my children" + per-child balance views.

## Alternatives considered

- **Keep `name + email` (legacy).** Zero migration, but blocks the multi-child account and any real portal —
  the core reason for the redesign. Rejected.
- **One account per participant.** Simple identity, but forces a parent of two into two logins and loses the
  "my children" rollup; awkward for minors who have no email. Rejected.
- **A `household` entity grouping participants.** More general, but adds a layer the product doesn't need at
  v1 and complicates RLS; a guardian↔participant link covers the required jobs directly. Rejected (revisit if
  multi-guardian households become common).
