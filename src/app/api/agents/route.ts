import { getSpecialists, master } from '@/lib/mastra-client'

// Discovery: the router, then the specialists registered with it, each with the A2A agent card
// fetched from its own server. A server that does not answer is listed without a card, so the
// others still show; while the router is unreachable it is the only one listed.
// `enabled` comes from the router, which is the one that delegates (null for the router itself). `delayMs` is the agent's own response delay (null while
// its server is unreachable), and `fault` the fault it is set to inject (null likewise).
export async function GET() {
  const setting = <T,>(url: string, name: string, read: (data: any) => T | null) =>
    fetch(`${url}/settings/${name}`, { cache: 'no-store' })
      .then(res => (res.ok ? res.json() : null))
      .then(read)
      .catch(() => null)
  const agents = [{ ...master, enabled: null }, ...((await getSpecialists()) ?? [])]
  const [results, delays, faults] = await Promise.all([
    Promise.allSettled(agents.map(({ id, client }) => client.getA2A(id).getAgentCard())),
    Promise.all(agents.map(({ url }) => setting(url, 'delay', data => (typeof data?.delayMs === 'number' ? (data.delayMs as number) : null)))),
    Promise.all(agents.map(({ url }) => setting(url, 'fault', data => (typeof data?.fault === 'string' ? (data.fault as string) : null)))),
  ])
  return Response.json({
    agents: agents.map(({ id, enabled }, index) => {
      const result = results[index]
      return { id, card: result.status === 'fulfilled' ? result.value : null, enabled, delayMs: delays[index], fault: faults[index] }
    }),
  })
}
