/**
 * Realizes docs/09-plugins-and-subscriptions.md §6 + docs/02-reservation-core.md §12 — the SMS plugin.
 *
 * `plugin:sms` is `pro`-tier. It sends transactional SMS for the same events the email layer handles but over a
 * different channel, behind a PROVIDER PORT so the concrete gateway (Twilio, SMSbrana) is swappable. It touches
 * the system only through the five seams (doc 09 §1): its own `sms.*` schema, namespaced routes, the event
 * subscriptions below, UI slots (none here), and a Zod settings schema. It NEVER alters core/public tables.
 *
 * Build order: ships AFTER `payments` (doc 09 §9) since it depends on the scheduler + `notification_preferences`.
 */
import { definePlugin, type PluginLifecycleCtx } from '@deverjak/tenantkit-kernel'
import { z } from 'zod'
import { type SmsProvider, StubSmsProvider } from './src/port'

/** Per-tenant SMS settings (doc 09 §6.5). Provider CREDENTIALS live in the vault, NEVER here (doc 09 §1, §6.5). */
export const SmsSettings = z.object({
  provider: z.enum(['twilio', 'smsbrana']).default('smsbrana'),
  senderId: z.string().max(11), // alphanumeric sender, where the provider allows
  reminderHours: z.number().int().default(24),
  events: z.object({
    reminder: z.boolean().default(true),
    creditIssued: z.boolean().default(false),
    applicationApproved: z.boolean().default(true),
    sessionCancelled: z.boolean().default(true),
  }),
  quietHours: z.object({ start: z.string(), end: z.string(), tz: z.string() }).optional(),
  monthlyCapMinor: z.number().int().optional(),
})
export type SmsSettingsValues = z.infer<typeof SmsSettings>

/** The bundled template pack seeded on enable (doc 09 §2.3, §6.4): one row per (key, locale). */
const TEMPLATE_PACK: Array<{ key: string; locale: string; body: string }> = [
  { key: 'session_reminder', locale: 'cs', body: 'Připomínka: lekce {{course}} zítra v {{time}}.' },
  { key: 'session_reminder', locale: 'en', body: 'Reminder: {{course}} lesson tomorrow at {{time}}.' },
  { key: 'credit_issued', locale: 'cs', body: 'Máte novou omluvenku, platí do {{expiresAt}}.' },
  { key: 'credit_issued', locale: 'en', body: 'You have a new makeup credit, valid until {{expiresAt}}.' },
]

/** Resolve the configured provider adapter from settings (doc 09 §6.1). Real adapters read creds from the vault. */
function selectProvider(settings: SmsSettingsValues): SmsProvider {
  switch (settings.provider) {
    // case 'twilio':   return new TwilioProvider(...)
    // case 'smsbrana': return new SmsbranaProvider(...)
    default:
      return new StubSmsProvider() // mockup default — logs instead of dialing a gateway
  }
}

export default definePlugin({
  id: 'sms',
  name: { cs: 'SMS notifikace', en: 'SMS notifications' },
  requiresTier: 'pro', // entitlement gate (doc 09 §3.2) — `plugin:sms` is pro-only
  dbSchema: 'sms', // owns the sms.* schema; migrations ship with this package (doc 09 §1)
  settingsSchema: SmsSettings,

  /**
   * Idempotent provisioning (doc 09 §2.3): seed default `sms.templates` so a freshly enabled tenant already has
   * Czech + English reminder copy. PORTS REFACTOR (docs/14): the lifecycle ctx is vendor-neutral — `ctx.db` is a
   * `ScopedDb` fenced to the plugin's OWN `sms.*` schema (doc 09 §7), not a Supabase client. Portable code calls
   * a SECURITY DEFINER RPC; the on-conflict upsert lives inside `sms.seed_templates`, so enabling twice is a no-op.
   */
  async onEnable(ctx: PluginLifecycleCtx) {
    await ctx.db.rpc('seed_templates', { tenant_id: ctx.tenantId, templates: TEMPLATE_PACK })
  },

  /**
   * Event subscriptions (doc 09 §6.2). Each handler reads core data read-only and writes only `sms.*` (a queued
   * `sms.messages` row the dispatcher later hands to the provider). Consent / quiet-hours / cost accounting
   * (doc 09 §6.3) are applied by the sender before the actual `provider.send`.
   */
  events: {
    /** N hours before a lesson — "Připomínka: lekce zítra v 17:00…" (doc 09 §6.2). */
    'session.reminder_due': async (event) => {
      await queueFromEvent(event, 'session_reminder')
    },
    /** On excuse → credit — "Máte novou omluvenku, platí do …" (doc 09 §5.1, §6.2; opt-in default off). */
    'credit.issued': async (event) => {
      await queueFromEvent(event, 'credit_issued')
    },
  },

  // routes: mounted under /api/plugins/sms/* (e.g. a test-send + a costs report). Each is auto-wrapped with
  // assertPluginEnabled (doc 09 §4) so an un-entitled tenant never reaches plugin code.
  routes: {
    'test-send': {
      POST: async () =>
        Response.json({ ok: true, note: 'mockup: would enqueue a test SMS via the configured provider' }),
    },
  },
})

/**
 * Shared queue step: turn a core event into a queued `sms.messages` row (status='queued'). This is where a real
 * impl resolves recipients + locale (guardian profile → tenant default, doc 09 §6.4), checks opt-in + quiet
 * hours, renders the `{{var}}` template, and lets the dispatcher call `selectProvider(settings).send(...)`.
 * Sketched as a structural stub so the subscription shape is concrete without wiring the dispatcher here.
 */
async function queueFromEvent(
  _event: { type: string; tenantId: string; payload: unknown },
  _templateKey: string,
): Promise<void> {
  // await admin.from('messages').insert({ tenant_id, to_phone, template, locale, body, status: 'queued' })
  // void selectProvider(settings)  // chosen at send time from per-tenant settings
  void selectProvider
  return
}

export { type SmsProvider } from './src/port'
