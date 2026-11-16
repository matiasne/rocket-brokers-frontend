import { master } from '@/lib/mastra-client'

const jobsUrl = (req: Request) => `${master.url}/sessions/${encodeURIComponent(new URL(req.url).searchParams.get('contextId') ?? '')}/jobs`

// Long-polls the router for the delegations of a chat session that outlived their turn:
// returns when the session has a version after `version`, or after `wait` seconds (20 unless given).
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams
  const url = `${jobsUrl(req)}?wait=${Number(params.get('wait') ?? 20)}&version=${Number(params.get('version') ?? -1)}`
  try {
    const res = await fetch(url, { cache: 'no-store', signal: req.signal })
    return Response.json(await res.json(), { status: res.status })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 502 })
  }
}

// With `jobId`, the user canceled that one background job. Without it, the chat session was
// closed: the router stops its delegations and cancels all its background jobs.
export async function DELETE(req: Request) {
  const jobId = new URL(req.url).searchParams.get('jobId')
  try {
    const res = await fetch(jobId ? `${jobsUrl(req)}/${encodeURIComponent(jobId)}` : jobsUrl(req), { method: 'DELETE', cache: 'no-store' })
    return Response.json(await res.json(), { status: res.status })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 502 })
  }
}
