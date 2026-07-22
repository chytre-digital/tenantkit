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
  TenantSummary,
  EmailProvider,
  EmailMessage,
  EmailSendResult,
  PaymentProvider,
  PaymentEvent,
  StorageProvider,
  SignedUploadRequest,
  SignedUploadTarget,
  StorageObjectStat,
  Clock,
  IdGen,
} from './ports'

// --- http & errors ---
export { jsonOk, jsonError } from './http/respond'
export { errorMessageFor } from './http/error-catalog'
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
export {
  enforceRateLimit,
  evaluateLimit,
  windowStartFor,
  rateLimitWindowMs,
  RATE_LIMIT_PRESETS,
  type RateLimitSpec,
  type RateLimitWindow,
  type RateLimitLockout,
  type LimitDecision,
} from './http/rate-limit'
export { type CookieAdapter, readOnlyCookies } from './http/cookies'

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
  type ParticipantAccount,
  type ParticipantRelation,
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
export {
  resolveTenantWorkspace,
  type TenantWorkspace,
  type WorkspaceResult,
} from './tenancy/workspace'

// --- rbac ---
export {
  type AppRole,
  type RoleDef,
  defineRoles,
  roleRank,
  roleAtLeast,
  getRoleOrder,
  getRoles,
  getOwnerRole,
} from './rbac/roles'
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

// --- server (withSlugRoute + legacy withRoute) ---
export {
  withRoute,
  type RouteOptions,
  type RouteCtx,
  type Audience,
  type ParticipantContext,
} from './server/with-route'
export {
  withSlugRoute,
  type SlugRouteOptions,
  type SlugRouteCtx,
} from './server/with-slug-route'
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

// --- events (the core.outbox dispatcher: fan a CoreEvent to plugin handlers + core subscribers) ---
export {
  createEventBus,
  dispatchEvent,
  type EventBus,
  type EventBusOptions,
  type PublishInput,
  type DispatchTarget,
  type OutboxEvent,
  type EventSubscriber,
  type SubscriberFailure,
  type DispatchResult,
} from './events'

// --- security (safe-link tokens; PII redaction) ---
export {
  createSafeLinks,
  DEFAULT_TTL_SECONDS,
  type SafeLinks,
  type SafeLinkConfig,
  type SafeLinkClaims,
  type MintInput,
  type VerifyResult,
  type SafeLinkFailure,
  redact,
  redactSecrets,
  redactPii,
  piiKeysOf,
  REDACTED,
  DEFAULT_SECRET_KEYS,
  type RedactOptions,
} from './security'

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
export { type EmailComposer, type TransactionalEmailInput } from './email/composer'

// --- i18n (vendor-free locale type; the next-intl factory `createI18n` lives in @tenantkit/i18n) ---
export {
  type Locale,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  readCookie,
} from './i18n/locale'
export { zodErrorMap, composeErrorMap, type ZodErrorMap } from './i18n/zod-locale'

// --- openapi (generate an OpenAPI 3.1 doc from route defs + their Zod schemas; doc 12 §5) ---
export {
  buildOpenApi,
  type RouteDef,
  type RouteAudience,
  type HttpMethod,
  type OpenApiInfo,
  type OpenApiServer,
  type BuildOpenApiInput,
  type OpenApiDocument,
  type JsonSchema,
} from './openapi'

// --- db (SQL building blocks) ---
export {
  ROLES_TABLE_SQL,
  rolesSeedSql,
  diffRoleSeed,
  type RoleRow,
  type RoleSeedDiff,
  type RoleSeedMismatch,
  IS_MEMBER_OF_SQL,
  IS_OWNER_SQL,
  IS_ADMIN_SQL,
  MY_ROLE_SQL,
  ROLE_RANK_SQL,
  SET_UPDATED_AT_SQL,
  ENFORCE_SINGLE_OWNER_SQL,
  ATTACH_SINGLE_OWNER_TRIGGER_SQL,
  CREATE_TENANT_WITH_OWNER_SQL,
  CORE_FUNCTIONS_SQL,
  AUDIT_LOG_SQL,
  SET_AUDIT_ACTOR_SQL,
  AUDIT_ROW_TRIGGER_FN_SQL,
  attachAuditTriggerSql,
  AUDIT_SQL,
  PARTICIPANT_ACCOUNTS_SQL,
  CAN_ACT_FOR_PARTICIPANT_SQL,
  INVITATIONS_SQL,
  ACCEPT_INVITATION_SQL,
  INVITATIONS_ALL_SQL,
} from './db'

// --- fields (the schema-driven custom-field system; module authored by a sibling agent) ---
export * from './fields'
