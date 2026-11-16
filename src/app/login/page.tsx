'use client'

import { useState, type FormEvent } from 'react'
import { createClient } from '@/lib/supabase/client'
import { supabaseConfigured } from '@/lib/supabase/config'

// Sign in or create an account with email and password (Supabase Auth). The proxy sends
// everyone who is not signed in here, and everyone who is back to the chat.
export default function LoginPage() {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setError(undefined)
    setNotice(undefined)
    setBusy(true)
    try {
      const { auth } = createClient()
      const { data, error } = mode === 'sign-in' ? await auth.signInWithPassword({ email, password }) : await auth.signUp({ email, password })
      if (error) return setError(error.message)
      // A project that confirms emails creates the account without a session.
      if (!data.session) return setNotice('Account created. Confirm it with the link sent to your email, then sign in.')
      window.location.assign('/')
    } catch (error) {
      setError(String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="login">
      <form onSubmit={onSubmit}>
        <h1>Mastra × A2A</h1>
        <p>{mode === 'sign-in' ? 'Sign in to your chat.' : 'Create an account.'}</p>
        {!supabaseConfigured ? (
          <p className="login-error">
            Supabase is not configured. Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and <code>NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> in <code>.env</code> and restart.
          </p>
        ) : (
          <>
            <label>
              Email
              <input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete={mode === 'sign-in' ? 'current-password' : 'new-password'}
                required
                minLength={6}
                value={password}
                onChange={event => setPassword(event.target.value)}
              />
            </label>
            {error && <p className="login-error">{error}</p>}
            {notice && <p className="login-notice">{notice}</p>}
            <button type="submit" disabled={busy}>
              {mode === 'sign-in' ? 'Sign in' : 'Create account'}
            </button>
            <button type="button" className="login-switch" onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}>
              {mode === 'sign-in' ? 'No account yet? Create one' : 'Already have an account? Sign in'}
            </button>
          </>
        )}
      </form>
    </main>
  )
}
