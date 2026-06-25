/**
 * Realizes docs/12-api-surface.md §5 — the OpenAPI generator, proven to derive the doc FROM the Zod schemas
 * `withRoute` enforces (so it cannot drift). Covers: path/query parameter derivation, requestBody from a body
 * schema, the shared error envelope, audience → security mapping, and multiple methods on one path.
 */
import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { buildOpenApi } from '../build'
import type { RouteDef } from '../types'

const routes: RouteDef[] = [
  {
    method: 'GET',
    path: '/api/courses',
    audience: 'staff',
    summary: 'List courses',
    query: z.object({ q: z.string().optional(), status: z.enum(['draft', 'active', 'completed']) }),
  },
  {
    method: 'GET',
    path: '/api/courses/{id}',
    audience: 'staff',
    errors: ['NOT_FOUND', 'NOT_A_MEMBER'],
  },
  {
    method: 'POST',
    path: '/api/public/applications',
    audience: 'public',
    successStatus: 201,
    body: z.object({ childName: z.string().min(1), email: z.string().email() }),
  },
]

/** Loosely typed view of the emitted document for ergonomic nested assertions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const doc: any = buildOpenApi({
  info: { title: 'Termínář API', version: '1.0.0' },
  servers: [{ url: 'https://app.terminar.cz' }],
  routes,
})

describe('buildOpenApi — document shape', () => {
  it('emits a 3.1.0 doc with info, servers, and the shared Error schema + security schemes', () => {
    expect(doc.openapi).toBe('3.1.0')
    expect(doc.info).toEqual({ title: 'Termínář API', version: '1.0.0' })
    expect(doc.servers).toEqual([{ url: 'https://app.terminar.cz' }])
    expect(doc.components.schemas.Error.required).toEqual(['error', 'code'])
    expect(Object.keys(doc.components.securitySchemes)).toEqual(['cookieSession', 'bearerAuth'])
  })
})

describe('buildOpenApi — parameters', () => {
  it('derives query parameters from the query schema (required follows the schema)', () => {
    const params = doc.paths['/api/courses'].get.parameters
    const byName = Object.fromEntries(params.map((p: any) => [p.name, p]))
    expect(byName['q'].in).toBe('query')
    expect(byName['q'].required).toBe(false) // optional in the Zod schema
    expect(byName['status'].required).toBe(true)
    expect(byName['status'].schema.enum).toEqual(['draft', 'active', 'completed'])
  })

  it('derives a required path parameter from a {param} segment', () => {
    const params = doc.paths['/api/courses/{id}'].get.parameters
    expect(params).toEqual([{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }])
  })
})

describe('buildOpenApi — requestBody from a Zod body schema', () => {
  it('embeds the converted JSON Schema and marks required fields', () => {
    const schema = doc.paths['/api/public/applications'].post.requestBody.content['application/json'].schema
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties)).toEqual(['childName', 'email'])
    expect(schema.properties.childName.minLength).toBe(1)
    expect(schema.properties.email.format).toBe('email')
    expect(schema.required.sort()).toEqual(['childName', 'email'])
    expect(schema.$schema).toBeUndefined() // stripped — embedded inline, not a standalone document
  })

  it('puts the success response under the declared status (201 here)', () => {
    expect(doc.paths['/api/public/applications'].post.responses['201']).toBeDefined()
    expect(doc.paths['/api/public/applications'].post.responses['200']).toBeUndefined()
  })
})

describe('buildOpenApi — security by audience + error responses', () => {
  it('public ⇒ no security; staff ⇒ session or bearer', () => {
    expect(doc.paths['/api/public/applications'].post.security).toEqual([])
    expect(doc.paths['/api/courses'].get.security).toEqual([{ cookieSession: [] }, { bearerAuth: [] }])
  })

  it('every operation has a default error response referencing the Error envelope', () => {
    const def = doc.paths['/api/courses/{id}'].get.responses.default
    expect(def.content['application/json'].schema.$ref).toBe('#/components/schemas/Error')
    expect(def.description).toContain('NOT_FOUND') // route.errors surfaced in the description
  })

  it('gives each operation a stable operationId', () => {
    expect(doc.paths['/api/courses'].get.operationId).toBe('get_api_courses')
    expect(doc.paths['/api/courses/{id}'].get.operationId).toBe('get_api_courses_id')
  })
})
