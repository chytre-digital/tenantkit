/**
 * The enrollment domain — pure (no I/O), realizing docs/07-registration-and-enrollment.md. Age-based course
 * recommendation for the public funnel, guardian/participant dedupe keys, the application state machine, and the
 * enrollable/waitlist predicates. The DB orchestration (approval RPC, account provisioning) lives in the app;
 * these are the rules it derives identically client + server.
 */
export * from './recommend'
export * from './dedupe'
export * from './application'
