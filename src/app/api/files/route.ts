import { findAgent } from '@/lib/mastra-client'

// The specialist that checks MISMO files. An attached file goes straight to its server, and the
// chat message carries only the fileId it answers with.
const FILE_AGENT = 'mismo-check'

// Uploads a file attached in the chat. Body: { name, xml }. Answers { fileId, summary }.
export async function POST(request: Request) {
  const agent = await findAgent(FILE_AGENT)
  if (!agent) return Response.json({ error: `The ${FILE_AGENT} agent is not running, so the file cannot be checked.` }, { status: 503 })
  const res = await fetch(`${agent.url}/files`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: await request.text(),
  }).catch(() => null)
  if (!res) return Response.json({ error: `The ${FILE_AGENT} server is unreachable` }, { status: 502 })
  return Response.json(await res.json(), { status: res.status })
}
