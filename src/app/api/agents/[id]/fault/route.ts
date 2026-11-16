import { findAgent } from '@/lib/mastra-client'

// Sets the fault an agent injects, on its own server. Body: { fault: string }.
export async function PUT(request: Request, ctx: RouteContext<'/api/agents/[id]/fault'>) {
  const { id } = await ctx.params
  const agent = await findAgent(id)
  if (!agent) return Response.json({ error: `Unknown agent "${id}"` }, { status: 404 })
  const res = await fetch(`${agent.url}/settings/fault`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: await request.text(),
  }).catch(() => null)
  if (!res) return Response.json({ error: `The ${id} server is unreachable` }, { status: 502 })
  return Response.json(await res.json(), { status: res.status })
}
