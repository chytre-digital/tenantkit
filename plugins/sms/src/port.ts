/**
 * Realizes docs/09-plugins-and-subscriptions.md §6.1 — the SMS provider PORT (infrastructure boundary, doc 01 §3).
 *
 * The application layer depends on `SmsProvider`, never on Twilio/SMSbrana directly — so a tenant on SMSbrana
 * and a tenant on Twilio run identical code (the same lesson the four Supabase factories teach: parameterize the
 * vendor). Concrete adapters (TwilioProvider, SmsbranaProvider) implement this and are selected by
 * `settings.provider`; their credentials come from the vault (doc 09 §6.5), never from `plugin_settings`.
 */

/** E.164 phone string, e.g. '+420777123456'. Branded loosely; validated at the edge. */
export type E164 = string

export interface SmsProvider {
  /** Send one message. Returns the provider reference + (optional) cost in minor units for cost accounting. */
  send(msg: { to: E164; body: string; senderId?: string }): Promise<{ ref: string; costMinor?: number }>
  name: 'twilio' | 'smsbrana'
}

/**
 * A stub provider for the mockup / local / tests: it never dials a gateway, it just logs and returns a fake ref.
 * Real deployments register `TwilioProvider` / `SmsbranaProvider` instead (selected in index.ts `selectProvider`).
 */
export class StubSmsProvider implements SmsProvider {
  readonly name = 'smsbrana'

  async send(msg: { to: E164; body: string; senderId?: string }): Promise<{ ref: string; costMinor?: number }> {
    // console.debug('[sms:stub] →', msg.to, msg.body)  — wired to the app logger in a real build (doc 01 §9)
    return { ref: `stub-${Date.now()}`, costMinor: 0 }
  }
}
