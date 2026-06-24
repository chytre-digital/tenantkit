/**
 * @tenantkit/testing — the in-memory runtime + the port CONFORMANCE SUITE.
 *
 * Two jobs (docs/14 §6.4): (1) let the kernel + apps test vendor-free and fast via `createTestRuntime()`;
 * (2) be the bar every adapter must clear via `runAllConformance()`. Provisional scope `@tenantkit/*` (ADR-0010).
 */
export { createTestRuntime, type TestRuntime } from './createTestRuntime'
export {
  type ConformanceHarness,
  type MakeHarness,
  runAllConformance,
  runIdentityConformance,
  runAuthzConformance,
  runDatabaseScopingConformance,
  runEmailConformance,
} from './conformance'
export { MemoryStore, type MemorySeed, type Actor, type FakeRpc } from './memory/store'
export { createMemoryEmail, type MemoryEmailProvider, type SentEmail } from './memory/email'
export { createMemoryPayments, type MemoryPaymentProvider } from './memory/payments'
export { createFixedClock, createCounterIdGen, type AdvanceableClock } from './memory/clock'
