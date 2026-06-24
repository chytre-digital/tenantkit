/**
 * A framework-agnostic cookie store. Read all request cookies; write response cookies. Lives in the KERNEL
 * (not in any adapter) so the kernel, the Next binding, and every Database/Identity adapter depend on THIS
 * vendor-free type — never on each other. (Decouples @tenantkit/next from @tenantkit/adapter-supabase.)
 */
export interface CookieAdapter {
  getAll(): { name: string; value: string }[]
  setAll(cookies: { name: string; value: string; options?: Record<string, unknown> }[]): void
}

/** A read-only cookie store for RSC/edge contexts where cookies can't be set (the middleware refreshes them). */
export const readOnlyCookies = (all: { name: string; value: string }[]): CookieAdapter => ({
  getAll: () => all,
  setAll: () => {
    /* ignored — read-only context; a middleware does the real cookie write */
  },
})
