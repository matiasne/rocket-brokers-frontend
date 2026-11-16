import { CONVERSATIONS_URL, poppyHeaders } from '@/lib/poppy'

// Sends one PAP message for the borrower: plain text, or the approval of an operation.
// Without a `conversationId` it opens a new conversation. The reply is not in the response:
// it arrives as events. Returns what went over the wire, so the page can show it.
export async function POST(req: Request) {
  const { userId, conversationId, text, approval } = await req.json()
  const url = conversationId ? `${CONVERSATIONS_URL}/${conversationId}/messages` : CONVERSATIONS_URL
  const headers = poppyHeaders(userId)
  const body = {
    id: `msg_${crypto.randomUUID()}`,
    message: {
      // An approval is the person's own act; everything else is written by their agent.
      author: { type: approval ? 'human' : 'agent' },
      ...(text && { text }),
      ...(approval && { extensions: { operations: { approval } } }),
    },
  }
  try {
    const res = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    return Response.json({ request: { method: 'POST', url, headers, body }, status: res.status, response: await res.json() })
  } catch (error) {
    return Response.json({ request: { method: 'POST', url, headers, body }, status: 0, response: { error: String(error) } })
  }
}
