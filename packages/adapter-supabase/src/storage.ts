/** `StorageProvider` port → Supabase Storage. Optional; used for tenant logos / data exports. */
import type { StorageProvider } from '@tenantkit/kernel'
import { adminClient } from './clients'

export class SupabaseStorage implements StorageProvider {
  private db = adminClient()

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
}

export const createSupabaseStorage = (): SupabaseStorage => new SupabaseStorage()
