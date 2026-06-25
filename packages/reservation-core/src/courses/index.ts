/**
 * The course domain — pure (no I/O), realizing docs/06-courses-and-terminar.md. Capacity/occupancy math, the
 * status state machine + kind/session invariants, and the recurrence generator. Built on the @tenantkit/kernel
 * but vendor-free; the kernel knows nothing about courses.
 */
export * from './capacity'
export * from './status'
export * from './recurrence'
