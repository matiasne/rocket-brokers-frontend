import { master } from '@/lib/mastra-client'

// Reads one of the router's tasks over A2A (`tasks/get`): how the page picks a turn up again
// after a reload cut its stream.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    const response = (await master.client.getA2A(master.id).getTask({ id })) as { result?: unknown; error?: { message?: string } }
    if (!response.result) return Response.json({ error: response.error?.message ?? 'Task not found' }, { status: 404 })
    return Response.json({ task: response.result })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 502 })
  }
}
