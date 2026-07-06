---
'@deverjak/tenantkit-reservation-core': minor
---

New `creditCoversSession(credit, sessionStart, timeZone?)` predicate (doc 08 §6/§14): a credit's expiry bounds
the TARGET lesson's calendar day (studio timezone, inclusive) — "platí do 5. 8." books lessons through 5. 8.,
never a lesson on 6. 8. Callers filter with it before `selectCreditFIFO` (which stays a pure sorter), mirroring
the shipped SQL `book_makeup` coverage clause.
