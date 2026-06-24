/**
 * Realizes docs/14-portability-and-providers.md §4 (`EmailProvider` port) + §7 (in-memory adapter).
 *
 * The capture-everything email transport. It NEVER sends anything — it PUSHES each `EmailMessage` onto an
 * inspectable `sentEmails[]` array so a test can assert "exactly one welcome email went to ada@x, with the
 * magic-link URL in its body" without a network, a mailbox, or Resend (the contract that real adapters meet:
 * `send()` never throws — ports/index.ts §3).
 *
 * Mirrors `@tenantkit/email-resend`'s result contract so swapping this for Resend changes nothing in the kernel:
 *   • normal send            → `{ status: 'ok', id }`   and a row appended to `sentEmails`.
 *   • `failNext()` armed      → `{ status: 'error', error }` (lets a test exercise the graceful-failure path,
 *                              doc 10 §1 — a failed email must not break enrollment) — still recorded, with `.error`.
 *   • `skipNext()` armed      → `{ status: 'skipped', reason }` (models the "no API key" local-dev path).
 */
import type { EmailMessage, EmailProvider, EmailSendResult } from '@deverjak/tenantkit-kernel'

/** A captured send: the message plus the result the provider returned for it (for end-to-end assertions). */
export interface SentEmail {
  message: EmailMessage
  result: EmailSendResult
}

/** The in-memory `EmailProvider` plus the test affordances `createTestRuntime` surfaces. */
export interface MemoryEmailProvider extends EmailProvider {
  /** Every message handed to `send()`, in order. Cleared with `clear()`. */
  readonly sentEmails: SentEmail[]
  /** Arm the next `send()` to return `{ status: 'error' }` (graceful-failure path). */
  failNext(error?: string): void
  /** Arm the next `send()` to return `{ status: 'skipped' }` (no-key path). */
  skipNext(reason?: string): void
  /** Forget all captured emails (between tests). */
  clear(): void
  /** Convenience: the last message sent, or undefined. */
  last(): EmailMessage | undefined
}

export function createMemoryEmail(): MemoryEmailProvider {
  const sentEmails: SentEmail[] = []
  let queuedFailure: string | null = null
  let queuedSkip: string | null = null
  let counter = 0

  return {
    sentEmails,

    async send(message: EmailMessage): Promise<EmailSendResult> {
      let result: EmailSendResult
      if (queuedFailure !== null) {
        result = { status: 'error', error: queuedFailure }
        queuedFailure = null
      } else if (queuedSkip !== null) {
        result = { status: 'skipped', reason: queuedSkip }
        queuedSkip = null
      } else {
        counter += 1
        result = { status: 'ok', id: `mem-email-${counter}` }
      }
      // Capture regardless of outcome — an errored send is exactly what some tests want to observe.
      sentEmails.push({ message, result })
      return result
    },

    failNext(error = 'simulated email failure') {
      queuedFailure = error
    },
    skipNext(reason = 'no_api_key') {
      queuedSkip = reason
    },
    clear() {
      sentEmails.length = 0
      queuedFailure = null
      queuedSkip = null
    },
    last() {
      return sentEmails.at(-1)?.message
    },
  }
}
