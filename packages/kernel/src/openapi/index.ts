/**
 * Barrel for the kernel `openapi` module — the Zod-driven OpenAPI 3.1 generator (docs/12 §5).
 * Re-exported from the package root so apps `import { buildOpenApi } from '@tenantkit/kernel'` and feed it the
 * same route definitions `withRoute` enforces.
 */
export { buildOpenApi } from './build'
export type {
  RouteDef,
  RouteAudience,
  HttpMethod,
  OpenApiInfo,
  OpenApiServer,
  BuildOpenApiInput,
  OpenApiDocument,
  JsonSchema,
} from './types'
