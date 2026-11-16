import { master } from '@/lib/mastra-client'

// Switches a specialist on or off on the router. Body: { enabled: boolean }.
export async function PUT(request: Request, ctx: RouteContext<'/api/agents/[id]'>) {
  const { id } = await ctx.params
  const res = await fetch(`${master.url}/specialists/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: await request.text(),
  }).catch(() => null)
  if (!res) return Response.json({ error: 'The router server is unreachable' }, { status: 502 })
  return Response.json(await res.json(), { status: res.status })
}
