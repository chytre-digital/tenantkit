/**
 * Unit tests for the cookie/Bearer credential resolver (spec §5.1). Pure and offline — no Supabase, no env.
 * These pin the precedence rules that keep the identity guard and the RLS DB scope on the SAME credential.
 */
import { describe, expect, it } from 'vitest'
import {
  normalizeRequestAuth,
  resolveRequestCredential,
  type SupabaseRequestAuthMode,
} from '../request-auth'

const SESSION_COOKIE = 'sb-access-token=eyJhbGciOi.header.sig; sb-refresh-token=refreshvalue'
const TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature'

function req(headers: Record<string, string> = {}): Request {
  return new Request('https://api.example.com/api/v1/t/acme/things', { headers })
}

describe('normalizeRequestAuth', () => {
  it('defaults to cookie mode', () => {
    expect(normalizeRequestAuth()).toEqual({ mode: 'cookie' })
    expect(normalizeRequestAuth({})).toEqual({ mode: 'cookie' })
  })
  it('passes an explicit mode through', () => {
    expect(normalizeRequestAuth({ mode: 'cookie-or-bearer' })).toEqual({ mode: 'cookie-or-bearer' })
  })
})

describe('resolveRequestCredential — no credential at all', () => {
  it('cookie mode → cookie', () => {
    expect(resolveRequestCredential(req(), { mode: 'cookie' })).toEqual({ kind: 'cookie' })
  })
  it('cookie-or-bearer mode → cookie', () => {
    expect(resolveRequestCredential(req(), { mode: 'cookie-or-bearer' })).toEqual({ kind: 'cookie' })
  })
  it('bearer mode → anonymous', () => {
    expect(resolveRequestCredential(req(), { mode: 'bearer' })).toEqual({ kind: 'anonymous' })
  })
})

describe('resolveRequestCredential — cookie present, no Authorization', () => {
  for (const mode of ['cookie', 'cookie-or-bearer'] as SupabaseRequestAuthMode[]) {
    it(`${mode} → cookie`, () => {
      expect(resolveRequestCredential(req({ cookie: SESSION_COOKIE }), { mode })).toEqual({ kind: 'cookie' })
    })
  }
})

describe('resolveRequestCredential — valid Bearer', () => {
  for (const mode of ['bearer', 'cookie-or-bearer'] as SupabaseRequestAuthMode[]) {
    it(`${mode} → bearer with the token`, () => {
      expect(resolveRequestCredential(req({ authorization: `Bearer ${TOKEN}` }), { mode })).toEqual({
        kind: 'bearer',
        accessToken: TOKEN,
      })
    })
  }

  it('is case-insensitive on the scheme', () => {
    for (const scheme of ['bearer', 'Bearer', 'BEARER', 'BeArEr']) {
      expect(resolveRequestCredential(req({ authorization: `${scheme} ${TOKEN}` }), { mode: 'bearer' })).toEqual({
        kind: 'bearer',
        accessToken: TOKEN,
      })
    }
  })

  it('trims the token at the edges only (inner content preserved)', () => {
    expect(resolveRequestCredential(req({ authorization: `Bearer   ${TOKEN}   ` }), { mode: 'bearer' })).toEqual({
      kind: 'bearer',
      accessToken: TOKEN,
    })
  })
})

describe('resolveRequestCredential — malformed Authorization (bearer transport on) → invalid, never cookie', () => {
  const malformed = [
    ['empty token after Bearer', 'Bearer '],
    ['whitespace-only token', 'Bearer      '],
    ['bare scheme, no space', 'Bearer'],
    ['unsupported Basic scheme', 'Basic dXNlcjpwYXNz'],
    ['empty header', ''],
    ['whitespace-only header', '   '],
  ] as const

  for (const [label, value] of malformed) {
    it(`bearer mode: ${label} → invalid`, () => {
      expect(resolveRequestCredential(req({ authorization: value }), { mode: 'bearer' })).toEqual({ kind: 'invalid' })
    })
    it(`cookie-or-bearer mode: ${label} → invalid (does NOT fall back to cookie)`, () => {
      expect(
        resolveRequestCredential(req({ authorization: value, cookie: SESSION_COOKIE }), { mode: 'cookie-or-bearer' }),
      ).toEqual({ kind: 'invalid' })
    })
  }
})

describe('resolveRequestCredential — cookie AND Bearer together', () => {
  it('cookie-or-bearer: Bearer wins', () => {
    expect(
      resolveRequestCredential(req({ authorization: `Bearer ${TOKEN}`, cookie: SESSION_COOKIE }), {
        mode: 'cookie-or-bearer',
      }),
    ).toEqual({ kind: 'bearer', accessToken: TOKEN })
  })
})

describe('resolveRequestCredential — pure cookie mode ignores Authorization entirely', () => {
  it('valid Bearer is ignored → cookie', () => {
    expect(resolveRequestCredential(req({ authorization: `Bearer ${TOKEN}` }), { mode: 'cookie' })).toEqual({
      kind: 'cookie',
    })
  })
  it('garbage Authorization is ignored → cookie', () => {
    expect(resolveRequestCredential(req({ authorization: 'not-a-scheme' }), { mode: 'cookie' })).toEqual({
      kind: 'cookie',
    })
  })
  it('default (no options) behaves as cookie mode', () => {
    expect(resolveRequestCredential(req({ authorization: `Bearer ${TOKEN}` }), {})).toEqual({ kind: 'cookie' })
  })
})

describe('resolveRequestCredential — never leaks the token on the rejection path', () => {
  it('a malformed bearer header yields no token field to log/snapshot', () => {
    const result = resolveRequestCredential(req({ authorization: `Bearer ${TOKEN}x-but-then-trailing` }), {
      mode: 'bearer',
    })
    // A well-formed-looking token IS carried on the `bearer` branch (that's the credential); the point of this
    // test is the *rejection* path: `invalid`/`anonymous` results must be plain and tokenless so nothing sensitive
    // can end up in an error snapshot or log line built from the resolver output.
    const rejection = resolveRequestCredential(req({ authorization: 'Bearer ' }), { mode: 'bearer' })
    expect(JSON.stringify(rejection)).not.toContain('Bearer')
    expect(rejection).toEqual({ kind: 'invalid' })
    // sanity: the valid case still returns the token (used only to build a request-scoped client, never logged)
    expect(result).toEqual({ kind: 'bearer', accessToken: `${TOKEN}x-but-then-trailing` })
  })
})
