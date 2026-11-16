import { ListTasksRequest, ListTasksResponse } from '@mastra/core/a2a/v1'
import { getSpecialists } from '@/lib/mastra-client'

type ListedTask = { status?: { timestamp?: string } }

// The other async style in A2A: no open stream, just ask each specialist server
// registered with the router for its tasks (`ListTasks`, A2A v1.0) and poll for state changes.
// A server that is down simply contributes no tasks; /api/agents reports it.
export async function GET() {
  const lists = await Promise.allSettled(
    ((await getSpecialists()) ?? []).map(async ({ id, client }) => {
      const response = await client.getA2AV1(id).listTasks(ListTasksRequest.fromJSON({ pageSize: 20 }))
      const { tasks = [] } = ListTasksResponse.toJSON(response) as { tasks?: ListedTask[] }
      return tasks.map(task => ({ ...task, agent: id }))
    }),
  )
  const tasks = lists.flatMap(list => (list.status === 'fulfilled' ? list.value : []))
  tasks.sort((a, b) => (b.status?.timestamp ?? '').localeCompare(a.status?.timestamp ?? ''))
  return Response.json({ tasks })
}
