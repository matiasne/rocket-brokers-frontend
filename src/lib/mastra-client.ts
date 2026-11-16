import { MastraClient } from '@mastra/client-js'

// One Mastra server per agent. The UI is told only where the router lives (MASTER_URL); the
// specialists are whatever has registered with it (servers/router/src/mastra/specialists.ts).
const agentAt = (id: string, url: string) => ({ id, url, client: new MastraClient({ baseUrl: url }) })

export const master = agentAt('master', process.env.MASTER_URL ?? 'http://localhost:4111')

type Registered = { id: string; url: string; enabled: boolean }
type Specialist = ReturnType<typeof agentAt> & { enabled: boolean }

// The UI polls every second or so; one question to the router covers the polls of that moment.
const FRESH_MS = 2000
let asked = 0
let answer: Promise<Specialist[] | null> = Promise.resolve(null)

// The specialists registered with the router now, or null while the router is unreachable.
export function getSpecialists() {
  if (Date.now() - asked < FRESH_MS) return answer
  asked = Date.now()
  answer = fetch(`${master.url}/specialists`, { cache: 'no-store' })
    .then(res => (res.ok ? (res.json() as Promise<{ specialists: Registered[] }>) : null))
    .then(data => data?.specialists.map(({ id, url, enabled }) => ({ ...agentAt(id, url), enabled })) ?? null)
    .catch(() => null)
  return answer
}

// The router, or a specialist registered with it.
export async function findAgent(id: string) {
  return id === master.id ? master : (await getSpecialists())?.find(specialist => specialist.id === id)
}
