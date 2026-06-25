/**
 * Barrel for the kernel `security` module — the cross-cutting security primitives that aren't tied to one
 * subsystem: safe-link tokens (docs/05 §2f) and PII redaction for logs/GDPR (docs/01 §9, docs/03 §10).
 * Re-exported from the package root so apps `import { createSafeLinks } from '@tenantkit/kernel'`.
 */
export {
  createSafeLinks,
  DEFAULT_TTL_SECONDS,
  type SafeLinks,
  type SafeLinkConfig,
  type SafeLinkClaims,
  type MintInput,
  type VerifyResult,
  type SafeLinkFailure,
} from './safe-link'
export {
  redact,
  redactSecrets,
  redactPii,
  piiKeysOf,
  REDACTED,
  DEFAULT_SECRET_KEYS,
  type RedactOptions,
} from './redact'
