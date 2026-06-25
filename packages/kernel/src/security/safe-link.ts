/**
 * Realizes docs/05-auth.md §2f (login-less "safe-link" flows) + docs/13 §7 Phase 5 ("safe-link entropy/HMAC")
 * and the glossary's **Safe-link token** (docs/00 §6) — the kernel's single-purpose, signed, expiring token.
 *
 * A safe-link is the one-shot capability a transactional email hands an unauthenticated recipient: "confirm
 * this application", "excuse this session", "unsubscribe". It is NOT a session — it authorizes exactly one
 * `purpose` for one `subject` until `exp`, and nothing else. Legacy Termínář had THREE bespoke token schemes
 * (doc 00 §7); this is the single concept.
 *
 * Construction (a compact, self-describing token — a purpose-scoped mini-JWT, no vendor lib):
 *   token = base64url(JSON(claims)) + "." + base64url(HMAC-SHA256(secret, that-first-segment))
 * `verify` recomputes the MAC, compares in CONSTANT TIME, then checks `exp` and (optionally) the expected
 * `purpose`. It NEVER throws on a bad/tampered/expired token — it returns a discriminated reason — so a route
 * maps the failure to a 4xx instead of a 500 (the same "never throw into the request" rule as email/events).
 *
 * Vendor-free + runtime-agnostic: Web Crypto (`crypto.subtle`), `TextEncoder`, and `btoa/atob` only — so it runs
 * on Node, edge, and workers identically. The signing key is derived once and cached per `createSafeLinks`.
 */
import type { Clock } from '../ports'
import type { IdGen } from '../ports'

/** Why a token failed verification — surfaced so a route can choose the right 4xx + message. */
export type SafeLinkFailure = 'malformed' | 'bad_signature' | 'expired' | 'purpose_mismatch'

/** The signed, verified-back claims. `data` carries purpose-specific context (e.g. `{ applicationId }`). */
export interface SafeLinkClaims<D = unknown> {
  /** What this token authorizes, e.g. 'application.confirm' | 'self-excuse' | 'email.unsubscribe'. */
  purpose: string
  /** Who/what it acts on — typically a participant/application/email id (NOT a session). */
  subject: string
  data?: D
  /** Issued-at, epoch seconds. */
  iat: number
  /** Expiry, epoch seconds. After this instant `verify` returns `expired`. */
  exp: number
  /** Random per-token nonce → tokens are unguessable and single-use-trackable (entropy, doc 05 §6). */
  nonce: string
}

export interface MintInput<D = unknown> {
  purpose: string
  subject: string
  data?: D
  /** Lifetime in seconds from now (default `DEFAULT_TTL_SECONDS`). Ignored if `expiresAt` is given. */
  ttlSeconds?: number
  /** Absolute expiry; overrides `ttlSeconds`. */
  expiresAt?: Date
  /** Override the generated nonce (tests); normally left to the injected `ids`/Web Crypto. */
  nonce?: string
}

export type VerifyResult<D = unknown> =
  | { valid: true; claims: SafeLinkClaims<D> }
  | { valid: false; reason: SafeLinkFailure }

export interface SafeLinks {
  /** Sign a new single-purpose token. Async (Web Crypto). */
  mint<D = unknown>(input: MintInput<D>): Promise<string>
  /** Verify a token. `opts.purpose`, when given, must match the token's `purpose` (else `purpose_mismatch`). */
  verify<D = unknown>(token: string, opts?: { purpose?: string }): Promise<VerifyResult<D>>
}

export interface SafeLinkConfig {
  /** The HMAC secret. MUST be high-entropy and server-only (never shipped to the client). */
  secret: string
  /** Injected for deterministic expiry in tests; falls back to the wall clock. */
  clock?: Clock
  /** Injected for a deterministic nonce in tests; falls back to `crypto.randomUUID()`. */
  ids?: Pick<IdGen, 'token' | 'uuid'>
}

