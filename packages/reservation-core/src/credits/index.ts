/**
 * The omluvenka credit engine — pure domain (no I/O), realizing docs/08-attendance-and-omluvenky.md.
 * Moved here as part of the two-layer split (ADR-0010): this is @reservation-core/domain, built ON the
 * @tenantkit/kernel. The kernel knows nothing about credits; this layer knows nothing about Supabase.
 */
export * from './expiry'
export * from './issue'
export * from './redeem'
