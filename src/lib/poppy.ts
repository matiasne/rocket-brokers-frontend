import { master } from '@/lib/mastra-client'

// This Next.js server plays the borrower's personal agent: it speaks the Personal Agent
// Protocol (PAP) to the router server on the borrower's behalf.
export const DISCOVERY_URL = `${master.url}/.well-known/poppy.json`
export const CONVERSATIONS_URL = `${master.url}/poppy/conversations`

// DEMO ONLY: a real personal agent signs the session JWT with its own key and the company
// verifies it. Here the token is unsigned and the router only reads the user id from it.
export function poppyHeaders(userId: string) {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const session = `${encode({ alg: 'none', typ: 'poppy-session+jwt' })}.${encode({ sub: userId, iat: Math.floor(Date.now() / 1000) })}.`
  return {
    'Poppy-Session': session,
    'Poppy-Version': '1.0',
    // Lets the company send operations (exact terms to approve) to this agent.
    'Poppy-Extensions': '"operations";v="3"',
  }
}
