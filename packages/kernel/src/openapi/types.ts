/**
 * Realizes docs/12-api-surface.md §5 (the generated OpenAPI) + docs/13 §7 Phase 5 ("the generated OpenAPI from
 * Zod, the typed client, the apiAccess public surface") — the INPUT + OUTPUT contracts of the generator.
 *
 * The whole point: a route already declares its shape to `withRoute` (audience, Zod `body`/`query`) — so the
 * API doc should be DERIVED from those declarations, never hand-maintained to drift from enforcement (doc 12 §5:
 * "generated in CI and matches enforcement"). A `RouteDef` is the `withRoute` options PLUS the method/path that
 * file-routing owns; `buildOpenApi` turns a list of them into a `3.1.0` document.
 *
 * These are plain types — the generator (build.ts) is pure and emits a JSON-serializable object, no vendor lib.
 */
import type { ZodType } from 'zod'

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS'

/** Mirrors `withRoute`'s `Audience` (server/with-route.ts) — drives the operation's security requirement. */
export type RouteAudience = 'public' | 'staff' | 'family'

/** One documented endpoint. The Zod schemas are the SAME objects `withRoute({ body, query })` validates with. */
export interface RouteDef {
  method: HttpMethod
  /** Path with OpenAPI-style params, e.g. `/api/courses/{id}`. `{param}` segments become path parameters. */
  path: string
  summary?: string
  description?: string
  /** 'public' ⇒ no security; 'staff'|'family' ⇒ the session/bearer requirement. Defaults to 'staff'. */
  audience?: RouteAudience
  tags?: string[]
  /** Request body schema → `requestBody` (application/json). */
  body?: ZodType
  /** Query schema (a `z.object`) → one `in: query` parameter per top-level property. */
  query?: ZodType
  /** Success status (default 200) and its optional response schema. */
  successStatus?: number
  successSchema?: ZodType
  /** Stable error codes this route can return (doc 12 §1.2) — listed in the error response description. */
  errors?: string[]
}

export interface OpenApiInfo {
  title: string
  version: string
  description?: string
}

export interface OpenApiServer {
  url: string
  description?: string
}

export interface BuildOpenApiInput {
  info: OpenApiInfo
  routes: RouteDef[]
  servers?: OpenApiServer[]
}

/** A JSON Schema object (what `z.toJSONSchema` returns, with `$schema` stripped). Kept loose on purpose. */
export type JsonSchema = Record<string, unknown>

/** The subset of an OpenAPI 3.1 document this generator emits. JSON-serializable. */
export interface OpenApiDocument {
  openapi: '3.1.0'
  info: OpenApiInfo
  servers?: OpenApiServer[]
  paths: Record<string, Record<string, unknown>>
  components: {
    schemas: Record<string, JsonSchema>
    securitySchemes: Record<string, unknown>
  }
}
