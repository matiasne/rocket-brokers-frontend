import { CONVERSATIONS_URL, poppyHeaders } from '@/lib/poppy'

// Long-polls a PAP conversation: returns when there are events after `cursor`,
// when the company stops or starts working, or after 20 seconds.
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams
  const cursor = params.get('cursor')
  const url = `${CONVERSATIONS_URL}/${params.get('conversationId')}/events?wait=20${cursor ? `&cursor=${cursor}` : ''}`
  try {
    const res = await fetch(url, { headers: poppyHeaders(params.get('userId') ?? ''), cache: 'no-store' })
    return Response.json(await res.json(), { status: res.status })
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 502 })
  }
}
