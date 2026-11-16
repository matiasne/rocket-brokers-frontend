import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { SUPABASE_KEY, SUPABASE_URL } from './config'

// The server's client for one request, signed in as whoever the request's cookies say.
export async function createClient() {
  const store = await cookies()
  return createServerClient(SUPABASE_URL, SUPABASE_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: all => {
        try {
          for (const { name, value, options } of all) store.set(name, value, options)
        } catch {
          // A Server Component cannot set cookies; the proxy refreshes them instead.
        }
      },
    },
  })
}
