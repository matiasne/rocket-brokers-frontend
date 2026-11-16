import { createBrowserClient } from '@supabase/ssr'
import { SUPABASE_KEY, SUPABASE_URL } from './config'

// The browser's client: one per page, signed in through the auth cookies.
export const createClient = () => createBrowserClient(SUPABASE_URL, SUPABASE_KEY)
