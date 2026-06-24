/**
 * @reservation-core/domain — the reservation domain on the @tenantkit/* kernel (ADR-0010, layer 2).
 *
 * Today: the omluvenka credit engine. As the spec is built out, the pure helpers for courses/sessions/
 * capacity and the recurrence generator (docs/06) live here too — vendor-free, kernel-only.
 */
export * as credits from './credits/index'
