import { master } from '@/lib/mastra-client'

// Sends the user's message to the router agent over A2A (`message/stream`)
// and relays every A2A event (task, status-update, artifact-update) to the browser as SSE.
export async function POST(req: Request) {
  const { text, contextId } = await req.json()
  const a2a = master.client.getA2A(master.id)
  const encoder = new TextEncoder()

  const body = new ReadableStream({
    async start(controller) {
      const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      try {
        const events = a2a.sendMessageStream({
          message: {
            kind: 'message',
            role: 'user',
            messageId: crypto.randomUUID(),
            contextId,
            parts: [{ kind: 'text', text }],
          },
        })
        for await (const event of events) send(event)
      } catch (error) {
        send({ kind: 'error', message: error instanceof Error ? error.message : String(error) })
      }
      controller.close()
    },
  })

  return new Response(body, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform' },
  })
}
