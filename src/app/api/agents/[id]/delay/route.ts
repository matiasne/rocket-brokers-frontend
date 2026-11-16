import { findAgent } from '@/lib/mastra-client'

// Sets an agent's response delay on its own server. Body: { delayMs: number }.
export async function PUT(request: Request, ctx: RouteContext<'/api/agents/[id]/delay'>) {
  const { id } = await ctx.params
  const agent = await findAgent(id)
  if (!agent) return Response.json({ error: `Unknown agent "${id}"` }, { status: 404 })
  const res = await fetch(`${agent.url}/settings/delay`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: await request.text(),
  }).catch(() => null)
  if (!res) return Response.json({ error: `The ${id} server is unreachable` }, { status: 502 })
  return Response.json(await res.json(), { status: res.status })
}
