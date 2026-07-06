# @deverjak/tenantkit-reservation-core

## 0.3.0

### Minor Changes

- de5f9a8: New `creditCoversSession(credit, sessionStart, timeZone?)` predicate (doc 08 §6/§14): a credit's expiry bounds
  the TARGET lesson's calendar day (studio timezone, inclusive) — "platí do 5. 8." books lessons through 5. 8.,
  never a lesson on 6. 8. Callers filter with it before `selectCreditFIFO` (which stays a pure sorter), mirroring
  the shipped SQL `book_makeup` coverage clause.
- 03c840f: Named fixed-date expiry tokens (doc 08 §14): `ExpiryPolicy` gains `{ mode: 'token', tokenId }` resolved
  against a new `NamedExpiryToken[]` tenant catalog param on `computeExpiry` (with an IANA `timeZone` param,
  default Europe/Prague — inclusive end-of-day semantics). A token missing from the catalog or already expired
  at issue signals via `ComputedExpiry.unresolvedTokenId` instead of stamping a dead credit; the new
  `resolveCreditExpiry(coursePolicy, tenantDefault, …)` is the one-function TS mirror of the shipped SQL ladder
  (course override → tenant default → ttl-30). `decideIssue` passes the catalog through.
