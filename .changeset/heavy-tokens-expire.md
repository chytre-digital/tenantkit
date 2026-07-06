---
'@deverjak/tenantkit-reservation-core': minor
---

Named fixed-date expiry tokens (doc 08 §14): `ExpiryPolicy` gains `{ mode: 'token', tokenId }` resolved
against a new `NamedExpiryToken[]` tenant catalog param on `computeExpiry` (with an IANA `timeZone` param,
default Europe/Prague — inclusive end-of-day semantics). A token missing from the catalog or already expired
at issue signals via `ComputedExpiry.unresolvedTokenId` instead of stamping a dead credit; the new
`resolveCreditExpiry(coursePolicy, tenantDefault, …)` is the one-function TS mirror of the shipped SQL ladder
(course override → tenant default → ttl-30). `decideIssue` passes the catalog through.
