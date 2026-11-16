import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { SUPABASE_KEY, SUPABASE_URL, supabaseConfigured } from '@/lib/supabase/config'

// Everything but the login page needs a signed-in user: a page is sent to /login, an API
// route answers 401. Also keeps the auth cookies fresh, which only this layer can do.
export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl
  const isLogin = pathname === '/login'
  const refuse = () => (pathname.startsWith('/api/') ? NextResponse.json({ error: 'Not signed in' }, { status: 401 }) : NextResponse.redirect(new URL('/login', request.url)))
  if (!supabaseConfigured) return isLogin ? NextResponse.next() : refuse()

  let response = NextResponse.next({ request })
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: all => {
        for (const { name, value } of all) request.cookies.set(name, value)
        response = NextResponse.next({ request })
        for (const { name, value, options } of all) response.cookies.set(name, value, options)
      },
    },
  })
  const { data } = await supabase.auth.getUser()
  if (data.user && isLogin) return NextResponse.redirect(new URL('/', request.url))
  if (!data.user && !isLogin) return refuse()
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)'],
}
