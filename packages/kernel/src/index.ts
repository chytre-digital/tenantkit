/**
 * Barrel exports for `@tenantkit/kernel` (mockup).
 *
 * Realizes the public surface described across docs/02-reservation-core.md. In the real monorepo these live in
 * separate scoped packages (@reservation-core/{server,domain,i18n,db,plugins}); here one entry point re-exports
 * the whole framework.
 *
 * PORTS REFACTOR (docs/14): the kernel is now vendor-neutral. It exports the PORTS (`CoreRuntime` and friends)
 * that adapters implement — there are NO Supabase client exports here anymore (those moved to
 * `@tenantkit/adapter-supabase`). An app wires a `CoreRuntime` once and pre-binds `withRoute` (see
 * `apps/<app>/src/server/route.ts`).
 */

// --- env ---
export { env, EnvSchema, type Env } from './env'

// --- ports (the adapter contracts: identity, db, authz, email, payments, storage, clock, ids) ---
export type {
  CoreRuntime,
  IdentityProvider,
  AuthUser,
  AuthSession,
  SessionStore,
  Database,
  RequestDb,
  ScopedDb,
  AuthzStore,
  ProfileRow,
  EmailProvider,
  EmailMessage,
  EmailSendResult,
  PaymentProvider,
  PaymentEvent,
  StorageProvider,
  Clock,
  IdGen,
} from './ports'

// --- http & errors ---
export { jsonOk, jsonError } from './http/respond'
export {
  HttpError,
  isHttpError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  unprocessable,
  tooManyRequests,
  internal,
} from './http/errors'
export { enforceRateLimit, type RateLimitSpec } from './http/rate-limit'

// --- domain errors ---
export { DomainError, isDomainError, mapDomainError } from './domain/errors'

// --- validation ---
export {
  parseJson,
  parseQuery,
  parseHeaders,
  isParseError,
  type ParseResult,
} from './validation/parse'

// --- auth ---
export {
  resolveClaims,
  type AuthContext,
  type ProfileClaims,
  type Membership,
  type Guardianship,
  type GuardianRelation,
} from './auth/resolve-claims'

// --- tenancy ---
export {
  defineTenancy,
  tenancyConfig,
  resolveTenant,
  resolveActiveTenant,
  readActiveTenantCookie,
  setActiveTenantCookie,
  assertMember,
  provisionTenant,
  type TenancyConfig,
  type TenantFrom,
  type Promisable,
} from './tenancy'

// --- rbac ---
export { type AppRole, roleRank, roleAtLeast, ROLE_ORDER } from './rbac/roles'
export {
  can,
  mayEver,
  setPermissionGrants,
  type Permission,
  type Scope,
  type GrantMap,
} from './rbac/permissions'

// --- entitlements ---
export {
  getEntitlements,
  checkEntitlements,
  assertWithinLimit,
  createEntitlementsService,
  setTierEntitlements,
  setTierOrder,
  UNLIMITED,
  type Tier,
  type FeatureKey,
  type Limit,
  type TierEntitlements,
  type EntitlementsService,
} from './entitlements'

// --- server (withRoute) ---
export {
  withRoute,
  type RouteOptions,
  type RouteCtx,
  type Audience,
  type GuardianContext,
} from './server/with-route'
export { resolveLocale } from './server/resolve-locale'

// --- plugins ---
export {
  definePlugin,
  type Plugin,
  type PluginSpec,
  type PluginId,
  type PluginLifecycleCtx,
  type PluginRouteModule,
  type CoreEvent,
  type EventHandler,
  type UiSlot,
  type LocalizedString,
} from './plugins/define-plugin'
export {
  registerPlugins,
  registry,
  resolvePluginRoute,
  type PluginRegistry,
} from './plugins/registry'
export { assertPluginEnabled, type PluginGateReason } from './plugins/guard'

// --- email ---
export { sendEmail, type SendEmailInput, type EmailResult } from './email/send'
export {
  defineEmail,
  type EmailTemplate,
  type EmailSpec,
  type RenderedEmail,
  type EmailRenderInput,
  type TenantBranding,
} from './email/define-email'

// --- i18n (vendor-free locale type; the next-intl factory `createI18n` lives in @tenantkit/i18n) ---
export {
  type Locale,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  readCookie,
} from './i18n/locale'

// --- db (SQL building blocks) ---
export {
  IS_MEMBER_OF_SQL,
  MY_ROLE_SQL,
  GUARDIAN_CAN_ACT_SQL,
  ROLE_RANK_SQL,
  SET_UPDATED_AT_SQL,
  CREATE_TENANT_WITH_OWNER_SQL,
  CORE_FUNCTIONS_SQL,
} from './db'

// --- fields (the schema-driven custom-field system; module authored by a sibling agent) ---
export * from './fields'