/** Default safe-link lifetime: 1 hour. Per-purpose flows pass their own `ttlSeconds` (doc 05 §6 lockout/TTL). */
export const DEFAULT_TTL_SECONDS = 3600

export function createSafeLinks(config: SafeLinkConfig): SafeLinks {
  if (!config.secret) throw new Error('[safe-link] a non-empty `secret` is required')

  // Derive + cache the signing key once (a Promise so concurrent first calls share it).
  const keyPromise = crypto.subtle.importKey(
    'raw',
    utf8ToBytes(config.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )

  const nowSeconds = (): number => Math.floor((config.clock?.now() ?? new Date()).getTime() / 1000)
  const nonce = (): string => config.ids?.token?.() ?? config.ids?.uuid?.() ?? crypto.randomUUID()

  async function signSegment(segment: string): Promise<Uint8Array> {
    const key = await keyPromise
    const sig = await crypto.subtle.sign('HMAC', key, utf8ToBytes(segment))
    return new Uint8Array(sig)
  }

  return {
    async mint<D>(input: MintInput<D>): Promise<string> {
      const iat = nowSeconds()
      const exp = input.expiresAt
        ? Math.floor(input.expiresAt.getTime() / 1000)
        : iat + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS)
      const claims: SafeLinkClaims<D> = {
        purpose: input.purpose,
        subject: input.subject,
        iat,
        exp,
        nonce: input.nonce ?? nonce(),
        ...(input.data !== undefined ? { data: input.data } : {}),
      }
      const payloadSeg = bytesToBase64Url(utf8ToBytes(JSON.stringify(claims)))
      const sigSeg = bytesToBase64Url(await signSegment(payloadSeg))
      return `${payloadSeg}.${sigSeg}`
    },

    async verify<D>(token: string, opts?: { purpose?: string }): Promise<VerifyResult<D>> {
      const parts = token.split('.')
      if (parts.length !== 2 || !parts[0] || !parts[1]) return { valid: false, reason: 'malformed' }
      const [payloadSeg, sigSeg] = parts

      // 1) signature — recompute over the payload segment and compare in constant time BEFORE trusting claims.
      let presented: Uint8Array
      try {
        presented = base64UrlToBytes(sigSeg)
      } catch {
        return { valid: false, reason: 'malformed' }
      }
      const expected = await signSegment(payloadSeg)
      if (!timingSafeEqual(expected, presented)) return { valid: false, reason: 'bad_signature' }

      // 2) claims — only now is the payload trustworthy enough to parse.
      let claims: SafeLinkClaims<D>
      try {
        claims = JSON.parse(bytesToUtf8(base64UrlToBytes(payloadSeg))) as SafeLinkClaims<D>
      } catch {
        return { valid: false, reason: 'malformed' }
      }
      if (typeof claims?.exp !== 'number' || typeof claims?.purpose !== 'string') {
        return { valid: false, reason: 'malformed' }
      }

      // 3) expiry (live at verify, like credit expiry, doc 08 §5) then 4) purpose binding.
      if (nowSeconds() >= claims.exp) return { valid: false, reason: 'expired' }
      if (opts?.purpose !== undefined && opts.purpose !== claims.purpose) {
        return { valid: false, reason: 'purpose_mismatch' }
      }
      return { valid: true, claims }
    },
  }
}

// ── byte / base64url / utf8 helpers — Web-API only (no Node Buffer), so this runs on edge + workers too ──

// Narrowed to an ArrayBuffer-backed view: `crypto.subtle` wants `BufferSource` (no SharedArrayBuffer), but
// `TextEncoder.encode()` is typed `Uint8Array<ArrayBufferLike>` since TS 5.7. The encoder never returns a
// shared buffer, so the assertion is sound.
function utf8ToBytes(str: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(str) as Uint8Array<ArrayBuffer>
}
function bytesToUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function base64UrlToBytes(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad)
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
/** Length-independent-then-content constant-time compare (no early-out on the first differing byte). */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!
  return diff === 0
}
