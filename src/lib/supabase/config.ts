// The Supabase project the app signs users in with and stores their chat in. Both values are
// public by design: what a user may read or write is decided by row level security.
export const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
export const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? ''
export const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY)
