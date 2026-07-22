/**
 * Unit tests for the Supabase `StorageProvider` direct-upload + stat capabilities (spec §7 / P2). Pure — a fake
 * Supabase client is injected, so no live project or env is needed: we assert the mapping from the port shape
 * (`SignedUploadRequest` / `stat`) onto `createSignedUploadUrl()` / `info()` and back, including argument
 * threading (`upsert`), the `expiresAt` derivation, and missing-object → `null`.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { SupabaseStorage } from '../storage'

type InfoResult = { data: unknown; error: unknown }

function makeStorage(info: (key: string) => InfoResult = () => ({ data: null, error: null })) {
  const calls = {
    from: [] as string[],
    createSignedUploadUrl: [] as Array<{ key: string; opts: unknown }>,
    info: [] as string[],
  }
  const fileApi = {
    createSignedUploadUrl: async (key: string, opts: unknown) => {
      calls.createSignedUploadUrl.push({ key, opts })
      return {
        data: { signedUrl: `https://proj.supabase.co/storage/v1/object/upload/sign/evidence/${key}?token=jwt`, token: 'jwt', path: key },
        error: null,
      }
    },
    info: async (key: string) => {
      calls.info.push(key)
      return info(key)
    },
  }
  const client = { storage: { from: (bucket: string) => (calls.from.push(bucket), fileApi) } }
  return { storage: new SupabaseStorage(() => client as unknown as SupabaseClient), calls }
}

describe('SupabaseStorage.createSignedUpload (spec §7)', () => {
  it('mints a PUT target, threads bucket/key/upsert, and derives expiresAt from expiresInSec', async () => {
    const { storage, calls } = makeStorage()
    const before = Date.now()
    const target = await storage.createSignedUpload({ bucket: 'evidence', key: 'jobs/1/before.jpg', contentType: 'image/jpeg', expiresInSec: 900, upsert: true })
    const after = Date.now()

    expect(calls.from).toEqual(['evidence'])
    expect(calls.createSignedUploadUrl).toEqual([{ key: 'jobs/1/before.jpg', opts: { upsert: true } }])
    expect(target.method).toBe('PUT')
    expect(target.url).toContain('/object/upload/sign/evidence/jobs/1/before.jpg')
    expect(target.headers).toEqual({ 'content-type': 'image/jpeg', 'x-upsert': 'true' })
    expect(target.expiresAt).toBeGreaterThanOrEqual(before + 900_000)
    expect(target.expiresAt).toBeLessThanOrEqual(after + 900_000)
  })

  it('omits the x-upsert header and passes upsert:false when upsert is not requested', async () => {
    const { storage, calls } = makeStorage()
    const target = await storage.createSignedUpload({ bucket: 'evidence', key: 'k.png', contentType: 'image/png', expiresInSec: 60 })
    expect(calls.createSignedUploadUrl).toEqual([{ key: 'k.png', opts: { upsert: false } }])
    expect(target.headers).toEqual({ 'content-type': 'image/png' })
  })

  it('throws when Supabase returns an error (no silent success)', async () => {
    const storage = new SupabaseStorage(
      () =>
        ({
          storage: { from: () => ({ createSignedUploadUrl: async () => ({ data: null, error: new Error('bucket not found') }) }) },
        }) as unknown as SupabaseClient,
    )
    await expect(storage.createSignedUpload({ bucket: 'nope', key: 'k', contentType: 'text/plain', expiresInSec: 60 })).rejects.toThrow('bucket not found')
  })
})

describe('SupabaseStorage.stat (spec §7)', () => {
  it('maps info() metadata to { size, contentType, etag }', async () => {
    const { storage } = makeStorage(() => ({ data: { size: 20481, contentType: 'image/jpeg', etag: 'abc123' }, error: null }))
    expect(await storage.stat({ bucket: 'evidence', key: 'k.jpg' })).toEqual({ size: 20481, contentType: 'image/jpeg', etag: 'abc123' })
  })

  it('omits etag when the object has none, and defaults a missing size/contentType', async () => {
    const { storage } = makeStorage(() => ({ data: { size: undefined, contentType: undefined }, error: null }))
    const stat = await storage.stat({ bucket: 'evidence', key: 'k' })
    expect(stat).toEqual({ size: 0, contentType: null })
    expect('etag' in (stat as object)).toBe(false)
  })

  it('resolves null for a missing object (404 status)', async () => {
    const { storage } = makeStorage(() => ({ data: null, error: { status: 404, message: 'Object not found' } }))
    expect(await storage.stat({ bucket: 'evidence', key: 'gone' })).toBeNull()
  })

  it('resolves null when Supabase signals not-found by message (400)', async () => {
    const { storage } = makeStorage(() => ({ data: null, error: { status: 400, message: 'Object not found' } }))
    expect(await storage.stat({ bucket: 'evidence', key: 'gone' })).toBeNull()
  })

  it('re-throws non-not-found errors (e.g. a 500 is not swallowed as "absent")', async () => {
    const { storage } = makeStorage(() => ({ data: null, error: { status: 500, message: 'internal error' } }))
    await expect(storage.stat({ bucket: 'evidence', key: 'k' })).rejects.toMatchObject({ status: 500 })
  })
})
