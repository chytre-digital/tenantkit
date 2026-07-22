/** `StorageProvider` port → Supabase Storage. Optional; used for tenant logos / data exports + direct uploads. */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SignedUploadRequest, SignedUploadTarget, StorageObjectStat, StorageProvider } from '@deverjak/tenantkit-kernel'
import { adminClient } from './clients'

/** True when a storage error means "no such object" — so `stat` can resolve `null` instead of throwing. */
function isNotFound(error: unknown): boolean {
  const e = error as { status?: number; statusCode?: string; message?: string }
  return e?.status === 404 || e?.statusCode === '404' || /not[\s_-]?found/i.test(e?.message ?? '')
}

export class SupabaseStorage implements StorageProvider {
  // Client factory is injectable for tests; defaults to the lazy service-role singleton (resolved on first use,
  // not at construction — see authz.ts).
  constructor(private readonly client: () => SupabaseClient = adminClient) {}

  private get db(): SupabaseClient {
    return this.client()
  }

  async put(input: { bucket: string; key: string; body: ArrayBuffer | Uint8Array; contentType: string }): Promise<{ key: string }> {
    const { error } = await this.db.storage.from(input.bucket).upload(input.key, input.body, {
      contentType: input.contentType, upsert: true,
    })
    if (error) throw error
    return { key: input.key }
  }

  async signedUrl(input: { bucket: string; key: string; expiresInSec: number }): Promise<string> {
    const { data, error } = await this.db.storage.from(input.bucket).createSignedUrl(input.key, input.expiresInSec)
    if (error || !data) throw error ?? new Error('signedUrl failed')
    return data.signedUrl
  }

  async remove(input: { bucket: string; key: string }): Promise<void> {
    const { error } = await this.db.storage.from(input.bucket).remove([input.key])
    if (error) throw error
  }

  /**
   * Mint a direct-upload target: the client PUTs the bytes straight to Supabase Storage — they never touch the
   * app server. Uses `createSignedUploadUrl` (service-role) with `upsert`. Supabase does NOT accept a per-URL
   * upload expiry (its upload tokens have a fixed server-side TTL, default ~2h), so `expiresInSec` sets the
   * advertised `expiresAt` only — keep it within Supabase's upload-token window.
   */
  async createSignedUpload(input: SignedUploadRequest): Promise<SignedUploadTarget> {
    const upsert = input.upsert === true
    const { data, error } = await this.db.storage.from(input.bucket).createSignedUploadUrl(input.key, { upsert })
    if (error || !data) throw error ?? new Error('createSignedUpload failed')
    const headers: Record<string, string> = { 'content-type': input.contentType }
    if (upsert) headers['x-upsert'] = 'true'
    return {
      url: data.signedUrl,
      method: 'PUT',
      headers,
      expiresAt: Date.now() + input.expiresInSec * 1000,
    }
  }

  /** Read an object's metadata, or `null` when it does not exist (a missing object is not an error). */
  async stat(input: { bucket: string; key: string }): Promise<StorageObjectStat | null> {
    const { data, error } = await this.db.storage.from(input.bucket).info(input.key)
    if (error) {
      if (isNotFound(error)) return null
      throw error
    }
    if (!data) return null
    const stat: StorageObjectStat = { size: data.size ?? 0, contentType: data.contentType ?? null }
    if (data.etag != null) stat.etag = data.etag
    return stat
  }
}

export const createSupabaseStorage = (): SupabaseStorage => new SupabaseStorage()
