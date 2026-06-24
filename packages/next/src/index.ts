/**
 * @tenantkit/next — the Next.js binding (docs/14 §5, the "second coupling axis"). The kernel speaks Web
 * Request/Response; this package supplies the Next-specific seams: the cookie adapter (next/headers) and the
 * session-refresh middleware. Swap this for @tenantkit/hono or @tenantkit/remix and the kernel is unchanged.
 */
import { cookies } from 'next/headers'
import { NextResponse, type NextRequest } from 'next/server'
import type { CookieAdapter, CoreRuntime } from '@tenantkit/kernel'

/** A writable `CookieAdapter` over `next/headers` — pass as `createSupabaseRuntime({ cookies: nextCookies })`. */
export async function nextCookies(): Promise<CookieAdapter> {
  const store = await cookies()
  return {
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    setAll: (toSet) => {
      for (const c of toSet) {
        try {
          store.set(c.name, c.value, c.options)
        } catch {
          /* called from a Server Component render — ignored; the middleware below does the real refresh */
        }
      }
    },
  }
}

/**
 * The middleware (`proxy.ts`) glue: rotate the auth cookie on every request via the SessionStore port.
 * Compose with next-intl's middleware as in the reference apps.
 */
export function createProxyMiddleware(runtime: CoreRuntime) {
  return async function proxy(request: NextRequest): Promise<NextResponse> {
    const response = NextResponse.next({ request })
    await runtime.sessions.refresh(request, response)
    return response
  }
}
