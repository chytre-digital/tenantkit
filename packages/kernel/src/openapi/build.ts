/**
 * Realizes docs/12-api-surface.md §5 — `buildOpenApi(routes)`: the Zod-driven OpenAPI generator.
 *
 * Pure + vendor-free: the ONLY dependency is Zod's first-party `z.toJSONSchema` (Zod 4), which emits
 * draft-2020-12 JSON Schema — natively embeddable in an OpenAPI 3.1 document. For each `RouteDef` it derives:
 *   • path parameters  ← the `{param}` segments in `path` (always required)
 *   • query parameters ← each top-level property of the `query` schema (required per the schema's `required`)
 *   • requestBody      ← the `body` schema (application/json)
 *   • responses        ← the success status + a shared `Error` envelope ({error,code,details,issues}, doc 12 §1.1)
 *   • security         ← derived from `audience` (public ⇒ none; staff/family ⇒ session or bearer)
 *
 * Because the schemas ARE the ones `withRoute` enforces, the doc cannot drift from the implementation — the
 * Phase 5 exit criterion ("generated in CI and matches enforcement", doc 13 §7).
 */
import { z, type ZodType } from 'zod'
import type {
  BuildOpenApiInput,
  JsonSchema,
  OpenApiDocument,
  RouteAudience,
  RouteDef,
} from './types'

/** The uniform error envelope every route can return (doc 02 §5, doc 12 §1.1) — referenced by every operation. */
const ERROR_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    error: { type: 'string', description: 'Human-readable message.' },
    code: { type: 'string', description: 'Stable machine code, e.g. NOT_A_MEMBER.' },
    details: { description: 'Optional structured context.' },
    issues: { type: 'array', description: 'Zod field issues on a 400 VALIDATION_ERROR.', items: {} },
  },
  required: ['error', 'code'],
}

/** Security schemes the audiences map onto (doc 05 §2: cookie session, or a bearer token for `apiAccess`). */
const SECURITY_SCHEMES: Record<string, unknown> = {
  cookieSession: { type: 'apiKey', in: 'cookie', name: 'session', description: 'Session cookie set at sign-in.' },
  bearerAuth: { type: 'http', scheme: 'bearer', description: 'API token (pro `apiAccess` surface, doc 12 §1.6).' },
}

export function buildOpenApi(input: BuildOpenApiInput): OpenApiDocument {
  const paths: Record<string, Record<string, unknown>> = {}

  for (const route of input.routes) {
    const path = route.path
    const ops = (paths[path] ??= {})
    ops[route.method.toLowerCase()] = operationFor(route)
  }

  const doc: OpenApiDocument = {
    openapi: '3.1.0',
    info: input.info,
    paths,
    components: { schemas: { Error: ERROR_SCHEMA }, securitySchemes: SECURITY_SCHEMES },
  }
  if (input.servers) doc.servers = input.servers
  return doc
}

function operationFor(route: RouteDef): Record<string, unknown> {
  const audience: RouteAudience = route.audience ?? 'staff'
  const parameters = [...pathParameters(route.path), ...queryParameters(route.query)]
  const successStatus = String(route.successStatus ?? 200)

  const op: Record<string, unknown> = {
    operationId: operationId(route),
    responses: {
      [successStatus]: successResponse(route.successSchema),
      default: {
        description: route.errors?.length
          ? `Error. Possible codes: ${route.errors.join(', ')}.`
          : 'Error response (the standard { error, code } envelope).',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  }
  if (route.summary) op.summary = route.summary
  if (route.description) op.description = route.description
  if (route.tags?.length) op.tags = route.tags
  if (parameters.length) op.parameters = parameters
  if (route.body) {
    op.requestBody = {
      required: true,
      content: { 'application/json': { schema: toSchema(route.body) } },
    }
  }
  // public ⇒ explicitly no security; staff/family ⇒ session OR bearer.
  op.security = audience === 'public' ? [] : [{ cookieSession: [] }, { bearerAuth: [] }]
  return op
}

function successResponse(schema?: ZodType): Record<string, unknown> {
  const res: Record<string, unknown> = { description: 'Success' }
  if (schema) res.content = { 'application/json': { schema: toSchema(schema) } }
  return res
}

/** `{param}` segments → required path parameters (string-typed; the route validates specifics). */
function pathParameters(path: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  for (const match of path.matchAll(/\{([^}]+)\}/g)) {
    out.push({ name: match[1], in: 'path', required: true, schema: { type: 'string' } })
  }
  return out
}

/** Each top-level property of the query object → an `in: query` parameter. */
function queryParameters(query?: ZodType): Array<Record<string, unknown>> {
  if (!query) return []
  const json = toSchema(query)
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>
  const required = new Set((json.required as string[] | undefined) ?? [])
  return Object.entries(properties).map(([name, schema]) => ({
    name,
    in: 'query',
    required: required.has(name),
    schema,
  }))
}

/** Convert a Zod schema to JSON Schema and drop the top-level `$schema` (OpenAPI embeds the schema inline). */
function toSchema(schema: ZodType): JsonSchema {
  const json = z.toJSONSchema(schema) as JsonSchema
  if ('$schema' in json) delete json['$schema']
  return json
}

function operationId(route: RouteDef): string {
  const slug = route.path.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')
  return `${route.method.toLowerCase()}_${slug}`
}
